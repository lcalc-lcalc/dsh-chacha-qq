/**
 * 集成测试：把三层真的串起来跑一条消息。
 *
 * 这一层不测「算法对不对」（那是各模块自己的事），只测
 * **装配起来之后消息走得通不通**：
 *
 *   packet → normalize → 去重 → 路由 → 安全 → 兴趣 → 会话 → Mind → 分片发送
 *
 * 用的 gateway / mind 都是假的，所以不需要 DSH、不需要 QQ、不需要网络。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { group, check, ok, notOk, report } from './harness.mjs'

import { ConfigStore } from '../src/config.js'
import { Controller } from '../src/controller/pipeline.js'
import { ObservationWindow } from '../src/controller/observe.js'
import { MindSessions } from '../src/mind/session.js'
import * as interestModule from '../src/controller/interest.js'
import * as tagsModule from '../src/controller/tags.js'
import * as securityModule from '../src/controller/security.js'
import * as moderationModule from '../src/controller/moderation.js'

const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }

/** 临时的数据目录 + 配置。 */
function makeStore(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chacha-v3-int-'))
  const store = new ConfigStore(path.join(dir, 'config.json'))
  store.load()
  store.patch({
    // 测试里不要真的等 2~5 秒
    rhythm: { minGapMs: 0, maxGapMs: 0, maxTokensPerPiece: 20 },
    ...overrides,
  })
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** 假网关：记下所有 call，不连网。 */
function makeGateway({ selfId = '1000000001' } = {}) {
  const calls = []
  return {
    selfId,
    connected: true,
    calls,
    on() {},
    connect() {},
    close() {},
    async call(action, params) {
      calls.push({ action, params })
      if (action === 'get_group_member_info') {
        return { data: { user_id: params.user_id, role: 'member', nickname: '某人' } }
      }
      if (action === 'get_group_list') return { data: [] }
      return { ok: true, data: {} }
    },
  }
}

/** 假 Mind：立刻回一段话，可指定 trace。 */
function makeMind({ reply = '喵~ 茶茶酱在的哦', trace = [], fail = false } = {}) {
  const asked = []
  return {
    available: true,
    live: new Map(),
    asked,
    async ask(request) {
      asked.push(request)
      if (fail) throw new Error('模型挂了')
      if (typeof request.onDelta === 'function') request.onDelta(reply)
      return { text: reply, trace, reason: 'completed', elapsedMs: 5 }
    },
  }
}

/** 造一条 QQ 私聊包。 */
function privatePacket({ userId = '111222', text = '你好呀', id = 'm1' } = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: id,
    user_id: Number(userId),
    self_id: 1000000001,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: Number(userId), nickname: '测试者' },
    time: Math.floor(Date.now() / 1000),
  }
}

/** 造一条 QQ 群聊包。 */
function groupPacket({ groupId = '999', userId = '111222', text = '大家好', id = 'g1', atBot = false } = {}) {
  const message = []
  if (atBot) message.push({ type: 'at', data: { qq: '1000000001' } })
  message.push({ type: 'text', data: { text } })
  return {
    post_type: 'message',
    message_type: 'group',
    message_id: id,
    group_id: Number(groupId),
    user_id: Number(userId),
    self_id: 1000000001,
    raw_message: text,
    message,
    sender: { user_id: Number(userId), nickname: '群友', card: '群友甲' },
    time: Math.floor(Date.now() / 1000),
  }
}

/** 等异步的 fire-and-forget 跑完。 */
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

// ══════════════════════════════════════════════════════════════
group('集成：主人私聊 → 立刻回')

{
  const { store, dir, cleanup } = makeStore({ owner: { qq: '1111111111' } })
  const gateway = makeGateway()
  const mind = makeMind({ reply: '主人！茶茶酱在哦。今天想做什么呀？' })
  const controller = new Controller({
    ctx: {}, store, log: SILENT, gateway, mind, observe: null, interest: interestModule, tags: tagsModule, security: securityModule, moderation: moderationModule, dataDir: dir,
  })

  controller.onPacket(privatePacket({ userId: '1111111111', text: '茶茶，在吗' }))
  await tick(200)

  ok('主人消息进了 Mind', mind.asked.length === 1, `asked=${mind.asked.length}`)
  const req = mind.asked[0] ?? {}
  check('角色是 owner', req.role, 'owner')
  ok('会话是一对一的私聊会话', String(req.sessionId).startsWith('qq-private-1111111111'), req.sessionId)
  check('输入带上了原文', req.text, '茶茶，在吗')

  const sends = gateway.calls.filter((c) => c.action === 'send_private_msg')
  ok('真的发出去了', sends.length >= 1, `sends=${sends.length}`)
  const sentText = sends.map((c) => (c.params?.message ?? []).map((s) => s.data?.text ?? '').join('')).join('|')
  ok('发出去的内容是那句话', sentText.includes('茶茶酱在哦'), sentText)

  cleanup()
}

// ══════════════════════════════════════════════════════════════
group('集成：分片（一片 <20 token）')

{
  const { store, dir, cleanup } = makeStore({ owner: { qq: '1111111111' } })
  const gateway = makeGateway()
  const long = '今天天气很好呀。我们去公园走走吧。顺便买点好吃的回来。你觉得怎么样呢？我还想吃冰淇淋。'
  const mind = makeMind({ reply: long })
  const controller = new Controller({
    ctx: {}, store, log: SILENT, gateway, mind, observe: null, interest: interestModule, tags: tagsModule, security: securityModule, moderation: moderationModule, dataDir: dir,
  })

  controller.onPacket(privatePacket({ userId: '1111111111', text: '说点长的' }))
  await tick(300)

  const sends = gateway.calls.filter((c) => c.action === 'send_private_msg')
  ok('长回复被切成了多片', sends.length > 1, `片数=${sends.length}`)
  const pieces = sends.map((c) => (c.params?.message ?? []).map((s) => s.data?.text ?? '').join(''))
  ok('每一片都不超过 20 token 太多', pieces.every((p) => p.length <= 40), pieces.map((p) => p.length).join(','))
  const joined = pieces.join('')
  ok('没丢字（拼回去 ≈ 原文）', joined.replace(/\s/g, '').length >= long.replace(/\s/g, '').length - 4,
    `${joined.length} vs ${long.length}`)

  cleanup()
}

// ══════════════════════════════════════════════════════════════
group('集成：陌生人私聊（默认兴趣 0.5 → 可能不回）')

{
  const { store, dir, cleanup } = makeStore({
    owner: { qq: '1111111111' },
    interest: { default: 0.5, users: {}, groups: {}, atSureThreshold: 0.1, atMultiplier: 5, unmentionedFactor: 0.35 },
  })
  const gateway = makeGateway()
  const mind = makeMind()
  const controller = new Controller({
    ctx: {}, store, log: SILENT, gateway, mind, observe: null, interest: interestModule, tags: tagsModule, security: securityModule, moderation: moderationModule, dataDir: dir,
  })

  // 跑 30 次，统计「回了多少次」，验证概率在合理区间
  let replied = 0
  for (let i = 0; i < 30; i++) {
    mind.asked.length = 0
    gateway.calls.length = 0
    controller.dedupe.clear?.()
    controller.onPacket(privatePacket({ userId: `88800${i}`, text: `测试 ${i}`, id: `p${i}` }))
    await tick(30)
    if (mind.asked.length > 0) replied++
  }
  ok('既不是全回也不是全不回（说明掷骰生效）', replied > 0 && replied < 30, `30 次里回了 ${replied} 次`)

  cleanup()
}

// ══════════════════════════════════════════════════════════════
group('集成：陌生人被 @ → 一定回（兴趣 0.5 > 0.1）')

{
  const { store, dir, cleanup } = makeStore({
    owner: { qq: '1111111111' },
    interest: { default: 0.5 },
  })
  const gateway = makeGateway()
  const mind = makeMind({ reply: '你好呀' })
  const controller = new Controller({
    ctx: {}, store, log: SILENT, gateway, mind, observe: null, interest: interestModule, tags: tagsModule, security: securityModule, moderation: moderationModule, dataDir: dir,
  })

  controller.onPacket(groupPacket({ userId: '555666', text: ' 茶茶在吗', id: 'at1', atBot: true }))
  await tick(200)

  ok('被 @ 就回了', mind.asked.length === 1, `asked=${mind.asked.length}`)
  const req = mind.asked[0] ?? {}
  check('群里的陌生人走 guest', req.role, 'guest')
  ok('会话是群聊 guest 会话', String(req.sessionId).includes('group-999-guest'), req.sessionId)

  cleanup()
}

// ══════════════════════════════════════════════════════════════
group('集成：群里主人和群友是两条会话')

{
  const { store, dir, cleanup } = makeStore({ owner: { qq: '1111111111' } })
  const gateway = makeGateway()
  const mind = makeMind()
  const controller = new Controller({
    ctx: {}, store, log: SILENT, gateway, mind, observe: null, interest: interestModule, tags: tagsModule, security: securityModule, moderation: moderationModule, dataDir: dir,
  })

  controller.onPacket(groupPacket({ userId: '1111111111', text: '我是主人', id: 'o1', atBot: true }))
  await tick(120)
  controller.onPacket(groupPacket({ userId: '555666', text: '我是群友', id: 'm2', atBot: true }))
  await tick(120)

  const ids = mind.asked.map((r) => String(r.sessionId))
  ok('两次都进了 Mind', ids.length === 2, ids.join(' | '))
  ok('主人会话带 -owner', ids.some((id) => id.endsWith('-owner')), ids.join(' | '))
  ok('群友会话带 -guest', ids.some((id) => id.endsWith('-guest')), ids.join(' | '))
  notOk('两条不是同一条会话', ids[0] === ids[1])

  cleanup()
}

// ══════════════════════════════════════════════════════════════
group('集成：黑名单拦得住')

{
  const { store, dir, cleanup } = makeStore({
    owner: { qq: '1111111111' },
    access: { blocklist: [{ qq: '666777', level: 'block' }] },
  })
  const gateway = makeGateway()
  const mind = makeMind()
  const controller = new Controller({
    ctx: {}, store, log: SILENT, gateway, mind, observe: null, interest: interestModule, tags: tagsModule, security: securityModule, moderation: moderationModule, dataDir: dir,
  })

  controller.onPacket(privatePacket({ userId: '666777', text: '理理我', id: 'b1' }))
  await tick(150)

  check('被拉黑的人根本没进 Mind', mind.asked.length, 0)
  check('也没有发任何消息', gateway.calls.length, 0)
  ok('拦截被计数', controller.stats.blocked >= 1, String(controller.stats.blocked))

  cleanup()
}

// ══════════════════════════════════════════════════════════════
group('集成：去重（同一条消息来两遍）')

{
  const { store, dir, cleanup } = makeStore({ owner: { qq: '1111111111' } })
  const gateway = makeGateway()
  const mind = makeMind()
  const controller = new Controller({
    ctx: {}, store, log: SILENT, gateway, mind, observe: null, interest: interestModule, tags: tagsModule, security: securityModule, moderation: moderationModule, dataDir: dir,
  })

  const packet = privatePacket({ userId: '1111111111', text: '重复测试', id: 'dup-1' })
  controller.onPacket(packet)
  controller.onPacket(packet)
  await tick(200)

  check('重复的那条被丢掉', mind.asked.length, 1)

  cleanup()
}

// ══════════════════════════════════════════════════════════════
group('集成：Mind 挂了也不崩')

{
  const { store, dir, cleanup } = makeStore({ owner: { qq: '1111111111' } })
  const gateway = makeGateway()
  const mind = makeMind({ fail: true })
  const controller = new Controller({
    ctx: {}, store, log: SILENT, gateway, mind, observe: null, interest: interestModule, tags: tagsModule, security: securityModule, moderation: moderationModule, dataDir: dir,
  })

  let threw = false
  try {
    controller.onPacket(privatePacket({ userId: '1111111111', text: '你在吗', id: 'f1' }))
    await tick(250)
  } catch {
    threw = true
  }
  notOk('没有把异常抛到收包循环外', threw)

  const sends = gateway.calls.filter((c) => c.action === 'send_private_msg')
  ok('仍然给了主人一句兜底话', sends.length >= 1, `sends=${sends.length}`)

  cleanup()
}

// ══════════════════════════════════════════════════════════════
group('集成：观望窗口（@ 提前结算 + 同一坨只等一次）')

{
  const { store } = makeStore({
    owner: { qq: '1111111111' },
    observe: { enabled: true, defaultMinMs: 20000, defaultMaxMs: 60000, atMs: 10000, guestPrivateMs: 5000, sameThreadMs: 60000, maxBatch: 60 },
  })
  const settled = []
  const windows = new ObservationWindow({
    log: SILENT,
    onSettle: (key, messages) => settled.push({ key, count: messages.length }),
    now: () => Date.now(),
    rng: () => 0.5,
    // 用假定时器：立刻触发，避免测试真的等 20 秒
    setTimer: (fn) => {
      const handle = setTimeout(fn, 5)
      return handle
    },
    clearTimer: (handle) => clearTimeout(handle),
  })

  windows.push(privatePacket({ userId: '111', id: 'w1' }), { action: 'observe', role: 'guest', priority: 'private' }, store.get())
  ok('进了一个观望批次', windows.pendingCount() === 1, String(windows.pendingCount()))
  await tick(40)
  ok('到期后自动结算', settled.length === 1, `settled=${settled.length}`)

  // @ 立刻结算
  settled.length = 0
  windows.push(groupPacket({ userId: '222', id: 'w2' }), { action: 'observe', role: 'guest', priority: 'group' }, store.get())
  windows.push(groupPacket({ userId: '222', id: 'w3', atBot: true }), { action: 'handle', role: 'guest', priority: 'at' }, store.get())
  ok('被 @ 时立刻结算整批', settled.length === 1 && settled[0].count === 2, JSON.stringify(settled))

  windows.dispose()
}

// ══════════════════════════════════════════════════════════════
group('集成：会话代次（重置后是新 sessionId）')

{
  const { store, cleanup } = makeStore({ owner: { qq: '1111111111' } })
  const sessions = new MindSessions({ store, log: SILENT, prefix: 'qq' })
  const key = sessions.keyOf({ scene: 'private', peerId: '1111111111' })
  const before = sessions.idOf(key)
  sessions.reset(key)
  const after = sessions.idOf(key)
  notOk('重置前后 sessionId 不同', before === after)
  ok('重置后带代次后缀', after.endsWith('-g1'), after)
  cleanup()
}

// ══════════════════════════════════════════════════════════════
group('会话列表（面板左侧栏靠它）')

{
  const { store, dir, cleanup } = makeStore({
    owner: { qq: '1111111111' },
    modes: { default: 'companion', peers: { 'group-999': 'work' } },
  })
  const gateway = makeGateway()
  const mind = makeMind({ reply: '在的哦' })
  const controller = new Controller({
    ctx: {}, store, log: SILENT, gateway, mind, observe: null,
    interest: interestModule, tags: tagsModule, security: securityModule, moderation: moderationModule,
    dataDir: dir,
  })

  controller.onPacket(privatePacket({ userId: '1111111111', text: '你好呀', id: 'cv1' }))
  await tick(200)
  controller.onPacket(groupPacket({ userId: '555666', text: '群里说句话', id: 'cv2', atBot: true }))
  await tick(200)

  const list = controller.listConversations()
  ok('聚合出了会话', list.length >= 2, `${list.length} 个`)

  const priv = list.find((item) => item.peerKey === 'private-1111111111')
  ok('主人私聊在里面', Boolean(priv), JSON.stringify(list.map((i) => i.peerKey)))
  if (priv) {
    check('私聊的 role 是 owner', priv.role, 'owner')
    ok('带着模式', ['companion', 'work'].includes(priv.mode), String(priv.mode))
    ok('有最后一句', priv.lastText.length > 0, priv.lastText)
    ok('有收发计数', priv.counts.in >= 1, JSON.stringify(priv.counts))
    ok('有名字', String(priv.name).length > 0, priv.name)
    ok('有 lastAt', priv.lastAt > 0, String(priv.lastAt))
  }

  const grp = list.find((item) => item.peerKey === 'group-999')
  ok('群聊在里面', Boolean(grp), JSON.stringify(list.map((i) => i.peerKey)))
  if (grp) {
    check('⭐ 群的模式读的是 modes.peers（配了 work）', grp.mode, 'work')
    ok('群有上下文缓存条数', grp.cached >= 1, String(grp.cached))
  }

  ok('按时间倒序', (() => {
    for (let i = 1; i < list.length; i += 1) {
      if ((list[i - 1].lastAt || 0) < (list[i].lastAt || 0)) return false
    }
    return true
  })(), list.map((i) => i.lastAt).join(','))

  cleanup()
}

report('集成（三层串起来）')
