/**
 * 观望机制（主人的硬要求，DESIGN §6）。
 *
 * 需求原文：
 *   > 消息进入 DSH 后进入「观望」状态（持续时间 20 秒~1 分钟）。
 *   > 例外：① 被 @ ② 主人的私聊 ③ 他人的私聊在「一坨」聊天中已经有过一次观望。
 *   > 被 @ 后延迟 10 秒回，主人私聊秒回，他人私聊延迟 5 秒。
 *
 * 为什么要观望：QQ 里人是一串一串发消息的（「在吗」+「问你个事」+「算了没事」）。
 * 收到第一条就冲上去回，等于把一句完整的话拆成三次回答，又蠢又刷屏。
 * 攒成一个批次再交给 Mind，它看到的是一段完整上下文，回得也像人。
 *
 * 实现表（DESIGN §6 + lead 确认的补充）：
 *   | 主人私聊               | 0          |
 *   | 主人群聊 @ 我          | 0          | 主人优先，不受观望约束
 *   | 主人群聊没 @           | ownerGroupMs=5s | 主人在群里跟别人聊天时别每句都秒回（又吵又烧钱）
 *   | 群聊被 @（非主人）     | atMs=10s   |
 *   | 私聊（非主人）首次     | random(20~60s) |
 *   | 私聊（非主人）同一坨内 | 5s         |
 *   | 群聊没 @（observe）    | random(20~60s)，窗口结束一次性投喂 |
 *
 * 「同一坨」判定：同一 peerId 在 observe.sameThreadMs（默认 60s）内已经跑完过一次观望
 * → 认为还在同一段连续对话里，不用再等一轮完整观望。
 * 说明：实现表里「同一坨」只给了**私聊**这一档，所以群聊 observe 仍然走 20~60s
 * （群聊里话是别人说的，缩短窗口没意义）。
 *
 * 定时器铁律：
 *   - 自己 setTimeout 精确调度，**不用 setInterval 轮询**（轮询会让延迟不准、还浪费 CPU）；
 *   - 定时器一律 unref()，否则插件停不掉、进程退不出去；
 *   - 同一批只启一个定时器，批次后续消息只累积、**不重置**（重置会越聊越不回）；
 *   - dispose() 必须能把所有 peer 的定时器清干净。
 */
import { ACTION, PRIORITY, ROLE } from './route.js'

/** 观望相关默认值，字段名与 config.js / DESIGN §5 一致。 */
export const DEFAULT_OBSERVE = {
  enabled: true,
  // ⚠️ 这几个数和 config.js 的 DEFAULT_CONFIG.observe **必须一致**。
  // 两处不一致时，测试（传空 config）会走这里的值、线上走 config.json 的值，
  // 表现是「本地测试绿、真机行为不对」—— 这种偏差最难查。
  defaultMinMs: 8000,
  defaultMaxMs: 25000,
  atMs: 4000,
  guestPrivateMs: 3000,
  ownerPrivateMs: 0,
  /**
   * 主人在群里没 @ 她时等多久。
   * 为什么不是 0：主人在群里跟别人聊天的每句话都秒回，在真群里会非常吵，
   * 而且每句都是一次模型调用（烧钱）。真想叫她有 @ 这条路。
   */
  ownerGroupMs: 3000,
  sameThreadMs: 90000,
  maxBatch: 40,
  /**
   * 按对话覆盖随机观望区间：{ "group-123456": { "minMs": 5000, "maxMs": 15000 } }
   * 只覆盖 min/max 两档，其余档位（@ / 主人 / 同坨）不受影响。
   */
  peers: {},
}

function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 把 config.observe 归一成一份字段齐全、数值合法的表。 */
export function resolveObserveConfig(config) {
  const source = config?.observe && typeof config.observe === 'object' ? config.observe : {}
  const out = {
    enabled: source.enabled !== false,
    defaultMinMs: Math.max(0, numOr(source.defaultMinMs, DEFAULT_OBSERVE.defaultMinMs)),
    defaultMaxMs: Math.max(0, numOr(source.defaultMaxMs, DEFAULT_OBSERVE.defaultMaxMs)),
    atMs: Math.max(0, numOr(source.atMs, DEFAULT_OBSERVE.atMs)),
    guestPrivateMs: Math.max(0, numOr(source.guestPrivateMs, DEFAULT_OBSERVE.guestPrivateMs)),
    ownerPrivateMs: Math.max(0, numOr(source.ownerPrivateMs, DEFAULT_OBSERVE.ownerPrivateMs)),
    ownerGroupMs: Math.max(0, numOr(source.ownerGroupMs, DEFAULT_OBSERVE.ownerGroupMs)),
    sameThreadMs: Math.max(0, numOr(source.sameThreadMs, DEFAULT_OBSERVE.sameThreadMs)),
    maxBatch: Math.max(0, numOr(source.maxBatch, DEFAULT_OBSERVE.maxBatch)),
  }
  // 配置写反了也不能让 random 区间变成负数
  if (out.defaultMaxMs < out.defaultMinMs) {
    const min = out.defaultMaxMs
    out.defaultMaxMs = out.defaultMinMs
    out.defaultMinMs = min
  }
  return out
}

/**
 * [min, max] 里按 rng 取一个整数毫秒。
 * rng 可注入（测试不许用真随机），返回值会被夹到 [0, 1) 防止手写 rng 越界。
 */
function randomBetween(minMs, maxMs, rng) {
  const lo = Math.max(0, Math.round(minMs))
  const hi = Math.max(0, Math.round(maxMs))
  if (hi <= lo) return lo
  const raw = Number(rng())
  const unit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.9999999999) : 0
  return lo + Math.floor(unit * (hi - lo + 1))
}

/**
 * 这个对话有没有单独配观望时长（面板里的「当前对话覆盖」）。
 * 键的形状和 pipeline 的会话 key 同构：`private-<QQ>` / `group-<群号>`。
 */
export function peerObserveOverride(message, observe) {
  const peers = observe?.peers
  if (!peers || typeof peers !== 'object') return null
  const scene = String(message?.scene ?? '')
  const id = scene === 'group'
    ? String(message?.groupId || message?.peerId || '')
    : String(message?.peerId || '')
  if (!id) return null
  const key = scene === 'group' ? `group-${id}` : `private-${id}`
  const hit = peers[key]
  return hit && typeof hit === 'object' ? hit : null
}

/**
 * 这条消息该等多久再处理（0 = 立刻）。
 *
 * 纯函数：只查表 + 用注入的 rng 抽随机数，不碰定时器、不碰状态。
 *
 * @param {object} message QqMessage
 * @param {object} decision decideRoute 的结果
 * @param {object} config 完整配置
 * @param {object} [ctx]
 *   - rng: () => number   随机源，默认 Math.random
 *   - sameThread: boolean 是否在同一坨里（ObservationWindow 会替你算）
 *   - isSameThread: (message) => boolean 需要按消息算时的回调（优先于 sameThread）
 * @returns {number} 毫秒
 */
export function waitMsFor(message, decision, config = {}, ctx = {}) {
  const base = resolveObserveConfig(config)
  // 按对话覆盖：只覆盖「随机观望区间」那两档，其余档位（@ / 主人 / 同坨）仍走全局值。
  // 这样面板上调「这个群回慢一点」不会把「被 @ 必须 10 秒」也一起改掉。
  // ⚠️ 从**原始配置**取 peers —— resolveObserveConfig 只挑它认识的键，会把 peers 丢掉。
  const rawPeers = (config && typeof config === 'object' && config.observe && typeof config.observe === 'object')
    ? config.observe.peers
    : base.peers
  const override = peerObserveOverride(message, { peers: rawPeers ?? base.peers })
  const observe = override
    ? {
      ...base,
      ...(Number.isFinite(Number(override.minMs)) ? { defaultMinMs: Number(override.minMs) } : {}),
      ...(Number.isFinite(Number(override.maxMs)) ? { defaultMaxMs: Number(override.maxMs) } : {}),
    }
    : base

  const rng = typeof ctx?.rng === 'function' ? ctx.rng : Math.random
  const info = decision && typeof decision === 'object' ? decision : {}

  // 丢弃的消息不需要等
  if (info.action === ACTION.IGNORE) return 0
  // 观望总开关关了 = 全部立刻处理（主人临时要「秒回模式」时用）
  if (observe.enabled === false) return 0

  // 主人：私聊秒回；**群里没 @ 不算秒回**（ownerGroupMs，默认 5 秒）。
  // 依据：主人的原话只承诺「主人私聊秒回」，群聊没给这个口子；
  // 而且主人在群里跟别人聊天时句句秒回会非常吵、每句都烧一次模型调用。想叫她用 @。
  if (info.role === ROLE.OWNER) {
    if (message?.scene === 'group') {
      // 群里被 @：DESIGN §6「主人群聊 @ 我 → 0 秒」，主人优先，不受观望约束
      if (message?.mentionsMe === true || info.priority === PRIORITY.AT) return 0
      return Math.round(observe.ownerGroupMs)
    }
    return Math.round(observe.ownerPrivateMs)
  }

  const sameThread = typeof ctx?.isSameThread === 'function'
    ? Boolean(ctx.isSameThread(message))
    : Boolean(ctx?.sameThread)

  const priority = info.priority ?? inferPriority(message)
  switch (priority) {
    case PRIORITY.INSTANT:
      return 0
    case PRIORITY.AT:
      return Math.round(observe.atMs)
    case PRIORITY.PRIVATE:
      return sameThread
        ? Math.round(observe.guestPrivateMs)
        : randomBetween(observe.defaultMinMs, observe.defaultMaxMs, rng)
    case PRIORITY.OBSERVE:
    default:
      // 群聊没 @：完整观望，窗口结束一次性投喂
      return randomBetween(observe.defaultMinMs, observe.defaultMaxMs, rng)
  }
}

/** decision 缺 priority 时按消息本身猜一档（防御：调用方手搓 decision 也不会算出负数）。 */
function inferPriority(message) {
  if (message?.scene === 'group') return message?.mentionsMe ? PRIORITY.AT : PRIORITY.OBSERVE
  return PRIORITY.PRIVATE
}

/**
 * 批次键：同 peerId 连续消息累积成一批。
 * 群聊按群号、私聊按对方 QQ —— 因为「一坨」是会话级的概念，不是人级。
 */
export function batchKeyOf(message) {
  const scene = message?.scene === 'group' ? 'group' : 'private'
  const peer = scene === 'group'
    ? String(message?.groupId ?? message?.peerId ?? '')
    : String(message?.peerId ?? message?.userId ?? '')
  return `${scene}:${peer}`
}

/**
 * 观望窗口：同一 peer 的消息在窗口内累积，窗口结束一次性交给 onSettle。
 *
 * 契约（由 lead 装配层确认）：
 *   new ObservationWindow({ log, onSettle(batchKey, messages), now, rng })
 *   - 定时器归窗口管，结算回调归调用方：调用方不用自己维护 peer→timer 的 Map。
 *   - push(message, decision, config) 返回 { batchKey, settleAfterMs, ... }。
 *   - 同一批只启一次定时器；后续消息只累积，不重置（否则越聊越不回）。
 *   - 批次里出现「被 @」→ 清定时器、**立刻**结算整批；
 *     条数超过 observe.maxBatch → 同样提前结算。
 *   - dispose() 清掉所有定时器。
 *
 * 补充说明：若调用方没给 onSettle（只发生在单测/排错），结算的批次会暂存在
 * 有上限的待取队列里，用 take(batchKey) 取；生产路径必须走 onSettle。
 */
export class ObservationWindow {
  /**
   * @param {object} options
   * @param {object} [options.log]        日志器（有 debug/warn 就行）
   * @param {(batchKey:string, messages:object[]) => void} [options.onSettle] 到期回调
   * @param {() => number} [options.now]   时钟，默认 Date.now
   * @param {() => number} [options.rng]   随机源，默认 Math.random
   * @param {number} [options.windowMs]    兜底窗口长度（waitMsFor 给出非法值时用）
   * @param {Function} [options.setTimer]  注入的 setTimeout（测试用假时钟）
   * @param {Function} [options.clearTimer] 注入的 clearTimeout
   * @param {number} [options.maxReadyMsgs] 无 onSettle 时待取队列上限，默认 256
   */
  constructor({
    log = null,
    onSettle = null,
    now = null,
    rng = null,
    windowMs = null,
    setTimer = null,
    clearTimer = null,
    maxReadyMsgs = null,
  } = {}) {
    this.log = log
    this.windowMs = Math.max(0, numOr(windowMs, DEFAULT_OBSERVE.defaultMaxMs))
    this._now = typeof now === 'function' ? now : () => Date.now()
    this._rng = typeof rng === 'function' ? rng : Math.random
    this._setTimer = typeof setTimer === 'function' ? setTimer : (fn, ms) => setTimeout(fn, ms)
    this._clearTimer = typeof clearTimer === 'function' ? clearTimer : (handle) => clearTimeout(handle)
    this._onSettle = typeof onSettle === 'function' ? onSettle : null
    this._maxReadyMsgs = Math.max(0, numOr(maxReadyMsgs, 256))

    /** @type {Map<string, {key:string, messages:object[], createdAt:number, settleAt:number, timer:any, priority:string}>} */
    this._batches = new Map()
    /** 只在没有 onSettle 时使用：已结算待取批次 */
    this._ready = new Map()
    this._readyCount = 0
    /** peer → 上次跑完观望的时间，用于「同一坨」判定 */
    this._lastSettled = new Map()
    this._disposed = false
  }

  /**
   * 入队一条消息。
   * @returns {{batchKey:string, settleAfterMs:number, waitedMs:number, flush:boolean,
   *            settled:object[]|null, flushReason:string|null}}
   *   flush=true 表示这次 push 提前结算了整批（@ / 秒回 / 攒满）。
   *   **交付只有一条路**：给了 onSettle 就走回调（settled 恒为 null，防重复处理）；
   *   没给 onSettle（单测/排错）时 settled 才带整批。
   */
  push(message, decision, config = {}) {
    if (this._disposed) throw new Error('ObservationWindow 已 dispose，不能再 push')
    const key = batchKeyOf(message)
    const at = this._now()
    const action = decision?.action ?? ACTION.OBSERVE
    const noop = { batchKey: key, settleAfterMs: 0, waitedMs: 0, flush: false, settled: null, flushReason: null }

    // 反正要丢的消息不进窗口（否则白占一个定时器）
    if (action === ACTION.IGNORE) return noop

    const sameThread = this.isSameThread(key, config, at)
    let delayMs = waitMsFor(message, decision, config, { rng: this._rng, now: this._now, sameThread })
    if (!Number.isFinite(delayMs) || delayMs < 0) delayMs = this.windowMs
    delayMs = Math.round(delayMs)

    const pending = this._batches.get(key)

    // 秒回（主人 / 观望关闭）：不排队，把同批已有消息一并结算，保证不丢不乱序
    if (delayMs <= 0) {
      const messages = pending ? pending.messages.concat(message) : [message]
      const waitedMs = pending ? at - pending.createdAt : 0
      if (pending) {
        this._clearBatchTimer(pending)
        this._batches.delete(key)
      }
      this._settle(key, messages, 'instant', at)
      return { batchKey: key, settleAfterMs: 0, waitedMs, flush: true, settled: this._delivery(messages), flushReason: 'instant' }
    }

    // 已有批次：只累积，不重置定时器
    if (pending) {
      pending.messages.push(message)
      const waitedMs = at - pending.createdAt

      // 被 @：立刻结算整批（原定时器作废）
      if (message?.mentionsMe === true || decision?.priority === PRIORITY.AT) {
        const messages = pending.messages.slice()
        this._clearBatchTimer(pending)
        this._batches.delete(key)
        this._settle(key, messages, 'at', at)
        return { batchKey: key, settleAfterMs: 0, waitedMs, flush: true, settled: this._delivery(messages), flushReason: 'at' }
      }

      // 攒太多：提前结算，别把内存和上下文撑爆
      const maxBatch = Math.max(0, numOr(config?.observe?.maxBatch, DEFAULT_OBSERVE.maxBatch))
      if (maxBatch > 0 && pending.messages.length >= maxBatch) {
        const messages = pending.messages.slice()
        this._clearBatchTimer(pending)
        this._batches.delete(key)
        this._settle(key, messages, 'batch-full', at)
        return { batchKey: key, settleAfterMs: 0, waitedMs, flush: true, settled: this._delivery(messages), flushReason: 'batch-full' }
      }

      return { batchKey: key, settleAfterMs: Math.max(0, pending.settleAt - at), waitedMs, flush: false, settled: null, flushReason: null }
    }

    // 新批次：第一条消息定 T，之后不改
    const batch = {
      key,
      messages: [message],
      createdAt: at,
      settleAt: at + delayMs,
      timer: null,
      priority: decision?.priority ?? PRIORITY.OBSERVE,
    }
    this._batches.set(key, batch)
    batch.timer = this._setTimer(() => this._onTimer(key), delayMs)
    // unref：观望窗口不该让进程退不出去（v2 的 node 测试就是被这个挂住过）
    if (batch.timer && typeof batch.timer.unref === 'function') batch.timer.unref()
    return { batchKey: key, settleAfterMs: delayMs, waitedMs: 0, flush: false, settled: null, flushReason: null }
  }

  /**
   * 取出并清空一个批次。
   * 正常路径不需要调它（onSettle 会送上门）；这里主要给「没有 onSettle」的单测/排错用。
   * 对还在观望中的批次调用 = 立刻结算并拿走。
   */
  take(batchKey) {
    const key = String(batchKey ?? '')
    if (!key || this._disposed) return []
    const ready = this._ready.get(key)
    if (ready) {
      this._ready.delete(key)
      this._readyCount -= ready.length
      return ready
    }
    const pending = this._batches.get(key)
    if (!pending) return []
    this._batches.delete(key)
    this._clearBatchTimer(pending)
    this._lastSettled.set(key, this._now())
    return pending.messages.slice()
  }

  /**
   * 这个 peer 是不是还在「同一坨」里（sameThreadMs 内刚跑完一次观望）。
   * at 默认取注入的 now()，测试可以直接喂时间点。
   */
  isSameThread(batchKey, config = {}, at = this._now()) {
    const key = String(batchKey ?? '')
    const last = this._lastSettled.get(key)
    if (last === undefined) return false
    const sameThreadMs = Math.max(0, numOr(config?.observe?.sameThreadMs, DEFAULT_OBSERVE.sameThreadMs))
    return at - last <= sameThreadMs
  }

  /** 当前还在观望中的批次数（面板/排错用）。 */
  pendingCount() {
    return this._batches.size
  }

  /** 当前批次键列表（排错用）。 */
  pendingKeys() {
    return [...this._batches.keys()]
  }

  /** 这个 peer 是否还有未结算的批次。 */
  hasPending(batchKey) {
    return this._batches.has(String(batchKey ?? ''))
  }

  /** 清掉所有定时器、丢掉未结算消息（插件停止时调）。可重复调用。 */
  dispose() {
    if (this._disposed) return
    this._disposed = true
    let dropped = 0
    for (const batch of this._batches.values()) {
      this._clearBatchTimer(batch)
      dropped += batch.messages.length
    }
    this._batches.clear()
    this._ready.clear()
    this._readyCount = 0
    this._lastSettled.clear()
    if (dropped > 0) this.log?.debug?.(`ObservationWindow dispose：丢弃 ${dropped} 条未结算消息`)
  }

  /** 定时器到点。 */
  _onTimer(key) {
    if (this._disposed) return
    const batch = this._batches.get(key)
    if (!batch) return // 已被 @ 或 dispose 提前清掉
    this._batches.delete(key)
    batch.timer = null
    this._settle(key, batch.messages.slice(), 'window', this._now())
  }

  /**
   * 结算一批：记「同一坨」时间戳，然后交给回调（或暂存待取）。
   * flush 含义：是不是提前结算（@ / 秒回 / 攒满）——窗口自然到点不算 flush。
   */
  _settle(key, messages, reason, at) {
    if (!messages || messages.length === 0) return
    this._lastSettled.set(key, at)
    if (this._onSettle) {
      try {
        this._onSettle(key, messages)
      } catch (error) {
        // 回调抛错绝不能带崩定时器
        this.log?.warn?.('观望结算回调抛错（已吞掉）', error)
      }
      return
    }
    // 没给回调：暂存，等 take()。有上限，面板停摆时不至于涨内存。
    const list = this._ready.get(key)
    if (list) list.push(...messages)
    else this._ready.set(key, messages.slice())
    this._readyCount += messages.length
    this._trimReady()
  }

  /** 交付路径二选一：有 onSettle 就只走回调，避免调用方把同一批处理两次。 */
  _delivery(messages) {
    return this._onSettle ? null : messages
  }

  _trimReady() {
    while (this._maxReadyMsgs > 0 && this._readyCount > this._maxReadyMsgs) {
      const firstKey = this._ready.keys().next().value
      if (firstKey === undefined) break
      const list = this._ready.get(firstKey)
      if (!list || list.length === 0) {
        this._ready.delete(firstKey)
        continue
      }
      const dropped = list.splice(0, 1)
      this._readyCount -= dropped.length
      if (list.length === 0) this._ready.delete(firstKey)
      this.log?.warn?.('观望待取批次积压，丢弃最旧的一条', firstKey)
    }
  }

  _clearBatchTimer(batch) {
    if (!batch?.timer) return
    try {
      this._clearTimer(batch.timer)
    } catch {
      // 定时器可能已被宿主清掉，忽略
    }
    batch.timer = null
  }
}
