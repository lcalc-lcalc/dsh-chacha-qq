/**
 * OneBot 11 WebSocket 客户端（NapCat 当服务端，我们当客户端）。
 *
 * 本模块只做三件事：连上去、收发、重连。不判断、不决策、不记忆 —— 那是 L2 的活。
 *
 * 从 v2 抄过来的坑，对应位置都写了注释，别手贱删掉：
 *  1. `close()` 会先把 `closing` 置 true，之后 `connect()` 直接被拦。
 *     所以面板上的「重连」只能走 `forceReconnect()`，它负责把标志掰回来。
 *     v2 就栽在这 —— 重连按钮等于「一键搞死网关」。
 *  2. `close` 事件回调里如果没摘监听器，主动关闭也会触发重连，于是两条 WS 同时在线。
 *     解法：先摘监听器再 close，主动关闭不排重连。
 *  3. 连着 ≠ 收得到消息（NapCat 的 hook 会退化）。
 *     解法：心跳 `status.good` + 静默检测双信号，静默超时就 emit `stale`。
 */
import { EventEmitter } from 'node:events'

/** WebSocket.OPEN。不读实例上的常量，测试注入的假 socket 也认这个数。 */
const WS_OPEN = 1

/** OneBot 动作默认超时；发文件那种慢动作由 api.js 单独给更长。 */
const DEFAULT_CALL_TIMEOUT_MS = 15000

const DEFAULT_RECONNECT = { minDelayMs: 1000, maxDelayMs: 30000, factor: 1.8 }

/** 10 分钟一帧都没收到就认为上游退化（v2 线上验证过的默认值）。 */
const DEFAULT_SILENCE_WARN_MS = 10 * 60 * 1000

/** 日志是可选注入的，缺了也不能让每行都写 null 检查。 */
const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} }

function normalizeLog(log) {
  if (!log) return NOOP_LOG
  return {
    info: (...args) => log.info?.(...args),
    warn: (...args) => log.warn?.(...args),
    error: (...args) => log.error?.(...args),
    debug: (...args) => log.debug?.(...args),
  }
}

/** 只认正的有限数，配错一个字段不该把整个网关拖进 NaN 地狱。 */
function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 退避参数兜底：factor 太小退避不增长，max 小于 min 会让封顶失效。 */
function normalizeReconnect(input) {
  const minDelayMs = positiveNumber(input?.minDelayMs, DEFAULT_RECONNECT.minDelayMs)
  const maxDelayMs = positiveNumber(input?.maxDelayMs, DEFAULT_RECONNECT.maxDelayMs)
  return {
    minDelayMs,
    maxDelayMs: Math.max(maxDelayMs, minDelayMs),
    factor: Math.max(1.1, positiveNumber(input?.factor, DEFAULT_RECONNECT.factor)),
  }
}

export class OneBotGateway extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.wsUrl 形如 ws://127.0.0.1:3001
   * @param {string} [options.token] access_token，拼进 URL query
   * @param {object} [options.log] logger，至少实现 info/warn/error
   * @param {{minDelayMs:number,maxDelayMs:number,factor:number}} [options.reconnect]
   * @param {number} [options.silenceWarnMs] 多久没收到任何帧就报 stale
   * @param {Function} [options.WebSocketImpl] 测试注入用；默认 Node 22+ 的全局 WebSocket
   */
  constructor({ wsUrl, token = '', log, reconnect, silenceWarnMs = DEFAULT_SILENCE_WARN_MS, WebSocketImpl } = {}) {
    super()
    if (!wsUrl) throw new Error('OneBotGateway 缺少 wsUrl')

    this.log = normalizeLog(log)
    this.rawUrl = wsUrl
    this.token = token
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket
    this.silenceWarnMs = positiveNumber(silenceWarnMs, DEFAULT_SILENCE_WARN_MS)

    this.reconnect = normalizeReconnect(reconnect)

    this.ws = null
    this.handlers = null
    this.connecting = false
    // ⚠️ 这个标志就是 v2 坑 15 的本体：close() 之后它是 true，connect() 会直接返回。
    //    只有 forceReconnect() 会把它复位，别的路径都不行。
    this.closing = false

    this.delay = this.reconnect.minDelayMs
    this.retryTimer = null
    this.silenceTimer = null
    this.lastPacketAt = 0
    this.silenceWarned = false
    this.seq = 0
    this.pending = new Map()

    this._selfId = ''
    /** 心跳报的上游健康：null 未知 / true 好 / false 坏 */
    this._upstreamGood = null
    this.heartbeatInterval = null
  }

  /** token 走 URL query：Node 内置 WebSocket 没有自定义 header 的入口，这样最省事。 */
  buildUrl() {
    if (!this.token) return this.rawUrl
    try {
      const url = new URL(this.rawUrl)
      url.searchParams.set('access_token', this.token)
      return url.toString()
    } catch {
      // wsUrl 不是标准 URL 时别为了拼 token 把连接搞崩，原样连
      return this.rawUrl
    }
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === WS_OPEN
  }

  get selfId() {
    return this._selfId
  }

  /** 连通、心跳没说坏、也没静默超时，才算健康。 */
  get healthy() {
    if (!this.connected) return false
    if (this._upstreamGood === false) return false
    if (this.lastPacketAt && Date.now() - this.lastPacketAt > this.silenceWarnMs) return false
    return true
  }

  /** 建立连接（幂等：正在连 / 已连上 / 已主动关闭 都直接返回）。 */
  connect() {
    // 这里拦 closing 是故意的：close() 之后想重连必须 forceReconnect()
    if (this.connecting || this.connected || this.closing) return

    const Impl = this.WebSocketImpl
    if (typeof Impl !== 'function') {
      this.log.error('没有可用的 WebSocket 实现（Node 22+ 自带，或给 WebSocketImpl）')
      this.emitError(new Error('WebSocket 不可用'))
      this.scheduleReconnect()
      return
    }

    this.connecting = true
    let ws
    try {
      ws = new Impl(this.buildUrl())
    } catch (error) {
      this.connecting = false
      this.log.error('WebSocket 构造失败：', error?.message ?? error)
      this.emitError(error)
      this.scheduleReconnect()
      return
    }

    this.ws = ws
    const isCurrent = () => this.ws === ws

    const onOpen = () => {
      if (!isCurrent()) return
      this.connecting = false
      this.delay = this.reconnect.minDelayMs
      this._upstreamGood = null
      this.lastPacketAt = Date.now()
      this.silenceWarned = false
      this.log.info(`已连接 ${this.rawUrl}`)
      this.armSilenceWatch()
      this.emitSafe('open')
      // 连上先问一次登录号：既拿 selfId，也顺手验证 action 链路真的通
      this.call('get_login_info')
        .then((data) => {
          if (!isCurrent()) return
          const id = data?.user_id
          if (id === undefined || id === null || id === '') return
          this._selfId = String(id)
          this.log.info(`登录号 ${this._selfId}（${data?.nickname ?? ''}）`)
          this.emitSafe('login', data)
        })
        .catch((error) => this.log.warn('get_login_info 失败：', error?.message ?? error))
    }

    const onMessage = (event) => {
      if (!isCurrent()) return
      this.lastPacketAt = Date.now()
      this.silenceWarned = false
      try {
        this.handlePacket(event?.data)
      } catch (error) {
        // 一帧坏只丢这一帧：解析失败、监听器抛错、任何意外都不许拖垮连接
        this.log.warn('处理帧失败，已丢弃：', error?.message ?? error)
      }
    }

    const onClose = (event) => {
      if (!isCurrent()) return
      this.detach(ws)
      this.ws = null
      this.connecting = false
      this.clearSilenceWatch()
      this.failPending(new Error('连接已断开'))
      const payload = {
        code: Number(event?.code ?? 0),
        reason: String(event?.reason ?? ''),
        intentional: false,
      }
      if (this.closing) {
        // close() 正常情况下已经摘过监听器了；能走到这里说明是 close 竞态，安静收尾
        this.emitSafe('close', { ...payload, intentional: true })
        return
      }
      this.log.warn(`连接断开（code=${payload.code}），准备重连`)
      this.emitSafe('close', payload)
      this.scheduleReconnect()
    }

    const onError = (event) => {
      if (!isCurrent()) return
      const error = event instanceof Error ? event : new Error(String(event?.message ?? 'WebSocket 出错'))
      this.log.warn('WebSocket 出错：', error.message)
      // error 后面一般都会跟一个 close，重连交给 onClose，这里只上报
      this.emitError(error)
    }

    this.handlers = { open: onOpen, message: onMessage, close: onClose, error: onError }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
  }

  /**
   * 主动关闭：只关，不重连。
   *
   * ⚠️ 关掉之后再 connect() 会被 closing 拦住 —— 这是故意的（防止热更新时
   * 两条 WS 同时在线）。要重新连必须调 forceReconnect()。
   */
  close() {
    if (this.closing && !this.ws) return
    this.closing = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    this.connecting = false
    this.detach(ws)
    this.failPending(new Error('网关已关闭'))
    if (ws) {
      try {
        ws.close(1000, 'gateway closed')
      } catch {
        // 已经死了就算了
      }
      this.log.info('连接已关闭')
    }
    this.emitSafe('close', { code: 1000, reason: 'closed', intentional: true })
  }

  /**
   * 强制重连：把可能卡住的状态全部清零再来一次。
   *
   * 为什么必须有它：退避 + 防抖 + close 事件叠在一起时，会卡在「既不连也不报错」
   * 的状态（日志停在最后一次断开，之后一片安静）。面板上的「重连」按钮只能调这个，
   * 它顺便把 closing 复位，否则 connect() 永远进不去。
   */
  forceReconnect() {
    const wasConnected = this.connected
    this.closing = false // 解锁，必须在 connect() 之前
    this.connecting = false
    this.clearTimers()

    const ws = this.ws
    this.ws = null
    if (ws) {
      this.detach(ws)
      try {
        ws.close(1000, 'force reconnect')
      } catch {
        // 已经死了就算了
      }
    }
    this.failPending(new Error('强制重连，旧连接作废'))

    this.delay = this.reconnect.minDelayMs
    this.log.info(wasConnected ? '强制重连（原本连着）' : '强制重连（之前是断开的）')
    this.connect()
  }

  /**
   * 配置热更新：换成另一套连接参数。
   *
   * 只有 wsUrl / token 真的变了才重连（每次保存配置都抖一下连接完全没必要）；
   * 退避与静默阈值就地生效。返回是否真的重连了。
   */
  update(options = {}) {
    const nextUrl = options.wsUrl === undefined || String(options.wsUrl) === '' ? this.rawUrl : String(options.wsUrl)
    const nextToken = options.token === undefined ? this.token : String(options.token)
    if (options.reconnect !== undefined) this.reconnect = normalizeReconnect(options.reconnect)
    if (options.silenceWarnMs !== undefined) {
      this.silenceWarnMs = positiveNumber(options.silenceWarnMs, this.silenceWarnMs)
    }

    const changed = nextUrl !== this.rawUrl || nextToken !== this.token
    this.rawUrl = nextUrl
    this.token = nextToken
    if (!changed) return false

    this.log.info('连接参数已变更，重连中')
    this.forceReconnect()
    return true
  }

  /** 指数退避：每次断开后等一会儿再试，间隔封顶 maxDelayMs。 */
  scheduleReconnect() {
    if (this.closing || this.retryTimer) return
    const wait = Math.max(1, Math.min(this.delay, this.reconnect.maxDelayMs))
    this.delay = Math.min(Math.round(this.delay * this.reconnect.factor), this.reconnect.maxDelayMs)
    this.log.info(`${wait}ms 后重连`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, wait)
    this.retryTimer.unref?.()
  }

  clearTimers() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.clearSilenceWatch()
  }

  /**
   * 静默检测：连着但很长时间收不到任何帧（含心跳），说明 NapCat 上游退化了。
   * 检查粒度取阈值的 1/4，夹在 [50ms, 60s] 之间 —— 阈值配小的时候测试也能快速触发。
   */
  armSilenceWatch() {
    this.clearSilenceWatch()
    const interval = Math.max(50, Math.min(this.silenceWarnMs / 4, 60000))
    this.silenceTimer = setInterval(() => {
      if (!this.connected) return
      const silent = Date.now() - this.lastPacketAt
      if (silent < this.silenceWarnMs || this.silenceWarned) return
      // 一次静默只报一次，不然日志和面板都会被同一个问题刷屏
      this.silenceWarned = true
      this.log.warn(`已经 ${Math.round(silent / 1000)} 秒没收到任何帧，NapCat 上游可能退化了`)
      this.emitSafe('stale', silent)
    }, interval)
    this.silenceTimer.unref?.()
  }

  clearSilenceWatch() {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  /** 摘监听器：主动关连接时先做，否则 close 回调又触发重连（v2 的双连接坑）。 */
  detach(ws = this.ws) {
    const handlers = this.handlers
    this.handlers = null
    if (!ws || !handlers || typeof ws.removeEventListener !== 'function') return
    for (const [type, fn] of Object.entries(handlers)) {
      try {
        ws.removeEventListener(type, fn)
      } catch {
        // 已经没了就算了
      }
    }
  }

  /** 断开时把所有等回包的调用失败掉，别让上层一直挂着等。 */
  failPending(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /**
   * 处理一帧：可能是 API 回包、心跳（meta_event），也可能是一条普通事件。
   * 这里只做分发，收到的原始帧原样交给上层（normalize 负责翻译）。
   */
  handlePacket(raw) {
    let packet
    try {
      packet = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      this.log.warn('收到无法解析的帧，已丢弃')
      return
    }
    if (!packet || typeof packet !== 'object') {
      this.log.warn('收到非对象帧，已丢弃')
      return
    }

    // API 回包：有 echo 且没有 post_type（事件帧不会有 echo）
    if (packet.echo !== undefined && packet.post_type === undefined) {
      this.resolveCall(packet)
      return
    }

    // 心跳：napcat 的 post_type=meta_event，status.good 是上游健康度
    if (packet.post_type === 'meta_event' && packet.meta_event_type === 'heartbeat') {
      if (typeof packet.status?.good === 'boolean') this._upstreamGood = packet.status.good
      if (packet.interval) this.heartbeatInterval = Number(packet.interval)
      if (packet.status?.good === false) this.log.warn('心跳说 status.good=false：NapCat 收不到 QQ 数据了')
      this.emitSafe('heartbeat', packet)
      return
    }

    this.emitSafe('packet', packet)
  }

  /** 把回包交给对应 echo 的 Promise。 */
  resolveCall(packet) {
    const echo = String(packet.echo)
    const entry = this.pending.get(echo)
    if (!entry) {
      this.log.debug('收到未知 echo 的回包：', echo)
      return
    }
    this.pending.delete(echo)
    clearTimeout(entry.timer)
    if (packet.status === 'ok' || packet.retcode === 0) {
      entry.resolve(packet.data)
      return
    }
    const detail = packet.message ? ` ${packet.message}` : ''
    entry.reject(new Error(`${entry.action} 失败：retcode=${packet.retcode}${detail}`))
  }

  /**
   * 调一个 OneBot 动作，按 echo 等回包。
   * @param {string} action 例如 send_group_msg
   * @param {object} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} 回包的 data
   */
  call(action, params = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error(`未连接，无法调用 ${action}`))
        return
      }
      const timeout = positiveNumber(timeoutMs, DEFAULT_CALL_TIMEOUT_MS)
      const echo = `cq-${++this.seq}`
      const entry = { action, resolve, reject, timer: null }
      entry.timer = setTimeout(() => {
        if (!this.pending.has(echo)) return
        this.pending.delete(echo)
        reject(new Error(`${action} 超时（${timeout}ms）`))
      }, timeout)
      entry.timer.unref?.()
      this.pending.set(echo, entry)
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(entry.timer)
        this.pending.delete(echo)
        reject(error)
      }
    })
  }

  /** 外部监听器抛错不能把我们带崩（尤其不能让 WS 的 close 流程断在半路）。 */
  emitSafe(event, payload) {
    try {
      return this.emit(event, payload)
    } catch (error) {
      this.log.warn(`监听 ${event} 的回调抛错：`, error?.message ?? error)
      return false
    }
  }

  /** EventEmitter 的 'error' 没人监听会直接 throw，这里必须兜住。 */
  emitError(error) {
    if (this.listenerCount('error') === 0) {
      this.log.debug('网关出错（没有 error 监听者）：', error?.message ?? error)
      return
    }
    this.emitSafe('error', error)
  }
}
