/**
 * meme/index.js · 表情包系统统一出口
 *
 * 三个文件各管一段，这里做两件事：
 *   ① 统一导出（store / render / steal 的类、纯函数、默认配置）；
 *   ② `MemeSystem` 门面 —— 把 PLAN §2.3 的「三级闸门」按**请求级上下文**串起来，
 *      让 pipeline 只用两三行就能接上：
 *
 *        const meme = new MemeSystem({ dataDir, config, log, vision, inbound })
 *        // 出站：渲染并发送（内部处理 模式闸→消息概率闸→类别冷却→抽图→混排）
 *        await meme.sendReply({ outbox, message, text: reply, quote })
 *        // 入站：盗图（内部处理 概率闸→模式闸→尺寸格式→视觉→去重入库）
 *        await meme.maybeSteal(message)
 *
 * 为什么闸门放在门面而不是 buildSegments：
 *   meme_manager 原来把闸门挂在实例上，多条消息并发时会互相串状态（它自己的 bug）。
 *   这里每次 renderReply 都从头算、冷却表按类别记时间戳，不存任何「正在发哪条」的中间态，
 *   所以并发的两条回复不会互相把概率/混排吃到对方头上。
 *
 * 配置读取：`config` 传整份配置（对象或 getter 都行），内部现读现算 —— 面板改概率立即生效。
 */
import { isOn } from '../../modes.js'
import {
  MemeStore,
  DEFAULT_MEME_CONFIG,
  MEME_CATEGORIES,
  IMAGE_EXTS,
  configRootOf,
  normalizeLog,
  readMemeConfig,
} from './store.js'
import {
  buildSegments,
  extractTags,
  splitThinking,
  stripResidualMarkers,
  splitSegmentPlan,
} from './render.js'
import { StealGate, peerKeyOf } from './steal.js'

export {
  // store
  MemeStore,
  DEFAULT_MEME_CONFIG,
  MEME_CATEGORIES,
  IMAGE_EXTS,
  readMemeConfig,
  configRootOf,
  // render
  buildSegments,
  extractTags,
  splitThinking,
  stripResidualMarkers,
  splitSegmentPlan,
  // steal
  StealGate,
  peerKeyOf,
}

/** 从消息算发送目标（和 outbox 的 targetOf 同语义；只用于发图兜底）。 */
function targetOfMessage(message) {
  if (String(message?.scene ?? '') === 'group') {
    const peerId = String(message?.groupId || message?.peerId || '')
    return peerId ? { scene: 'group', peerId } : null
  }
  const peerId = String(message?.peerId || message?.userId || '')
  return peerId ? { scene: 'private', peerId } : null
}

/**
 * 表情包系统门面。
 *
 * 生命周期：构造时不落盘、不联网；`ensureDirs` 在后台建骨架目录（失败不影响发送）；
 * `dispose()` 清掉盗图临时文件、标记失效（可重复调用）。
 */
export class MemeSystem {
  /**
   * @param {object} options
   * @param {string} options.dataDir 数据根目录（表情库在 `<dataDir>/memes`）
   * @param {object|Function} options.config 整份配置（对象 / getter）
   * @param {object} [options.log]
   * @param {() => number} [options.now] 时间注入（冷却）
   * @param {() => number} [options.rng] 随机注入（掷骰/抽图）
   * @param {(filePath: string) => Promise<object>} [options.vision] 盗图用的视觉判断（注入）
   * @param {object} [options.inbound] inbound 实例（盗图下载优先复用它）
   * @param {typeof fetch} [options.fetchImpl] 测试注入
   * @param {string} [options.tmpDir] 盗图临时目录根
   */
  constructor({
    dataDir,
    config,
    log,
    now = Date.now,
    rng = Math.random,
    vision = null,
    inbound = null,
    fetchImpl,
    tmpDir,
  } = {}) {
    this.config = config
    this.now = typeof now === 'function' ? now : Date.now
    this.rng = typeof rng === 'function' ? rng : Math.random
    this.log = normalizeLog(log)
    /** 类别冷却表：category → 上次抽中的时间戳（毫秒） */
    this.cooldowns = new Map()

    this.store = new MemeStore({ dataDir, config, log: this.log, now: this.now })
    this.stealGate = new StealGate({
      store: this.store,
      config,
      log: this.log,
      vision,
      inbound,
      rng: this.rng,
      now: this.now,
      fetchImpl,
      tmpDir,
    })
  }

  /**
   * 建好骨架目录 + 首次运行把类别描述写进 `_catalog.json`。
   *
   * 不放在构造函数里（构造不能碰盘，否则单测/热重载会被磁盘拖住）——
   * 装配层启动时 await 一次即可；不调也能跑（ingest 会自己建目录）。
   */
  async ensureDirs() {
    return this.store.ensureDirs()
  }

  /** 当前 meme 配置（缺键已补默认值）。 */
  memeConfig() {
    return readMemeConfig(this.config)
  }

  /** 类别列表（listCategories 的转发，pipeline/工具直接用）。 */
  listCategories() {
    return this.store.listCategories()
  }

  /** 掷骰（rng 异常按 0 处理：宁可少发图，不乱发）。 */
  roll() {
    const value = Number(this.rng())
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  }

  /** 往冷却表里记一笔（同一类别 cooldownMs 内不再抽）。 */
  markCooldown(category, at = this.now()) {
    const key = String(category ?? '').trim().toLowerCase()
    if (!key) return
    this.cooldowns.set(key, Number(at) || 0)
  }

  /** 这个类别现在是否在冷却中。 */
  inCooldown(category, cooldownMs = this.memeConfig().cooldownMs, at = this.now()) {
    if (!(Number(cooldownMs) > 0)) return false
    const last = Number(this.cooldowns.get(String(category ?? '').trim().toLowerCase()) ?? 0)
    if (!last) return false
    return Number(at) - last < Number(cooldownMs)
  }

  /**
   * 渲染一条要发的回复：闸门 → 抽标签 → 模式 → 概率 → 冷却 → 抽图 → 排段。
   *
   * 返回的 `text` 永远是**已清洗**的正文（不含任何 && 标记）：
   *   · `segments === null` → 不发图，调用方直接 `outbox.send(message, plan.text)`；
   *   · `segments` 非空 → 按段发（image 段交给发图通道，text 段交给 outbox.send）；
   *     带 `trailing: true` 的图表示「文字发完再单独发」。
   *
   * @param {string} text 模型终稿
   * @param {{peerKey?: string}} [options]
   * @returns {{text: string, segments: Array<object>|null, picked: string[], reason: string}}
   */
  renderReply(text, { peerKey = '' } = {}) {
    try {
      return this._renderReply(text, { peerKey })
    } catch (error) {
      // 图库目录权限、坏 catalog 之类的问题不能把整条回复搞丢：退回纯文本（而且清干净标记）
      this.log.warn(`表情包渲染失败（回落纯文本）：${error?.message ?? error}`)
      return { text: stripResidualMarkers(text), segments: null, picked: [], reason: 'error' }
    }
  }

  /** renderReply 的实际实现（外面那层只管兜错）。 */
  _renderReply(text, { peerKey = '' } = {}) {
    const cfg = this.memeConfig()
    const root = configRootOf(this.config)
    const validCategories = this.store.listCategories().map((item) => item.key)
    const extracted = extractTags(text, { maxTags: cfg.maxPerMessage, validCategories })
    const cleanText = stripResidualMarkers(extracted.cleaned)
    const plan = { text: cleanText, segments: null, picked: [], reason: '' }

    if (extracted.tags.length === 0) return plan

    // 模式闸：work 模式下「只记不发」（isOn 为 false；标记已经清掉了）
    if (!isOn('memeSend', String(peerKey ?? ''), root)) {
      plan.reason = 'mode'
      return plan
    }

    // 消息级概率闸：整条消息一把闸
    if (!(this.roll() < cfg.probability)) {
      plan.reason = 'probability'
      return plan
    }

    // 类别冷却 + 同类别去重（同一条消息里 `&&happy&&&&happy&&` 只发一张）
    const usable = []
    const usablePositions = []
    const seen = new Set()
    for (let index = 0; index < extracted.tags.length; index += 1) {
      const category = extracted.tags[index]
      if (seen.has(category)) continue
      seen.add(category)
      if (this.inCooldown(category, cfg.cooldownMs)) continue
      usable.push(category)
      usablePositions.push(extracted.positions[index] ?? 0)
    }
    if (usable.length === 0) {
      plan.reason = 'cooldown'
      return plan
    }

    // 用一层薄代理跟踪「这一轮真的抽到了哪些类别」，抽完记冷却
    const picked = []
    const trackingStore = {
      pick: (category, options) => {
        const result = this.store.pick(category, options)
        if (result && result.path) picked.push(category)
        return result
      },
    }
    const segments = buildSegments(extracted.cleaned, usable, trackingStore, {
      inlineProbability: cfg.inlineProbability,
      rng: this.rng,
      positions: usablePositions,
    })
    if (segments.length === 0) {
      plan.reason = 'empty'
      return plan
    }

    const at = this.now()
    for (const category of picked) this.markCooldown(category, at)
    plan.segments = segments
    plan.picked = picked
    return plan
  }

  /**
   * 给 Mind 的人格/上下文用的「表情包使用说明」片段。
   *
   * 为什么由这里生成：类别表和 hint 是图库的真相，散在 preset 里手写就会和图库不同步
   * （图库删了类别，她还在标记，永远抽不到图）。preset 那边只要把这段拼进
   * `systemPrompt.context`（动态段，不破前缀缓存）即可。
   *
   * @returns {string}
   */
  renderGuide() {
    const cfg = this.memeConfig()
    const categories = this.listCategories()
    const lines = categories.map((item) => {
      const empty = item.count > 0 ? '' : '（当前空库，抽不到图）'
      return `- ${item.key}（${item.name}）：${item.hint}${empty}`
    })
    return [
      `你可以在回复里用 \`&&类别&&\` 夹一张表情包，例如「主人早安呀 &&happy&& 今天也要开心哦」。`,
      `每个标记对应一张图，一条回复最多 ${cfg.maxPerMessage} 个标记；只在句子里插，不要连发。`,
      '类别要按「什么时候用」选（不是按图长什么样），只能从下面这些里选：',
      ...lines,
    ].join('\n')
  }

  /** 盗图（转发 StealGate；任何异常都不外抛）。 */
  async maybeSteal(message) {
    try {
      return await this.stealGate.maybeSteal(message)
    } catch (error) {
      this.log.warn(`盗图异常（不影响聊天）：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 一条回复的完整出站：渲染 + 按段发送。
   *
   * 为什么把发送也收进来：混排的输出是「文字段 + 图片段」交错，pipeline 自己拼
   * 很容易把图漏掉或把 && 漏出去；这里一次调用处理完，emmm 只回一行结果。
   *
   * 发送策略：
   *   · text 段 → `outbox.send(message, text, { quote })`（走节奏分片，片间 2~5 秒）；
   *   · image 段 → 优先 `outbox.sendImage`，没有就用 `outbox.deliver` 直接发 image 段；
   *   · 任何一段失败只记日志，不影响其它段（一张图发不出去不能把后半句话吞掉）。
   *
   * @param {object} options
   * @param {object} options.outbox Outbox 实例
   * @param {object} options.message QqMessage
   * @param {string} options.text 模型终稿
   * @param {boolean} [options.quote] 是否引用原消息（只引用第一条文字段）
   * @returns {Promise<{sent: number, images: number, textOnly: boolean, plan: object}>}
   */
  async sendReply({ outbox, message, text, quote = false } = {}) {
    const plan = this.renderReply(text, { peerKey: peerKeyOf(message) })
    if (!plan.segments || plan.segments.length === 0) {
      if (!outbox || typeof outbox.send !== 'function') {
        return { sent: 0, images: 0, textOnly: true, plan, skipped: 'no-outbox' }
      }
      const outcome = await outbox.send(message, plan.text, { quote: Boolean(quote) })
      return { sent: Number(outcome?.sent) || 0, images: 0, textOnly: true, plan }
    }

    let sent = 0
    let images = 0
    let quoteNext = Boolean(quote)
    for (const segment of plan.segments) {
      if (segment?.type === 'image') {
        if (await this.sendImage(outbox, message, segment?.data?.path)) images += 1
        continue
      }
      const piece = String(segment?.data?.text ?? '')
      if (!piece) continue
      const outcome = await outbox.send(message, piece, { quote: quoteNext })
      quoteNext = false // 引用只跟第一条
      sent += Number(outcome?.sent) || 0
    }
    return { sent, images, textOnly: false, plan }
  }

  /**
   * 发一张图（image 段）。
   *
   * 为什么优先找 `outbox.sendImage`：发图要的是 action 层能力，属于 outbox 的活；
   * 它没有这个方法时退到 `outbox.deliver`（Outbox 的公有方法，自己算目标）。
   * 两条路都不通就记日志跳过 —— 决定不发图，绝不把本机路径当文字发给用户。
   *
   * @param {object} outbox
   * @param {object} message
   * @param {string} imagePath 本机绝对路径
   * @returns {Promise<boolean>}
   */
  async sendImage(outbox, message, imagePath) {
    const filePath = String(imagePath ?? '')
    if (!filePath) return false
    try {
      if (typeof outbox?.sendImage === 'function') {
        return Boolean(await outbox.sendImage(message, filePath))
      }
      if (typeof outbox?.deliver === 'function') {
        const target = targetOfMessage(message)
        if (!target) return false
        await outbox.deliver(target, [{ type: 'image', data: { path: filePath } }])
        return true
      }
      this.log.warn('发图：outbox 既没有 sendImage 也没有 deliver，跳过这张')
      return false
    } catch (error) {
      this.log.warn(`发图失败（不影响文字）：${error?.message ?? error}`)
      return false
    }
  }

  /** 面板/排错：图库 + 盗图计数 + 冷却表。 */
  stats() {
    return {
      ...this.store.stats(),
      steal: this.stealGate.stats(),
      cooldowns: Object.fromEntries(this.cooldowns),
    }
  }

  /** 清干净（可重复调用）。 */
  dispose() {
    this.stealGate.dispose()
    this.store.dispose()
    this.cooldowns.clear()
  }
}
