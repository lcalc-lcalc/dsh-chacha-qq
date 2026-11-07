/**
 * 面板 REST 端点（宿主侧唯一实现文件）。
 *
 * 契约见 `docs/PANEL-DESIGN.md` §2 —— 端点、入参、返回 JSON 全部照它。
 * 这里只负责「把运行时的状态摊平成 JSON」和「把面板上的按钮翻译成一次动作调用」，
 * 所有业务逻辑仍然在 src/ 各层里，面板不重复判断一遍。
 *
 * 三条铁律（都是踩过坑才写下来的，别改）：
 *
 * 1. **每个 handler 自己校验来源**。
 *    面板 API **不在** DSH `/api` 的鉴权覆盖范围内（那些路由是另一套 Fetch 注册表，
 *    由 connection 服务按浏览器身份放行）。我们挂在原生 webServer 上，等于开在 DSH 的
 *    HTTP 端口上，所以这一层 `remoteAddress` 校验就是**唯一的门**。
 *    只认回环：`127.0.0.1` / `::1` / `::ffff:127.0.0.1`；`x-forwarded-for` 一律不信
 *    （那是客户端自己写的头，伪造一个就进来了）。
 *
 * 2. **同一个路径只注册一个精确路由**（v2 坑 21）。
 *    DSH 的 `webServer.register` 对 (kind, path) 做去重，**重复会直接 throw**；
 *    旧版把 GET /chacha-qq/config 和 POST /chacha-qq/config 各注册一次，
 *    结果第二个 throw 把整块面板带黑，而且日志只有一个字。
 *    所以 `/chacha-qq/config` 是**一个**注册项，GET/POST 在 handler 里按 `request.method` 分支。
 *
 * 3. **任何 handler 都不许抛**。
 *    一个坏请求把异常抛回 webServer 的 listener，轻则这条请求吊死（客户端永远转圈），
 *    重则整块面板不可用。这里三层兜底：每个 handler 自己 try/catch → dispatch 再兜一层 →
 *    适配层写响应时再兜一层，并且一律记日志（不然「面板打不开」永远查不出原因）。
 *
 * ⚠️ handler 形态：DSH 这一版的 `webServer.register` 给的是 **Node 原生
 * `(req: IncomingMessage, res: ServerResponse)`**（WebRoute.handler 的类型就是它），
 * 而 v3 设计稿里写的是 Web 标准 `Request → Response`。两种都认：
 *   · `panel.node(req, res)`   —— 真实 DSH 用这条（返回 void，直接写 res）
 *   · `panel.fetch(request)`   —— 返回 `Response`，测试和「将来 DSH 换成 Fetch 契约」用这条
 * 装配层（index.js）只管调 `registerPanel()`，不用猜是哪一种。
 */
import net from 'node:net'

// 只借用纯函数：面板不改它们，也不复制一份（两份实现迟早对不上）。
import { MODES, normalizePeerKey, resolveMode } from '../modes.js'

// ══════════════════════════════════════════════════════════════
// 常量
// ══════════════════════════════════════════════════════════════

/**
 * 面板端点清单。
 * ⚠️ 一个路径 = 一个注册项；方法在 handler 内部分支。顺序就是日志里的顺序。
 */
export const PANEL_PATHS = Object.freeze([
  '/chacha-qq/state',
  '/chacha-qq/conversations',
  '/chacha-qq/messages',
  '/chacha-qq/config',
  '/chacha-qq/action',
  '/chacha-qq/memes',
])

/** POST /config 的 body 上限。512KB 足够放下整份配置的补丁，再大就是打错文件了。 */
const MAX_CONFIG_BODY_BYTES = 512 * 1024
/** POST /action 只传几个字段，别给它灌 512KB。 */
const MAX_ACTION_BODY_BYTES = 64 * 1024
/** /messages 的 limit 默认值与硬上限（夹在 1~1000）。 */
const DEFAULT_MESSAGE_LIMIT = 200
const MAX_MESSAGE_LIMIT = 1000
/** 状态条上带最近 80 条日志（§2.1）。 */
const LOG_RING_LIMIT = 80
/** 探 NapCat 端口的超时（§2.5：2 秒）。 */
const PROBE_TIMEOUT_MS = 2000

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  // 面板 2~3 秒轮询一次，任何一层缓存住都会让主人看到「卡住不动」
  'cache-control': 'no-store',
})

/**
 * 允许的远端地址（回环的三种写法）。
 * `0:0:0:0:0:0:0:1` 是 `::1` 的展开形式，某些平台的 getpeername 会给这一种。
 */
const LOOPBACK_REMOTES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1'])

// ══════════════════════════════════════════════════════════════
// 小工具（纯函数，全部不抛）
// ══════════════════════════════════════════════════════════════

/** 纯对象判定：数组 / null / class 实例都不算。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只认数组，其它一律空数组（下游模块返回 undefined 是常态）。 */
function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** 只认纯对象，其它一律空对象。 */
function asObject(value) {
  return isPlainObject(value) ? value : {}
}

/** 只认有限数，`NaN`/`Infinity`/`'abc'` 全给兜底值 —— 面板最怕 NaN（画不出图）。 */
function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 压成字符串；`null`/`undefined` 给兜底值。 */
function str(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  return typeof value === 'string' ? value : String(value)
}

/** 取布尔：只认 true / 'true' / 1。 */
function bool(value) {
  return value === true || value === 'true' || value === 1
}

/**
 * 安全调一个可选方法。
 * 下游模块可能是 null（没交付）、可能抛错（磁盘权限之类），
 * 两者都当「没有」处理 —— 一个子系统坏掉不该让整块面板 500。
 */
function call(object, method, ...args) {
  try {
    if (object && typeof object[method] === 'function') return object[method](...args)
  } catch {
    // 故意吞掉：调用方拿 undefined 会走兜底
  }
  return undefined
}

/**
 * 安全调一个可选方法（异步版）。
 * `listConversations()` 只要求「返回会话数组」，没规定同步 —— 装配层那位写成 async
 * 也不会让面板退回聚合兜底（Promise 不是数组，同步 call() 会把它当「没有」丢掉）。
 */
async function callAsync(object, method, ...args) {
  try {
    if (object && typeof object[method] === 'function') return await object[method](...args)
  } catch {
    // 同上：下游坏了当「没有」
  }
  return undefined
}

/** 跑一段取值逻辑，抛错就返回兜底值。 */
function safe(fn, fallback = null) {
  try {
    const value = fn()
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

/** 本地「今天零点」，token 统计按它切日。 */
function startOfToday(now = Date.now()) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// ══════════════════════════════════════════════════════════════
// 来源校验
// ══════════════════════════════════════════════════════════════

/** 远端地址是不是回环。取不到地址 = 拒绝（失败要关闭，不能开放）。 */
function isLoopbackAddress(remoteAddress) {
  return LOOPBACK_REMOTES.has(str(remoteAddress).trim())
}

/**
 * Host 头是不是回环（防 DNS rebinding，v2 坑 22）。
 *
 * 只校验 remoteAddress 是不够的：恶意页面可以把自己解析到 127.0.0.1，
 * 浏览器发出的请求源地址确实是回环，但 Host 是攻击者的域名。
 * 反过来，没有 Host 头（HTTP/1.0、本机命令行工具）放行 —— 没有 Host 就没有 rebinding。
 */
function isLoopbackHost(headerValue) {
  const raw = str(headerValue).trim()
  if (!raw) return true

  let hostname = raw
  const colons = (raw.match(/:/g) ?? []).length
  if (raw.startsWith('[')) {
    // [::1] / [::1]:60228
    const end = raw.indexOf(']')
    if (end > 0) hostname = raw.slice(1, end)
  } else if (colons === 1) {
    // 127.0.0.1:60228 / localhost:60228
    hostname = raw.slice(0, raw.indexOf(':'))
  } else if (colons > 1) {
    // 裸 IPv6（没有端口可言）
    hostname = raw
  }
  hostname = hostname.toLowerCase()
  if (!hostname) return false
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

// ══════════════════════════════════════════════════════════════
// 读取请求体 / 构造响应
// ══════════════════════════════════════════════════════════════

/** 读 body 时的两种失败：太大 / 读不出来。用 code 区分，方便映射成 413 / 400。 */
class BodyError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BodyError'
    this.code = code
  }
}

/**
 * 读 Node 原生请求体（DSH webServer 给的就是这个）。
 *
 * 先看 content-length 能提前拒就提前拒 —— 把一个 10MB 的 body 读完了再说「太大」，
 * 等于白挨一次打。超限后立刻停手不再累积，连接留给适配层在响应写完时掐掉。
 */
function readNodeBody(request, limit) {
  return new Promise((resolve, reject) => {
    if (!request || typeof request.on !== 'function') {
      reject(new BodyError('unreadable', '请求体不可读'))
      return
    }

    const declared = num(request.headers?.['content-length'], 0)
    if (declared > limit) {
      reject(new BodyError('too-large', `请求体 ${declared} 字节，超过上限 ${limit}`))
      return
    }

    const chunks = []
    let size = 0
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      request.off?.('data', onData)
      request.off?.('end', onEnd)
      request.off?.('error', onError)
      fn(value)
    }
    const onData = (chunk) => {
      size += chunk?.length ?? 0
      if (size > limit) {
        // 停手：不再累积、也不继续消费（上层会回 413 并掐连接）
        request.pause?.()
        finish(reject, new BodyError('too-large', `请求体超过上限 ${limit} 字节`))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString('utf8'))
    const onError = (error) => finish(reject, new BodyError('unreadable', str(error?.message ?? error)))

    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
}

/**
 * 读 Web 标准 Request 的 body（`request.text()`）。
 * 真实 Fetch Request 没法流式限长，只能读完再量 —— 所以这里只当第二形态用。
 */
async function readFetchBody(request, limit) {
  const declared = num(headerOf(request, 'content-length'), 0)
  if (declared > limit) throw new BodyError('too-large', `请求体 ${declared} 字节，超过上限 ${limit}`)

  let text
  try {
    text = await request.text()
  } catch (error) {
    throw new BodyError('unreadable', str(error?.message ?? error))
  }
  if (Buffer.byteLength(text ?? '', 'utf8') > limit) {
    throw new BodyError('too-large', `请求体超过上限 ${limit} 字节`)
  }
  return text
}

/** 从 Node 请求上取头（大小写归一，数组取第一个）。 */
function nodeHeader(request, name) {
  const headers = request?.headers
  if (!headers || typeof headers !== 'object') return ''
  const value = headers[name] ?? headers[String(name).toLowerCase()]
  return Array.isArray(value) ? str(value[0]) : str(value)
}

/** 从 Web Request 上取头（兼容 Headers 对象 / 普通对象）。 */
function headerOf(request, name) {
  const headers = request?.headers
  if (!headers) return ''
  if (typeof headers.get === 'function') return str(headers.get(name))
  const value = headers[name] ?? headers[String(name).toLowerCase()]
  return Array.isArray(value) ? str(value[0]) : str(value)
}

/**
 * 造一个 JSON 响应描述（`{status, headers, text}`）。
 * 序列化失败也必须给出一个能用的响应 —— 否则一个循环引用就把请求吊死。
 */
function jsonResult(body, status = 200, extraHeaders = null) {
  let text
  try {
    const serialized = JSON.stringify(body)
    text = serialized === undefined ? 'null' : serialized
  } catch (error) {
    status = 500
    text = JSON.stringify({ ok: false, error: `响应无法序列化：${str(error?.message ?? error)}` })
  }
  return {
    status,
    headers: extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : { ...JSON_HEADERS },
    text,
  }
}

/** 把响应描述写进 Node 原生响应。 */
function writeNodeResponse(response, result, request) {
  try {
    if (!response || typeof response.writeHead !== 'function') return
    const headers = { ...result.headers }
    if (result.status === 413) {
      // 被拒的 body 还有大半在路上。这里**把剩下的排干再让 Node 正常关连接**：
      //   · 直接 destroy 会在响应刷出去之前发 RST，客户端只看到「连接被重置」，看不到 413；
      //   · 排干是「只数数、不存」，内存不会涨（我们早就停止累积了）。
      // 排干量给个上限：真有人灌 10GB 就掐掉，那是攻击，不是主人点面板。
      headers.connection = 'close'
      try {
        let drained = 0
        const drainCap = 8 * 1024 * 1024
        request?.on?.('data', (chunk) => {
          drained += chunk?.length ?? 0
          if (drained > drainCap) {
            try {
              request.destroy?.()
            } catch {
              // ignore
            }
          }
        })
        request?.resume?.()
      } catch {
        // 排不干也无所谓，Node 的 requestTimeout 会兜底
      }
    }
    response.writeHead(result.status, headers)
    response.end(result.text)
  } catch (error) {
    // 写不出去（客户端先断了）不能传染，销毁拉倒
    try {
      response?.destroy?.()
    } catch {
      // ignore
    }
    throw error
  }
}

// ══════════════════════════════════════════════════════════════
// 路径 / 会话 key / token 统计 等纯逻辑
// ══════════════════════════════════════════════════════════════

/** 从 URL 里抠出 pathname（去掉 query 和多余尾斜杠）。 */
function pathOf(url) {
  try {
    const pathname = new URL(str(url, '/'), 'http://127.0.0.1').pathname
    if (pathname === '/') return '/'
    return pathname.replace(/\/+$/, '') || '/'
  } catch {
    return ''
  }
}

/** URL → searchParams（解析不出来就给空参数，别让一处坏 URL 把整个端点打死）。 */
function queryOf(url) {
  try {
    return new URL(str(url, '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * 一条 `recent` 记录属于哪个会话。
 *
 * ⚠️ 拼法和 pipeline 的 `sessionKeyOf` / modes.js 的 key 同构（但群不按发言人拆）：
 *   群聊   `group-<群号>`      ← 面板一行一个群
 *   私聊   `private-<QQ号>`
 * `recent` 里没有现成的 peerKey 字段（pipeline 记的是 peerId + scene + groupId），
 * 所以这里自己拼；万一将来 pipeline 补上了 peerKey，先用它（归一化后同构）。
 */
function peerKeyOf(entry) {
  const raw = str(entry?.peerKey).trim()
  if (raw) return normalizePeerKey(raw) || raw
  if (str(entry?.scene) === 'group') return `group-${str(entry?.groupId ?? entry?.peerId)}`
  return `private-${str(entry?.peerId)}`
}

/** 一条 `recent` 记录的方向。pipeline 用 `direction`，输出契约用 `dir`。 */
function directionOf(entry) {
  return str(entry?.direction ?? entry?.dir, 'internal') || 'internal'
}

/**
 * `peerKey` → 出站目标 `{ scene, peerId, userId }`（`Outbox.push` 认的形状）。
 *
 *   private-1111111111 → { scene:'private', peerId:'1111111111', userId:'1111111111' }
 *   group-999          → { scene:'group',   peerId:'999',        userId:'' }
 *
 * 群聊的 userId 给空串：群发不针对某个人（outbox.push 会自己补 groupId = peerId）。
 * @returns {{scene:string, peerId:string, userId:string}|null}
 */
function parsePeerKey(peerKey) {
  const raw = str(peerKey).trim()
  if (!raw) return null
  const key = normalizePeerKey(raw) || raw
  if (key.startsWith('private-')) {
    const peerId = key.slice('private-'.length)
    return peerId ? { scene: 'private', peerId, userId: peerId } : null
  }
  if (key.startsWith('group-')) {
    const peerId = key.slice('group-'.length)
    return peerId ? { scene: 'group', peerId, userId: '' } : null
  }
  return null
}

/** 这个会话是不是主人（§2.2：主人私聊 = owner，群 = guest）。 */
function defaultRoleOf(scene, peerId, config) {
  if (scene !== 'private') return 'guest'
  const owner = asObject(config?.owner)
  const ids = new Set([str(owner.qq), ...asArray(owner.aliases).map((item) => str(item))].filter(Boolean))
  return ids.has(str(peerId)) ? 'owner' : 'guest'
}

/** /messages 的 limit：默认 200，夹在 1~1000。 */
function parseMessageLimit(raw) {
  const text = str(raw).trim()
  if (!text) return DEFAULT_MESSAGE_LIMIT
  const parsed = Math.floor(Number(text))
  if (!Number.isFinite(parsed)) return DEFAULT_MESSAGE_LIMIT
  return Math.min(MAX_MESSAGE_LIMIT, Math.max(1, parsed))
}

/**
 * 只读端点只接受 GET（§2：全部 GET/POST，读接口就是 GET）。
 * 返回 null = 通过，否则返回一个 405 响应。
 */
function requireGet(request) {
  const method = str(request?.method, 'GET').toUpperCase()
  if (method === 'GET') return null
  return jsonResult({ ok: false, error: `method not allowed: ${method}` }, 405, { allow: 'GET' })
}

/** 把 mind.listSessions() 的一条压成 §2.1 / §2.2 的形状。 */
function toSessionBrief(session) {
  return {
    sessionId: str(session?.sessionId),
    role: str(session?.role),
    mode: str(session?.mode),
    events: num(session?.events),
    pressure: num(session?.pressure),
  }
}

/**
 * 给一个会话找它对应的 Mind 会话（§2.2 的 `session`）。
 *
 * 会话 id 的三种形态（`MindSessions.idOf`）：
 *   `qq-private-123`      `qq-group-999-owner`      `qq-group-999-owner-g2`（换代次后）
 * 所以「等于 base」或「base-*」都算命中；群可能有 owner/guest 两条，取活跃（events 多）的那条。
 */
function matchSession(sessions, config, peerKey) {
  const prefix = str(config?.mind?.sessionPrefix, 'qq') || 'qq'
  const base = `${prefix}-${peerKey}`
  const hits = asArray(sessions).filter((session) => {
    const id = str(session?.sessionId)
    return id === base || id.startsWith(`${base}-`)
  })
  if (hits.length === 0) return null
  hits.sort((a, b) => num(b?.events) - num(a?.events))
  const hit = hits[0]
  return { sessionId: str(hit?.sessionId), events: num(hit?.events), pressure: num(hit?.pressure) }
}

/** 关系快照 + 阶段：面板只画分数 / 阶段 / 中文名，账本不塞进去（太大）。 */
function toRelationBrief(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  return {
    score: num(snapshot.score),
    phase: str(snapshot.phase),
    label: str(snapshot.label),
  }
}

// ══════════════════════════════════════════════════════════════
// 面板实现
// ══════════════════════════════════════════════════════════════

/**
 * 建一个面板处理器（纯逻辑，不碰网络、不碰 ctx）。
 *
 * 拆出来的原因：`registerPanel()` 需要 ctx.get('webServer')，测试里没有 webServer，
 * 但每个端点的行为都必须能测。所以「路由实现」和「往 webServer 上注册」分两层。
 *
 * @param {object} options
 * @param {object} [options.runtime] 装配好的运行时（可能缺零件，全部 defensive）
 * @param {object} [options.log]     日志器（可缺）
 */
export function createPanel({ runtime = null, log = null } = {}) {
  /** runtime.log 才是根日志器（只有它有 recent/clearRing）；传进来的可能是 child。 */
  const rootLog = runtime?.log ?? log ?? null

  const note = (level, ...args) => {
    try {
      const fn = rootLog?.[level]
      if (typeof fn === 'function') fn.call(rootLog, ...args)
    } catch {
      // 日志自己坏了也不许影响请求
    }
  }

  // ── 取值层：每个都「拿不到就给空」，绝不抛 ───────────────────

  function configOf() {
    return safe(() => asObject(runtime?.store?.get?.()), {})
  }

  function snapshotOf() {
    const snapshot = call(runtime?.controller, 'snapshot')
    return isPlainObject(snapshot) ? snapshot : null
  }

  function logRing(limit = LOG_RING_LIMIT) {
    const list = call(rootLog, 'recent', limit)
    return asArray(list).map((entry) => ({
      at: num(entry?.at),
      level: str(entry?.level),
      tag: str(entry?.tag),
      text: str(entry?.text),
    }))
  }

  function mindSessions() {
    return asArray(call(runtime?.mind, 'listSessions'))
  }

  /**
   * 今日 token（§2.1）。
   *
   * 数据来源是 `controller.recent` 里 `kind:'usage'` 的条目 —— 那是 `turn.js`
   * 从 DSH 会话日志的 `assistant/message.usage` 采下来的，不用再单独统计一次。
   * 一条 usage = 一次模型调用；字段名兼容 `input/output` 与 OneBot 风格的 `inputTokens/outputTokens`。
   */
  function sumUsage() {
    const recent = safe(() => asArray(runtime?.controller?.recent), [])
    const dayStart = startOfToday()
    const out = { todayInput: 0, todayOutput: 0, todayTurns: 0 }
    for (const entry of recent) {
      if (str(entry?.kind) !== 'usage') continue
      const at = num(entry?.at, 0)
      // 「今日」按本地零点切；没有时间戳的条目算今日（recent 只留 200 条，不会太旧）
      if (at > 0 && at < dayStart) continue
      const tokens = asObject(entry?.tokens ?? entry?.usage)
      out.todayInput += num(tokens.input ?? tokens.inputTokens)
      out.todayOutput += num(tokens.output ?? tokens.outputTokens)
      out.todayTurns += 1
    }
    return out
  }

  /** 模型信息（§2.1）。Mind 还没跑过一轮时 modelInfo() 是 null，退回配置值。 */
  function modelInfoOf() {
    const config = configOf()
    const info = asObject(call(runtime?.mind, 'modelInfo'))
    const provider = str(info.provider ?? config?.mind?.provider)
    const model = str(info.model ?? config?.mind?.model)
    const effort = str(info.effort ?? config?.mind?.reasoningEffort)
    const source = str(info.source) || (provider || model ? 'config' : 'dsh-default')
    return { provider, model, effort, source }
  }

  /**
   * 连接信息（§2.1）。网关可能整个没起来。
   * ⚠️ `connected` / `selfId` 都是 getter，getter 内部摸 socket 是可能抛的
   *    （连接正处在半死状态），所以每个都走 safe() —— 状态条画不出来也不能 500。
   */
  function connOf() {
    const config = configOf()
    const gateway = runtime?.gateway
    const startedAt = num(runtime?.startedAt ?? runtime?.controller?.startedAt, 0)
    return {
      connected: bool(safe(() => gateway?.connected, false)),
      selfId: str(safe(() => gateway?.selfId, '') || config?.qq?.selfId),
      uptimeMs: startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0,
      // 网关内部字段叫 rawUrl；老/新版本可能叫 wsUrl；最后退回配置
      wsUrl: str(
        safe(() => gateway?.rawUrl, '') || safe(() => gateway?.wsUrl, '') || config?.qq?.wsUrl,
      ),
    }
  }

  // ── 会话列表（§2.2）：/state 的 modes.counts 也用它，所以抽出来 ──

  /** 把 Lead 补的 `listConversations()` 一条压成面板契约的形状（宽容：缺字段自己补）。 */
  function normalizeConversation(raw) {
    const row = asObject(raw)
    const key = str(row.peerKey).trim() || peerKeyOf(row)
    if (!key) return null
    const scene = str(row.scene) === 'group' || key.startsWith('group-') ? 'group' : 'private'
    const peerId = str(row.peerId) || (scene === 'group' ? key.slice('group-'.length) : key.slice('private-'.length))
    const counts = asObject(row.counts)
    return {
      peerKey: key,
      scene,
      peerId,
      name: str(row.name) || peerId,
      mode: MODES.includes(str(row.mode)) ? str(row.mode) : '',
      role: str(row.role),
      lastAt: num(row.lastAt ?? row.at),
      lastText: str(row.lastText ?? row.text),
      counts: { in: num(counts.in ?? counts.inbound), out: num(counts.out ?? counts.outbound) },
      relation: isPlainObject(row.relation) ? row.relation : null,
      tags: asArray(row.tags).map((tag) => str(tag)).filter(Boolean),
      session: isPlainObject(row.session) ? row.session : null,
      // 群上下文缓存条数（pipeline 的 listConversations 会给；没有就是 0）
      cached: num(row.cached),
    }
  }

  /**
   * `listConversations()` 没交付（或返回空）时的兜底：自己从 `recent` 聚合。
   *
   * 为什么要留这条兜底：会话列表是面板的骨架，`recent` 里有 peerId/scene/direction，
   * 足够画出「谁、什么时候、最后一句、收发各几条」。没有 listConversations 就整块面板空白
   * 是不可接受的（那正是 v0 的样子）。
   */
  function aggregateConversations(recent) {
    const map = new Map()
    for (const entry of recent) {
      const peerKey = peerKeyOf(entry)
      if (!peerKey || peerKey === 'private-' || peerKey === 'group-') continue
      let conv = map.get(peerKey)
      if (!conv) {
        const scene = peerKey.startsWith('group-') ? 'group' : 'private'
        conv = {
          peerKey,
          scene,
          peerId: scene === 'group' ? peerKey.slice('group-'.length) : peerKey.slice('private-'.length),
          name: '',
          mode: '',
          role: '',
          lastAt: 0,
          lastText: '',
          counts: { in: 0, out: 0 },
          relation: null,
          tags: [],
          session: null,
        }
        map.set(peerKey, conv)
      }
      // recent 是时间正序，所以「后写的赢」就是最新状态
      conv.lastAt = Math.max(conv.lastAt, num(entry?.at))
      const dir = directionOf(entry)
      if (dir === 'in') conv.counts.in += 1
      else if (dir === 'out') conv.counts.out += 1
      // 名字取**对方**（in）的：§2.2 的样例里私聊那一行 name 是「主人」，
      // 不是她自己的「茶茶酱」。和 pipeline.listConversations 同一套取法。
      if (dir === 'in' && str(entry?.name)) conv.name = str(entry?.name)
      else if (!conv.name && str(entry?.name)) conv.name = str(entry?.name)
      if (str(entry?.role)) conv.role = str(entry?.role)
      const tags = asArray(entry?.tags).map((tag) => str(tag)).filter(Boolean)
      if (tags.length > 0) conv.tags = tags
      // 轨迹条目的 text 常常是空串（工具调用），这里只认有内容的那条当预览
      if (str(entry?.text)) conv.lastText = str(entry?.text)
    }
    return [...map.values()]
  }

  /**
   * 补 mode / role / relation / session，然后按 lastAt 倒序（§2.2 排序要求）。
   * async 是为了 `listConversations()` —— 同步/异步实现都认。
   */
  async function buildConversations() {
    const config = configOf()
    const fromController = await callAsync(runtime?.controller, 'listConversations')
    let list = []
    if (Array.isArray(fromController) && fromController.length > 0) {
      list = fromController.map((raw) => normalizeConversation(raw)).filter(Boolean)
    }
    if (list.length === 0) {
      list = aggregateConversations(safe(() => asArray(runtime?.controller?.recent), []))
    }

    const sessions = mindSessions()
    for (const conv of list) {
      if (!MODES.includes(conv.mode)) conv.mode = resolveMode(conv.peerKey, config)
      if (!conv.role) conv.role = defaultRoleOf(conv.scene, conv.peerId, config)
      if (!conv.name) conv.name = conv.peerId || conv.peerKey
      if (conv.relation === null) {
        // relation.get() 是只读的（读盘 + 归一，不写回），对群号调也安全
        conv.relation = toRelationBrief(call(runtime?.relation, 'get', conv.peerId))
      }
      if (conv.session === null) conv.session = matchSession(sessions, config, conv.peerKey)
    }

    list.sort((a, b) => num(b.lastAt) - num(a.lastAt))
    return list
  }

  // ── §2.1 GET /chacha-qq/state ──────────────────────────────

  function handleState(request) {
    const rejected = requireGet(request)
    if (rejected) return rejected
    return buildState()
  }

  async function buildState() {
    const config = configOf()
    const snapshot = snapshotOf()
    const conversations = await buildConversations()

    // modes.counts：按会话数，不按消息数 —— 主人问的是「几个对话在哪种模式下」
    const counts = { companion: 0, work: 0 }
    for (const conv of conversations) {
      const mode = str(conv.mode) === 'work' ? 'work' : 'companion'
      counts[mode] += 1
    }

    const stats = asObject(snapshot?.stats ?? runtime?.controller?.stats)
    const groups = asArray(snapshot?.groups).map((group) => ({
      groupId: str(group?.groupId),
      cached: num(group?.cached),
    }))

    return jsonResult({
      ok: true,
      now: Date.now(),
      parts: { ...asObject(runtime?.parts) },
      dataDir: str(runtime?.dataDir),
      conn: connOf(),
      model: modelInfoOf(),
      mind: {
        // available 也是 getter，同样必须 safe
        available: bool(safe(() => runtime?.mind?.available, false)),
        sessions: mindSessions().map(toSessionBrief),
      },
      stats: {
        blocked: num(stats.blocked),
        injected: num(stats.injected),
        replyBlocked: num(stats.replyBlocked),
        byReason: asObject(stats.byReason),
      },
      groups,
      usage: sumUsage(),
      modes: { default: str(config?.modes?.default, 'companion') || 'companion', counts },
      log: logRing(),
    })
  }

  // ── §2.2 GET /chacha-qq/conversations ──────────────────────

  async function handleConversations(request) {
    const rejected = requireGet(request)
    if (rejected) return rejected
    // 契约就是裸数组（不是 {ok, list}），前端直接 map
    return jsonResult(await buildConversations())
  }

  // ── §2.3 GET /chacha-qq/messages ───────────────────────────

  /**
   * 一条 `recent` → 面板一条消息。
   *
   * ⚠️ 两处改名都在**输出侧**做，不动 pipeline（archive / 群管 / 统计还在读它的字段）：
   *   ① `direction` → `dir`（§2.3 的契约名）
   *   ② `toolName/toolArgs/toolResult/toolError` → `name/args/result/error`
   *      pipeline 现在把工具名放在 `toolName`，而 `name` 是给人看的标签（「调用 xxx」）。
   *      §2.3 要的 `name` 是**工具名本身**，所以 kind=tool 时优先取 toolName。
   */
  function toMessage(entry) {
    const kind = str(entry?.kind)
    const message = { at: num(entry?.at), dir: directionOf(entry), text: str(entry?.text) }

    // ② 工具字段改名
    const toolName = str(entry?.toolName)
    const name = kind === 'tool' ? toolName || str(entry?.name) : str(entry?.name)
    if (name) message.name = name

    const args = entry?.args ?? entry?.toolArgs
    if (args !== undefined && args !== null) message.args = args

    const result = entry?.result ?? entry?.toolResult
    if (result !== undefined && result !== null && str(result)) message.result = str(result)

    // §2.3 的样例里 tool 条目带 `"error": false`，所以 tool 一定给布尔；别的有才给
    if (kind === 'tool') message.error = Boolean(entry?.toolError ?? entry?.error ?? false)
    else if (entry?.error) message.error = Boolean(entry.error)

    // 原样也留一份（前端若是按 pipeline 的字段名写的，不至于一片空白；多两个键不花钱）
    if (kind === 'tool') {
      if (toolName) message.toolName = toolName
      if (entry?.toolArgs !== undefined && entry?.toolArgs !== null) message.toolArgs = entry.toolArgs
      if (str(entry?.toolResult)) message.toolResult = str(entry.toolResult)
    }

    // 其余字段原样透传（面板按 kind 画折叠块：思考 / 工具 / 计划 / token）
    for (const field of ['kind', 'userId', 'media', 'role', 'tags', 'chunk', 'chunks', 'tokens', 'plan', 'sessionId']) {
      const value = entry?.[field]
      if (value === undefined || value === null) continue
      if (Array.isArray(value) && value.length === 0) continue
      if (isPlainObject(value) && Object.keys(value).length === 0) continue
      message[field] = value
    }
    return message
  }

  function handleMessages(request) {
    const rejected = requireGet(request)
    if (rejected) return rejected

    const peerKey = str(request?.query?.get?.('peerKey')).trim()
    const limit = parseMessageLimit(request?.query?.get?.('limit'))
    const wanted = normalizePeerKey(peerKey)

    const recent = safe(() => asArray(runtime?.controller?.recent), [])
    const list = []
    for (const entry of recent) {
      const key = peerKeyOf(entry)
      // peerKey 省略 = 全部混在一起（调试用，§2.3）
      if (wanted && normalizePeerKey(key) !== wanted) continue
      list.push(toMessage(entry))
    }
    // 只要最近 limit 条（面板从上往下滚，太多了没必要传）
    return jsonResult(list.slice(-limit))
  }

  // ── §2.4 GET / POST /chacha-qq/config（一个注册项，两个方法） ──

  async function readJsonBody(request, limit) {
    let text
    try {
      text = await request.readBody(limit)
    } catch (error) {
      if (error?.code === 'too-large') {
        return { error: jsonResult({ ok: false, error: `请求体太大（上限 ${Math.round(limit / 1024)}KB）` }, 413) }
      }
      return { error: jsonResult({ ok: false, error: `请求体读不出来：${str(error?.message ?? error)}` }, 400) }
    }
    if (!str(text).trim()) {
      return { error: jsonResult({ ok: false, error: '请求体是空的' }, 400) }
    }
    try {
      return { body: JSON.parse(text) }
    } catch (error) {
      return { error: jsonResult({ ok: false, error: `JSON 解析失败：${str(error?.message ?? error)}` }, 400) }
    }
  }

  /**
   * 读「POST body」，或者 `?payload=<urlencoded JSON>`。
   *
   * 为什么要 payload 这条后路：**Electron 的桥接层会吞掉 POST body**（前端实测），
   * 于是面板侧约定：POST 失败时退回同路径的 `GET ...?payload=<encodeURIComponent(JSON.stringify(body))>`。
   * 不认这条也能跑（只是那种环境下「保存」永远失败并弹错），认了才叫能用。
   *
   * ⚠️ 代价：payload 走 URL，受 Node 的 maxHeaderSize（默认 16KB）限制，
   *    所以配置抽屉里超大的补丁（比如一整段热词）还是走 POST；payload 只是兜底。
   *
   * @returns {Promise<{body?:object, error?:object}>} 和 readJsonBody 同形状，调用方不用改
   */
  async function readBodyOrPayload(request, limit) {
    // URLSearchParams 已经做过百分号解码，这里拿到的是明文 JSON
    const payload = str(request?.query?.get?.('payload'))
    if (payload) {
      if (payload.length > limit) {
        return { error: jsonResult({ ok: false, error: `payload 太长（上限 ${Math.round(limit / 1024)}KB，建议改用 POST body）` }, 413) }
      }
      try {
        return { body: JSON.parse(payload) }
      } catch (error) {
        return { error: jsonResult({ ok: false, error: `payload 不是合法 JSON：${str(error?.message ?? error)}` }, 400) }
      }
    }
    return readJsonBody(request, limit)
  }

  async function handleConfig(request) {
    const method = str(request?.method, 'GET').toUpperCase()
    // ⚠️ 带 ?payload= 的 GET 其实是「写」（Electron 吞 POST body 的兜底），不能当读处理
    const writeViaPayload = method === 'GET' && Boolean(str(request?.query?.get?.('payload')))

    if (method === 'GET' && !writeViaPayload) {
      // 配置是面板的硬依赖：读不到就明说 500，别回一个 {} 让抽屉显示成「全是空的」
      if (typeof runtime?.store?.get !== 'function') {
        note('error', '面板读配置失败：ConfigStore 不可用')
        return jsonResult({ ok: false, error: '配置存储不可用' }, 500)
      }
      return jsonResult({ ok: true, config: configOf() })
    }

    if (method !== 'POST' && !writeViaPayload) {
      return jsonResult({ ok: false, error: `method not allowed: ${method}` }, 405, { allow: 'GET, POST' })
    }

    const { body, error } = await readBodyOrPayload(request, MAX_CONFIG_BODY_BYTES)
    if (error) {
      note('debug', `面板配置保存被拒：${method} ${str(request?.url)}`)
      return error
    }

    // ⚠️ 深合并已经在 ConfigStore.patch 里做了（mergeDeep + sanitizeConfig）。
    //    这里**只透传**，别再 merge 一遍 —— 两份合并逻辑迟早对不上（v2 就栽在这）。
    if (!isPlainObject(body?.patch)) {
      return jsonResult({ ok: false, error: '缺少 patch 对象' }, 400)
    }

    const store = runtime?.store
    if (typeof store?.patch !== 'function') {
      note('error', '面板保存配置失败：ConfigStore 不可用')
      return jsonResult({ ok: false, error: '配置存储不可用' }, 500)
    }

    let next
    try {
      next = store.patch(body.patch)
    } catch (writeError) {
      note('error', '面板保存配置失败：', writeError)
      return jsonResult({ ok: false, error: `保存配置失败：${str(writeError?.message ?? writeError)}` }, 500)
    }

    // 连接参数可能变了（wsUrl / token）：网关自己判「真变了才重连」，没变就什么都不做
    try {
      runtime?.applyConfig?.(next ?? configOf())
    } catch (applyError) {
      note('warn', '应用新配置失败（下次重启生效）：', applyError)
    }

    note('info', `面板已保存配置：${Object.keys(body.patch).join(', ') || '(空补丁)'}`)
    return jsonResult({ ok: true, config: next ?? configOf() })
  }

  // ── §2.5 POST /chacha-qq/action ────────────────────────────

  /**
   * 探一次 NapCat 端口：只连 TCP，不做 OneBot 握手。
   * 为什么够用：端口通了就说明 NapCat 活着；真正的协议层健康在 /state 的 conn/connected 里。
   */
  function probeNapCat() {
    const config = configOf()
    // 优先用**配置里**的 wsUrl：那是主人刚在抽屉里定下的目标。
    // 网关上的 rawUrl 是「当初连的是哪」，配置改完还没 applyConfig 时它会滞后一步，
    // 面板的「测试连接」要测的是主人现在的意图。配置缺了才退回网关/默认值。
    const wsUrl =
      str(config?.qq?.wsUrl) ||
      str(safe(() => runtime?.gateway?.rawUrl, '')) ||
      str(safe(() => runtime?.gateway?.wsUrl, '')) ||
      'ws://127.0.0.1:3001'
    let url
    try {
      url = new URL(wsUrl)
    } catch {
      return Promise.resolve({ ok: false, latencyMs: 0, error: `wsUrl 不合法：${wsUrl}` })
    }

    const secure = url.protocol === 'wss:'
    const host = str(url.hostname).replace(/^\[|\]$/g, '')
    const port = num(url.port, 0) || (secure ? 443 : 80)
    if (!host) return Promise.resolve({ ok: false, latencyMs: 0, error: `wsUrl 里没有主机名：${wsUrl}` })

    const startedAt = Date.now()
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      let socket = null
      const finish = (result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        try {
          socket?.destroy?.()
        } catch {
          // 已经断了
        }
        resolve(result)
      }
      try {
        socket = net.connect({ host, port })
      } catch (error) {
        finish({ ok: false, latencyMs: Date.now() - startedAt, error: str(error?.message ?? error) })
        return
      }
      timer = setTimeout(() => {
        finish({ ok: false, latencyMs: Date.now() - startedAt, error: `连接超时（${PROBE_TIMEOUT_MS} 毫秒）` })
      }, PROBE_TIMEOUT_MS)
      timer.unref?.()
      socket.once('connect', () => finish({ ok: true, latencyMs: Date.now() - startedAt }))
      socket.once('error', (error) => {
        finish({ ok: false, latencyMs: Date.now() - startedAt, error: str(error?.code ?? error?.message ?? error) })
      })
    })
  }

  /**
   * 换代次（清上下文，保留记忆）。
   *
   * ⚠️ 群会话真正的代次键是 `group-<群号>-owner` / `-guest`（pipeline 的 sessionKey），
   *    而面板只有 `group-<群号>`。只给字面键 +1 的话，主人点了「重置会话」其实没重置 ——
   *    这种「假成功」比报错还糟。所以同族键一起 +1，并返回字面键的新代次。
   */
  function bumpGeneration(rawPeerKey) {
    const key = str(rawPeerKey).trim()
    if (!key) return { error: jsonResult({ ok: false, error: '缺少 peerKey' }, 400) }

    const store = runtime?.store
    if (typeof store?.patch !== 'function') {
      note('error', '重置会话失败：ConfigStore 不可用')
      return { error: jsonResult({ ok: false, error: '配置存储不可用' }, 500) }
    }

    const config = configOf()
    const prefix = str(config?.mind?.sessionPrefix, 'qq') || 'qq'
    const before = asObject(config?.sessions?.generations)
    const generations = { ...before }
    const normalized = normalizePeerKey(key)
    const targets = [key]
    if (normalized) {
      for (const existing of Object.keys(before)) {
        if (existing !== key && normalizePeerKey(existing) === normalized) targets.push(existing)
      }
    }

    let primary = 0
    const oldSessionIds = []
    for (const [index, target] of targets.entries()) {
      const previous = num(generations[target], 0)
      generations[target] = previous + 1
      if (index === 0) primary = generations[target]
      // 旧代的活 agent 该拆就拆：archive/ 里那一轮的完整轨迹还在，memory/ 也还在
      oldSessionIds.push(previous > 0 ? `${prefix}-${target}-g${previous}` : `${prefix}-${target}`)
    }

    try {
      store.patch({ sessions: { generations } })
    } catch (error) {
      note('error', '重置会话写盘失败：', error)
      return { error: jsonResult({ ok: false, error: `写配置失败：${str(error?.message ?? error)}` }, 500) }
    }

    for (const sessionId of oldSessionIds) {
      try {
        const disposing = runtime?.mind?.dispose?.(sessionId)
        if (disposing && typeof disposing.catch === 'function') {
          disposing.catch((error) => note('debug', `拆旧会话 ${sessionId} 失败：`, error))
        }
      } catch (error) {
        note('debug', `拆旧会话 ${sessionId} 失败：`, error)
      }
    }

    note('info', `面板重置会话 ${targets.join(', ')} → 第 ${primary} 代`)
    return { generation: primary }
  }

  /** 切模式（companion / work）。写的是 modes.peers，深合并所以别的会话不受影响。 */
  function setMode(rawPeerKey, rawMode) {
    const mode = str(rawMode).trim()
    if (!MODES.includes(mode)) {
      return { error: jsonResult({ ok: false, error: `mode 只能是 ${MODES.join(' / ')}` }, 400) }
    }
    const raw = str(rawPeerKey).trim()
    if (!raw) return { error: jsonResult({ ok: false, error: '缺少 peerKey' }, 400) }

    const store = runtime?.store
    if (typeof store?.patch !== 'function') {
      note('error', '切换模式失败：ConfigStore 不可用')
      return { error: jsonResult({ ok: false, error: '配置存储不可用' }, 500) }
    }

    // 群按键归一到 group-<群号>：面板传什么形状都能落地（modes.js 的 resolveMode 认这个键）
    const key = normalizePeerKey(raw) || raw
    try {
      store.patch({ modes: { peers: { [key]: mode } } })
    } catch (error) {
      note('error', '切换模式写盘失败：', error)
      return { error: jsonResult({ ok: false, error: `保存模式失败：${str(error?.message ?? error)}` }, 500) }
    }

    note('info', `面板切换模式：${key} → ${mode}`)
    return { mode }
  }

  /** 清内存日志环（不动磁盘日志，别把排查证据一起清了）。 */
  function clearLogRing() {
    if (typeof rootLog?.clearRing !== 'function') {
      return { error: jsonResult({ ok: false, error: '日志环不可用' }, 200) }
    }
    try {
      rootLog.clearRing()
      return { done: true }
    } catch (error) {
      note('error', '清日志环失败：', error)
      return { error: jsonResult({ ok: false, error: `清日志失败：${str(error?.message ?? error)}` }, 500) }
    }
  }

  /**
   * 表情包类别（/memes 和 action=list-categories 共用）。
   *
   * 这里**不用** call() 静默吞错：图库目录权限/坏 catalog 是主人能修的故障，
   * 面板上看到空列表时必须能在日志里找到原因（否则又是「面板一片空白、日志一片安静」）。
   */
  function listMemeCategories() {
    if (typeof runtime?.meme?.listCategories !== 'function') return []
    try {
      // 契约是「原样返回」；不是数组就当空
      return asArray(runtime.meme.listCategories())
    } catch (error) {
      note('warn', '读表情包类别失败（面板显示空）：', error)
      return []
    }
  }

  /**
   * 「给自己发一条测试消息」。
   *
   * 走的是 `controller.outbox.push()`，**不直接调 gateway** —— 分片 / 节奏 / Markdown 降级 /
   * 重试这些都在 outbox 里，绕过它发出去的消息在 QQ 上看起来就和正常回复不一样。
   * outbox.push 的 target 形状是 `{ scene, peerId, userId }`（群聊 userId 给空串）。
   */
  async function sendTest(rawPeerKey, rawText) {
    const peerKey = str(rawPeerKey).trim()
    const text = str(rawText).trim()
    if (!peerKey || !text) return { error: jsonResult({ ok: false, error: 'peerKey 和 text 都要' }, 400) }

    const target = parsePeerKey(peerKey)
    if (!target) return { error: jsonResult({ ok: false, error: 'peerKey 解析不了（要 private-xxx / group-xxx）' }, 400) }

    const outbox = runtime?.controller?.outbox
    if (typeof outbox?.push !== 'function') {
      // 503：不是请求写错了，是出站通道还没装配好（Controller 没起来）
      return { error: jsonResult({ ok: false, error: '出站还没就绪' }, 503) }
    }

    try {
      const result = await outbox.push(target, text)
      note('info', `面板测试消息 → ${target.scene}:${target.peerId}（发了 ${result?.sent ?? 0} 片）`)
      return { result }
    } catch (error) {
      note('error', '面板测试消息发送失败：', error)
      return { error: jsonResult({ ok: false, error: `发送失败：${str(error?.message ?? error)}` }, 500) }
    }
  }

  async function handleAction(request) {
    const method = str(request?.method, 'GET').toUpperCase()
    // 同 /config：带 ?payload= 的 GET 是兜底写法，真动作要执行
    const writeViaPayload = method === 'GET' && Boolean(str(request?.query?.get?.('payload')))
    if (method !== 'POST' && !writeViaPayload) {
      return jsonResult({ ok: false, error: `method not allowed: ${method}` }, 405, { allow: 'POST' })
    }

    const { body, error } = await readBodyOrPayload(request, MAX_ACTION_BODY_BYTES)
    if (error) return error

    const action = str(body?.action).trim()
    switch (action) {
      // 对话区底部的「给自己发测试消息」（不动 Mind，只走出站）
      case 'send-test': {
        const sent = await sendTest(body?.peerKey, body?.text)
        if (sent.error) return sent.error
        return jsonResult({ ok: true, sent: num(sent.result?.sent), total: num(sent.result?.total) })
      }

      case 'test-connect': {
        const result = await probeNapCat()
        note('info', `面板探测 NapCat：${result.ok ? `通（${result.latencyMs}ms）` : `不通（${result.error}）`}`)
        // ⚠️ HTTP 200：这是「探测结果」，不是「请求失败」。前端看 body.ok 决定画绿点还是红点
        return jsonResult(result)
      }

      case 'reset-session': {
        const bumped = bumpGeneration(body?.peerKey)
        if (bumped.error) return bumped.error
        return jsonResult({ ok: true, generation: bumped.generation })
      }

      case 'set-mode': {
        const applied = setMode(body?.peerKey, body?.mode)
        if (applied.error) return applied.error
        return jsonResult({ ok: true, mode: applied.mode })
      }

      case 'clear-log': {
        const cleared = clearLogRing()
        if (cleared.error) return cleared.error
        return jsonResult({ ok: true })
      }

      case 'hard-restart': {
        const controller = runtime?.controller
        if (typeof controller?.hardRestart !== 'function') {
          return jsonResult({ ok: false, error: '不支持' })
        }
        try {
          const result = await controller.hardRestart()
          const okFlag = result && typeof result.ok === 'boolean' ? result.ok : true
          note('info', `面板硬重启：${okFlag ? '已发出' : '失败'}`)
          return jsonResult({ ok: okFlag, result: result ?? null })
        } catch (restartError) {
          note('error', '硬重启失败：', restartError)
          return jsonResult({ ok: false, error: str(restartError?.message ?? restartError) })
        }
      }

      // 设计稿 §2.5 里有这一项（配置页要填默认类别），顺带做了，和 GET /memes 同源
      case 'list-categories':
        return jsonResult({ ok: true, categories: listMemeCategories() })

      default:
        note('debug', `面板动作不认识：${action || '(空)'}`)
        return jsonResult({ ok: false, error: 'unknown action' }, 400)
    }
  }

  // ── §2.6 GET /chacha-qq/memes ──────────────────────────────

  function handleMemes(request) {
    const rejected = requireGet(request)
    if (rejected) return rejected
    const categories = listMemeCategories()
    return jsonResult(categories)
  }

  // ── 路由表：**一个路径一项**（GET/POST 在 handler 内部按 method 分支） ──

  const routes = {
    '/chacha-qq/state': handleState,
    '/chacha-qq/conversations': handleConversations,
    '/chacha-qq/messages': handleMessages,
    '/chacha-qq/config': handleConfig,
    '/chacha-qq/action': handleAction,
    '/chacha-qq/memes': handleMemes,
  }

  /**
   * 统一入口（测试直接调它）。
   *
   * @param {object} request
   * @param {string} request.path          已解析的 pathname
   * @param {string} request.method
   * @param {string} [request.url]         带 query 的原始 URL
   * @param {string} [request.remoteAddress]
   * @param {string} [request.host]
   * @param {Function} [request.readBody]  `(limit) => Promise<string>`，超限抛 BodyError
   * @returns {Promise<{status:number, headers:object, text:string}>}
   */
  async function dispatch(request = {}) {
    const path = str(request.path)
    const url = str(request.url) || path
    const method = str(request.method, 'GET').toUpperCase() || 'GET'

    try {
      // ① 来源校验 —— 面板 API 不被 DSH 的 /api 鉴权保护，这一层就是唯一的门
      if (!isLoopbackAddress(request.remoteAddress)) {
        note('warn', `面板端点拒绝非回环请求：${str(request.remoteAddress) || '(无地址)'} ${method} ${path}`)
        return jsonResult({ ok: false, error: 'forbidden' }, 403)
      }
      if (!isLoopbackHost(request.host)) {
        note('warn', `面板端点拒绝非回环 Host：${str(request.host)} ${method} ${path}`)
        return jsonResult({ ok: false, error: 'forbidden' }, 403)
      }

      const handler = routes[path]
      if (typeof handler !== 'function') {
        return jsonResult({ ok: false, error: `unknown endpoint: ${path || '(空)'}` }, 404)
      }

      const readBody =
        typeof request.readBody === 'function'
          ? request.readBody
          : () => Promise.reject(new BodyError('unreadable', '没有可读的请求体'))

      return await handler({ method, url, query: queryOf(url), readBody, remoteAddress: str(request.remoteAddress), host: str(request.host) })
    } catch (error) {
      // ② 最后一道网：任何 handler 抛错都落成 500 JSON，绝不把异常抛回 webServer
      note('error', `面板端点出错（${method} ${path}）：`, error)
      return jsonResult({ ok: false, error: `面板内部错误：${str(error?.message ?? error)}` }, 500)
    }
  }

  /** Node 原生形态（DSH webServer 的真实契约）。 */
  async function node(request, response, fallbackPath = '') {
    const path = pathOf(request?.url) || str(fallbackPath)
    try {
      const result = await dispatch({
        path,
        url: str(request?.url) || path,
        method: str(request?.method, 'GET'),
        // 只认 socket/connection 上的真实地址；x-forwarded-for 是客户端自己写的，不看
        remoteAddress: str(request?.socket?.remoteAddress ?? request?.connection?.remoteAddress),
        host: nodeHeader(request, 'host'),
        readBody: (limit) => readNodeBody(request, limit),
      })
      writeNodeResponse(response, result, request)
    } catch (error) {
      // ③ 连 dispatch 都炸了（理论上不会）：也必须回一个 500，不能吊死请求
      note('error', `面板端点写响应失败（${path}）：`, error)
      try {
        writeNodeResponse(response, jsonResult({ ok: false, error: '面板内部错误' }, 500), request)
      } catch {
        try {
          response?.destroy?.()
        } catch {
          // ignore
        }
      }
    }
  }

  /** Web 标准形态：`Request → Response`。 */
  async function fetchHandler(request) {
    const url = str(request?.url, '/')
    const result = await dispatch({
      path: pathOf(url),
      url,
      method: str(request?.method, 'GET'),
      // 真实 Fetch Request 没有 socket：取不到地址就按外部请求拒绝（失败要关闭）
      remoteAddress: str(request?.socket?.remoteAddress ?? request?.remoteAddress),
      host: headerOf(request, 'host'),
      readBody: (limit) => readFetchBody(request, limit),
    })
    return new Response(result.text, { status: result.status, headers: result.headers })
  }

  /** DSH webServer 按路径注册，给它一个固定闭包的 `(req, res)`。 */
  function nodeHandler(path) {
    return (request, response) => node(request, response, path)
  }

  return {
    paths: Object.keys(routes),
    dispatch,
    node,
    fetch: fetchHandler,
    nodeHandler,
  }
}

// ══════════════════════════════════════════════════════════════
// 装配：往 DSH 的 webServer 上注册
// ══════════════════════════════════════════════════════════════

/**
 * 面板 REST 端点注册。
 *
 * 装配层（index.js）只管把 runtime 递进来；这里负责往 `ctx.get('webServer')` 上挂
 * 6 个精确路由，并把 disposer 原样交回去（卸载 / HMR 时由 Runtime.dispose 调用）。
 *
 * @param {object} options
 * @param {object} options.ctx      cordis Context（要 ctx.get('webServer')）
 * @param {object} options.runtime  装配好的运行时（store/gateway/controller/mind/...，可缺）
 * @param {object} [options.log]    日志器（一般传 runtime.log 或它的 child）
 * @returns {Array<Function>} 所有注册的 disposer
 */
export function registerPanel({ ctx = null, runtime = null, log = null } = {}) {
  const disposers = []
  const logger = log ?? runtime?.log ?? null
  const note = (level, ...args) => {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, ...args)
    } catch {
      // ignore
    }
  }

  // 面板逻辑先建好：webServer 不在也不影响面板对象可用（测试/将来别处挂载）
  const panel = createPanel({ runtime, log })

  let webServer = null
  try {
    webServer = ctx?.get?.('webServer') ?? null
  } catch (error) {
    note('warn', '取 webServer 失败：', error)
  }

  if (!webServer || typeof webServer.register !== 'function') {
    // 没有 webServer 只是「面板看不见」，QQ 功能一点不受影响 —— 所以只 warn 不抛
    note('warn', 'webServer 不可用，面板端点没注册（QQ 功能不受影响）')
    return disposers
  }

  let registered = 0
  for (const path of panel.paths) {
    const handler = panel.nodeHandler(path)
    // kind 必须是 'exact'：同一路径只允许一个精确路由（v2 坑 21），
    // 而且必须显式写 —— DSH 的实现里「不是 exact」一律进 prefix 表。
    const route = { kind: 'exact', path, handler }

    let dispose = null
    try {
      dispose = webServer.register(route)
    } catch (error) {
      // 重复注册：上一次 HMR 的 disposer 没跑到，旧路由还占着位置。
      // 一条冲突就会让整块面板全黑（v2 就这样），所以清掉旧占位再试一次。
      note('warn', `路由 ${path} 注册冲突，清掉旧路由后重试：`, error?.message ?? error)
      try {
        webServer.exact?.delete?.(path)
        webServer.prefixes?.delete?.(path)
      } catch {
        // 内部结构变了就算了，下面还会再试一次
      }
      try {
        dispose = webServer.register(route)
      } catch (again) {
        note('error', `路由 ${path} 注册失败（这个端点面板上看不到）：`, again?.message ?? again)
        dispose = null
      }
    }

    if (typeof dispose === 'function') disposers.push(dispose)
    if (dispose !== null) registered += 1
  }

  note(
    registered > 0 ? 'info' : 'warn',
    `面板端点已注册 ${registered}/${panel.paths.length}：${panel.paths.join(', ')}`,
  )

  return disposers
}
