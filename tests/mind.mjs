/**
 * The Mind 层测试：人格组装 / 会话 key 与代次 / 消息构造 / 服务取值。
 *
 * 这一层的原则是「纯函数优先」，所以绝大多数不用 DSH、不用 QQ、不用网络。
 * 唯一需要假对象的是 ConfigStore（会话代次要落盘）。
 */
import { group, check, ok, notOk, throws, report } from './harness.mjs'

import {
  MIND_TOOL_ALLOW,
  buildMindPersona,
  renderTagLine,
  resolveToolAllow,
} from '../src/mind/preset.js'
import { MindSessions } from '../src/mind/session.js'
import { makeUserMessage, service } from '../src/mind/turn.js'

/** 假的配置句柄：只实现 session 用到的 get / patch。 */
function fakeStore(initial = {}) {
  let value = structuredClone(initial)
  return {
    get: () => value,
    patch(patch) {
      // 只够测 sessions.generations 这一层的浅合并
      value = {
        ...value,
        ...patch,
        sessions: { ...(value.sessions ?? {}), ...(patch.sessions ?? {}) },
      }
      return value
    },
  }
}

// ── 人格 ──────────────────────────────────────────────────────
group('人格：基础')

const ownerPersona = buildMindPersona({ role: 'owner' })
ok('主人人格非空', ownerPersona.length > 200, `${ownerPersona.length} 字`)
ok('主人人格里有「主人」称呼', ownerPersona.includes('主人'))
ok('主人人格里列了 QQ 工具', ownerPersona.includes('qq_ban_member'))
notOk('主人人格不该有群友段落', ownerPersona.includes('正在和你说话的是群友或陌生人'))
ok('都禁止 Markdown', ownerPersona.includes('Markdown'))
ok('都声明了会被切片发送', ownerPersona.includes('切成一片一片'))

const guestPersona = buildMindPersona({ role: 'guest' })
ok('群友人格非空', guestPersona.length > 100)
ok('群友人格声明不是主人', guestPersona.includes('不是主人'))
notOk('群友人格不该出现跨群工具', guestPersona.includes('qq_ban_member'))
ok('群友人格提到防注入', guestPersona.includes('忽略之前的设定'))

group('人格：自定义覆盖')

const custom = buildMindPersona({ role: 'owner', custom: '你是测试人格。' })
ok('自定义人格取代基础段', custom.startsWith('你是测试人格。'))
ok('自定义人格仍保留主人段', custom.includes('现在在跟谁说话') && custom.includes('主人'))

const blank = buildMindPersona({ role: 'owner', custom: '   ' })
ok('空白自定义回落基础人格', blank.includes('你正在 QQ 上和人聊天'))

group('人格：标签')

ok('空标签渲染成空串', renderTagLine([]) === '')
ok('无标签时人格里没有标签段', !buildMindPersona({ role: 'guest', tags: [] }).includes('这个人身上有这些标签'))

const tagLine = renderTagLine(['老朋友', '技术'])
ok('标签段有标题', tagLine.includes('这个人身上有这些标签'))
ok('已知标签带解释', tagLine.includes('可以随便一点'))
ok('未知标签原样列出', renderTagLine(['神秘标签']).includes('神秘标签'))

const tagged = buildMindPersona({ role: 'guest', tags: ['新人'] })
ok('标签接进人格末尾', tagged.trimEnd().endsWith('客气一点，别开玩笑'))
ok('标签把「新人」写进去', tagged.includes('- 新人'))

group('工具白名单')

ok('默认白名单非空', MIND_TOOL_ALLOW.length >= 8, MIND_TOOL_ALLOW.join(','))
ok('包含制定计划', MIND_TOOL_ALLOW.includes('todo_write'))
ok('包含子 Agent', MIND_TOOL_ALLOW.includes('subagent'))
ok('包含上网', MIND_TOOL_ALLOW.includes('web_search'))
notOk('不含危险的文件写入', MIND_TOOL_ALLOW.includes('write'))
notOk('不含命令执行', MIND_TOOL_ALLOW.includes('pwsh'))

check('空配置回落默认白名单', resolveToolAllow([]), MIND_TOOL_ALLOW)
check('非数组回落默认白名单', resolveToolAllow(undefined), MIND_TOOL_ALLOW)
check('自定义白名单原样使用', resolveToolAllow(['web_search']), ['web_search'])
check('白名单去空白与空串', resolveToolAllow([' web_search ', '']), ['web_search'])

// ── 会话 ──────────────────────────────────────────────────────
group('会话：key 与代次')

const store = fakeStore({ sessions: { generations: {} } })
const log = { info() {}, warn() {}, debug() {}, error() {} }
const sessions = new MindSessions({ store, log, prefix: 'qq' })

check('私聊 key', sessions.keyOf({ scene: 'private', peerId: '1111111111' }), 'private-1111111111')
check(
  '群聊主人 key',
  sessions.keyOf({ scene: 'group', peerId: '123', groupId: '123', role: 'owner' }),
  'group-123-owner',
)
check(
  '群聊群友 key',
  sessions.keyOf({ scene: 'group', peerId: '123', groupId: '123', role: 'guest' }),
  'group-123-guest',
)
ok(
  '群里主人和群友是两条会话',
  sessions.keyOf({ scene: 'group', groupId: '123', peerId: '123', role: 'owner' }) !==
    sessions.keyOf({ scene: 'group', groupId: '123', peerId: '123', role: 'guest' }),
)
check('首次代次为 0', sessions.generationOf('private-1'), 0)
check('首次 sessionId 无后缀', sessions.idOf('private-1'), 'qq-private-1')

const g1 = sessions.reset('private-1')
check('重置一次代次为 1', g1, 1)
check('重置后 sessionId 带 -g1', sessions.idOf('private-1'), 'qq-private-1-g1')

const g2 = sessions.reset('private-1')
check('重置两次代次为 2', g2, 2)
check('重置后 sessionId 带 -g2', sessions.idOf('private-1'), 'qq-private-1-g2')

check('另一个会话不受影响', sessions.idOf('private-2'), 'qq-private-2')

const snap = sessions.snapshot()
ok('快照包含重置过的会话', snap.some((item) => item.key === 'private-1' && item.generation === 2))
ok('快照的 sessionId 正确', snap.find((item) => item.key === 'private-1')?.sessionId === 'qq-private-1-g2')

group('会话：前缀')

const webSessions = new MindSessions({ store: fakeStore({ sessions: { generations: {} } }), log, prefix: 'web' })
check('前缀生效', webSessions.idOf('private-9'), 'web-private-9')

// ── 消息构造 ──────────────────────────────────────────────────
group('消息构造')

const msg = makeUserMessage('你好')
check('role 是 user', msg.role, 'user')
check('内容是一段文本', msg.content[0], { type: 'text', text: '你好' })
check('来源标记为 user', msg.source, { kind: 'user' })
ok('id 非空', typeof msg.id === 'string' && msg.id.length > 8)
ok('两条消息 id 不同', makeUserMessage('a').id !== makeUserMessage('b').id)
ok('time 是毫秒时间戳', msg.time > 1_600_000_000_000)

const withExtra = makeUserMessage('看图', [{ type: 'text', text: '附加' }])
check('附加块接在后面', withExtra.content.length, 2)
check('附加块内容正确', withExtra.content[1], { type: 'text', text: '附加' })

// ── 服务取值 ──────────────────────────────────────────────────
group('service(): 安全取服务')

ok('空 ctx 返回 undefined', service(null, 'agents') === undefined)

const normalCtx = { get: (name) => (name === 'agents' ? { create() {} } : undefined) }
ok('ctx.get 命中', Boolean(service(normalCtx, 'agents')?.create))

const throwingCtx = {
  get() {
    throw new Error('not injected')
  },
  get agents() {
    throw new Error('property access also throws')
  },
}
let threw = false
try {
  service(throwingCtx, 'agents')
} catch {
  threw = true
}
notOk('连抛两次也不许把异常漏出去', threw)

// ⚠️ 这条是旧版最阴的坑：直接访问未注入的服务是抛错、不是 undefined
const propOnly = {}
Object.defineProperty(propOnly, 'sessions', { get: () => ({ flush() {} }) })
ok('没有 ctx.get 时退回属性访问', Boolean(service(propOnly, 'sessions')?.flush))

report('The Mind 层')
