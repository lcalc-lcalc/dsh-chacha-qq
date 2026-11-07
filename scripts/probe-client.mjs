/**
 * scripts/probe-client.mjs — 没有浏览器时，怎么证明「面板能起、两条槽位注册对」
 *
 * 为什么要有这个探针：
 *  - client.js 不是 ESM，`node --check` 只能证明「语法能被解析」；
 *  - 面板真正崩掉的地方是「factory 里的某个 require 拿到 undefined」「注册参数写错」
 *    「按 kind 提前 return 让 hooks 数量变化」这类**运行时**问题；
 *  - 宿主没有可编程浏览器，只能自己造一个最小运行时把组件真跑一遍。
 *
 * 做四件事：
 *   1. 静态检查：无 BOM、无 import/export、无 defaultValue、颜色全走宿主变量、必备变量在
 *   2. 用假 `window.__ModuleLoader__` 把 client.js 跑起来，拿到 { id, factory }
 *   3. 假 ctx 调一次 apply()，断言两条注册的参数（sidebar.panellist + main key）
 *   4. 迷你 React 运行时把组件真正渲染一遍（不起定时器、不联网），夹具覆盖各种轨迹 kind
 *
 * 跑法：node scripts/probe-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG } from '../src/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const clientFile = path.join(root, 'client.js')

let pass = 0
const failures = []

function ok(name, extra) {
  pass += 1
  console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`)
}

function bad(name, detail) {
  failures.push(name)
  console.log(`  ✗ ${name}${detail ? `\n      → ${detail}` : ''}`)
}

function check(name, condition, detail) {
  if (condition) ok(name)
  else bad(name, detail)
}

function group(title) {
  console.log(`\n${title}`)
}

/** 极简断言包装：让某一段渲染失败也能继续跑后面的用例。 */
function attempt(name, fn) {
  try {
    const value = fn()
    ok(name)
    return value
  } catch (error) {
    bad(name, error?.stack ? String(error.stack).split('\n').slice(0, 4).join('\n      ') : String(error))
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// 0. 读文件
// ─────────────────────────────────────────────────────────────
const bytes = fs.readFileSync(clientFile)
const source = bytes.toString('utf8')

console.log('=== dsh-chacha-qq · 面板前端探针 ===')
console.log(`文件：${clientFile}`)
console.log(`大小：${bytes.length} 字节 · ${source.split('\n').length} 行`)

// ─────────────────────────────────────────────────────────────
// 1. 静态检查（这些是「面板不出来」的高发区）
// ─────────────────────────────────────────────────────────────
group('1. 静态检查')

check('UTF-8 无 BOM', !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
  `前 3 字节：${bytes[0].toString(16)} ${bytes[1].toString(16)} ${bytes[2].toString(16)}`)

const importHits = source.match(/^\s*(?:import|export)\s/mg) ?? []
check('没有 import / export 语句（不是 ESM）', importHits.length === 0, `命中 ${importHits.length} 处`)

// 静态检查只在「代码」上做：注释里写「不用 defaultValue」不算违规。
// 这个文件的注释全是整行（// 或 * 开头），所以按行过滤足够，不用写正则剥注释机。
const code = source.split('\n').filter((line) => {
  const trimmed = line.trim()
  return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('*/'))
}).join('\n')

const defaultValueHits = code.match(/defaultValue\s*[:=]/g) ?? []
check('没有 defaultValue（v2 坑 19：配置还没到时会把输入框定死成空）',
  defaultValueHits.length === 0, `命中 ${defaultValueHits.length} 处`)

const hexHits = code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
check('没有写死颜色（#fff / #000 之类）', hexHits.length === 0, `命中：${hexHits.join(', ')}`)

const requiredVars = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-border-l3',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-font-family',
]
const missingVars = requiredVars.filter((name) => !source.includes(name))
check('契约要求的宿主 CSS 变量都用到了', missingVars.length === 0, `缺：${missingVars.join(', ')}`)

check('有 mountStyle + data-plugin 标记', source.includes('data-plugin="dsh-chacha-qq"'))
check('三个轮询都有 clearInterval', (source.match(/clearInterval\(/g) ?? []).length >= 3,
  `clearInterval 出现 ${(source.match(/clearInterval\(/g) ?? []).length} 次`)
check('切会话用 seq 守卫（三个轮询各自比对 seq）',
  /my !== stateSeq\.current/.test(source)
  && /my !== convSeq\.current/.test(source)
  && /my !== msgSeq\.current/.test(source))
check('两种会话覆盖表都写了（modes.peers / interest / meme.steal.peers）',
  source.includes("'peers', peerKey") && source.includes("'interest', 'users'"))

// 「非法值不发 POST」光靠渲染证明不了：还要确认保存路径本身绕不过那道闸。
// 面板里唯一写配置的地方必须是 postConfig(...)；直接 api('/config', {method:'POST'}) 一律算漏。
check('保存配置只走 postConfig 这道闸（没有绕过校验直接 POST /config 的路径）',
  (source.match(/api\('\/config'\s*,\s*\{\s*method:\s*'POST'/g) ?? []).length === 0
  && source.includes('await postConfig(api, patch)'))

// 语法：等价于 `node --check`（按脚本、不是按模块解析）
attempt('语法可解析（vm.Script，等价 node --check）', () => {
  // eslint-disable-next-line no-new
  new vm.Script(source, { filename: 'client.js' })
})

// ─────────────────────────────────────────────────────────────
// 2. 假 React / 假 require / 假 document，把 factory 跑起来
// ─────────────────────────────────────────────────────────────
group('2. factory 能不能起')

function fakeCreateElement(type, props, ...children) {
  const merged = { ...(props || {}) }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged }
}

/** 第一趟用「stub 版」React：只要求 factory 能执行完，不渲染。 */
const stubReact = {
  createElement: fakeCreateElement,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

function makeRequire(react, primitives = {}) {
  return function fakeRequire(name) {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`probe 没准备这个依赖：${name}`)
  }
}

function makeDocument() {
  const appended = []
  return {
    appended,
    head: {
      appendChild(node) {
        appended.push(node)
      },
    },
    querySelector() {
      return null
    },
    createElement() {
      const attrs = {}
      return {
        attrs,
        textContent: '',
        removed: false,
        setAttribute(key, value) {
          attrs[key] = value
        },
        remove() {
          this.removed = true
        },
      }
    },
  }
}

/**
 * 把 client.js 跑起来。
 * `instrument` = true 时在注册段前插一行，把内部组件挂到 globalThis 上给渲染测试用
 * （只在探针里做，交付的 client.js 一个字都不改）。
 */
function execute({ react, primitives = {}, instrument = false } = {}) {
  let loaded = null
  const window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  }
  const document = makeDocument()
  const effects = []
  const registrations = []
  const injected = []
  const registerDepth = []
  let injectDepth = 0

  let runSource = source
  if (instrument) {
    const anchor = '    // ──────────────────────────── 注册 ────────────────────────────'
    const hits = runSource.split(anchor).length - 1
    if (hits !== 1) throw new Error(`插桩锚点命中 ${hits} 次（期望 1 次），client.js 结构变了`)
    runSource = runSource.replace(anchor, [
      '    globalThis.__CQ_INTERNALS__ = {',
      '      TopBar, ConversationList, ChatMessage, TraceRow, Composer, ChatArea, ConfigDrawer,',
      '      PeerOverrideCard, ChachaPanel, ChachaIcon,',
      '      normalizeState, normalizeMessage, normalizeConversation, normalizeModel,',
      '      deriveConversations, messagesFromState, resolveModeLocal,',
      '      FEATURES, featureOnHere, featurePeerValue, nextFeatureTri, featureTriText,',
      '      pruneFeaturePeers, normalizePeerKeyLocal, setPathIn, unsetPathIn,',
      '      parseCsv, parseNumMap, formatNumMap, fmtTokens, msToSec, secToMs, clip,',
      '      validateMind, postConfig, effortText, effortBadge, EFFORT_VALUES,',
      '    }',
      anchor,
    ].join('\n'))
  }

  // 不联网、不起真实定时器：探针里 fetch 永远 reject，setInterval 只登记不触发
  const timers = []
  const setIntervalStub = (fn, ms) => {
    const timer = { fn, ms, cleared: false }
    timers.push(timer)
    return timers.length
  }
  const clearIntervalStub = (id) => {
    const timer = timers[id - 1]
    if (timer) timer.cleared = true
  }

  // eslint-disable-next-line no-new-func
  const runner = new Function(
    'window', 'document', 'fetch', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    runSource,
  )
  runner(
    window,
    document,
    () => Promise.reject(new Error('probe: 不联网')),
    console,
    () => 0,
    () => {},
    setIntervalStub,
    clearIntervalStub,
  )

  const definition = loaded
  const plugin = definition && typeof definition.factory === 'function'
    ? definition.factory(makeRequire(react, primitives))
    : null

  const ctx = {
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
      return () => {}
    },
    get() {
      return undefined
    },
    slots: {
      inject(name, fn) {
        injected.push(name)
        injectDepth += 1
        try {
          return fn()
        } finally {
          injectDepth -= 1
        }
      },
      register(options, component) {
        registerDepth.push(injectDepth > 0)
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  return {
    definition,
    plugin,
    ctx,
    document,
    effects,
    registrations,
    injected,
    registerDepth,
    timers,
  }
}

let run = null
attempt('用假 window.__ModuleLoader__ 执行 client.js', () => {
  run = execute({ react: stubReact })
})

check('加载器拿到了 definition', Boolean(run?.definition))
check('id === "dsh-chacha-qq"', run?.definition?.id === 'dsh-chacha-qq', `实际：${run?.definition?.id}`)
check('factory 是函数', typeof run?.definition?.factory === 'function')

const plugin = run?.plugin
check('plugin 是对象', Boolean(plugin && typeof plugin === 'object'))
check('plugin.inject 里有 "slots"', Array.isArray(plugin?.inject) && plugin.inject.includes('slots'),
  `实际：${JSON.stringify(plugin?.inject)}`)
check('plugin.apply 是函数', typeof plugin?.apply === 'function')

// ─────────────────────────────────────────────────────────────
// 3. apply(fakeCtx) → 两条槽位注册
// ─────────────────────────────────────────────────────────────
group('3. apply(fakeCtx) 的槽位注册')

attempt('apply 不抛异常', () => {
  plugin.apply(run.ctx)
})

check('注入的槽位顺序 = sidebar.panellist → main',
  JSON.stringify(run.injected) === JSON.stringify(['sidebar.panellist', 'main']),
  `实际：${JSON.stringify(run.injected)}`)
check('注册了正好 2 条', run.registrations.length === 2, `实际：${run.registrations.length}`)
check('每次 register 都在 slots.inject 里（硬规则 2）',
  run.registerDepth.length === 2 && run.registerDepth.every(Boolean),
  `实际：${JSON.stringify(run.registerDepth)}`)

const [sideReg, mainReg] = run.registrations
check('① 侧边栏 name === "sidebar.panellist"', sideReg?.options?.name === 'sidebar.panellist',
  JSON.stringify(sideReg?.options))
check('① 侧边栏 id === "chacha-qq"', sideReg?.options?.id === 'chacha-qq', JSON.stringify(sideReg?.options))
check('① 侧边栏有 order 数字 + label',
  typeof sideReg?.options?.order === 'number' && typeof sideReg?.options?.label === 'string' && sideReg.options.label.length > 0,
  JSON.stringify(sideReg?.options))
check('① 侧边栏组件是函数（ChachaIcon）', typeof sideReg?.component === 'function')

check('② 整页面板 name === "main"', mainReg?.options?.name === 'main', JSON.stringify(mainReg?.options))
check('② 整页面板 key === "chacha-qq"（与侧边栏 id 同名，硬规则 3）',
  mainReg?.options?.key === 'chacha-qq', JSON.stringify(mainReg?.options))
check('② 整页面板组件是函数（ChachaPanel）', typeof mainReg?.component === 'function')

// 加功能开关不该碰注册段：这条是「一字未改」的兜底，键顺序也一起比。
check('两条槽位注册参数一字未改（逐字比对）',
  JSON.stringify(sideReg?.options) === JSON.stringify({
    name: 'sidebar.panellist', id: 'chacha-qq', order: -30, label: '茶茶酱的 QQ',
  })
  && JSON.stringify(mainReg?.options) === JSON.stringify({ name: 'main', key: 'chacha-qq' }),
  `实际：${JSON.stringify(sideReg?.options)} / ${JSON.stringify(mainReg?.options)}`)

check('样式挂到 <head> 一次', run.document.appended.length === 1, `实际：${run.document.appended.length}`)
const styleNode = run.document.appended[0]
check('样式节点带 data-plugin="dsh-chacha-qq"', styleNode?.attrs?.['data-plugin'] === 'dsh-chacha-qq')
check('CSS 非空（> 4000 字符）', String(styleNode?.textContent ?? '').length > 4000,
  `实际：${String(styleNode?.textContent ?? '').length}`)
check('ctx.effect 拿到清理函数（卸载时回收样式）', typeof run.effects[0]?.disposer === 'function')

const styleCleanup = attempt('清理函数真的 remove() 了样式节点', () => {
  run.effects[0].disposer()
  return styleNode.removed
})
check('样式节点已被移除', styleCleanup === true)

console.log('\n  注册参数（原样）：')
for (const [index, registration] of run.registrations.entries()) {
  console.log(`    slot #${index + 1}: ${JSON.stringify(registration.options)}`)
  console.log(`              组件: ${registration.component?.name || '(匿名)'}`)
}

// ─────────────────────────────────────────────────────────────
// 4. 迷你 React 运行时：把组件真跑一遍
// ─────────────────────────────────────────────────────────────
group('4. 渲染冒烟（迷你 React 运行时，不联网、不起定时器）')

let currentHooks = null
/**
 * 强制某个 useState 的初值。
 * 轨迹默认是折叠的（open=false），展开态才有 ✔ / 参数 / 结果这些细节；
 * 探针用它把 `open` 直接顶成 true，不用真的模拟点击。
 */
let stateOverrides = null

const renderReact = {
  createElement: fakeCreateElement,
  useState(init) {
    if (!currentHooks) throw new Error('useState 在组件外被调用')
    const index = currentHooks.index
    currentHooks.index += 1
    if (!(index in currentHooks.states)) {
      const forced = stateOverrides ? stateOverrides(index, init) : null
      currentHooks.states[index] = forced && 'value' in forced
        ? forced.value
        : (typeof init === 'function' ? init() : init)
    }
    return [
      currentHooks.states[index],
      (next) => {
        const prev = currentHooks.states[index]
        currentHooks.states[index] = typeof next === 'function' ? next(prev) : next
      },
    ]
  },
  // 只登记不执行：面板里的 effect 会起轮询/读 fetch，探针不跑它们
  useEffect(fn, deps) {
    if (!currentHooks) throw new Error('useEffect 在组件外被调用')
    currentHooks.index += 1
    currentHooks.effects.push({ fn, deps })
  },
  useRef(init) {
    if (!currentHooks) throw new Error('useRef 在组件外被调用')
    const index = currentHooks.index
    currentHooks.index += 1
    if (!(index in currentHooks.states)) currentHooks.states[index] = { current: init }
    return currentHooks.states[index]
  },
  useMemo(fn) {
    if (!currentHooks) throw new Error('useMemo 在组件外被调用')
    currentHooks.index += 1
    return fn()
  },
  useCallback(fn) {
    if (!currentHooks) throw new Error('useCallback 在组件外被调用')
    currentHooks.index += 1
    return fn
  },
}

function renderComponent(type, props) {
  const previous = currentHooks
  const frame = { index: 0, states: [], effects: [] }
  currentHooks = frame
  try {
    const output = type(props)
    if (output && typeof output.then === 'function') {
      throw new Error(`${type.name} 的渲染返回了 Promise`)
    }
    return output
  } finally {
    currentHooks = previous
  }
}

/** 把 h() 树展开成「只剩宿主元素」的树（函数组件就地调用）。 */
function expand(node, depth = 0) {
  if (node === null || node === undefined || node === true || node === false) return null
  if (Array.isArray(node)) {
    return node.map((item) => expand(item, depth + 1)).filter((item) => item !== null)
  }
  if (typeof node !== 'object') return node
  if (depth > 120) throw new Error('渲染树超过 120 层（有递归组件？）')

  const { type, props } = node
  if (typeof type === 'function') {
    return expand(renderComponent(type, props), depth + 1)
  }
  if (typeof type !== 'string') {
    throw new Error(`渲染出非法元素 type：${String(type)}`)
  }
  const nextProps = { ...(props || {}) }
  if (props && props.children !== undefined) {
    nextProps.children = expand(props.children, depth + 1)
  }
  return { type, props: nextProps }
}

/** 展平收集所有元素节点，方便断言。 */
function collect(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  if (node.props && node.props.children !== undefined) collect(node.props.children, out)
  return out
}

function renderTree(label, type, props) {
  return attempt(`渲染 ${label}`, () => expand(fakeCreateElement(type, props ?? {})))
}

let internals = null
attempt('插桩加载（只为暴露内部组件给渲染测试）', () => {
  const instrumented = execute({ react: renderReact, instrument: true })
  internals = globalThis.__CQ_INTERNALS__ ?? null
  if (!internals) throw new Error('插桩没生效：__CQ_INTERNALS__ 为空')
  return instrumented
})
delete globalThis.__CQ_INTERNALS__

check('内部组件表拿到了（TopBar / ConversationList / ChatArea / TraceRow / ConfigDrawer）',
  Boolean(internals
    && typeof internals.TopBar === 'function'
    && typeof internals.ConversationList === 'function'
    && typeof internals.ChatArea === 'function'
    && typeof internals.TraceRow === 'function'
    && typeof internals.ConfigDrawer === 'function'
    && typeof internals.ChachaPanel === 'function'))

if (internals) {
  // ── 夹具 ────────────────────────────────────────────────
  const now = Date.now()
  const FIXTURE_STATE = {
    ok: true,
    now,
    parts: { gateway: true, mind: true, controller: true },
    dataDir: 'C:/fake/.dsh/plugins/dsh-chacha-qq',
    conn: { connected: true, selfId: '1000000001', uptimeMs: 1234567 },
    model: { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'max', source: 'config' },
    mind: { available: true, sessions: [{ sessionId: 'qq-private-1111111111', events: 210, pressure: 0.83 }] },
    stats: { blocked: 0, injected: 2, replyBlocked: 0 },
    groups: [{ groupId: '1085327714', cached: 30 }],
    usage: { todayInput: 12000, todayOutput: 3400, todayTurns: 8 },
    modes: { default: 'companion', counts: { companion: 2 } },
    log: [{ at: now, level: 'info', tag: 'boot', text: '装配完成' }],
  }
  const FIXTURE_CONVS = [
    {
      peerKey: 'private-1111111111',
      scene: 'private',
      peerId: '1111111111',
      name: '主人',
      mode: 'companion',
      role: 'owner',
      lastAt: now - 60000,
      lastText: '主人早安呀',
      counts: { in: 12, out: 13 },
      relation: { score: 620, phase: 'close', label: '亲近' },
      tags: ['老朋友'],
      session: { sessionId: 'qq-private-1111111111', events: 210, pressure: 0.83 },
    },
    {
      peerKey: 'group-1085327714',
      scene: 'group',
      peerId: '1085327714',
      name: '群 A',
      mode: 'work',
      role: 'guest',
      lastAt: now - 3600000,
      lastText: '有人吗',
      counts: { in: 30, out: 4 },
    },
  ]
  const FIXTURE_MESSAGES = [
    { at: now - 90000, dir: 'in', scene: 'private', peerId: '1111111111', userId: '1111111111', name: '主人', text: '早安呀' },
    { at: now - 88000, dir: 'internal', kind: 'reasoning', text: '先看看她昨天说了什么。'.repeat(12) },
    {
      at: now - 87000,
      dir: 'internal',
      kind: 'tool',
      name: 'qq_group_history',
      args: { groupId: '999', limit: 30 },
      result: '{"ok":true,"lines":30}',
      error: false,
    },
    {
      at: now - 86000,
      dir: 'internal',
      kind: 'tool-result',
      name: 'web_fetch',
      args: { url: 'https://example.com' },
      result: 'boom: timeout',
      error: true,
    },
    {
      at: now - 85000,
      dir: 'internal',
      kind: 'plan',
      plan: [
        { content: '看一眼历史', status: 'completed' },
        { content: '回她', status: 'in_progress' },
        { content: '收尾', status: 'pending' },
      ],
    },
    { at: now - 84000, dir: 'internal', kind: 'usage', tokens: { input: 1234, output: 56, total: 1290 } },
    { at: now - 83000, dir: 'out', scene: 'private', peerId: '1111111111', name: '茶茶酱', text: '主人早安呀！', chunk: 1, chunks: 3 },
  ]

  const draft = structuredClone(DEFAULT_CONFIG)
  draft.modes.peers = { 'group-1085327714': 'work' }
  draft.observe.peers = { 'private-1111111111': { minMs: 1000, maxMs: 3000 } }
  draft.interest.users = { 1111111111: 0.95 }
  draft.meme.steal.peers = { 'group-1085327714': 0.3 }
  draft.moderation.hotKeywords = ['加群', '广告']
  // 功能总开关：故意把「日程」的全局关掉（用来验「（全局已关）」那句提醒），
  // 再给群会话留两条本对话覆盖（三态里的「关」和「开」各一条）。
  draft.features.schedule = false
  draft.features.peers = { 'group-1085327714': { meme: false, memeSteal: true } }
  // 「大脑」组：五个键都给上非默认值，才能证明输入框真的挂在草稿上。
  draft.mind.provider = 'deepseek-account'
  draft.mind.model = 'deepseek-flash'
  draft.mind.reasoningEffort = 'high'
  draft.mind.maxTokens = 8000
  // 人格故意塞换行 + 逗号 + 引号：一旦有人把它改成「数组派生」（join/split），这里当场变形。
  draft.mind.personaOverride = '你是茶茶酱。\n说话短一点，别用列表，也别用「首先、其次」。'

  // 注意：`texts.hot` 故意带一个**结尾逗号**。
  // 如果哪天有人把输入框改回「由数组派生」，这个逗号会被当场吃掉，断言立刻红。
  const texts = {
    hot: '加群, 广告,',
    ext: 'gif, png, jpg, jpeg, webp',
    users: '1111111111=0.95',
    groups: '',
    patterns: '',
  }
  const allOpen = {
    mind: true, features: true,
    modes: true, observe: true, interest: true, rhythm: true, security: true, emotion: true,
    memory: true, meme: true, life: true, relation: true, moderation: true, log: true,
  }

  // 抽屉的完整 props（新用例只覆盖自己关心的那几个）——省得每次抄 20 行
  const drawerProps = (overrides) => ({
    open: true,
    onClose() {},
    draft,
    config: draft,
    configError: '',
    dirty: true,
    saving: false,
    saveHint: '',
    formError: '',
    setField() {},
    unsetField() {},
    setFeaturePeer() {},
    onSave() {},
    onReset() {},
    onReload() {},
    texts,
    setText() {},
    resetToken: 0,
    defaultOpen: { ...allOpen },
    conversation: FIXTURE_CONVS[0],
    memes: [],
    memesError: '',
    onReloadMemes() {},
    logs: [],
    onClearLog() {},
    busy: '',
    ...(overrides || {}),
  })

  // ── 逐块渲染 ────────────────────────────────────────────
  const topTree = renderTree('TopBar（有数据）', internals.TopBar, {
    state: FIXTURE_STATE,
    online: true,
    draft,
    saveState: { dirty: true, saving: false, hint: '' },
    onSave() {},
    onRefresh() {},
    refreshing: false,
    drawerOpen: true,
    onToggleDrawer() {},
    onSetDefaultMode() {},
    onTestConnect() {},
    onRestart() {},
    busy: '',
    actionHint: '✓ NapCat 12ms',
    stats: { pending: 2 },
  })
  const topJson = JSON.stringify(topTree ?? [])
  check('TopBar 显示连接态 / 模型 / 未保存', topJson.includes('1000000001') && topJson.includes('deepseek-flash') && topJson.includes('未保存'))
  check('TopBar 显示待处理请求徽章', topJson.includes('待处理 2'))
  check('TopBar 模型 chip：provider 和 model 都显示',
    topJson.includes('deepseek-account') && topJson.includes('deepseek-flash'))
  check('TopBar 把 effort=max 翻成人话「最深」（不再直接甩枚举值）',
    topJson.includes('最深'))

  // 第一轮还没跑过：state.model 是空的。这里绝不能显示「未知模型」（会让人以为坏了）
  const topNoModel = renderTree('TopBar（第一轮还没跑过，model 为空）', internals.TopBar, {
    state: { ...FIXTURE_STATE, model: null },
    online: true,
    draft,
    saveState: { dirty: false, saving: false, hint: '' },
    onSave() {},
    onRefresh() {},
    refreshing: false,
    drawerOpen: true,
    onToggleDrawer() {},
    onSetDefaultMode() {},
    onTestConnect() {},
    onRestart() {},
    busy: '',
    actionHint: '',
    stats: { pending: 0 },
  })
  const topNoModelJson = JSON.stringify(topNoModel ?? [])
  check('模型为空时显示「跟随默认」，而不是「未知模型」',
    topNoModelJson.includes('跟随默认') && !topNoModelJson.includes('未知模型'))

  const listTree = renderTree('ConversationList（有数据）', internals.ConversationList, {
    conversations: FIXTURE_CONVS,
    selected: 'private-1111111111',
    onSelect() {},
    query: '',
    onQuery() {},
    source: 'api',
    modeOf: () => 'companion',
    onRefresh() {},
  })
  const listJson = JSON.stringify(listTree ?? [])
  check('会话卡片渲染出名字 / 徽章 / 关系阶段',
    listJson.includes('主人') && listJson.includes('亲近') && listJson.includes('群 A') && listJson.includes('干活'))
  check('会话列表有搜索框', collect(listTree).some((node) => node.type === 'input'))

  const chatTree = renderTree('ChatArea（有数据，含全部轨迹 kind）', internals.ChatArea, {
    conversation: FIXTURE_CONVS[0],
    mixed: false,
    messages: FIXTURE_MESSAGES,
    loading: false,
    source: 'api',
    onResetSession() {},
    onSendTest: async () => true,
    sending: false,
    sendHint: '',
    busy: '',
  })
  const chatJson = JSON.stringify(chatTree ?? [])
  check('in / out 气泡都在', chatJson.includes('早安呀') && chatJson.includes('主人早安呀！'))
  check('out 显示「第 n/m 片」', chatJson.includes('第 1/3 片'))
  check('轨迹（折叠态）：思考 / 工具 / 失败 / 计划 / token 摘要都在',
    chatJson.includes('💭 思考')
    && chatJson.includes('🔧 qq_group_history')
    && chatJson.includes('🔧 web_fetch')
    && chatJson.includes('失败')
    && chatJson.includes('📋 计划')
    && chatJson.includes('1/3 完成')
    && chatJson.includes('📊 token')
    && chatJson.includes('in 1.2k'))

  // 展开态：把 TraceRow 的 `open`（useState #0）直接顶成 true，看折叠起来的细节
  stateOverrides = (index) => (index === 0 ? { value: true } : undefined)
  const planOpen = JSON.stringify(renderTree('TraceRow（计划 · 展开）', internals.TraceRow, { item: FIXTURE_MESSAGES[4] }) ?? [])
  const toolOpen = JSON.stringify(renderTree('TraceRow（工具 · 展开）', internals.TraceRow, { item: FIXTURE_MESSAGES[2] }) ?? [])
  const errOpen = JSON.stringify(renderTree('TraceRow（工具失败 · 展开）', internals.TraceRow, { item: FIXTURE_MESSAGES[3] }) ?? [])
  const reasonOpen = JSON.stringify(renderTree('TraceRow（思考 · 展开）', internals.TraceRow, { item: FIXTURE_MESSAGES[1] }) ?? [])
  const usageOpen = JSON.stringify(renderTree('TraceRow（token · 展开）', internals.TraceRow, { item: FIXTURE_MESSAGES[5] }) ?? [])
  stateOverrides = null

  check('计划展开后 todo 带勾选状态（✔ / ◐ / ○）',
    planOpen.includes('✔') && planOpen.includes('◐') && planOpen.includes('○')
    && planOpen.includes('看一眼历史') && planOpen.includes('收尾'))
  check('工具展开后显示参数摘要 + 结果 pre',
    toolOpen.includes('groupId') && toolOpen.includes('limit') && toolOpen.includes('cq-trace-pre'))
  check('工具失败展开后标红（data-error=true）+ 结果可见',
    errOpen.includes('data-error') && errOpen.includes('boom: timeout'))
  check('思考展开后是全文（不再是预览截断）',
    reasonOpen.includes('cq-trace-body') && reasonOpen.length > 400)
  check('token 展开后三项都在（输入 / 输出 / 合计）',
    usageOpen.includes('输入') && usageOpen.includes('输出') && usageOpen.includes('合计')
    && usageOpen.includes('1.2k'))

  const drawerTree = renderTree('ConfigDrawer（真实 DEFAULT_CONFIG + 全展开）', internals.ConfigDrawer, {
    open: true,
    onClose() {},
    draft,
    config: draft,
    configError: '',
    dirty: true,
    saving: false,
    saveHint: '',
    setField() {},
    unsetField() {},
    onSave() {},
    onReset() {},
    onReload() {},
    texts,
    setText() {},
    resetToken: 0,
    defaultOpen: allOpen,
    conversation: FIXTURE_CONVS[0],
    memes: [{ key: 'happy', name: '开心', hint: '开心的时候', count: 23 }],
    memesError: '',
    onReloadMemes() {},
    logs: FIXTURE_STATE.log,
    onClearLog() {},
    busy: '',
  })
  const drawerJson = JSON.stringify(drawerTree ?? [])
  const groups = ['① 模式', '② 观望', '③ 兴趣', '④ 节奏', '⑤ 安全', '⑥ 情绪', '⑦ 记忆', '⑧ 表情包', '⑨ 日程', '⑩ 关系', '⑪ 群管']
  const missingGroups = groups.filter((title) => !drawerJson.includes(title))
  check('11 个配置分组全在', missingGroups.length === 0, `缺：${missingGroups.join(', ')}`)
  check('分组可折叠（data-open 属性在）', drawerJson.includes('cq-sec'))
  check('「当前对话覆盖」在（peerKey 显示）', drawerJson.includes('private-1111111111'))
  check('图库类别渲染出来了', drawerJson.includes('开心'))
  check('运行日志渲染出来了', drawerJson.includes('装配完成'))

  // ── 「大脑」组（模型 / 思考强度 / 人格）──────────────────
  check('「大脑」分组渲染出来了（标题原样）',
    drawerJson.includes('大脑（她用什么模型想事情）'))
  check('「大脑」组排在「① 模式」之前（配置抽屉的第一个分组）',
    drawerJson.indexOf('大脑（她用什么模型想事情）') >= 0
    && drawerJson.indexOf('大脑（她用什么模型想事情）') < drawerJson.indexOf('① 模式'))

  // ── 功能总开关（features.* 的 10 个）─────────────────────
  //
  // 主人原话：「臭猫忘记做总开关和对话单独的开关」。
  // 后端三层（features.peers > features > modes 矩阵）已经由 src/modes.js 做好，
  // 这里只证明面板**真把那一层画出来了**，而且能写进草稿。
  const EXPECTED_FEATURES = [
    'schedule', 'life', 'emotion', 'proactive', 'meme',
    'memeSteal', 'relation', 'memory', 'moderation', 'replyGuard',
  ]
  const drawerNodes = collect(drawerTree)
  const toggleRows = drawerNodes.filter((node) => node.props?.['data-role'] === 'feature-toggle')
  const toggleKeys = toggleRows.map((node) => node.props?.['data-feature'])

  check('「功能总开关」分组渲染出来了（标题原样）',
    drawerJson.includes('功能总开关（一票否决，跟模式无关）'))
  check('「功能总开关」排在「大脑」之后、「① 模式」之前（第二组）',
    drawerJson.indexOf('大脑（她用什么模型想事情）') >= 0
    && drawerJson.indexOf('功能总开关（一票否决，跟模式无关）') > drawerJson.indexOf('大脑（她用什么模型想事情）')
    && drawerJson.indexOf('功能总开关（一票否决，跟模式无关）') < drawerJson.indexOf('① 模式'))
  check('10 个总开关都在，键名和顺序都对',
    JSON.stringify(toggleKeys) === JSON.stringify(EXPECTED_FEATURES),
    `实际：${JSON.stringify(toggleKeys)}`)

  const featureDescs = [
    '每天生成一份她的日程（关掉省一次模型调用）',
    '精力/心情底色注入到上下文',
    '判断心情 + 注入（关掉连判断都不跑，省最多）',
    '她主动来找你（功能还没实现，先占位）',
    '句内 &&类别&& 标记换成图片',
    '看她喜不喜欢别人发的图',
    '记账 + 语气提示',
    '读写记忆（关掉 = 不注入、不总结）',
    '热词审查 + 自动禁言',
    '她要说出去的话出门前再看一遍',
  ]
  const missingDescs = featureDescs.filter((text) => !drawerJson.includes(text))
  check('每个开关都带那句灰色说明（原话，没自己改）',
    missingDescs.length === 0, `缺：${missingDescs.join(' / ')}`)
  check('组底部有「总开关关掉 = 彻底停」的提示',
    drawerJson.includes('总开关关掉 = 这个功能彻底停，跟下面的「模式」无关。'))

  // 拨一下总开关：草稿里必须是 boolean false，不能是字符串 'false'
  // （字符串落盘后后端 `=== false` 判定失效，等于关了还在跑）
  const toggleCalls = []
  const toggleDraft = structuredClone(draft)
  toggleDraft.features.meme = true
  const toggleTree = renderTree('ConfigDrawer（拨总开关 features.meme）', internals.ConfigDrawer, drawerProps({
    draft: toggleDraft,
    config: toggleDraft,
    setField: (path, value) => toggleCalls.push([path, value]),
  }))
  const memeToggleRow = collect(toggleTree).find((node) => (
    node.props?.['data-role'] === 'feature-toggle' && node.props?.['data-feature'] === 'meme'
  ))
  const memeSwitch = memeToggleRow
    ? collect(memeToggleRow).find((node) => node.type === 'input' && node.props?.type === 'checkbox')
    : null
  if (memeSwitch?.props?.onChange) memeSwitch.props.onChange({ target: { checked: false } })
  check('把 features.meme 拨到关 → 草稿里是 boolean false（不是字符串）',
    toggleCalls.length === 1
    && toggleCalls[0]?.[0] === 'features.meme'
    && toggleCalls[0]?.[1] === false
    && typeof toggleCalls[0]?.[1] === 'boolean',
    `实际：${JSON.stringify(toggleCalls)}`)
  check('总开关的选中态跟着草稿走（features.schedule=false 显示成关）',
    collect(toggleTree).find((node) => (
      node.props?.['data-role'] === 'feature-toggle' && node.props?.['data-feature'] === 'schedule'
    ))?.props?.['data-on'] === 'false')

  // ── 本对话功能开关（三态）────────────────────────────────
  const PEER_KEY = 'group-1085327714'
  const triDraft = structuredClone(draft)
  triDraft.features.schedule = false // 全局关掉，用来验「（全局已关）」
  triDraft.features.peers = { [PEER_KEY]: { meme: false, memeSteal: true } }
  // 会话的 peerKey 故意带 -owner：面板必须按群号归一后再写（不是 group-...-owner）
  const groupConvWithRole = { ...FIXTURE_CONVS[1], peerKey: `${PEER_KEY}-owner` }
  const triCalls = []
  const triTree = renderTree('ConfigDrawer（本对话三态开关）', internals.ConfigDrawer, drawerProps({
    draft: triDraft,
    config: triDraft,
    conversation: groupConvWithRole,
    setFeaturePeer: (peerKey, feature, value) => triCalls.push([peerKey, feature, value]),
  }))
  const triNodes = collect(triTree)
  const peerRow = (feature) => triNodes.find((node) => (
    node.props?.['data-role'] === 'feature-peer-row' && node.props?.['data-feature'] === feature
  ))
  const triBtn = (feature) => triNodes.find((node) => (
    node.props?.['data-role'] === 'feature-tri' && node.props?.['data-feature'] === feature
  ))

  check('「当前对话覆盖」里有「本对话功能开关」区',
    JSON.stringify(triTree ?? []).includes('本对话功能开关')
    && peerRow('meme') !== undefined
    && EXPECTED_FEATURES.every((feature) => peerRow(feature) !== undefined))
  check('三态：features.peers 里没这个键 → 显示「跟随全局」',
    peerRow('relation')?.props?.['data-state'] === 'follow'
    && triBtn('relation')?.props?.children === '跟随全局',
    `state=${peerRow('relation')?.props?.['data-state']} text=${JSON.stringify(triBtn('relation')?.props?.children)}`)
  check('三态：配了 false → 显示「关」',
    peerRow('meme')?.props?.['data-state'] === 'off' && triBtn('meme')?.props?.children === '关',
    `state=${peerRow('meme')?.props?.['data-state']} text=${JSON.stringify(triBtn('meme')?.props?.children)}`)
  check('三态：配了 true → 显示「开」',
    peerRow('memeSteal')?.props?.['data-state'] === 'on' && triBtn('memeSteal')?.props?.children === '开',
    `state=${peerRow('memeSteal')?.props?.['data-state']} text=${JSON.stringify(triBtn('memeSteal')?.props?.children)}`)
  check('全局已关 + 本对话「跟随全局」→ 标出「（全局已关）」',
    JSON.stringify(peerRow('schedule') ?? {}).includes('（全局已关）')
    && !JSON.stringify(peerRow('meme') ?? {}).includes('（全局已关）'))

  if (triBtn('relation')?.props?.onClick) triBtn('relation').props.onClick()
  check('本对话覆盖写入的键 = group-<群号>（不是 group-<群号>-owner）',
    triCalls.length === 1
    && triCalls[0]?.[0] === PEER_KEY
    && triCalls[0]?.[1] === 'relation'
    && triCalls[0]?.[2] === true,
    `实际：${JSON.stringify(triCalls)}`)
  check('三态循环：跟随全局 → 开 → 关 → 跟随全局',
    internals.nextFeatureTri(undefined) === true
    && internals.nextFeatureTri(true) === false
    && internals.nextFeatureTri(false) === undefined
    && internals.featureTriText(undefined) === '跟随全局'
    && internals.featureTriText(true) === '开'
    && internals.featureTriText(false) === '关')
  check('featurePeerValue 和 featureMode 一样绕三圈（手改的 group-xxx-owner 也认得）',
    internals.featurePeerValue(
      { features: { peers: { [`${PEER_KEY}-owner`]: { meme: false } } } },
      `${PEER_KEY}-guest`,
      'meme',
    ) === false
    && internals.featurePeerValue({ features: { peers: {} } }, PEER_KEY, 'meme') === undefined)
  // ⚠️ 切回「跟随全局」写的是 **null**，不是删键、也不是写 false。
  //    为什么：保存时 patch 就是这份草稿，**patch 里没有的键后端不会去删**
  //    （mergeDeep 只合并不删除）。而 null 有「删除这一项」的语义
  //    （src/config.js 的 applyNullDeletes 会真删掉磁盘上那条覆盖）。
  check('三态切回「跟随全局」= 写 null（后端靠它真删磁盘上的覆盖）',
    internals.unsetPathIn(
      internals.setPathIn({ features: { peers: {} } }, ['features', 'peers', 'group-9', 'meme'], true),
      ['features', 'peers', 'group-9', 'meme'],
    ).features.peers['group-9']['meme'] === null)
  check('空壳 {} 仍然会被清掉（但 null 保留，它是删除信号）',
    JSON.stringify(internals.pruneFeaturePeers({
      features: { peers: { 'group-9': {}, 'group-10': null } },
    }).features.peers) === JSON.stringify({ 'group-10': null }))
  check('全局总开关缺省 = 开（旧配置里没有 features 段也不会被误关）',
    internals.featureOnHere({}, 'meme') === true
    && internals.featureOnHere({ features: { meme: false } }, 'meme') === false)

  // ── 保存 payload 的形状（走 postConfig 那道闸）────────────
  const payloadCalls = []
  const payloadPost = (url, init) => {
    payloadCalls.push({ url, init })
    return Promise.resolve({ ok: true, config: {} })
  }
  const payloadDraft = internals.pruneFeaturePeers({
    features: { meme: false, peers: { 'group-9': { meme: true }, 'group-10': {} } },
  })
  check('features.peers[peerKey] 是空对象时被清掉（不留 {}）',
    JSON.stringify(payloadDraft.features) === JSON.stringify({
      meme: false, peers: { 'group-9': { meme: true } },
    }),
    JSON.stringify(payloadDraft.features))
  await internals.postConfig(payloadPost, payloadDraft)
  check('保存 payload 形状 = { patch: { features: { meme: false, peers: { "group-9": { meme: true } } } } }',
    payloadCalls.length === 1
    && payloadCalls[0]?.url === '/config'
    && payloadCalls[0]?.init?.method === 'POST'
    && JSON.stringify(payloadCalls[0]?.init?.body) === JSON.stringify({
      patch: { features: { meme: false, peers: { 'group-9': { meme: true } } } },
    }),
    JSON.stringify(payloadCalls[0]?.init?.body))

  const selects = collect(drawerTree).filter((node) => node.type === 'select')
  const effortSelect = selects.find((node) => node.props?.['data-role'] === 'mind-effort')
  check('思考强度是 <select>（不是自由文本输入框）', Boolean(effortSelect))
  const effortOptions = effortSelect
    ? collect(effortSelect).filter((node) => node.type === 'option').map((node) => String(node.props?.value))
    : []
  check('思考强度选项正好是 ["", "off", "low", "high", "max"]（就这四档 + 跟随默认）',
    JSON.stringify(effortOptions) === JSON.stringify(['', 'off', 'low', 'high', 'max']),
    `实际：${JSON.stringify(effortOptions)}`)
  check('每一档都带代价说明（option 文字 + 当前档位的灰色小字）',
    drawerJson.includes('不做推理') && drawerJson.includes('最深最慢') && drawerJson.includes('cq-effort-desc'))

  const textareas = collect(drawerTree).filter((node) => node.type === 'textarea')
  const hotArea = textareas.find((node) => String(node.props?.value ?? '').includes('加群'))
  check('热词输入框是「草稿字符串」（结尾逗号还在 → 没被数组派生吃掉）',
    hotArea?.props?.value === '加群, 广告,',
    `实际：${JSON.stringify(hotArea?.props?.value)}`)

  const personaArea = textareas.find((node) => String(node.props?.value ?? '').startsWith('你是茶茶酱'))
  check('人格覆盖是 textarea（8 行），草稿字符串原样：换行 / 逗号都没被吃掉',
    Boolean(personaArea)
    && personaArea.props?.rows === 8
    && personaArea.props?.value === draft.mind.personaOverride
    && personaArea.props.value.includes('\n'),
    `实际：${JSON.stringify(personaArea?.props?.value)}`)

  // 默认展开表：主人拉开抽屉就该看见「大脑」，不用先找再点一下
  const drawerDefaultTree = renderTree('ConfigDrawer（不传 defaultOpen：看默认展开哪几组）', internals.ConfigDrawer, {
    open: true,
    onClose() {},
    draft,
    config: draft,
    configError: '',
    dirty: false,
    saving: false,
    saveHint: '',
    formError: '',
    setField() {},
    unsetField() {},
    onSave() {},
    onReset() {},
    onReload() {},
    texts,
    setText() {},
    resetToken: 0,
    conversation: FIXTURE_CONVS[0],
    memes: [],
    memesError: '',
    onReloadMemes() {},
    logs: [],
    onClearLog() {},
    busy: '',
  })
  const drawerDefaultJson = JSON.stringify(drawerDefaultTree ?? [])
  check('「大脑」组默认展开（打开抽屉直接能看到思考强度下拉）',
    drawerDefaultJson.includes('大脑（她用什么模型想事情）')
    && drawerDefaultJson.includes('思考强度 reasoningEffort')
    && drawerDefaultJson.includes('mind-effort'))

  // 校验失败的红条：formError 非空时必须出现在抽屉顶部
  const drawerFormErrorTree = renderTree('ConfigDrawer（带校验错误）', internals.ConfigDrawer, {
    open: true,
    onClose() {},
    draft,
    config: draft,
    configError: '',
    dirty: true,
    saving: false,
    saveHint: '',
    formError: '思考强度只能是 off / low / high / max（留空 = 跟随默认），配置里却是「ultra」',
    setField() {},
    unsetField() {},
    onSave() {},
    onReset() {},
    onReload() {},
    texts,
    setText() {},
    resetToken: 0,
    defaultOpen: allOpen,
    conversation: FIXTURE_CONVS[0],
    memes: [],
    memesError: '',
    onReloadMemes() {},
    logs: [],
    onClearLog() {},
    busy: '',
  })
  const drawerFormErrorJson = JSON.stringify(drawerFormErrorTree ?? [])
  check('校验失败时抽屉顶部出现红条（错误不会被 dirty 状态盖住）',
    drawerFormErrorJson.includes('✗ 没保存')
    && drawerFormErrorJson.includes('data-role') && drawerFormErrorJson.includes('mind-error')
    && drawerFormErrorJson.includes('ultra'))

  // 手改坏的配置：脏值必须**照实**显示（多出一项），否则下拉 value 会变成 ''，
  // 而「再选一次已选中的项」不触发 change —— 脏值清不掉、保存永远被拦。
  const badEffortDraft = structuredClone(draft)
  badEffortDraft.mind.reasoningEffort = 'ultra'
  const drawerBadEffortTree = renderTree('ConfigDrawer（配置里是非法思考强度 ultra）', internals.ConfigDrawer, {
    open: true,
    onClose() {},
    draft: badEffortDraft,
    config: badEffortDraft,
    configError: '',
    dirty: false,
    saving: false,
    saveHint: '',
    formError: '',
    setField() {},
    unsetField() {},
    onSave() {},
    onReset() {},
    onReload() {},
    texts,
    setText() {},
    resetToken: 0,
    defaultOpen: allOpen,
    conversation: FIXTURE_CONVS[0],
    memes: [],
    memesError: '',
    onReloadMemes() {},
    logs: [],
    onClearLog() {},
    busy: '',
  })
  const badEffortJson = JSON.stringify(drawerBadEffortTree ?? [])
  const badEffortSelect = collect(drawerBadEffortTree).find(
    (node) => node.type === 'select' && node.props?.['data-role'] === 'mind-effort',
  )
  const badEffortOptions = badEffortSelect
    ? collect(badEffortSelect).filter((node) => node.type === 'option').map((node) => String(node.props?.value))
    : []
  check('配置里是非法档位（ultra）：下拉照实显示脏值（选任意一档即可覆盖），并标红说明',
    badEffortSelect?.props?.value === 'ultra'
    && JSON.stringify(badEffortOptions) === JSON.stringify(['', 'off', 'low', 'high', 'max', 'ultra'])
    && badEffortJson.includes('不是合法档位')
    && badEffortJson.includes('cq-effort-desc'),
    `value=${JSON.stringify(badEffortSelect?.props?.value)} options=${JSON.stringify(badEffortOptions)}`)

  // 空状态：config 还没到、没有会话 —— 最容易被忽略的一屏
  attempt('渲染 ConfigDrawer（draft=null / 配置端点不可用）', () => {
    expand(fakeCreateElement(internals.ConfigDrawer, {
      open: true,
      onClose() {},
      draft: null,
      config: null,
      configError: 'HTTP 404',
      dirty: false,
      saving: false,
      saveHint: '',
      setField() {},
      unsetField() {},
      onSave() {},
      onReset() {},
      onReload() {},
      texts: { hot: '', ext: '', users: '', groups: '', patterns: '' },
      setText() {},
      resetToken: 0,
      defaultOpen: allOpen,
      conversation: null,
      memes: [],
      memesError: 'HTTP 404',
      onReloadMemes() {},
      logs: [],
      onClearLog() {},
      busy: '',
    }))
  })

  attempt('渲染 ChatArea（空消息）', () => {
    expand(fakeCreateElement(internals.ChatArea, {
      conversation: null,
      mixed: true,
      messages: [],
      loading: false,
      source: 'state',
      onResetSession() {},
      onSendTest: async () => true,
      sending: false,
      sendHint: '',
      busy: '',
    }))
  })

  // 整页面板（全空）—— 第一次挂载就长这样，必须能起来
  const panelTree = renderTree('ChachaPanel（刚挂载：什么都还没到）', internals.ChachaPanel, {})
  const panelJson = JSON.stringify(panelTree ?? [])
  check('整页面板四个区块都在（顶部 / 会话列表 / 对话区 / 抽屉）',
    panelJson.includes('茶茶酱的 QQ')
    && panelJson.includes('cq-side')
    && panelJson.includes('cq-chat')
    && panelJson.includes('cq-drawer'))

  attempt('渲染 ChachaIcon', () => expand(fakeCreateElement(internals.ChachaIcon, { size: 18, active: true })))

  // ── 「大脑」组的保存校验：非法值一个请求都不许打 ─────────────
  //
  // 宿主 src/config.js 对 reasoningEffort 只校验「是个字符串」，maxTokens 负数也照收；
  // 非法值落盘后每一轮都会递给内核。所以「非法值不发 POST」只能由前端证明 ——
  // 把投递函数换成计数用的假 fetch，数它到底被调了几次。
  const transportCalls = []
  const fakePost = (url, init) => {
    transportCalls.push({ url, init })
    return Promise.resolve({ ok: true, config: { mind: { reasoningEffort: 'max' } } })
  }

  const badEffortResult = await internals.postConfig(fakePost, {
    mind: { reasoningEffort: 'ultra', maxTokens: 0 },
  })
  check('思考强度非法（ultra）：拒绝保存，假 fetch 一次都没被调',
    badEffortResult?.blocked === true
    && String(badEffortResult?.error ?? '').includes('ultra')
    && transportCalls.length === 0,
    `结果=${JSON.stringify(badEffortResult)} fetch=${transportCalls.length}`)

  const negativeTokensResult = await internals.postConfig(fakePost, {
    mind: { reasoningEffort: 'max', maxTokens: -1 },
  })
  check('maxTokens 负数：拒绝保存，假 fetch 一次都没被调',
    negativeTokensResult?.blocked === true && transportCalls.length === 0,
    `结果=${JSON.stringify(negativeTokensResult)} fetch=${transportCalls.length}`)

  const goodResult = await internals.postConfig(fakePost, {
    mind: { reasoningEffort: 'max', maxTokens: 0 },
  })
  check('合法值照常保存（假 fetch 正好被调 1 次，打向 POST /config）',
    transportCalls.length === 1
    && transportCalls[0]?.url === '/config'
    && transportCalls[0]?.init?.method === 'POST'
    && transportCalls[0]?.init?.body?.patch?.mind?.reasoningEffort === 'max'
    && goodResult?.ok === true,
    `calls=${JSON.stringify(transportCalls)}`)

  check('validateMind：合法返回 ""、非法返回人话、缺 maxTokens 不误报',
    internals.validateMind({ mind: { reasoningEffort: 'low', maxTokens: 0 } }) === ''
    && internals.validateMind({ mind: { reasoningEffort: '', maxTokens: 0 } }) === ''
    && internals.validateMind({ mind: { reasoningEffort: 'MAX' } }).length > 0
    && internals.validateMind({ mind: { reasoningEffort: '', maxTokens: -5 } }).length > 0
    && internals.validateMind({ mind: { reasoningEffort: '', maxTokens: 'abc' } }).length > 0)

  check('effortText：四档翻人话 / 空和 auto 不显示 / 未知值原样返回',
    internals.effortText('off') === '不思考'
    && internals.effortText('low') === '轻思考'
    && internals.effortText('high') === '深思考'
    && internals.effortText('max') === '最深'
    && internals.effortText('') === ''
    && internals.effortText('auto') === ''
    && internals.effortText('ultra') === 'ultra')

  check('effortBadge：空档也有说法（跟随默认），四档翻人话',
    internals.effortBadge('') === '跟随默认' && internals.effortBadge('max') === '最深')
}

// ─────────────────────────────────────────────────────────────
// 5. 归一化 / 降级 / 文本草稿（纯函数，用**今天真实**的 /state 形状）
// ─────────────────────────────────────────────────────────────
group('5. 归一化与降级（宿主端点还没全就绪时靠这些活着）')

if (internals) {
  // 这是 index.js 今天真实吐出来的形状：顶层扁平 + controller 嵌套，
  // 和 PANEL-DESIGN §2.1 的目标形状**不一样**。面板必须两种都吃得下。
  const todayState = {
    ok: true,
    parts: { gateway: true, controller: true, mind: false },
    dataDir: 'C:/fake/.dsh/plugins/dsh-chacha-qq',
    controller: {
      connected: true,
      selfId: '1000000001',
      uptimeMs: 60000,
      stats: { blocked: 1 },
      pendingRequests: 3,
      groups: [{ groupId: '1085327714', cached: 5 }],
      mind: { available: false, model: { provider: 'deepseek-account', model: 'deepseek-flash' }, sessions: [] },
      recent: [
        { at: 1000, direction: 'in', scene: 'group', groupId: '1085327714', userId: '1111111111', peerId: '1085327714', name: '主人', text: '在吗', role: 'owner' },
        { at: 2000, direction: 'out', scene: 'group', groupId: '1085327714', userId: '1111111111', peerId: '1085327714', name: '茶茶酱', text: '在的', chunks: 2, role: 'owner' },
        { at: 3000, direction: 'internal', kind: 'tool', scene: 'group', groupId: '1085327714', peerId: '1085327714', name: '调用 qq_group_history', text: '' },
      ],
      now: 4000,
    },
    log: [{ at: 4000, level: 'info', tag: 'boot', text: '装配完成' }],
  }

  const normalized = internals.normalizeState(todayState)
  check('normalizeState 吃得下「controller 嵌套」形状',
    normalized?.conn?.connected === true
    && normalized.conn.selfId === '1000000001'
    && normalized.pendingRequests === 3)
  check('normalizeState 从 controller.mind.model 挖出模型',
    normalized?.model?.model === 'deepseek-flash')
  check('normalizeState 把 direction 归一成 dir、补齐 peerKey',
    normalized?.recent?.length === 3
    && normalized.recent[0].dir === 'in'
    && normalized.recent[0].peerKey === 'group-1085327714')

  const derived = internals.deriveConversations(normalized)
  check('会话列表能从 state.recent 推导（/conversations 没上线时的降级）',
    derived.length === 1
    && derived[0].peerKey === 'group-1085327714'
    && derived[0].counts.in === 1
    && derived[0].counts.out === 1
    && derived[0].lastText === '在的')
  check('推导出的群会话名用群号（recent 里没有群名，不瞎编）',
    derived[0]?.name === '群 1085327714')

  check('messagesFromState 按 peerKey 过滤（/messages 没上线时的降级）',
    internals.messagesFromState(normalized, 'group-1085327714').length === 3
    && internals.messagesFromState(normalized, 'private-1').length === 0
    && internals.messagesFromState(normalized, '').length === 3)

  check('normalizeMessage：direction → dir、toolError → error',
    internals.normalizeMessage({ at: 1, direction: 'internal', kind: 'tool', toolError: true })?.dir === 'internal'
    && internals.normalizeMessage({ at: 1, direction: 'internal', kind: 'tool', toolError: true })?.error === true)

  check('normalizeConversation 缺 peerKey 时用 scene + peerId 拼出来',
    internals.normalizeConversation({ scene: 'private', peerId: '1111111111', name: '主人' })?.peerKey === 'private-1111111111')

  // 模式解析：peers 精确命中 > 群号归一化命中 > default
  const modeCfg = { modes: { default: 'companion', peers: { 'group-333-owner': 'work' } } }
  check('resolveModeLocal：群聊覆盖按群号生效（不按发言人）',
    internals.resolveModeLocal('group-333-guest', modeCfg) === 'work'
    && internals.resolveModeLocal('private-1', modeCfg) === 'companion')

  // 文本草稿的解析：逗号/空段/去重 —— 这是 v2 坑 20 的正面用例
  const csv = internals.parseCsv('加群, 广告, ,加群\n spam ')
  check('parseCsv 去空段 + 去重', JSON.stringify(csv) === JSON.stringify(['加群', '广告', 'spam']),
    JSON.stringify(csv))
  const numMap = internals.parseNumMap('1111111111=0.95\n# 注释行\n999,0.7')
  check('parseNumMap 解析「键=值 / 键,值」并跳过注释',
    numMap['1111111111'] === 0.95 && numMap['999'] === 0.7 && Object.keys(numMap).length === 2,
    JSON.stringify(numMap))
  check('formatNumMap 能回填成草稿文本',
    internals.formatNumMap({ 999: 0.7 }) === '999=0.7')

  check('msToSec / secToMs 来回一致（界面上显示秒，草稿里存毫秒）',
    internals.msToSec(20000) === 20 && internals.secToMs(2.5) === 2500)
  check('fmtTokens 长数字变人话', internals.fmtTokens(1234) === '1.2k' && internals.fmtTokens(42) === '42')
  check('clip 会截断并加省略号', internals.clip('一二三四五', 3) === '一二三…')
}

// ─────────────────────────────────────────────────────────────
// 结果
// ─────────────────────────────────────────────────────────────
console.log(`\n=== 结果：${pass} 项通过，${failures.length} 项失败 ===`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  ✗ ${name}`)
  process.exitCode = 1
} else {
  console.log('全绿：factory 能起、两条槽位注册参数正确、组件能渲染。')
}
