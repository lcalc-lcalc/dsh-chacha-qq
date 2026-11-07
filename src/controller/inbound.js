/**
 * inbound.js · L2 Controller 入站媒体落盘
 *
 * 把 QQ 里的图片 / 文件 / 语音 / 视频下载到本机：
 *   <dataDir>/incoming/<YYYY-MM-DD>/<messageId>-<index><ext>
 *
 * 为什么一定要落盘再交给 Mind：
 *  - DSH 的文件工具只认本机路径，模型拿到 URL 也没法直接读；
 *  - 视觉模型要的是本地文件；
 *  - 落盘之后主人自己也能打开看，出问题好复现（v2 的教训）。
 *
 * 硬约束：
 *  - 单文件 `inbound.maxBytes`（默认 8MB），单次 `inbound.maxImages`（默认 5 张）；
 *  - 下载失败**不抛**：返回 `{ failed: true, reason }`，模型那边看到「没取到」即可，
 *    一条坏链接不能把整轮处理拖垮；
 *  - 只接受 http/https：file:// 之类的协议一律拒绝（不然一条消息就能让机器人读本地文件）；
 *  - 零依赖，用 Node 全局 fetch（测试可注入 fetchImpl，不碰网络）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 猜不到扩展名时的兜底。 */
const EXT_BY_KIND = {
  image: '.jpg',
  record: '.amr',
  video: '.mp4',
  file: '',
}

const KIND_LABELS = {
  image: '图片',
  record: '语音',
  video: '视频',
  file: '文件',
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_IMAGES = 5

/**
 * NapCat 有些版本上报媒体只给 file（不给 url），得回头问一次。
 * 这里用注入的 gateway.call 兜底，不 import 网关本体（保持可测、不越层）。
 */
const URL_ACTION_BY_KIND = {
  image: 'get_image',
  record: 'get_record',
  video: 'get_video',
  file: 'get_file',
}

/** 读配置：兼容 store.get() / store() / 直接给对象三种形态。 */
function readConfig(store) {
  if (!store) return {}
  try {
    if (typeof store.get === 'function') {
      const value = store.get()
      return value && typeof value === 'object' ? value : {}
    }
    if (typeof store === 'function') {
      const value = store()
      return value && typeof value === 'object' ? value : {}
    }
    return typeof store === 'object' ? store : {}
  } catch {
    return {}
  }
}

function numberOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeLog(log) {
  const noop = () => {}
  return {
    debug: typeof log?.debug === 'function' ? log.debug.bind(log) : noop,
    warn: typeof log?.warn === 'function' ? log.warn.bind(log) : noop,
    error: typeof log?.error === 'function' ? log.error.bind(log) : noop,
  }
}

/** 日期目录名（本地时区）。now() 可注入，测试固定日期。 */
function dayStamp(nowMs) {
  const date = new Date(nowMs)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 从 url / 文件名猜扩展名，只保留「字母数字」的 2~5 位后缀，防止奇怪文件名。 */
function guessExt(kind, url, name) {
  const candidate = String(name || url || '')
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(candidate)
  if (match) return `.${match[1].toLowerCase()}`
  return EXT_BY_KIND[kind] ?? ''
}

/** message id 只保留安全字符，防目录穿越（虽然我们只用它做文件名前缀）。 */
function safeId(messageId, fallback) {
  const cleaned = String(messageId ?? '').replace(/[^0-9A-Za-z_-]/g, '')
  return cleaned || String(fallback)
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url)
}

export class Inbound {
  /**
   * @param {object} options
   * @param {object} [options.store] 配置（读 inbound 段）
   * @param {object} [options.log]
   * @param {string} [options.dataDir] 数据根目录；默认 <cwd>/data
   * @param {object} [options.gateway] 可选：拿不到 url 时用 call() 换一次下载地址
   * @param {typeof fetch} [options.fetchImpl] 测试注入
   * @param {() => number} [options.now]
   * @param {number} [options.timeoutMs=20000] 单个下载超时
   */
  constructor({ store, log, dataDir, gateway, fetchImpl, now = Date.now, timeoutMs = 20000 } = {}) {
    this.store = store
    this.log = normalizeLog(log)
    this.dataDir = String(dataDir ?? path.join(process.cwd(), 'data'))
    this.root = path.join(this.dataDir, 'incoming')
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
    this.gateway = gateway && typeof gateway.call === 'function' ? gateway : null
    this.now = typeof now === 'function' ? now : Date.now
    this.timeoutMs = Math.max(1, numberOr(timeoutMs, 20000))
    this.disposed = false
  }

  /** 当前配置（每次读，配置热更新后立刻生效）。 */
  limits() {
    const inbound = readConfig(this.store).inbound ?? {}
    return {
      maxBytes: Math.max(0, Math.floor(numberOr(inbound.maxBytes, DEFAULT_MAX_BYTES))),
      maxImages: Math.max(0, Math.floor(numberOr(inbound.maxImages, DEFAULT_MAX_IMAGES))),
    }
  }

  /**
   * 把一条消息里的媒体全部落地（永不抛）。
   *
   * @param {object} message 归一化消息（QqMessage）
   * @returns {Promise<Array<{kind: string, path: string, bytes: number, failed: boolean, reason?: string}>>}
   */
  async collect(message) {
    const media = Array.isArray(message?.media) ? message.media : []
    if (media.length === 0) return []

    const { maxBytes, maxImages } = this.limits()
    let dir
    try {
      dir = path.join(this.root, dayStamp(numberOr(this.now(), Date.now())))
      await fs.promises.mkdir(dir, { recursive: true })
    } catch (error) {
      this.log.error(`媒体落盘目录创建失败：${error?.message ?? error}`)
      return media.map((item) => ({
        kind: String(item?.kind ?? 'file'),
        url: String(item?.url ?? ''),
        path: '',
        bytes: 0,
        failed: true,
        reason: `落盘目录不可用：${error?.message ?? error}`,
      }))
    }

    const results = []
    let imageCount = 0
    for (const [index, item] of media.entries()) {
      const kind = String(item?.kind ?? 'file')
      if (kind === 'image') {
        if (imageCount >= maxImages) {
          results.push({
            kind,
            url: String(item?.url ?? ''),
            path: '',
            bytes: 0,
            failed: true,
            reason: `超过单条 ${maxImages} 张图片上限`,
          })
          continue
        }
        imageCount += 1
      }
      results.push(await this.fetchOne({ media: item, message, dir, index, maxBytes }))
    }
    return results
  }

  /**
   * 下载单个媒体（永不抛）。
   *
   * @param {object} options
   * @param {{kind?: string, url?: string, name?: string}} options.media
   * @param {object} options.message
   * @param {string} options.dir
   * @param {number} options.index
   * @param {number} options.maxBytes
   * @returns {Promise<{kind: string, path: string, bytes: number, failed: boolean, reason?: string}>}
   */
  async fetchOne({ media, message, dir, index, maxBytes }) {
    const kind = String(media?.kind ?? 'file')
    let url = String(media?.url ?? '')
    // NapCat 少数版本只给 file 不给 url：回头问一次协议端
    if (!url) url = await this.resolveUrl(media, kind)
    if (!url) {
      return { kind, url: '', path: '', bytes: 0, failed: true, reason: '拿不到下载地址' }
    }
    if (!isHttpUrl(url)) {
      return { kind, url, path: '', bytes: 0, failed: true, reason: '不支持的下载协议（只接受 http/https）' }
    }

    const ext = guessExt(kind, url, media?.name)
    const fileName = `${safeId(message?.id, numberOr(this.now(), Date.now()))}-${index}${ext}`
    const dest = path.join(dir, fileName)

    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) })
      if (!response || !response.ok) {
        throw new Error(`HTTP ${response?.status ?? '?'}`)
      }
      // 有 Content-Length 就提前放弃，别把 8MB 的流量先下完再丢
      const declaredRaw = response.headers?.get?.('content-length')
      const declared = declaredRaw === null || declaredRaw === undefined ? 0 : Number(declaredRaw)
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`文件过大（${Math.round(declared / 1024)}KB > ${Math.round(maxBytes / 1024)}KB）`)
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength > maxBytes) {
        throw new Error(`文件过大（${Math.round(buffer.byteLength / 1024)}KB > ${Math.round(maxBytes / 1024)}KB）`)
      }
      await fs.promises.writeFile(dest, buffer)
      this.log.debug(`媒体已落地：${dest}（${buffer.byteLength} 字节）`)
      return { kind, url, path: dest, bytes: buffer.byteLength, failed: false }
    } catch (error) {
      this.log.warn(`媒体下载失败（${kind}）：${error?.message ?? error}`)
      return { kind, url, path: '', bytes: 0, failed: true, reason: String(error?.message ?? error) }
    }
  }

  /**
   * 拿不到 url 时问一次协议端（get_image / get_record / get_video / get_file）。
   * 这只是兜底：正常 NapCat 的 image 段自带 url。失败返回 ''，不抛。
   */
  async resolveUrl(media, kind) {
    if (!this.gateway) return ''
    const fileId = String(media?.fileId ?? media?.file_id ?? media?.file ?? '')
    if (!fileId) return ''
    const action = URL_ACTION_BY_KIND[kind]
    if (!action) return ''
    try {
      const info = await this.gateway.call(action, { file: fileId })
      const resolved = String(info?.url ?? info?.data?.url ?? info?.file ?? '')
      if (resolved) this.log.debug(`媒体地址已换到：${action} → ${resolved.slice(0, 120)}`)
      return resolved
    } catch (error) {
      this.log.warn(`${action} 换下载地址失败：${error?.message ?? error}`)
      return ''
    }
  }

  /**
   * 生成一段给模型看的描述，告诉它文件在哪 / 哪个没取到。
   *
   * @param {Array<{kind: string, path: string, failed: boolean, reason?: string}>} results
   * @returns {string}
   */
  static describe(results) {
    if (!Array.isArray(results) || results.length === 0) return ''
    const lines = []
    for (const item of results) {
      const label = KIND_LABELS[item?.kind] ?? '文件'
      if (item?.failed) {
        lines.push(`- ${label}：没取到（${item?.reason ?? '未知原因'}）`)
      } else {
        lines.push(`- ${label}：已存到 ${item.path}（可以用 read 工具打开看）`)
      }
    }
    return lines.join('\n')
  }

  /** 本类没有定时器/连接，dispose 只为生命周期接口统一（可重复调用）。 */
  dispose() {
    this.disposed = true
  }
}
