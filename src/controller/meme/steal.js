/**
 * meme/steal.js · 盗图（收别人的图进表情库）
 *
 * 主人明确要的功能：「她看到喜欢的图，可以自己收藏起来以后用」。
 * 触发链（PLAN-v3.1 §2.4）：
 *
 *   群消息带图
 *     ↓ 按概率 p 掷骰（不通过就完全不管，零成本 —— 连下载都不做）
 *     ↓ 模式检查（work 模式完全不盗图）
 *     ↓ 尺寸/格式过滤（minBytes / maxBytes / 扩展名白名单）
 *     ↓ 下载到临时文件（优先复用 inbound 的落盘能力，没有就自己 fetch）
 *     ↓ 一次视觉调用：「这是什么？适合当表情包吗？给个内容描述 + 推荐类别」
 *     ↓ 是 → 生成描述性文件名 → 入库（sha256 去重）
 *     ↓ 否 → 删临时文件
 *
 * 视觉调用是**注入**的：具体怎么调模型（走 DSH 的 vision、还是别的）不是这一层的事，
 * 这里只负责「调用它、按结果落库」；测试里注入一个假的即可，不碰网络。
 *
 * ⚠️ 腾讯 CDN 坑（meme_manager 踩过，AstrBot 生态实测）：
 *   `multimedia.nt.qq.com.cn` 的图走 https 经常下不动，把 https 手动降成 http 才拿得到。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isOn, normalizePeerKey } from '../../modes.js'
import {
  configRootOf,
  normalizeLog,
  readMemeConfig,
  sha256Of,
  sniffImageExt,
} from './store.js'

/** 单个下载超时：表情包都不大，20 秒不回来基本就是地址死了。 */
const DOWNLOAD_TIMEOUT_MS = 20000

/** 腾讯图片 CDN 的 host（见文件头注释）。 */
const TENCENT_CDN_HOST = 'multimedia.nt.qq.com.cn'

/**
 * 把消息归一化成 modes.js 认的 peerKey：`group-<群号>` / `private-<QQ号>`。
 *
 * 为什么不直接用 message.peerId：群聊的 peerId 是群号，但 modes 的覆盖配置
 * 是按「对话」写的（`group-123456`），中间差一个前缀。这里集中算清楚，
 * 免得每个调用点各写一遍、写歪一个就导致「按对话配的概率不生效」。
 *
 * @param {object} message QqMessage
 * @returns {string}
 */
export function peerKeyOf(message) {
  const scene = String(message?.scene ?? '')
  if (scene === 'group') {
    const groupId = String(message?.groupId || message?.peerId || '')
    return groupId ? normalizePeerKey(`group-${groupId}`) : ''
  }
  const userId = String(message?.peerId || message?.userId || '')
  return userId ? normalizePeerKey(`private-${userId}`) : ''
}

/**
 * 腾讯 CDN 降协议（见文件头）。
 *
 * 只动这一个 host，别的 URL 原样返回 —— 别的地方降 http 可能反而被中间设备劫持。
 *
 * @param {string} url
 * @returns {string}
 */
export function fixTencentCdnUrl(url) {
  const text = String(url ?? '').trim()
  if (!text) return ''
  try {
    const parsed = new URL(text)
    if (parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === TENCENT_CDN_HOST) {
      parsed.protocol = 'http:'
      return parsed.toString()
    }
  } catch {
    // 不是合法 URL：原样交给下游，由下游报错（这里不猜）
  }
  return text
}

/** 从 media 的 name / url 里猜扩展名；猜不到返回 ''（猜不到就放过，不硬猜）。 */
function extOf(media) {
  const candidates = [media?.name, media?.url, media?.fileId]
  for (const candidate of candidates) {
    const raw = String(candidate ?? '').trim()
    if (!raw) continue
    let pathname = raw
    try {
      pathname = new URL(raw).pathname
    } catch {
      // 不是 URL：按普通文件名字符串处理
    }
    const match = /\.([a-zA-Z0-9]{2,5})(?:[?#].*)?$/.exec(pathname)
    if (match) return match[1].toLowerCase()
  }
  return ''
}

/** 读文件前 N 字节（格式嗅探用，不整份读）。 */
function readHead(filePath, length = 32) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const bytes = fs.readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, bytes)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 盗图闸门。
 *
 * 设计要点：
 *   · 所有外部依赖注入（vision / inbound / fetchImpl / rng / now），测试不碰网络；
 *   · 每条消息**最多一次视觉调用**（费钱的事只做一次），只拿第一张格式合格的图；
 *   · sha256 先查重：已经收藏过的图不浪费视觉调用；
 *   · 任何异常都不外抛 —— 一条消息处理失败不能拖垮聊天。
 */
export class StealGate {
  /**
   * @param {object} options
   * @param {MemeStore} options.store 表情库
   * @param {object|Function} options.config 整份配置（对象 / getter 都行）
   * @param {object} [options.log]
   * @param {(filePath: string) => Promise<{ok: boolean, description?: string, category?: string, isMeme: boolean}>} [options.vision]
   *        注入的视觉判断函数；不注入 = 不盗图（只记日志，不猜）
   * @param {object} [options.inbound] src/controller/inbound.js 的实例（有 collect 就复用）
   * @param {() => number} [options.rng] 掷骰注入
   * @param {() => number} [options.now] 时间注入（临时文件名/catalog 时间）
   * @param {typeof fetch} [options.fetchImpl] 测试注入（默认全局 fetch）
   * @param {string} [options.tmpDir] 临时文件根目录（默认 os.tmpdir()，测试可注入）
   * @param {number} [options.timeoutMs] 下载超时
   */
  constructor({
    store,
    config,
    log,
    vision,
    inbound = null,
    rng = Math.random,
    now = Date.now,
    fetchImpl,
    tmpDir,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
  } = {}) {
    this.store = store
    this.config = config
    this.log = normalizeLog(log)
    this.vision = typeof vision === 'function' ? vision : null
    this.inbound = inbound && typeof inbound.collect === 'function' ? inbound : null
    this.rng = typeof rng === 'function' ? rng : Math.random
    this.now = typeof now === 'function' ? now : Date.now
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
    this.tmpDir = String(tmpDir || os.tmpdir())
    this.timeoutMs = Math.max(1, Number(timeoutMs) || DOWNLOAD_TIMEOUT_MS)
    /** 本次进程里我们自己创建的临时文件 / 目录（dispose 时清干净） */
    this.tempPaths = new Set()
    this.tempDirs = new Set()
    this.disposed = false
    /** 面板/排错用计数 */
    this.counters = {
      attempts: 0, // 带图消息处理次数
      skippedNoImage: 0, // 没图，零成本返回
      skippedProbability: 0, // 概率没中
      skippedMode: 0, // 模式不允许（work）
      skippedFormat: 0, // 格式/大小/地址不合格
      visionRejected: 0, // 视觉说不是表情包
      deduped: 0, // 已经收藏过
      stolen: 0, // 真的收进来了
      failed: 0, // 下载/入库等异常
    }
  }

  /** 面板用计数快照。 */
  stats() {
    return { ...this.counters, pendingTemps: this.tempPaths.size, pendingTempDirs: this.tempDirs.size }
  }

  /**
   * 这条消息要不要盗图、要的话盗到没有。
   *
   * @param {object} message QqMessage
   * @returns {Promise<boolean>} true = 成功入库（或本来就已收藏）
   */
  async maybeSteal(message) {
    if (this.disposed) return false
    try {
      // ① 没有图片 → 零成本返回（绝不下载、绝不掷骰）
      const images = Array.isArray(message?.media)
        ? message.media.filter((item) => String(item?.kind ?? '') === 'image')
        : []
      if (images.length === 0) {
        this.counters.skippedNoImage += 1
        return false
      }
      this.counters.attempts += 1

      const cfg = readMemeConfig(this.config).steal
      const peerKey = peerKeyOf(message)

      // ② 按概率掷骰（peers[peerKey] 覆盖默认）
      const probability = this.probabilityFor(cfg, peerKey)
      if (!(this.roll() < probability)) {
        this.counters.skippedProbability += 1
        return false
      }

      // ③ 模式闸：work 模式不盗图（只发不收）
      if (!peerKey || !isOn('memeSteal', peerKey, configRootOf(this.config))) {
        this.counters.skippedMode += 1
        return false
      }

      if (!this.vision) {
        this.log.warn('盗图：没有注入 vision 判断函数，跳过')
        this.counters.failed += 1
        return false
      }

      // ④ 尺寸/格式过滤 + 选第一张合格的
      const candidate = this.firstCandidate(images, cfg)
      if (!candidate) {
        this.counters.skippedFormat += 1
        return false
      }

      // ⑤ 下载到临时文件
      const downloaded = await this.acquire(candidate, cfg, message)
      if (!downloaded) {
        this.counters.failed += 1
        return false
      }
      try {
        return await this.judgeAndIngest(downloaded)
      } finally {
        await this.cleanupDownload(downloaded)
      }
    } catch (error) {
      this.counters.failed += 1
      this.log.warn(`盗图失败（不影响聊天）：${error?.message ?? error}`)
      return false
    }
  }

  /* ── 闸门细节 ─────────────────────────────────────────────── */

  /** 掷骰：rng 异常时按 0 处理（保守：宁可漏收，不能乱收）。 */
  roll() {
    const value = Number(this.rng())
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  }

  /**
   * 这条消息的盗图概率：peers[peerKey] 优先，其次 steal.probability。
   *
   * @param {{probability: number, peers: object}} cfg steal 配置段
   * @param {string} peerKey
   */
  probabilityFor(cfg, peerKey) {
    const peers = cfg?.peers ?? {}
    const keys = [String(peerKey ?? ''), normalizePeerKey(peerKey)].filter(Boolean)
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(peers, key)) continue
      const value = Number(peers[key])
      if (Number.isFinite(value)) return Math.min(1, Math.max(0, value))
    }
    const fallback = Number(cfg?.probability)
    return Number.isFinite(fallback) ? Math.min(1, Math.max(0, fallback)) : 0
  }

  /** 第一张「地址合法 + 扩展名白名单内」的图（只看第一张：一条消息只做一次视觉调用）。 */
  firstCandidate(images, cfg) {
    const allowed = new Set((cfg?.allowedExt ?? []).map((ext) => String(ext).toLowerCase()))
    for (const media of images) {
      const url = fixTencentCdnUrl(media?.url)
      if (!url || !/^https?:\/\//i.test(url)) continue
      const ext = extOf(media)
      if (!ext || !allowed.has(ext)) continue
      return { media, url, ext }
    }
    return null
  }

  /* ── 下载 ─────────────────────────────────────────────────── */

  /**
   * 把候选图弄到本地临时文件。
   *
   * 优先复用 inbound.collect（DESIGN 说「走 inbound 已有的落盘能力」）；
   * 没有 inbound 就自己 fetch 到 os.tmpdir()。两条路落下来的都是**我们自己的副本**
   * （inbound 那条故意带 `-steal-` 后缀，不会和 pipeline 的媒体落盘同名），
   * 所以用完整理删掉是安全的。
   *
   * @returns {Promise<{path: string, bytes: number, ext: string, buffer: Buffer|null}|null>}
   */
  async acquire(candidate, cfg, message) {
    if (this.inbound) {
      const entry = {
        kind: 'image',
        url: candidate.url,
        fileId: String(candidate.media?.fileId ?? candidate.media?.file_id ?? ''),
        name: String(candidate.media?.name ?? ''),
      }
      // 故意换一个 id：inbound 的落盘文件名 = `<messageId>-<index><ext>`，
      // 如果和 pipeline 自己的落盘同名，谁先谁后都会互相覆盖/误删。
      const stealId = `${String(message?.id ?? '') || numberOr(this.now(), Date.now())}-steal-${numberOr(this.now(), Date.now())}`
      let results = []
      try {
        results = await this.inbound.collect({ id: stealId, media: [entry] })
      } catch (error) {
        this.log.warn(`盗图：inbound 落盘异常，跳过：${error?.message ?? error}`)
        return null
      }
      const hit = (Array.isArray(results) ? results : []).find((item) => item && !item.failed && item.path)
      if (!hit) {
        this.log.debug('盗图：inbound 没取到图')
        return null
      }
      const filePath = String(hit.path)
      let bytes = 0
      try {
        bytes = fs.statSync(filePath).size
      } catch {
        return null
      }
      if (!this.sizeAllowed(bytes, cfg)) {
        this.dropFile(filePath)
        this.log.debug(`盗图：文件大小不合格（${bytes} 字节）`)
        return null
      }
      let sniffed = ''
      try {
        sniffed = sniffImageExt(readHead(filePath))
      } catch (error) {
        // 读不了文件头就当判不出来（放行格式），但大小已经过了；这里只是排错日志
        this.log.debug(`盗图：读文件头失败，按扩展名放行：${error?.message ?? error}`)
      }
      const finalExt = sniffed || candidate.ext
      if (!this.extAllowed(finalExt, cfg)) {
        this.dropFile(filePath)
        this.log.debug(`盗图：格式不合格（${finalExt || '未知'}）`)
        return null
      }
      return { path: filePath, bytes, ext: finalExt, buffer: null }
    }

    if (typeof this.fetchImpl !== 'function') {
      this.log.warn('盗图：没有可用的 fetch，跳过')
      return null
    }

    let response
    try {
      response = await this.fetchImpl(candidate.url, { signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (error) {
      this.log.debug(`盗图：下载失败 ${candidate.url.slice(0, 120)} —— ${error?.message ?? error}`)
      return null
    }
    if (!response || !response.ok) {
      this.log.debug(`盗图：下载返回 HTTP ${response?.status ?? '?'}`)
      return null
    }
    // 有 Content-Length 就先放弃，别为了丢一张 8MB 的图先把流量下完
    const declaredRaw = response.headers?.get?.('content-length')
    const declared = declaredRaw === null || declaredRaw === undefined ? 0 : Number(declaredRaw)
    if (Number.isFinite(declared) && declared > 0 && !this.sizeAllowed(declared, cfg)) {
      this.log.debug(`盗图：Content-Length 不合格（${declared} 字节）`)
      return null
    }

    let buffer
    try {
      buffer = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      this.log.debug(`盗图：读取响应体失败：${error?.message ?? error}`)
      return null
    }
    if (!this.sizeAllowed(buffer.length, cfg)) {
      this.log.debug(`盗图：下载后大小不合格（${buffer.length} 字节）`)
      return null
    }
    const sniffed = sniffImageExt(buffer)
    const finalExt = sniffed || candidate.ext
    if (!this.extAllowed(finalExt, cfg)) {
      this.log.debug(`盗图：格式不合格（${finalExt || '未知'}）`)
      return null
    }

    // 写临时文件：视觉调用要的是**本机文件路径**，不是 Buffer
    let dir
    try {
      dir = fs.mkdtempSync(path.join(this.tmpDir, 'chacha-meme-steal-'))
    } catch (error) {
      this.log.warn(`盗图：临时目录创建失败：${error?.message ?? error}`)
      return null
    }
    this.tempDirs.add(dir)
    const file = path.join(dir, `steal.${finalExt}`)
    try {
      fs.writeFileSync(file, buffer)
    } catch (error) {
      this.log.warn(`盗图：临时文件写入失败：${error?.message ?? error}`)
      return null
    }
    this.tempPaths.add(file)
    return { path: file, bytes: buffer.length, ext: finalExt, buffer }
  }

  sizeAllowed(bytes, cfg) {
    const min = Number(cfg?.minBytes) || 0
    const max = Number(cfg?.maxBytes) || 0
    if (bytes < min) return false
    if (max > 0 && bytes > max) return false
    return true
  }

  extAllowed(ext, cfg) {
    const value = String(ext ?? '').toLowerCase()
    if (!value) return false
    return (cfg?.allowedExt ?? []).map((item) => String(item).toLowerCase()).includes(value)
  }

  /* ── 判断 + 入库 ───────────────────────────────────────────── */

  /**
   * 视觉判断 → 入库。
   *
   * 先查 sha256：已经收藏过的图不再花一次视觉调用（群里同一张表情包会被转很多次）。
   *
   * @param {{path: string, bytes: number, ext: string, buffer: Buffer|null}} downloaded
   * @returns {Promise<boolean>}
   */
  async judgeAndIngest(downloaded) {
    const buffer = downloaded.buffer ?? fs.readFileSync(downloaded.path) // 小图，同步读足够
    const hash = sha256Of(buffer)
    const existing = typeof this.store?.findBySha256 === 'function' ? this.store.findBySha256(hash) : null
    if (existing) {
      this.counters.deduped += 1
      this.log.debug(`盗图：这张已经收藏过（${existing.relative}），跳过视觉判断`)
      return true
    }

    let verdict = null
    try {
      verdict = await this.vision(downloaded.path)
    } catch (error) {
      this.log.warn(`盗图：视觉判断失败，跳过：${error?.message ?? error}`)
      return false
    }
    if (!verdict || !verdict.ok || !verdict.isMeme) {
      this.counters.visionRejected += 1
      this.log.debug('盗图：视觉判断「不是适合收藏的表情包」，丢弃')
      return false
    }

    const category =
      typeof this.store?.normalizeCategory === 'function'
        ? this.store.normalizeCategory(verdict.category)
        : 'other'
    const description = String(verdict.description ?? '').trim() || `表情_${numberOr(this.now(), Date.now())}`
    const result = await this.store.ingest({
      buffer,
      ext: downloaded.ext,
      description,
      category,
    })
    if (result.deduped) {
      this.counters.deduped += 1
      return true
    }
    this.counters.stolen += 1
    this.log.info(`盗图成功：${result.path}`)
    return true
  }

  /* ── 清理 ─────────────────────────────────────────────────── */

  /** 立刻删一个「我们自己的」落盘文件（inbound 副本 / 失败分支用；删不掉也不抛）。 */
  dropFile(filePath) {
    if (!filePath) return
    try {
      fs.rmSync(filePath, { force: true })
    } catch {
      // 删不掉就让 dispose 再试一次
      this.tempPaths.add(filePath)
    }
  }

  /** 用完删：自己落的临时文件/目录一个都不留。 */
  async cleanupDownload(downloaded) {
    if (!downloaded?.path) return
    const file = downloaded.path
    const dir = path.dirname(file)
    try {
      if (this.tempDirs.has(dir)) {
        await fs.promises.rm(dir, { recursive: true, force: true })
        this.tempDirs.delete(dir)
        this.tempPaths.delete(file)
        return
      }
      await fs.promises.rm(file, { force: true })
      this.tempPaths.delete(file)
    } catch (error) {
      this.log.debug(`盗图：临时文件清理失败（下次 dispose 再试）：${error?.message ?? error}`)
    }
  }

  /** dispose：清掉所有还挂着的临时文件/目录（可重复调用）。 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const dir of this.tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // 清不掉也不抛（插件卸载不能被临时文件拖住）
      }
    }
    for (const file of this.tempPaths) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // 同上
      }
    }
    this.tempDirs.clear()
    this.tempPaths.clear()
  }
}

/** 本地数字兜底（store.js 里的同名工具没导出，这里只要这一处）。 */
function numberOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
