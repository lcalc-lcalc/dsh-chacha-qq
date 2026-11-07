/**
 * 面板 REST 端点测试（`src/panel/api.js`）。
 *
 * 不需要真的 DSH：DSH 的 `webServer.register` 只做两件事 ——
 * 「按 pathname 找路由」和「把 Node 原生 req/res 交给 handler」，所以这里用
 * 一个**和它同形状**的假 webServer + 一个真 `node:http` 服务器就够真了。
 *
 * 覆盖重点（都是主人点名的雷）：
 *   · 回环校验（面板 API 不在 DSH /api 鉴权内，这层是唯一的门）
 *   · 一个路径一个注册项，GET/POST 在同一个 handler 里分支（v2 坑 21）
 *   · 深合并不顶掉兄弟字段（POST 一个 security.penalty，injectionEnabled 必须还在）
 *   · 坏 JSON / 超长 body / 缺零件 一律不许把 webServer 带崩
 *   · /messages 的 limit 夹在 1~1000；`direction` → `dir` 的输出侧改名
 *   · 没有 listConversations() 时能从 recent 自己聚合出会话
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { group, check, ok, notOk, report } from './harness.mjs'
import { ConfigStore, DEFAULT_CONFIG } from '../src/config.js'
import { createLogger } from '../src/log.js'
import { resolveMode } from '../src/modes.js'
import { PANEL_PATHS, createPanel, registerPanel } from '../src/panel/api.js'

// ══════════════════════════════════════════════════════════════
// 脚手架
// ══════════════════════════════════════════════════════════════

/** 临时数据目录：进程退出时统一清掉（不吞掉异常，免得删一半留垃圾）。 */
const tempDirs = []
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

/** 真 ConfigStore（深合并 / sanitize / 落盘都是真跑，不 mock）。 */
function tempStore(seed = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chacha-v3-panel-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'config.json')
  if (seed) fs.writeFileSync(file, JSON.stringify(seed, null, 2), 'utf8')
  const store = new ConfigStore(file)
  store.load()
  return store
}

/** 只写内存环的日志器（不传 file，测试目录里不留垃圾）。 */
function tempLogger() {
  return createLogger({ level: 'debug', ringSize: 400 })
}

const T0 = Date.now() - 60 * 1000

/**
 * 一份「pipeline 真的会写出来」的 recent。
 *
 * ⚠️ 照抄 `Controller.record()` 现在的字段：
 *   · 方向键叫 `direction`（不是 `dir`）—— 用来验证输出侧改名；
 *   · 工具信息记成 `toolName/toolArgs/toolResult/toolError` —— 用来验证改名回 §2.3 的 name/args/result；
 *   · `tokens` / `plan` 每条轨迹都有这个键（值可能是 null）—— 验证 null 不会被吐给面板。
 */
function sampleRecent() {
  return [
    {
      at: T0,
      direction: 'in',
      scene: 'private',
      peerId: '1111111111',
      groupId: '',
      userId: '1111111111',
      name: '主人',
      text: '茶茶酱早安',
      media: 0,
      role: 'owner',
      tags: ['主人'],
    },
    {
      at: T0 + 1000,
      direction: 'internal',
      kind: 'usage',
      scene: 'private',
      peerId: '1111111111',
      groupId: '',
      userId: '1111111111',
      name: 'token',
      text: '',
      toolName: '',
      toolArgs: null,
      toolResult: '',
      toolError: false,
      tokens: { input: 120, output: 30, total: 150, cacheRead: 0 },
      plan: null,
      role: 'owner',
    },
    {
      at: T0 + 2000,
      direction: 'out',
      scene: 'private',
      peerId: '1111111111',
      groupId: '',
      userId: '1111111111',
      name: '茶茶酱',
      text: '早安呀主人',
      chunks: 2,
      role: 'owner',
      tags: ['主人'],
    },
    {
      at: T0 + 3000,
      direction: 'in',
      scene: 'group',
      peerId: '999',
      groupId: '999',
      userId: '555',
      name: '路人',
      text: '群消息',
      media: 0,
      role: 'guest',
    },
    {
      at: T0 + 3500,
      direction: 'internal',
      kind: 'plan',
      scene: 'group',
      peerId: '999',
      groupId: '999',
      userId: '555',
      name: '计划',
      text: '',
      toolName: '',
      toolArgs: null,
      toolResult: '',
      toolError: false,
      tokens: null,
      plan: [{ content: '翻群历史', status: 'in_progress' }],
      role: 'guest',
    },
    {
      at: T0 + 4000,
      direction: 'internal',
      kind: 'tool',
      scene: 'group',
      peerId: '999',
      groupId: '999',
      userId: '555',
      name: '调用 qq_group_history',
      text: '',
      toolName: 'qq_group_history',
      toolArgs: { count: 3 },
      toolResult: 'ok',
      toolError: false,
      tokens: null,
      plan: null,
      role: 'guest',
    },
  ]
}

/**
 * 造一个「全零件」的运行时；传 `null` 显式抹掉某个零件（测降级）。
 * 用 `'x' in options` 判存在，因为 `null` 是有效输入。
 */
function makeRuntime(options = {}) {
  const recent = options.recent ?? sampleRecent()
  const runtime = {
    store: 'store' in options ? options.store : null,
    gateway:
      'gateway' in options
        ? options.gateway
        : {
          connected: true,
          selfId: '1000000001',
          rawUrl: 'ws://127.0.0.1:3001',
          forceReconnect() {},
        },
    controller:
      'controller' in options
        ? options.controller
        : {
          recent,
          startedAt: Date.now() - 10000,
          stats: { blocked: 2, injected: 1, replyBlocked: 3, byReason: { blocklist: 2 } },
          snapshot() {
            return {
              connected: true,
              selfId: '1000000001',
              groups: [{ groupId: '999', cached: 7 }],
              stats: this.stats,
              mind: { available: true, sessions: [] },
            }
          },
        },
    mind:
      'mind' in options
        ? options.mind
        : {
          available: true,
          modelInfo: () => ({
            provider: 'deepseek-account',
            model: 'deepseek-flash',
            effort: 'max',
            source: 'config',
          }),
          listSessions: () => [
            { sessionId: 'qq-private-1111111111', role: 'owner', mode: 'danger-full-access', events: 210, pressure: 0.17 },
            { sessionId: 'qq-group-999-guest', role: 'guest', mode: 'read-only', events: 12, pressure: 0.03 },
            { sessionId: 'qq-group-999-owner-g2', role: 'owner', mode: 'danger-full-access', events: 5, pressure: 0.01 },
          ],
          dispose: async () => {},
        },
    meme:
      'meme' in options
        ? options.meme
        : {
          listCategories: () => [
            { key: 'happy', name: '开心', hint: '开心的时候用', count: 23 },
            { key: 'sad', name: '难过', hint: '难过的时候用', count: 4 },
          ],
        },
    relation:
      'relation' in options
        ? options.relation
        : {
          // 主人有分数、别人是 0（和真实 RelationStore.get 的返回同形状）
          get: (userId) => ({
            score: String(userId) === '1111111111' ? 620 : 0,
            phase: String(userId) === '1111111111' ? 'close' : 'stranger',
            label: String(userId) === '1111111111' ? '亲近' : '陌生',
            ledger: [],
          }),
        },
    life: 'life' in options ? options.life : { status: () => ({ energy: 80 }) },
    parts: 'parts' in options ? options.parts : { gateway: true, mind: true, controller: true, life: true, meme: true, relation: true },
    dataDir: 'C:\\tmp\\chacha-data',
    startedAt: Date.now() - 5000,
    log: 'log' in options ? options.log : null,
  }
  // 记录「配置保存后有没有真的去热更新」
  runtime.applyConfig = (next) => {
    runtime.appliedConfig = next
  }
  return runtime
}

/**
 * 造一个 Web 形态的请求（有 `.text()`、有 `socket.remoteAddress`、有 Headers）。
 * 用真 `Headers` 是为了顺带测 headerOf 的 `.get()` 分支。
 */
function requestLike({
  pathname = '/chacha-qq/state',
  method = 'GET',
  remoteAddress = '127.0.0.1',
  host = '127.0.0.1:60228',
  body = null,
  rawBody = null,
  withContentLength = true,
} = {}) {
  const text = rawBody !== null ? rawBody : body === null ? '' : JSON.stringify(body)
  const headers = new Headers()
  if (host !== null) headers.set('host', host)
  if (withContentLength && text) headers.set('content-length', String(Buffer.byteLength(text, 'utf8')))
  return {
    method,
    url: `http://127.0.0.1:60228${pathname}`,
    socket: remoteAddress === null ? {} : { remoteAddress },
    headers,
    text: async () => text,
  }
}

/** 调一次面板（Web 形态），返回 { status, headers, json, text }。 */
async function call(panel, options = {}) {
  const response = await panel.fetch(requestLike(options))
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, headers: response.headers, json, text }
}

/** 和 DSH 的 WebServer 同形状的假货：kind 分表、重复 throw、返回 disposer。 */
function fakeWebServer() {
  const exact = new Map()
  const prefixes = new Map()
  return {
    exact,
    prefixes,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
  }
}

/** 假 cordis Context（只实现 ctx.get）。 */
function fakeCtx(services = {}) {
  return {
    get(name) {
      return services[name]
    },
  }
}

/** 起一个真 node:http 服务器，按 DSH 的方式（pathname → 精确路由 → handler(req, res)）分发。 */
function startNodeServer(webServer) {
  const server = http.createServer((request, response) => {
    let pathname = '/'
    try {
      pathname = new URL(request.url, 'http://127.0.0.1').pathname
    } catch {
      pathname = '/'
    }
    const route = webServer.exact.get(pathname)
    if (!route) {
      response.writeHead(404)
      response.end()
      return
    }
    Promise.resolve(route.handler(request, response)).catch(() => {
      try {
        response.destroy()
      } catch {
        // ignore
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 一次性 HTTP 客户端：`agent: false` 保证不留 keep-alive 连接（测试进程要能自己退出）。 */
function httpCall({ port, pathname = '/', method = 'GET', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body)
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        agent: false,
        headers: {
          ...(payload === null ? {} : { 'content-length': Buffer.byteLength(payload, 'utf8') }),
          ...headers,
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: response.statusCode, headers: response.headers, json, text })
        })
      },
    )
    request.on('error', reject)
    if (payload !== null) request.write(payload)
    request.end()
  })
}

/** 拿一个「刚刚还开着、现在关掉了」的端口（用来测连不上）。 */
async function closedPort() {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** 拿一个真的在监听的端口（用来测连得上）。 */
async function openPort() {
  const probe = net.createServer((socket) => socket.end())
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        probe.closeAllConnections?.()
        probe.close(resolve)
      }),
  }
}

// ══════════════════════════════════════════════════════════════
group('导出形状')

ok('PANEL_PATHS 是冻结数组', Array.isArray(PANEL_PATHS) && Object.isFrozen(PANEL_PATHS))
check('端点数量 = 6', PANEL_PATHS.length, 6)
check('路径清单', [...PANEL_PATHS], [
  '/chacha-qq/state',
  '/chacha-qq/conversations',
  '/chacha-qq/messages',
  '/chacha-qq/config',
  '/chacha-qq/action',
  '/chacha-qq/memes',
])
ok('路径没有重复', new Set(PANEL_PATHS).size === PANEL_PATHS.length)
ok('registerPanel 是函数', typeof registerPanel === 'function')
ok('createPanel 是函数', typeof createPanel === 'function')

const shapePanel = createPanel({ runtime: makeRuntime({ store: tempStore() }) })
check('createPanel 的 paths 和 PANEL_PATHS 一致', shapePanel.paths, [...PANEL_PATHS])
ok('createPanel 有 node/fetch/dispatch', typeof shapePanel.node === 'function' && typeof shapePanel.fetch === 'function' && typeof shapePanel.dispatch === 'function')

// ══════════════════════════════════════════════════════════════
group('回环校验（面板 API 唯一的门）')

{
  const logger = tempLogger()
  const panel = createPanel({ runtime: makeRuntime({ store: tempStore() }), log: logger })

  const v4 = await call(panel, { remoteAddress: '127.0.0.1' })
  check('127.0.0.1 通过', v4.status, 200)

  const v6 = await call(panel, { remoteAddress: '::1' })
  check('::1 通过', v6.status, 200)

  const mapped = await call(panel, { remoteAddress: '::ffff:127.0.0.1' })
  check('::ffff:127.0.0.1 通过', mapped.status, 200)

  const external = await call(panel, { remoteAddress: '8.8.8.8' })
  check('8.8.8.8 → 403', external.status, 403)
  check('403 body 是 {ok:false}', external.json?.ok, false)
  ok('403 body 带 error', typeof external.json?.error === 'string' && external.json.error.length > 0)

  const lan = await call(panel, { remoteAddress: '192.168.1.5' })
  check('192.168.1.5 → 403', lan.status, 403)

  const noAddress = await call(panel, { remoteAddress: null })
  check('取不到地址 → 403（失败要关闭）', noAddress.status, 403)

  const evilHost = await call(panel, { host: 'evil.example' })
  check('非回环 Host → 403（防 DNS rebinding）', evilHost.status, 403)

  const localhostHost = await call(panel, { host: 'localhost:60228' })
  check('localhost Host 通过', localhostHost.status, 200)

  const noHost = await call(panel, { host: null })
  check('没有 Host 头放行（没有 Host 就没有 rebinding）', noHost.status, 200)

  const ringText = logger.recent(200).map((entry) => entry.text).join('\n')
  ok('被拒的请求在日志里留了痕', ringText.includes('拒绝非回环'))
}

// ══════════════════════════════════════════════════════════════
group('method 分支（/config 只注册一次，GET/POST 在同一 handler）')

{
  const store = tempStore()
  const runtime = makeRuntime({ store })
  const panel = createPanel({ runtime, log: tempLogger() })

  const getConfig = await call(panel, { pathname: '/chacha-qq/config', method: 'GET' })
  check('GET /config → 200', getConfig.status, 200)
  check('GET /config ok', getConfig.json?.ok, true)
  check('GET 返回完整配置（有 qq 段）', getConfig.json?.config?.qq?.wsUrl, 'ws://127.0.0.1:3001')

  const postConfig = await call(panel, {
    pathname: '/chacha-qq/config',
    method: 'POST',
    body: { patch: { observe: { defaultMinMs: 25000 } } },
  })
  check('POST /config → 200', postConfig.status, 200)
  check('POST 返回保存后的配置', postConfig.json?.config?.observe?.defaultMinMs, 25000)

  const put = await call(panel, { pathname: '/chacha-qq/config', method: 'PUT' })
  check('PUT /config → 405', put.status, 405)
  check('405 带 Allow 头', put.headers.get('allow'), 'GET, POST')

  const del = await call(panel, { pathname: '/chacha-qq/config', method: 'DELETE' })
  check('DELETE /config → 405', del.status, 405)

  const postState = await call(panel, { pathname: '/chacha-qq/state', method: 'POST' })
  check('POST /state → 405（只读端点只认 GET）', postState.status, 405)

  const getAction = await call(panel, { pathname: '/chacha-qq/action', method: 'GET' })
  check('GET /action → 405（只认 POST）', getAction.status, 405)
  check('action 的 405 带 Allow: POST', getAction.headers.get('allow'), 'POST')
}

// ══════════════════════════════════════════════════════════════
group('配置深合并：补丁不许把兄弟字段顶掉')

{
  const store = tempStore()
  const runtime = makeRuntime({ store })
  const panel = createPanel({ runtime, log: tempLogger() })

  const before = await call(panel, { pathname: '/chacha-qq/config' })
  check('初始 security.injectionEnabled', before.json?.config?.security?.injectionEnabled, true)
  check('初始 security.penalty', before.json?.config?.security?.penalty, 'mute-and-block')

  const posted = await call(panel, {
    pathname: '/chacha-qq/config',
    method: 'POST',
    body: { patch: { security: { penalty: 'ban' } } },
  })
  check('POST 只改 penalty', posted.json?.config?.security?.penalty, 'ban')
  check('⚠️ 深合并：injectionEnabled 还在', posted.json?.config?.security?.injectionEnabled, true)
  check('⚠️ 深合并：outputGuard 还在', posted.json?.config?.security?.outputGuard, true)
  check('别的段没被顶掉（observe）', posted.json?.config?.observe?.defaultMinMs, DEFAULT_CONFIG.observe.defaultMinMs)
  check('别的段没被顶掉（qq.wsUrl）', posted.json?.config?.qq?.wsUrl, 'ws://127.0.0.1:3001')

  // 再读一次：落盘生效（不是只改了内存）
  const reread = await call(panel, { pathname: '/chacha-qq/config' })
  check('GET 读回 penalty', reread.json?.config?.security?.penalty, 'ban')
  check('GET 读回 injectionEnabled', reread.json?.config?.security?.injectionEnabled, true)

  check('保存后调了 applyConfig（热更新）', runtime.appliedConfig?.security?.penalty, 'ban')
}

// ══════════════════════════════════════════════════════════════
group('坏请求：坏 JSON / 空 body / 缺 patch')

{
  const store = tempStore()
  const panel = createPanel({ runtime: makeRuntime({ store }), log: tempLogger() })

  const badJson = await call(panel, {
    pathname: '/chacha-qq/config',
    method: 'POST',
    rawBody: '{ this is not json',
  })
  check('坏 JSON → 400', badJson.status, 400)
  check('坏 JSON body ok:false', badJson.json?.ok, false)

  const empty = await call(panel, { pathname: '/chacha-qq/config', method: 'POST', rawBody: '' })
  check('空 body → 400', empty.status, 400)

  const noPatch = await call(panel, { pathname: '/chacha-qq/config', method: 'POST', body: { security: {} } })
  check('缺 patch → 400', noPatch.status, 400)
  check('缺 patch 的错误信息可读', noPatch.json?.error?.includes('patch'), true)

  const badPatch = await call(panel, { pathname: '/chacha-qq/config', method: 'POST', body: { patch: 'nope' } })
  check('patch 不是对象 → 400', badPatch.status, 400)

  const badAction = await call(panel, { pathname: '/chacha-qq/action', method: 'POST', rawBody: '}' })
  check('action 坏 JSON → 400', badAction.status, 400)

  // 连续坏请求之后，服务还得是好的
  const after = await call(panel, { pathname: '/chacha-qq/state' })
  check('坏请求之后 /state 仍然 200（webServer 没崩）', after.status, 200)
  check('坏请求之后配置还在', after.json?.ok, true)
}

// ══════════════════════════════════════════════════════════════
group('超长 body 要拒')

{
  const store = tempStore()
  const runtime = makeRuntime({ store })
  const panel = createPanel({ runtime, log: tempLogger() })
  const huge = JSON.stringify({ patch: { observe: { defaultMinMs: 1 } }, junk: 'x'.repeat(600 * 1024) })

  // ① 带头 content-length 的快路径
  const declared = await call(panel, {
    pathname: '/chacha-qq/config',
    method: 'POST',
    rawBody: huge,
    withContentLength: true,
  })
  check('超长 body（有 content-length）→ 413', declared.status, 413)
  check('413 body ok:false', declared.json?.ok, false)

  // ② 没带 content-length（chunked）的慢路径：读完再量
  const chunked = await call(panel, {
    pathname: '/chacha-qq/config',
    method: 'POST',
    rawBody: huge,
    withContentLength: false,
  })
  check('超长 body（无 content-length）→ 413', chunked.status, 413)

  // ③ /action 的上限更小（64KB）
  const actionHuge = await call(panel, {
    pathname: '/chacha-qq/action',
    method: 'POST',
    rawBody: JSON.stringify({ action: 'clear-log', junk: 'x'.repeat(100 * 1024) }),
  })
  check('/action 超过 64KB → 413', actionHuge.status, 413)

  // ④ 拒了之后配置没被写坏
  check('拒掉的补丁没有落盘', store.get().observe.defaultMinMs, DEFAULT_CONFIG.observe.defaultMinMs)
}

// ══════════════════════════════════════════════════════════════
group('runtime 缺零件：全部降级不抛')

{
  const store = tempStore()
  const runtime = makeRuntime({
    store,
    controller: null,
    mind: null,
    meme: null,
    relation: null,
    gateway: null,
    life: null,
  })
  const panel = createPanel({ runtime, log: tempLogger() })

  const state = await call(panel, { pathname: '/chacha-qq/state' })
  check('controller/mind/meme 全缺：/state 仍 200', state.status, 200)
  check('  · ok true', state.json?.ok, true)
  check('  · mind.available false', state.json?.mind?.available, false)
  check('  · mind.sessions 空', state.json?.mind?.sessions, [])
  check('  · conn.connected false', state.json?.conn?.connected, false)
  check('  · conn.selfId 空串', state.json?.conn?.selfId, '')
  check('  · usage 全 0', state.json?.usage, { todayInput: 0, todayOutput: 0, todayTurns: 0 })
  check('  · modes.counts 全 0', state.json?.modes?.counts, { companion: 0, work: 0 })
  check('  · stats 全 0', state.json?.stats, { blocked: 0, injected: 0, replyBlocked: 0, byReason: {} })
  check('  · log 空数组', state.json?.log, [])
  check('  · groups 空数组', state.json?.groups, [])

  check('没 controller：/conversations 200 + []', (await call(panel, { pathname: '/chacha-qq/conversations' })).json, [])
  check('没 controller：/messages 200 + []', (await call(panel, { pathname: '/chacha-qq/messages' })).json, [])
  check('没 meme：/memes 200 + []', (await call(panel, { pathname: '/chacha-qq/memes' })).json, [])
  check('没 controller：/state 的 modes.counts 仍是 0', (await call(panel, { pathname: '/chacha-qq/state' })).json?.modes?.counts, { companion: 0, work: 0 })
  check('没 meme：action list-categories 空数组', (await call(panel, { pathname: '/chacha-qq/action', method: 'POST', body: { action: 'list-categories' } })).json?.categories, [])

  // clear-log 在没日志器时也不能抛
  const noLoggerPanel = createPanel({ runtime, log: null })
  const clearNoLog = await call(noLoggerPanel, { pathname: '/chacha-qq/action', method: 'POST', body: { action: 'clear-log' } })
  check('没有日志器时 clear-log 也不抛（ok:false）', clearLogOk(clearNoLog), false)
}

function clearLogOk(result) {
  return result?.json?.ok === true
}

// ── 连 runtime 都没有 ────────────────────────────────────────
{
  const panel = createPanel({})
  const state = await call(panel, { pathname: '/chacha-qq/state' })
  check('runtime = null：/state 仍 200', state.status, 200)
  check('  · parts 空对象', state.json?.parts, {})
  check('  · dataDir 空串', state.json?.dataDir, '')

  check('runtime = null：/conversations [] ', (await call(panel, { pathname: '/chacha-qq/conversations' })).json, [])
  check('runtime = null：/messages []', (await call(panel, { pathname: '/chacha-qq/messages' })).json, [])
  check('runtime = null：/memes []', (await call(panel, { pathname: '/chacha-qq/memes' })).json, [])

  const config = await call(panel, { pathname: '/chacha-qq/config' })
  check('runtime = null：GET /config → 500（配置是硬依赖）', config.status, 500)
  check('  且 body 是 {ok:false,error}', config.json?.ok, false)

  const configPost = await call(panel, {
    pathname: '/chacha-qq/config',
    method: 'POST',
    body: { patch: { observe: { defaultMinMs: 1 } } },
  })
  check('runtime = null：POST /config → 500', configPost.status, 500)
}

// ── 零件存在但内部抛错 ──────────────────────────────────────
{
  const throwingGateway = {
    get connected() {
      throw new Error('socket 处于半死状态')
    },
    get selfId() {
      throw new Error('还没 login')
    },
    rawUrl: 'ws://127.0.0.1:3001',
  }
  const throwingController = {
    recent: sampleRecent(),
    snapshot() {
      throw new Error('快照炸了')
    },
  }
  const throwingMeme = {
    listCategories() {
      throw new Error('图库目录权限不对')
    },
  }
  const logger = tempLogger()
  const panel = createPanel({
    runtime: makeRuntime({
      store: tempStore(),
      gateway: throwingGateway,
      controller: throwingController,
      meme: throwingMeme,
      log: logger,
    }),
    log: logger,
  })

  const state = await call(panel, { pathname: '/chacha-qq/state' })
  check('gateway getter 抛错：/state 仍 200', state.status, 200)
  check('  · connected 兜底 false', state.json?.conn?.connected, false)
  check('  · wsUrl 用 rawUrl 兜底', state.json?.conn?.wsUrl, 'ws://127.0.0.1:3001')
  check('controller.snapshot 抛错：stats 兜底 0', state.json?.stats?.blocked, 0)
  check('controller.snapshot 抛错：groups 兜底空', state.json?.groups, [])

  const memes = await call(panel, { pathname: '/chacha-qq/memes' })
  check('meme.listCategories 抛错：/memes 200 + []', memes.status, 200)
  check('  · 返回空数组', memes.json, [])
  ok('meme 出错在日志里留了痕', logger.recent(50).some((entry) => String(entry.text).includes('图库目录权限')))
}

// ══════════════════════════════════════════════════════════════
group('GET /state 字段')

{
  const logger = tempLogger()
  logger.info('面板测试日志 A')
  const store = tempStore({ modes: { peers: { 'group-999': 'work' } } })
  const panel = createPanel({ runtime: makeRuntime({ store, log: logger }), log: logger })

  const state = await call(panel, { pathname: '/chacha-qq/state' })
  const json = state.json ?? {}

  check('ok', json.ok, true)
  ok('now 是数字', typeof json.now === 'number' && Math.abs(json.now - Date.now()) < 10000)
  check('parts 原样', json.parts, { gateway: true, mind: true, controller: true, life: true, meme: true, relation: true })
  check('dataDir', json.dataDir, 'C:\\tmp\\chacha-data')

  check('conn.connected', json.conn?.connected, true)
  check('conn.selfId', json.conn?.selfId, '1000000001')
  ok('conn.uptimeMs > 0', Number(json.conn?.uptimeMs) > 0, String(json.conn?.uptimeMs))
  check('conn.wsUrl', json.conn?.wsUrl, 'ws://127.0.0.1:3001')

  check('model.provider', json.model?.provider, 'deepseek-account')
  check('model.model', json.model?.model, 'deepseek-flash')
  check('model.effort', json.model?.effort, 'max')
  check('model.source', json.model?.source, 'config')

  check('mind.available', json.mind?.available, true)
  check('mind.sessions 条数', json.mind?.sessions?.length, 3)
  check('mind.sessions[0] 字段', json.mind?.sessions?.[0], {
    sessionId: 'qq-private-1111111111',
    role: 'owner',
    mode: 'danger-full-access',
    events: 210,
    pressure: 0.17,
  })

  check('stats.blocked', json.stats?.blocked, 2)
  check('stats.injected', json.stats?.injected, 1)
  check('stats.replyBlocked', json.stats?.replyBlocked, 3)
  check('stats.byReason', json.stats?.byReason, { blocklist: 2 })

  check('groups', json.groups, [{ groupId: '999', cached: 7 }])

  check('usage 今日合计（只算 kind=usage）', json.usage, { todayInput: 120, todayOutput: 30, todayTurns: 1 })

  check('modes.default', json.modes?.default, 'companion')
  check('modes.counts 按会话数', json.modes?.counts, { companion: 1, work: 1 })

  ok('log 是数组', Array.isArray(json.log) && json.log.length > 0)
  ok('log 条目有 at/level/text', json.log.some((entry) => typeof entry.at === 'number' && typeof entry.level === 'string' && String(entry.text).includes('面板测试日志 A')))
}

// ── usage 的今天/昨天、以及缺 tokens 的降级 ──────────────────
{
  const yesterday = Date.now() - 2 * 24 * 60 * 60 * 1000
  const recent = [
    { at: Date.now() - 1000, direction: 'internal', kind: 'usage', scene: 'private', peerId: '1', tokens: { input: 10, output: 5 } },
    { at: yesterday, direction: 'internal', kind: 'usage', scene: 'private', peerId: '1', tokens: { input: 999, output: 999 } },
    { at: Date.now() - 500, direction: 'internal', kind: 'usage', scene: 'private', peerId: '1' },
  ]
  const panel = createPanel({ runtime: makeRuntime({ store: tempStore(), recent, controller: { recent } }), log: tempLogger() })
  const usage = (await call(panel, { pathname: '/chacha-qq/state' })).json?.usage
  check('昨天的 usage 不算今日', usage?.todayInput, 10)
  check('缺 tokens 的 usage 只计一次调用', usage?.todayTurns, 2)
  check('0 token 不会变成 NaN', usage?.todayOutput, 5)
}

// ══════════════════════════════════════════════════════════════
group('/conversations：没有 listConversations 就自己从 recent 聚合')

{
  const store = tempStore({ modes: { peers: { 'group-999': 'work' } } })
  const panel = createPanel({ runtime: makeRuntime({ store }), log: tempLogger() })

  const result = await call(panel, { pathname: '/chacha-qq/conversations' })
  check('/conversations → 200', result.status, 200)
  const list = result.json ?? []
  check('聚合出 2 个会话', list.length, 2)

  const group = list.find((row) => row.peerKey === 'group-999')
  const priv = list.find((row) => row.peerKey === 'private-1111111111')
  ok('群会话在', Boolean(group))
  ok('私聊会话在', Boolean(priv))

  check('按 lastAt 倒序（群最新）', list[0]?.peerKey, 'group-999')
  ok('lastAt 是数字且倒序', Number(list[0]?.lastAt) >= Number(list[1]?.lastAt))

  check('私聊 counts', priv?.counts, { in: 1, out: 1 })
  check('群 counts（工具轨迹不算收发）', group?.counts, { in: 1, out: 0 })
  check('lastText 取最新一条有内容的', priv?.lastText, '早安呀主人')
  check('群 lastText 跳过空文本的轨迹', group?.lastText, '群消息')

  check('mode：modes.peers 覆盖生效', group?.mode, 'work')
  check('mode：默认 companion', priv?.mode, 'companion')
  check('role：主人私聊 = owner', priv?.role, 'owner')
  check('role：群 = guest', group?.role, 'guest')
  check('scene', [priv?.scene, group?.scene], ['private', 'group'])
  check('peerId', priv?.peerId, '1111111111')
  check('name 取对方（in）的名字，不是她自己的', priv?.name, '主人')
  check('tags 带出来', priv?.tags, ['主人'])

  check('relation 映射成 {score,phase,label}', priv?.relation, { score: 620, phase: 'close', label: '亲近' })
  check('群的 relation 也查得到（陌生）', group?.relation?.phase, 'stranger')

  check('session 按 sessionId 匹配（私聊）', priv?.session, {
    sessionId: 'qq-private-1111111111',
    events: 210,
    pressure: 0.17,
  })
  // 群有 owner/guest 两条会话，取活跃的那条（guest 12 > owner 5）
  check('session 按 sessionId 匹配（群，取活跃那条）', group?.session?.sessionId, 'qq-group-999-guest')
}

// ── 关系模块缺失：relation 给 null，不抛 ────────────────────
{
  const panel = createPanel({ runtime: makeRuntime({ store: tempStore(), relation: null }), log: tempLogger() })
  const list = (await call(panel, { pathname: '/chacha-qq/conversations' })).json ?? []
  check('没 relation 模块：relation = null', list[0]?.relation, null)
  check('没 relation 模块：其它字段照给', list[0]?.peerKey, 'group-999')
}

// ══════════════════════════════════════════════════════════════
group('/conversations：Lead 的 listConversations() 优先')

{
  // ① 有就用，且补齐 mode/relation/session
  const controller = {
    recent: sampleRecent(),
    listConversations: () => [
      {
        peerKey: 'private-42',
        scene: 'private',
        peerId: '42',
        name: '路人甲',
        lastAt: T0 + 9999,
        lastText: '你好',
        counts: { in: 2, out: 1 },
        cached: 12,
      },
    ],
  }
  let panel = createPanel({ runtime: makeRuntime({ store: tempStore(), controller }), log: tempLogger() })
  let list = (await call(panel, { pathname: '/chacha-qq/conversations' })).json ?? []
  check('listConversations 优先（不受 recent 干扰）', list.length, 1)
  check('保留 Lead 给的字段', list[0]?.name, '路人甲')
  check('保留 Lead 给的群缓存条数', list[0]?.cached, 12)
  check('补上 mode', list[0]?.mode, 'companion')
  check('补上 role（非主人）', list[0]?.role, 'guest')
  check('补上 relation', list[0]?.relation?.phase, 'stranger')
  check('补上 session（没匹配 → null）', list[0]?.session, null)
  check('counts 原样', list[0]?.counts, { in: 2, out: 1 })

  // ② 返回空数组 → 回落到 recent 聚合
  const emptyController = { recent: sampleRecent(), listConversations: () => [] }
  panel = createPanel({ runtime: makeRuntime({ store: tempStore(), controller: emptyController }), log: tempLogger() })
  list = (await call(panel, { pathname: '/chacha-qq/conversations' })).json ?? []
  check('listConversations 返回空 → 回落聚合', list.length, 2)

  // ③ 返回垃圾 → 回落聚合
  const brokenController = { recent: sampleRecent(), listConversations: () => null }
  panel = createPanel({ runtime: makeRuntime({ store: tempStore(), controller: brokenController }), log: tempLogger() })
  list = (await call(panel, { pathname: '/chacha-qq/conversations' })).json ?? []
  check('listConversations 返回 null → 回落聚合', list.length, 2)
}

// ══════════════════════════════════════════════════════════════
group('/messages：字段、改名、过滤、limit 夹取')

{
  const panel = createPanel({ runtime: makeRuntime({ store: tempStore() }), log: tempLogger() })

  const all = await call(panel, { pathname: '/chacha-qq/messages' })
  check('/messages → 200', all.status, 200)
  check('省略 peerKey = 全部', all.json?.length, 6)

  const first = all.json?.[0] ?? {}
  check('输出用 dir 而不是 direction', first.dir, 'in')
  check('不再输出 direction', first.direction, undefined)
  check('at 原样', first.at, T0)
  check('text 原样', first.text, '茶茶酱早安')
  check('role 带出来', first.role, 'owner')

  const usage = all.json?.find((row) => row.kind === 'usage')
  check('usage 条目带 tokens', usage?.tokens, { input: 120, output: 30, total: 150, cacheRead: 0 })
  check('usage 条目 dir=internal', usage?.dir, 'internal')
  check('usage 条目没有把 null 的 plan 吐出去', usage?.plan, undefined)

  const tool = all.json?.find((row) => row.kind === 'tool')
  // pipeline 记的是 toolName/toolArgs/toolResult/toolError → 面板契约是 name/args/result/error
  check('tool 的 name = 工具名（不是「调用 xxx」标签）', tool?.name, 'qq_group_history')
  check('tool 的 args = toolArgs', tool?.args, { count: 3 })
  check('tool 的 result = toolResult', tool?.result, 'ok')
  check('tool 的 error = toolError', tool?.error, false)

  const plan = all.json?.find((row) => row.kind === 'plan')
  check('plan 条目带 todo 列表', plan?.plan, [{ content: '翻群历史', status: 'in_progress' }])
  check('plan 条目 name 保留人话标签', plan?.name, '计划')

  const out = all.json?.find((row) => row.dir === 'out')
  check('out 条目带 chunks', out?.chunks, 2)

  // 按 peerKey 过滤
  const groupMsgs = await call(panel, { pathname: '/chacha-qq/messages?peerKey=group-999' })
  check('peerKey=group-999 → 3 条', groupMsgs.json?.length, 3)
  check('  全是群的', groupMsgs.json?.every((row) => row.dir !== undefined && row.text !== undefined), true)

  const ownerKey = await call(panel, { pathname: '/chacha-qq/messages?peerKey=group-999-owner' })
  check('peerKey 归一（group-999-owner → group-999）', ownerKey.json?.length, 3)

  const privMsgs = await call(panel, { pathname: '/chacha-qq/messages?peerKey=private-1111111111' })
  check('peerKey=private-1111111111 → 3 条', privMsgs.json?.length, 3)

  const unknown = await call(panel, { pathname: '/chacha-qq/messages?peerKey=private-1' })
  check('没有这个会话 → []', unknown.json, [])

  // limit 夹取
  const zero = await call(panel, { pathname: '/chacha-qq/messages?limit=0' })
  check('limit=0 被夹到 1', zero.json?.length, 1)
  check('  · 返回的是最后一条', zero.json?.[0]?.at, T0 + 4000)

  const negative = await call(panel, { pathname: '/chacha-qq/messages?limit=-1' })
  check('limit=-1 被夹到 1', negative.json?.length, 1)

  const huge = await call(panel, { pathname: '/chacha-qq/messages?limit=99999' })
  check('limit=99999 只受数据量限制', huge.json?.length, 6)

  const nan = await call(panel, { pathname: '/chacha-qq/messages?limit=abc' })
  check('limit=abc → 默认 200', nan.json?.length, 6)
}

// ── limit 的硬上限 1000（拿 1200 条数据才测得出来）────────────
{
  const many = []
  for (let index = 0; index < 1200; index += 1) {
    many.push({ at: T0 + index, direction: 'in', scene: 'private', peerId: '7', text: `m${index}`, role: 'guest' })
  }
  const runtime = makeRuntime({ store: tempStore(), recent: many, controller: { recent: many } })
  const panel = createPanel({ runtime, log: tempLogger() })

  const defaults = await call(panel, { pathname: '/chacha-qq/messages' })
  check('1200 条数据、默认 limit = 200', defaults.json?.length, 200)
  check('  · 取的是最新的', defaults.json?.[199]?.text, 'm1199')

  const capped = await call(panel, { pathname: '/chacha-qq/messages?limit=99999' })
  check('limit=99999 被夹在 1000', capped.json?.length, 1000)
  check('  · 起点是第 200 条', capped.json?.[0]?.text, 'm200')
  check('  · 终点是最新', capped.json?.[999]?.text, 'm1199')
}

// ══════════════════════════════════════════════════════════════
group('/action：按钮动作')

{
  const store = tempStore()
  const runtime = makeRuntime({ store })
  const logger = tempLogger()
  runtime.log = logger
  const panel = createPanel({ runtime, log: logger })
  const act = (body) => call(panel, { pathname: '/chacha-qq/action', method: 'POST', body })

  // test-connect 通
  const live = await openPort()
  try {
    store.patch({ qq: { wsUrl: `ws://127.0.0.1:${live.port}` } })
    const reachable = await act({ action: 'test-connect' })
    check('test-connect → 200', reachable.status, 200)
    check('  · ok true', reachable.json?.ok, true)
    ok('  · latencyMs 是数字', typeof reachable.json?.latencyMs === 'number')
    notOk('  · 通的时候没有 error 字段', 'error' in (reachable.json ?? {}))
  } finally {
    await live.close()
  }

  // test-connect 不通
  const dead = await closedPort()
  store.patch({ qq: { wsUrl: `ws://127.0.0.1:${dead}` } })
  const unreachable = await act({ action: 'test-connect' })
  check('test-connect 连不上也是 200（结果是结果，不是请求失败）', unreachable.status, 200)
  check('  · ok false', unreachable.json?.ok, false)
  ok('  · 有 error 说明', typeof unreachable.json?.error === 'string' && unreachable.json.error.length > 0)

  // test-connect wsUrl 不合法
  store.patch({ qq: { wsUrl: 'not-a-url' } })
  const badUrl = await act({ action: 'test-connect' })
  check('wsUrl 不合法 → ok:false', badUrl.json?.ok, false)
  ok('  · error 提到 wsUrl', String(badUrl.json?.error).includes('wsUrl'))
  store.patch({ qq: { wsUrl: 'ws://127.0.0.1:3001' } })

  // reset-session
  const reset1 = await act({ action: 'reset-session', peerKey: 'private-1111111111' })
  check('reset-session → ok', reset1.json?.ok, true)
  check('  · generation = 1', reset1.json?.generation, 1)
  check('  · 落盘了', store.get().sessions.generations['private-1111111111'], 1)

  const reset2 = await act({ action: 'reset-session', peerKey: 'private-1111111111' })
  check('再点一次 → generation = 2', reset2.json?.generation, 2)

  // 别的代次不许被顶掉（深合并）
  store.patch({ sessions: { generations: { 'private-111': 3 } } })
  await act({ action: 'reset-session', peerKey: 'private-1111111111' })
  check('reset 不动其它会话的代次', store.get().sessions.generations['private-111'], 3)
  check('  · 目标会话到第 3 代', store.get().sessions.generations['private-1111111111'], 3)

  // 群会话：同族键一起 +1（否则点了等于没点）
  store.patch({ sessions: { generations: { 'group-999-owner': 1, 'group-999-guest': 2 } } })
  const resetGroup = await act({ action: 'reset-session', peerKey: 'group-999' })
  check('群 reset → 字面键 generation = 1', resetGroup.json?.generation, 1)
  check('  · owner 同族键也 +1', store.get().sessions.generations['group-999-owner'], 2)
  check('  · guest 同族键也 +1', store.get().sessions.generations['group-999-guest'], 3)

  const resetNoKey = await act({ action: 'reset-session' })
  check('reset-session 缺 peerKey → 400', resetNoKey.status, 400)

  // set-mode
  const setWork = await act({ action: 'set-mode', peerKey: 'group-999-owner', mode: 'work' })
  check('set-mode → ok', setWork.json?.ok, true)
  check('  · 返回 mode', setWork.json?.mode, 'work')
  check('  · 群键归一化后写进 peers', store.get().modes.peers['group-999'], 'work')
  check('  · resolveMode 真的认（按群生效）', resolveMode('group-999-guest', store.get()), 'work')

  const setBad = await act({ action: 'set-mode', peerKey: 'group-999', mode: 'turbo' })
  check('非法 mode → 400', setBad.status, 400)
  check('  · 配置没被写坏', store.get().modes.peers['group-999'], 'work')

  const setNoKey = await act({ action: 'set-mode', peerKey: '', mode: 'work' })
  check('set-mode 缺 peerKey → 400', setNoKey.status, 400)

  // clear-log
  logger.info('清之前的一条')
  ok('清之前日志环里有东西', logger.recent(10).length > 0)
  const cleared = await act({ action: 'clear-log' })
  check('clear-log → ok', cleared.json?.ok, true)
  check('  · 日志环空了', logger.recent(10).length, 0)

  // hard-restart：Controller 没实现
  const noRestart = await act({ action: 'hard-restart' })
  check('hard-restart 不支持 → ok:false', noRestart.json?.ok, false)
  check('  · 说明是「不支持」', noRestart.json?.error, '不支持')

  // hard-restart：Controller 实现了
  let restarted = 0
  const restartingController = {
    recent: sampleRecent(),
    snapshot: () => ({}),
    hardRestart: async () => {
      restarted += 1
      return { ok: true, restarted: true }
    },
  }
  const restartPanel = createPanel({ runtime: makeRuntime({ store, controller: restartingController }), log: logger })
  const restart = await call(restartPanel, { pathname: '/chacha-qq/action', method: 'POST', body: { action: 'hard-restart' } })
  check('hard-restart 支持 → ok:true', restart.json?.ok, true)
  check('  · 真的调了一次', restarted, 1)

  // 不认识的 action
  const unknown = await act({ action: 'dance' })
  check('未知 action → 400', unknown.status, 400)
  check('  · error = unknown action', unknown.json?.error, 'unknown action')

  // list-categories（设计稿 §2.5 里的那一项）
  const categories = await act({ action: 'list-categories' })
  check('list-categories → 2 类', categories.json?.categories?.length, 2)
}

// ══════════════════════════════════════════════════════════════
group('/action send-test：给自己发测试消息（走出站，不碰 Mind）')

{
  const store = tempStore()
  const pushes = []
  const controller = {
    recent: sampleRecent(),
    outbox: {
      async push(target, text) {
        pushes.push({ target, text })
        return { sent: 2, total: 2, cancelled: false }
      },
    },
  }
  const panel = createPanel({ runtime: makeRuntime({ store, controller }), log: tempLogger() })
  const act = (body) => call(panel, { pathname: '/chacha-qq/action', method: 'POST', body })

  const privateSend = await act({ action: 'send-test', peerKey: 'private-1111111111', text: '测试一下' })
  check('send-test → ok', privateSend.json?.ok, true)
  check('  · 走的是 outbox.push（不是 gateway）', pushes.length, 1)
  check('  · target 形状（私聊 userId = QQ）', pushes[0]?.target, { scene: 'private', peerId: '1111111111', userId: '1111111111' })
  check('  · 文本原样', pushes[0]?.text, '测试一下')
  check('  · 回传发了几片', privateSend.json?.sent, 2)

  const groupSend = await act({ action: 'send-test', peerKey: 'group-999', text: '群测试' })
  check('send-test 群：target 形状（userId 空串）', pushes[1]?.target, { scene: 'group', peerId: '999', userId: '' })
  check('  · 也成功', groupSend.json?.ok, true)

  check('缺 text → 400', (await act({ action: 'send-test', peerKey: 'private-1' })).status, 400)
  check('缺 peerKey → 400', (await act({ action: 'send-test', text: 'x' })).status, 400)
  check('peerKey 解析不了 → 400', (await act({ action: 'send-test', peerKey: 'nonsense', text: 'x' })).status, 400)
  check('空白文本 → 400', (await act({ action: 'send-test', peerKey: 'private-1', text: '   ' })).status, 400)

  // 出站没装配好：503（请求没错，是通道没起来）
  const noOutbox = createPanel({
    runtime: makeRuntime({ store: tempStore(), controller: { recent: [] } }),
    log: tempLogger(),
  })
  const notReady = await call(noOutbox, {
    pathname: '/chacha-qq/action',
    method: 'POST',
    body: { action: 'send-test', peerKey: 'private-1', text: 'x' },
  })
  check('Controller 没有 outbox → 503', notReady.status, 503)
  check('  · 说明是「出站还没就绪」', notReady.json?.error, '出站还没就绪')

  // 发送本身失败（网关断开）→ 500，并记日志
  const sendLogger = tempLogger()
  const throwingOutbox = createPanel({
    runtime: makeRuntime({
      store: tempStore(),
      controller: {
        recent: [],
        outbox: {
          async push() {
            throw new Error('网关断开')
          },
        },
      },
      log: sendLogger,
    }),
    log: sendLogger,
  })
  const failed = await call(throwingOutbox, {
    pathname: '/chacha-qq/action',
    method: 'POST',
    body: { action: 'send-test', peerKey: 'private-1', text: 'x' },
  })
  check('outbox.push 抛错 → 500', failed.status, 500)
  ok('  · 失败在日志里留了痕', sendLogger.recent(50).some((entry) => String(entry.text).includes('网关断开')))
}

// ══════════════════════════════════════════════════════════════
group('?payload= 兜底（Electron 桥接会吞掉 POST body）')

{
  const store = tempStore()
  const panel = createPanel({ runtime: makeRuntime({ store }), log: tempLogger() })
  const withPayload = (pathname, body) => `${pathname}?payload=${encodeURIComponent(JSON.stringify(body))}`

  // ① /config：带 payload 的 GET 是「写」，不是「读」
  const patchPayload = { patch: { observe: { defaultMinMs: 31000 } } }
  const configSave = await call(panel, { pathname: withPayload('/chacha-qq/config', patchPayload), method: 'GET' })
  check('GET /config?payload= → 200', configSave.status, 200)
  check('  · 真的存下了（不是只读）', configSave.json?.config?.observe?.defaultMinMs, 31000)
  check('  · 深合并照旧', configSave.json?.config?.security?.injectionEnabled, true)
  check('  · 落盘了', store.get().observe.defaultMinMs, 31000)

  // ② /action：带 payload 的 GET 会执行动作
  const actionPayload = { action: 'set-mode', peerKey: 'group-999', mode: 'work' }
  const actionRun = await call(panel, { pathname: withPayload('/chacha-qq/action', actionPayload), method: 'GET' })
  check('GET /action?payload= → 200', actionRun.status, 200)
  check('  · 动作真的执行了', actionRun.json?.mode, 'work')
  check('  · 配置里也落地了', store.get().modes.peers['group-999'], 'work')

  // ③ POST 带 payload 也认（payload 优先于 body）
  const postPayload = await call(panel, {
    pathname: withPayload('/chacha-qq/config', { patch: { observe: { defaultMinMs: 32000 } } }),
    method: 'POST',
    body: { patch: { observe: { defaultMinMs: 1 } } },
  })
  check('POST 同时带 body 和 payload：payload 优先', postPayload.json?.config?.observe?.defaultMinMs, 32000)

  // ④ payload 坏了 → 400，不乱写
  const before = store.get().observe.defaultMinMs
  const badPayload = await call(panel, { pathname: '/chacha-qq/config?payload=%7Bnot-json', method: 'GET' })
  check('坏 payload → 400', badPayload.status, 400)
  check('  · 配置没被写坏', store.get().observe.defaultMinMs, before)

  // ⑤ 没有 payload 时行为完全不变（普通 GET 仍然只读；普通 GET /action 仍然 405）
  const plainGet = await call(panel, { pathname: '/chacha-qq/config', method: 'GET' })
  check('普通 GET /config 仍然只读', plainGet.json?.ok, true)
  check('  · 读到的是最新值', plainGet.json?.config?.observe?.defaultMinMs, 32000)
  check('普通 GET /action 仍然 405', (await call(panel, { pathname: '/chacha-qq/action', method: 'GET' })).status, 405)
  check('PUT /config?payload= 仍然 405', (
    await call(panel, { pathname: withPayload('/chacha-qq/config', { patch: {} }), method: 'PUT' })
  ).status, 405)

  // ⑥ payload 太长 → 413（URL 不是拿来传大补丁的）
  const hugePayload = encodeURIComponent(JSON.stringify({ patch: { observe: {} }, junk: 'x'.repeat(600 * 1024) }))
  const tooLong = await call(panel, { pathname: `/chacha-qq/config?payload=${hugePayload}`, method: 'GET' })
  check('payload 超过上限 → 413', tooLong.status, 413)
}

// ══════════════════════════════════════════════════════════════
group('/memes：图库概览')

{
  const runtime = makeRuntime({ store: tempStore() })
  const panel = createPanel({ runtime, log: tempLogger() })
  const result = await call(panel, { pathname: '/chacha-qq/memes' })
  check('/memes → 200', result.status, 200)
  check('原样返回类别数组', result.json, runtime.meme.listCategories())
  check('是裸数组（不是 {ok,list}）', Array.isArray(result.json), true)
}

// ══════════════════════════════════════════════════════════════
group('registerPanel 装配')

{
  const store = tempStore()
  const runtime = makeRuntime({ store })
  const logger = tempLogger()
  const webServer = fakeWebServer()
  const disposers = registerPanel({ ctx: fakeCtx({ webServer }), runtime, log: logger })

  check('注册了 6 个端点', webServer.exact.size, 6)
  check('disposer 也是 6 个', disposers.length, 6)
  ok('全部是 exact 路由（同路径只允许一个）', [...webServer.exact.values()].every((route) => route.kind === 'exact'))
  ok('每个 handler 都是函数', [...webServer.exact.values()].every((route) => typeof route.handler === 'function'))
  check('注册的路径 = PANEL_PATHS', [...webServer.exact.keys()].sort(), [...PANEL_PATHS].sort())
  check('没有多余的前缀路由', webServer.prefixes.size, 0)

  // /config 只有一个注册项，却同时服务 GET 和 POST（v2 坑 21 的反面验证）。
  // 真的 GET/POST/PUT 三连在下面「真 Node HTTP」那一组打，这里只确认「只有一项」。
  const configRoute = webServer.exact.get('/chacha-qq/config')
  ok('/config 只有一项注册', Boolean(configRoute))
  check('/config 的 handler 是同一个函数', webServer.exact.get('/chacha-qq/config'), configRoute)
  check('/config 没有第二个注册项', [...webServer.exact.keys()].filter((key) => key === '/chacha-qq/config').length, 1)

  // 拆干净
  for (const dispose of disposers) dispose()
  check('disposer 全部生效后路由清空', webServer.exact.size, 0)

  ok('注册在日志里留了痕', logger.recent(50).some((entry) => String(entry.text).includes('面板端点已注册')))
}

// ── 没有 webServer / ctx：不抛、返回空数组 ──────────────────
{
  const runtime = makeRuntime({ store: tempStore() })
  check('ctx 里没有 webServer → 返回 []', registerPanel({ ctx: fakeCtx({}), runtime, log: tempLogger() }), [])
  check('ctx = null → 返回 []', registerPanel({ ctx: null, runtime, log: tempLogger() }), [])
  check('什么都不传 → 返回 []', registerPanel({}), [])
  check('webServer 不是对象 → 返回 []', registerPanel({ ctx: fakeCtx({ webServer: { register: null } }), runtime }), [])
}

// ── 上一次 HMR 留下的旧路由（disposer 没跑到）要能自救 ──────
{
  const webServer = fakeWebServer()
  // 模拟一个占着位置、但没有 disposer 的旧路由（v2 里就是这样让面板全黑的）
  webServer.exact.set('/chacha-qq/state', { kind: 'exact', path: '/chacha-qq/state', handler() {} })
  const logger = tempLogger()
  const runtime = makeRuntime({ store: tempStore() })
  const disposers = registerPanel({ ctx: fakeCtx({ webServer }), runtime, log: logger })

  check('冲突的旧路由被清掉并重新注册', webServer.exact.size, 6)
  check('仍然拿到 6 个 disposer', disposers.length, 6)
  ok('冲突在日志里记了一笔', logger.recent(50).some((entry) => String(entry.text).includes('注册冲突')))
  ok('新 handler 不是旧的那个空函数', webServer.exact.get('/chacha-qq/state').handler.length >= 1)
}

// ── webServer.register 一直抛：不抛出去，返回空数组 ─────────
{
  const brokenWebServer = {
    register() {
      throw new Error('webServer 内部坏了')
    },
  }
  const logger = tempLogger()
  let threw = false
  let disposers = null
  try {
    disposers = registerPanel({
      ctx: fakeCtx({ webServer: brokenWebServer }),
      runtime: makeRuntime({ store: tempStore() }),
      log: logger,
    })
  } catch {
    threw = true
  }
  notOk('webServer.register 一直抛也不往外抛', threw)
  check('拿不到 disposer 就返回空数组', disposers, [])
  ok('失败在日志里留了痕', logger.recent(50).some((entry) => String(entry.text).includes('注册失败')))
}

/** 用「路由表里的 handler」跑一次 Web 形态请求（不经过 node:http）。 */

// ── 返回垃圾 / 抛错 / 写成 async → 都要认 ──────────────────
{
  const throwingController = {
    recent: sampleRecent(),
    listConversations() {
      throw new Error('聚合炸了')
    },
  }
  const panel = createPanel({ runtime: makeRuntime({ store: tempStore(), controller: throwingController }), log: tempLogger() })
  const list = (await call(panel, { pathname: '/chacha-qq/conversations' })).json ?? []
  check('listConversations 抛错 → 回落聚合（面板不许空白）', list.length, 2)
}

// ── Lead 把 listConversations() 写成 async 也要认 ──────────
{
  const asyncController = {
    recent: sampleRecent(),
    async listConversations() {
      return [{ peerKey: 'private-77', scene: 'private', peerId: '77', name: '异步会话', lastAt: T0 + 8888, counts: { in: 1, out: 0 } }]
    },
  }
  let panel = createPanel({ runtime: makeRuntime({ store: tempStore(), controller: asyncController }), log: tempLogger() })
  let list = (await call(panel, { pathname: '/chacha-qq/conversations' })).json ?? []
  check('async listConversations 也能用（不是当没有）', list.length, 1)
  check('  · 用的是它返回的数据', list[0]?.name, '异步会话')

  const rejectingController = {
    recent: sampleRecent(),
    async listConversations() {
      throw new Error('异步也炸')
    },
  }
  panel = createPanel({ runtime: makeRuntime({ store: tempStore(), controller: rejectingController }), log: tempLogger() })
  list = (await call(panel, { pathname: '/chacha-qq/conversations' })).json ?? []
  check('async listConversations 拒绝 → 回落聚合', list.length, 2)
}

// ══════════════════════════════════════════════════════════════
group('存储 / 热更新写坏时：明确报错，不许抛')

{
  // ① ConfigStore 的 patch 抛错 → 500（不是 200 假成功）
  const badStore = {
    get: () => ({}),
    patch() {
      throw new Error('磁盘满了')
    },
  }
  const panel = createPanel({ runtime: makeRuntime({ store: badStore }), log: tempLogger() })

  const postBad = await call(panel, { pathname: '/chacha-qq/config', method: 'POST', body: { patch: { observe: {} } } })
  check('store.patch 抛错 → POST /config 500', postBad.status, 500)
  check('  · 带上原因', String(postBad.json?.error).includes('磁盘满了'), true)

  const setModeBad = await call(panel, {
    pathname: '/chacha-qq/action',
    method: 'POST',
    body: { action: 'set-mode', peerKey: 'group-1', mode: 'work' },
  })
  check('store.patch 抛错 → set-mode 500', setModeBad.status, 500)

  const resetBad = await call(panel, {
    pathname: '/chacha-qq/action',
    method: 'POST',
    body: { action: 'reset-session', peerKey: 'private-1' },
  })
  check('store.patch 抛错 → reset-session 500', resetBad.status, 500)

  // ② 网关热更新抛错：配置已经存下了，不能因为网关闹脾气就回 500
  const runtime = makeRuntime({ store: tempStore() })
  runtime.applyConfig = () => {
    throw new Error('网关正在重连')
  }
  const hotPanel = createPanel({ runtime, log: tempLogger() })
  const hot = await call(hotPanel, { pathname: '/chacha-qq/config', method: 'POST', body: { patch: { observe: { defaultMinMs: 13000 } } } })
  check('applyConfig 抛错 → 仍然 200（配置已保存）', hot.status, 200)
  check('  · 配置确实存下了', hot.json?.config?.observe?.defaultMinMs, 13000)
}

// ══════════════════════════════════════════════════════════════
group('乱传参数：一律给出可解析的响应（不许抛）')

{
  const panel = createPanel({ runtime: makeRuntime({ store: tempStore() }), log: tempLogger() })

  const cases = [
    ['PATCH /state', { pathname: '/chacha-qq/state', method: 'PATCH' }, 405],
    ['空 limit', { pathname: '/chacha-qq/messages?limit=' }, 200],
    ['limit=1e9（夹到 1000）', { pathname: '/chacha-qq/messages?limit=1e9' }, 200],
    ['limit=1.9（向下取整）', { pathname: '/chacha-qq/messages?limit=1.9' }, 200],
    ['body 是数组', { pathname: '/chacha-qq/config', method: 'POST', body: [1, 2, 3] }, 400],
    ['body 是 null', { pathname: '/chacha-qq/config', method: 'POST', rawBody: 'null' }, 400],
    ['action 是数字', { pathname: '/chacha-qq/action', method: 'POST', body: { action: 123 } }, 400],
    ['路径带尾斜杠', { pathname: '/chacha-qq/state/' }, 200],
  ]
  for (const [name, options, expected] of cases) {
    const result = await call(panel, options)
    check(`${name} → ${expected}`, result.status, expected)
  }

  // 所有响应都必须是合法 JSON
  const all = []
  for (const [, options] of cases) all.push(await call(panel, options))
  ok('乱传参数也一律返回合法 JSON', all.every((item) => item.json !== null))

  check('limit=1e9 真的夹住了', (await call(panel, { pathname: '/chacha-qq/messages?limit=1e9' })).json?.length, 6)
  check('limit=1.9 向下取整成 1', (await call(panel, { pathname: '/chacha-qq/messages?limit=1.9' })).json?.length, 1)
}

// ══════════════════════════════════════════════════════════════
group('真 Controller 联调：不喂假数据，跑一条真消息再读面板')

{
  // 这一组不用手搓的 recent：真的把一条 QQ 包喂进 Controller，
  // 让它自己跑完 record()，再确认面板读到的字段和 pipeline 现在写的一致。
  // 目的：pipeline 的 listConversations()/record() 将来再改，这里会立刻红。
  const { Controller } = await import('../src/controller/pipeline.js')
  const interestModule = await import('../src/controller/interest.js')
  const tagsModule = await import('../src/controller/tags.js')
  const securityModule = await import('../src/controller/security.js')
  const moderationModule = await import('../src/controller/moderation.js')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chacha-v3-panel-int-'))
  tempDirs.push(dir)
  const store = new ConfigStore(path.join(dir, 'config.json'))
  store.load()
    // ⚠️ 显式配 owner：开源版 DEFAULT_CONFIG.owner.qq 是**空**的
    //    （不能把开发者的号写进默认值）。不配的话这条消息会被当陌生人 ——
    //    兴趣掷骰可能不过，recent 就是空的，后面一连串断言全跟着红。
    store.patch({ owner: { qq: '1111111111', name: '主人' }, rhythm: { minGapMs: 0, maxGapMs: 0 }, log: { level: 'silent' } })

  const calls = []
  const gateway = {
    selfId: '1000000001',
    connected: true,
    on() {},
    connect() {},
    close() {},
    async call(action, params) {
      calls.push({ action, params })
      return { ok: true, data: {} }
    },
  }
  const mind = {
    available: true,
    live: new Map(),
    asked: [],
    async ask(request) {
      this.asked.push(request)
      if (typeof request.onDelta === 'function') request.onDelta('主人早安呀')
      return { text: '主人早安呀', trace: [], reason: 'completed', elapsedMs: 1 }
    },
  }
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }
  const controller = new Controller({
    ctx: {},
    store,
    log: quiet,
    gateway,
    mind,
    observe: null,
    interest: interestModule,
    tags: tagsModule,
    security: securityModule,
    moderation: moderationModule,
    dataDir: dir,
  })

  controller.onPacket({
    post_type: 'message',
    message_type: 'private',
    message_id: 'panel-1',
    user_id: 1111111111,
    self_id: 1000000001,
    raw_message: '茶茶早安',
    message: [{ type: 'text', data: { text: '茶茶早安' } }],
    sender: { user_id: 1111111111, nickname: '主人' },
    time: Math.floor(Date.now() / 1000),
  })
  await new Promise((resolve) => setTimeout(resolve, 300))

  ok('真 Controller 的 recent 里有记录了', controller.recent.length > 0, `recent=${controller.recent.length}`)
  const hasDir = controller.recent.every((entry) => entry.direction !== undefined)
  ok('record() 用的仍然是 direction 键', hasDir)

  const runtime = {
    store,
    gateway,
    controller,
    mind: null,
    meme: null,
    relation: null,
    parts: { gateway: true, controller: true },
    dataDir: dir,
    startedAt: Date.now() - 1000,
    log: tempLogger(),
  }
  const panel = createPanel({ runtime, log: runtime.log })

  const conversations = (await call(panel, { pathname: '/chacha-qq/conversations' })).json ?? []
  check('真 listConversations() → 1 个会话', conversations.length, 1)
  check('  · peerKey', conversations[0]?.peerKey, 'private-1111111111')
  check('  · scene', conversations[0]?.scene, 'private')
  check('  · name（对方昵称）', conversations[0]?.name, '主人')
  check('  · mode（resolveMode 落地）', conversations[0]?.mode, 'companion')
  check('  · role', conversations[0]?.role, 'owner')
  check('  · counts（1 in / 1 out）', conversations[0]?.counts, { in: 1, out: 1 })
  check('  · lastText 是她的回复', conversations[0]?.lastText, '主人早安呀')
  ok('  · lastAt 有值', Number(conversations[0]?.lastAt) > 0)

  const messages = (await call(panel, { pathname: '/chacha-qq/messages?peerKey=private-1111111111' })).json ?? []
  check('真 record() 的两条都读得到（in + out）', messages.length, 2)
  check('  · dir 改名生效（in）', messages[0]?.dir, 'in')
  check('  · dir 改名生效（out）', messages[1]?.dir, 'out')
  check('  · 原文', messages[0]?.text, '茶茶早安')
  check('  · 回复', messages[1]?.text, '主人早安呀')

  const state = (await call(panel, { pathname: '/chacha-qq/state' })).json ?? {}
  check('真 Controller 的 /state ok', state.ok, true)
  check('  · modes.counts 算到一个 companion 会话', state.modes?.counts, { companion: 1, work: 0 })
  check('  · stats 形状齐全', Object.keys(state.stats ?? {}).sort(), ['blocked', 'byReason', 'injected', 'replyBlocked'])

  controller.stop()

  // ③ 真 pipeline 的 set-mode 写入后，面板立刻反映（同一份 store）
  const setMode = await call(panel, {
    pathname: '/chacha-qq/action',
    method: 'POST',
    body: { action: 'set-mode', peerKey: 'private-1111111111', mode: 'work' },
  })
  check('真 Controller 在场时 set-mode 生效', setMode.json?.ok, true)
  const afterMode = (await call(panel, { pathname: '/chacha-qq/conversations' })).json ?? []
  check('  · 面板立刻读到 work', afterMode[0]?.mode, 'work')
}

// ══════════════════════════════════════════════════════════════
group('真 Node HTTP（DSH 的 req/res 契约，端到端）')

{
  const store = tempStore()
  const pushes = []
  const controller = {
    recent: sampleRecent(),
    snapshot: () => ({ groups: [{ groupId: '999', cached: 7 }], stats: { blocked: 0, injected: 0, replyBlocked: 0, byReason: {} } }),
    outbox: {
      async push(target, text) {
        pushes.push({ target, text })
        return { sent: 1, total: 1, cancelled: false }
      },
    },
  }
  const runtime = makeRuntime({ store, controller })
  const logger = tempLogger()
  const webServer = fakeWebServer()
  registerPanel({ ctx: fakeCtx({ webServer }), runtime, log: logger })
  const { server, port } = await startNodeServer(webServer)

  try {
    const state = await httpCall({ port, pathname: '/chacha-qq/state' })
    check('GET /state → 200', state.status, 200)
    check('  · JSON 合法且 ok', state.json?.ok, true)
    check('  · 状态条字段在', state.json?.conn?.connected, true)
    check('  · content-type', state.headers['content-type'], 'application/json; charset=utf-8')
    check('  · cache-control', state.headers['cache-control'], 'no-store')

    const conversations = await httpCall({ port, pathname: '/chacha-qq/conversations' })
    check('GET /conversations → 200', conversations.status, 200)
    check('  · 是数组', Array.isArray(conversations.json), true)
    check('  · 聚合出 2 个会话', conversations.json?.length, 2)

    const messages = await httpCall({ port, pathname: '/chacha-qq/messages?peerKey=group-999&limit=1' })
    check('GET /messages?peerKey&limit → 200', messages.status, 200)
    check('  · limit=1 生效', messages.json?.length, 1)
    check('  · dir 字段在', messages.json?.[0]?.dir, 'internal')

    const config = await httpCall({ port, pathname: '/chacha-qq/config' })
    check('GET /config → 200', config.status, 200)
    check('  · 有完整配置', config.json?.config?.modes?.default, 'companion')

    const saved = await httpCall({
      port,
      pathname: '/chacha-qq/config',
      method: 'POST',
      body: { patch: { security: { penalty: 'ban' } } },
    })
    check('POST /config → 200', saved.status, 200)
    check('  · penalty 改了', saved.json?.config?.security?.penalty, 'ban')
    check('  · ⚠️ 兄弟字段还在', saved.json?.config?.security?.injectionEnabled, true)

    const put = await httpCall({ port, pathname: '/chacha-qq/config', method: 'PUT' })
    check('PUT /config → 405', put.status, 405)

    // 「给自己发测试消息」真的走出去（真机 HTTP 路径）
    const sendTest = await httpCall({
      port,
      pathname: '/chacha-qq/action',
      method: 'POST',
      body: { action: 'send-test', peerKey: 'private-1111111111', text: '真机测试' },
    })
    check('POST /action send-test → 200', sendTest.status, 200)
    check('  · 走到 outbox.push', pushes[0]?.target, { scene: 'private', peerId: '1111111111', userId: '1111111111' })
    check('  · 文本到了', pushes[0]?.text, '真机测试')

    // Electron 吞 POST body 的兜底：GET ?payload=
    const payloadPath = `/chacha-qq/config?payload=${encodeURIComponent(JSON.stringify({ patch: { moderation: { defaultBanMinutes: 33 } } }))}`
    const viaPayload = await httpCall({ port, pathname: payloadPath })
    check('GET /config?payload= → 200（Node 路径也认）', viaPayload.status, 200)
    check('  · 真的写进配置', viaPayload.json?.config?.moderation?.defaultBanMinutes, 33)

    const badJson = await httpCall({ port, pathname: '/chacha-qq/config', method: 'POST', body: '{oops' })
    check('坏 JSON → 400', badJson.status, 400)
    check('  · ok:false', badJson.json?.ok, false)

    // 坏请求之后服务还得活着
    const after = await httpCall({ port, pathname: '/chacha-qq/state' })
    check('坏请求之后 /state 仍 200（webServer 没崩）', after.status, 200)

    // 超长 body：content-length 快路径
    const hugeBody = JSON.stringify({ patch: { observe: { defaultMinMs: 1 } }, junk: 'x'.repeat(600 * 1024) })
    const huge = await httpCall({ port, pathname: '/chacha-qq/config', method: 'POST', body: hugeBody })
    check('超长 body → 413', huge.status, 413)
    check('  · 413 后连接被要求关闭', huge.headers.connection, 'close')
    check('  · 超长补丁没落盘', store.get().observe.defaultMinMs, DEFAULT_CONFIG.observe.defaultMinMs)

    // Host 头伪造（DNS rebinding）
    const spoofed = await httpCall({ port, pathname: '/chacha-qq/state', headers: { host: 'evil.example' } })
    check('Host 伪造 → 403', spoofed.status, 403)

    // 最后再确认一次活着
    const last = await httpCall({ port, pathname: '/chacha-qq/sate' })
    check('不存在的路径 → 404（测试路由器给的）', last.status, 404)
    const alive = await httpCall({ port, pathname: '/chacha-qq/state' })
    check('跑完这一切之后 /state 仍然 200', alive.status, 200)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

// ══════════════════════════════════════════════════════════════
report('面板 REST 端点')
