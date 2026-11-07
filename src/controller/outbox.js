/**
 * outbox.js · L2 Controller 出站
 *
 * 三件事：
 *  ① markdownToPlain —— QQ 不渲染 Markdown，`**加粗**` 会原样显示成一堆星号。
 *     这份实现是从 v2 `lib/outbox.js` 原样搬过来的（踩过坑：图片语法必须先于链接、
 *     表格要先转行再删分隔线），不要自己重写。
 *  ② Outbox —— 降级 → 交 rhythm 分片 → 调 api 逐条发；失败重试一次，
 *     再失败降级成纯文本，再失败只记日志**不抛**（一条发不出去不能拖垮整轮）。
 *  ③ push —— 主动发消息（提醒、主动关心），和被动回复走同一条节奏。
 *
 * 依赖注入：
 *   - `api` 由 `src/napcat/api.js` 提供（DESIGN §4：sendPrivate(userId, segments) /
 *     sendGroup(groupId, segments)）。不 import gateway，保持可测。
 *   - 兼容传 `gateway`（DESIGN §4 老签名）：鸭子类型检测到只有 `call()` 时，
 *     退回 OneBot 原始 action（send_private_msg / send_group_msg）。
 *   - 节奏由 rhythm.createRhythmSender 负责；测试里 store 给 minGapMs=0 即可零等待。
 */

import { createRhythmSender } from './rhythm.js'

/**
 * Markdown → QQ 纯文本（保守：只去掉最常见的记号，不引入解析器）。
 * 直接沿用 v2 实现，规则顺序有讲究，改之前先看 tests/controller-io.mjs 的回归用例。
 *
 * @param {unknown} input
 * @returns {string}
 */
export function markdownToPlain(input) {
  let text = String(input ?? '')
  // 代码块围栏
  text = text.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '')
  // 行内代码
  text = text.replace(/`([^`]+)`/g, '$1')
  // 标题
  text = text.replace(/^#{1,6}\s+/gm, '')
  // 粗体 / 斜体 / 删除线
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
  text = text.replace(/~~([^~]+)~~/g, '$1')
  // 图片（必须在链接之前：否则 `![x](y)` 会先被链接规则吃掉方括号，留下一个孤零零的 `!`）
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '[图片]')
  // 链接：保留「文字 (地址)」
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
  // 分隔线
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
  // 引用
  text = text.replace(/^\s*>\s?/gm, '')
  // 列表符号
  text = text.replace(/^\s*[-*+]\s+/gm, '· ')
  text = text.replace(/^\s*(\d+)\.\s+/gm, '$1. ')
  // 表格竖线
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join('  '))
  text = text.replace(/^\s*[:\-\s|]{3,}\s*$/gm, '')
  // 多余空行
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/** 群里引用回复要带上原消息 id；私聊不加 reply 段（部分客户端会显示得很怪）。 */
function buildSegments(message, text, { quote = false } = {}) {
  const segments = [{ type: 'text', data: { text } }]
  if (quote && message?.scene === 'group' && message?.id) {
    segments.unshift({ type: 'reply', data: { id: String(message.id) } })
  }
  return segments
}

/**
 * 算出发送目标。私聊优先用 peerId（会话对端），群聊优先 groupId。
 * 为什么不用 userId：主动推送（push）时只有 peerId，没有「发言人」。
 *
 * @param {object} message
 * @returns {{scene: 'group'|'private', peerId: string}}
 */
function targetOf(message) {
  if (message?.scene === 'group') {
    const peerId = String(message.groupId || message.peerId || '')
    if (!peerId) throw new Error('群聊消息缺少 groupId / peerId，不知道发到哪个群')
    return { scene: 'group', peerId }
  }
  const peerId = String(message?.peerId || message?.userId || '')
  if (!peerId) throw new Error('私聊消息缺少 peerId / userId，不知道发给谁')
  return { scene: 'private', peerId }
}

/**
 * 归一化注入的发送通道：优先 api（sendPrivate/sendGroup），兼容 gateway（call）。
 * 返回 null 表示没有可用通道 —— 发送会失败但不会抛。
 */
function resolveChannel(api, gateway) {
  const raw = api ?? gateway
  if (!raw || typeof raw !== 'object') return null
  const sendGroup = typeof raw.sendGroup === 'function' ? raw.sendGroup.bind(raw) : null
  const sendPrivate = typeof raw.sendPrivate === 'function' ? raw.sendPrivate.bind(raw) : null
  if (sendGroup || sendPrivate) return { kind: 'api', sendGroup, sendPrivate }
  if (typeof raw.call === 'function') {
    return { kind: 'gateway', call: raw.call.bind(raw) }
  }
  return null
}

/** 日志归一化：没传 log 就静音，不能因为 log 缺失把发送搞崩。 */
function normalizeLog(log) {
  const noop = () => {}
  return {
    debug: typeof log?.debug === 'function' ? log.debug.bind(log) : noop,
    info: typeof log?.info === 'function' ? log.info.bind(log) : noop,
    warn: typeof log?.warn === 'function' ? log.warn.bind(log) : noop,
    error: typeof log?.error === 'function' ? log.error.bind(log) : noop,
  }
}

/**
 * 解析注入的 rhythm：
 *   - 已经是发送器实例（有 send）→ 直接用；
 *   - 是 rhythm 模块命名空间（有 createRhythmSender）→ 现场造一个（index.js/pipeline.js
 *     传的是整个模块，见 pipeline.js 的 `new Outbox({ ..., rhythm })`）；
 *   - 没传 / 不合法 → 用本文件的 createRhythmSender 造默认的。
 */
function resolveRhythmSender(candidate, dependencies) {
  if (candidate && typeof candidate.send === 'function') return candidate
  if (candidate && typeof candidate.createRhythmSender === 'function') {
    return candidate.createRhythmSender(dependencies)
  }
  return createRhythmSender(dependencies)
}

export class Outbox {
  /**
   * @param {object} options
   * @param {object} [options.api] src/napcat/api.js 的封装（sendPrivate/sendGroup）
   * @param {object} [options.gateway] 兼容旧签名（有 call() 时按 OneBot action 发）
   * @param {object} [options.store] 配置（读 rhythm 段）
   * @param {object} [options.log]
   * @param {object} [options.rhythm] 注入自定义节奏发送器（测试用）
   * @param {number} [options.retryDelayMs=600] 重试前等多久；测试传 0
   */
  constructor({ api, gateway, store, log, rhythm, retryDelayMs = 600 } = {}) {
    this.log = normalizeLog(log)
    this.channel = resolveChannel(api, gateway)
    this.store = store
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0)
    this.disposed = false
    const dependencies = { outbox: this, store, log: this.log }
    this.rhythm = resolveRhythmSender(rhythm, dependencies)
    if (!this.channel) this.log.warn('Outbox 初始化：没有可用的 api / gateway，所有发送都会失败')
  }

  /** Markdown 降级入口（节奏发送器也通过它处理原文，避免 rhythm 反向依赖 outbox）。 */
  plain(text) {
    return markdownToPlain(text)
  }

  /**
   * 发一段回复：降级 → 分片 → 逐条发 → 片间按 2~5 秒随机间隔。
   *
   * @param {object} message 归一化消息（QqMessage）
   * @param {string} text 模型终稿（Markdown 会降级）
   * @param {{quote?: boolean}} [options]
   * @returns {Promise<{sent: number, total: number, cancelled: boolean}>}
   */
  async send(message, text, options = {}) {
    if (this.disposed) {
      this.log.warn('Outbox 已 dispose，忽略这次发送')
      return { sent: 0, total: 0, cancelled: true }
    }
    return this.rhythm.send(message, text, options)
  }

  /**
   * 发单条（节奏发送器的底层出口）。
   *
   * 失败策略：
   *   ① 原样发（可能带引用段）
   *   ② 重试一次（同一内容）
   *   ③ 降级成纯文本（去掉引用段）再试
   *   ④ 仍失败 → 记 error，返回 false，不抛
   *
   * @param {object} message
   * @param {string} text
   * @param {{quote?: boolean}} [options]
   * @returns {Promise<boolean>} 是否发出去
   */
  async sendPiece(message, text, { quote = false } = {}) {
    const content = String(text ?? '')
    if (!content) return false

    let target
    try {
      target = targetOf(message)
    } catch (error) {
      this.log.error(`发送失败：${error?.message ?? error}`)
      return false
    }

    const richSegments = buildSegments(message, content, { quote })
    const plainSegments = [{ type: 'text', data: { text: content } }]

    // ① 原样发
    try {
      await this.deliver(target, richSegments)
      return true
    } catch (error) {
      this.log.warn(`发给 ${target.scene}:${target.peerId} 失败，重试一次：${error?.message ?? error}`)
    }

    // ② 重试一次（等一小会儿，NapCat/网络抖一下就过去了）
    await this.waitRetry()
    if (this.disposed) return false
    try {
      await this.deliver(target, richSegments)
      return true
    } catch (error) {
      this.log.warn(`重试仍失败，降级纯文本：${error?.message ?? error}`)
    }

    // ③ 降级：去掉引用段，只发纯文本（引用段是最容易让 OneBot 报错的）
    if (richSegments.length > plainSegments.length) {
      if (this.disposed) return false
      try {
        await this.deliver(target, plainSegments)
        return true
      } catch (error) {
        this.log.error(`纯文本兜底也失败，放弃这一片：${error?.message ?? error}`)
        return false
      }
    }

    // 本来就是纯文本，两连败就放弃（再试第三次没有意义）
    this.log.error('这一片重试后仍失败，放弃（不抛，继续后面的分片）')
    return false
  }

  /** 真正调用 api/gateway。@returns {Promise<unknown>} */
  async deliver(target, segments) {
    const channel = this.channel
    if (!channel) throw new Error('没有可用的发送通道（api/gateway 都没传）')
    if (channel.kind === 'api') {
      if (target.scene === 'group') {
        if (!channel.sendGroup) throw new Error('api 缺少 sendGroup()')
        return channel.sendGroup(target.peerId, segments)
      }
      if (!channel.sendPrivate) throw new Error('api 缺少 sendPrivate()')
      return channel.sendPrivate(target.peerId, segments)
    }
    // 兼容 gateway：OneBot 11 原生 action
    const action = target.scene === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = target.scene === 'group' ? { group_id: target.peerId } : { user_id: target.peerId }
    return channel.call(action, { ...params, message: segments })
  }

  async waitRetry() {
    if (this.retryDelayMs <= 0 || this.disposed) return
    await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
  }

  /**
   * 主动发消息（提醒、主动关心用）。不引用任何消息。
   *
   * @param {{scene?: string, peerId?: string, userId?: string}} target
   * @param {string} text
   * @returns {Promise<{sent: number, total: number, cancelled: boolean}>}
   */
  async push(target, text) {
    const scene = target?.scene === 'group' ? 'group' : 'private'
    const peerId = String(target?.peerId ?? target?.userId ?? '')
    const userId = String(target?.userId ?? '')
    const message =
      scene === 'group'
        ? { id: '', scene, peerId, groupId: peerId, userId }
        : { id: '', scene, peerId, userId }
    return this.send(message, text)
  }

  /** 打断正在发的这一轮（新消息抢占）。 */
  cancel(reason = '') {
    if (typeof this.rhythm?.cancel !== 'function') return false
    return this.rhythm.cancel(reason)
  }

  /** 清干净：取消在途发送 + 清掉节奏定时器。可重复调用。 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (typeof this.rhythm?.dispose === 'function') this.rhythm.dispose()
  }
}
