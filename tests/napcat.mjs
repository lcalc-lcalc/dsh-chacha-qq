/**
 * L1 NapCat 适配层测试。
 *
 * 三块：
 *  1. normalize —— 纯函数，真数据、零 IO；
 *  2. gateway   —— 注入假 WebSocket，不连真 NapCat（正常收发/echo/超时/重连/静默/坏帧）；
 *  3. api       —— 假网关记录调用参数 + 临时真文件验证 base64 坑。
 *
 * 跑法：node tests/napcat.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { group, check, ok, rejects, throws, report } from './harness.mjs'
import { OneBotGateway } from '../src/napcat/gateway.js'
import { normalizeMessage, segmentsToText, umoOf, sessionKeyOf, sessionIdOf } from '../src/napcat/normalize.js'
import { createQqApi, toFileRef } from '../src/napcat/api.js'

/**
 * 测试进程保活。
 * gateway 里的定时器（超时、退避、静默）都 unref 了：生产上靠真实 socket 撑住
 * 事件循环，这里假 socket 不是真句柄，等超时的时候进程会直接退出。
 */
const keepAlive = setInterval(() => {}, 1000)

const SELF = '1000000001'
const OWNER = '1111111111'
const STRANGER = '1234567890'

const text = (value) => ({ type: 'text', data: { text: value } })
const at = (qq, name) => ({ type: 'at', data: name ? { qq, name } : { qq } })
const image = (url = 'https://example.com/a.jpg') => ({ type: 'image', data: { file: 'a.jpg', url } })

/** 造一条群消息原始帧。 */
function rawGroup({ userId = STRANGER, groupId = '999', segments = [], id = 'm1', sender = {}, ...rest } = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    message_id: id,
    group_id: groupId,
    user_id: userId,
    self_id: SELF,
    time: 1700000000,
    message: segments,
    sender: { user_id: userId, nickname: '群友', card: '', role: 'member', ...sender },
    ...rest,
  }
}

/** 造一条私聊原始帧。 */
function rawPrivate({ userId = OWNER, segments = [], id = 'p1', ...rest } = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: id,
    user_id: userId,
    self_id: SELF,
    time: 1700000000,
    message: segments,
    sender: { user_id: userId, nickname: '主人', card: '' },
    ...rest,
  }
}

// ══════════════════════════════════════════════════════════════
// 一、normalize（纯函数）
// ══════════════════════════════════════════════════════════════

group('normalize：消息段 → 纯文本')

check('纯文本原样保留', segmentsToText([text('你好呀')]), '你好呀')
check('多段文本拼接', segmentsToText([text('你好'), text('呀')]), '你好呀')
check('文本 + @ 拼成一行', segmentsToText([at(OWNER, '阿明'), text(' 在吗')]), '@阿明 在吗')
check('@ 没昵称时用 QQ 号', segmentsToText([at(OWNER)]), `@${OWNER}`)
check('@全体成员单独显示', segmentsToText([at('all')]), '@全体成员')
check('图片变占位', segmentsToText([text('看'), image()]), '看[图片]')
check('表情变占位', segmentsToText([{ type: 'face', data: { id: '178' } }]), '[表情]')
check('商城表情也当表情', segmentsToText([{ type: 'mface', data: { summary: '[贴纸]' } }]), '[表情]')
check('语音变占位', segmentsToText([{ type: 'record', data: { file: 'x.amr' } }]), '[语音]')
check('视频变占位', segmentsToText([{ type: 'video', data: { file: 'x.mp4' } }]), '[视频]')
check('文件带名字', segmentsToText([{ type: 'file', data: { name: '报表.xlsx' } }]), '[文件 报表.xlsx]')
check('文件没名字也有占位', segmentsToText([{ type: 'file', data: {} }]), '[文件]')
check('引用不占正文', segmentsToText([{ type: 'reply', data: { id: '55' } }, text('嗯')]), '嗯')
check('JSON 卡片变占位', segmentsToText([{ type: 'json', data: { data: '{}' } }]), '[卡片]')
check('XML 卡片变占位', segmentsToText([{ type: 'xml', data: {} }]), '[卡片]')
check('合并转发变占位', segmentsToText([{ type: 'forward', data: { id: 'x' } }]), '[合并转发]')
check('markdown 取 content', segmentsToText([{ type: 'markdown', data: { content: '**粗**' } }]), '**粗**')
check('未知段直接忽略', segmentsToText([{ type: 'mystery', data: {} }, text('在')]), '在')
check('空数组 → 空串', segmentsToText([]), '')
check('非数组 → 空串', segmentsToText(null), '')
check('首尾空白被 trim', segmentsToText([text('  你好  ')]), '你好')
check('脏数据不炸', segmentsToText([null, text('嗨'), { type: 'text' }]), '嗨')

group('normalize：群消息整体')

const groupRaw = rawGroup({ segments: [at(SELF, '茶茶'), text(' 在吗')] })
const groupMsg = normalizeMessage(groupRaw, SELF)
check('scene=group', groupMsg.scene, 'group')
check('peerId 是群号', groupMsg.peerId, '999')
check('groupId', groupMsg.groupId, '999')
check('userId', groupMsg.userId, STRANGER)
check('selfId 用传入值', groupMsg.selfId, SELF)
check('sender.id', groupMsg.sender.id, STRANGER)
check('sender.nickname', groupMsg.sender.nickname, '群友')
check('sender.card', groupMsg.sender.card, '')
check('id 是字符串', groupMsg.id, 'm1')
check('text 把 @ 换成人名', groupMsg.text, '@茶茶 在吗')
check('@ 了自己 → mentionsMe', groupMsg.mentionsMe, true)
check('at 换算成毫秒', groupMsg.at, 1700000000000)
check('segments 原样保留', groupMsg.segments.length, 2)
check('segments 里能读到 @ 目标', groupMsg.segments[0].data.qq, SELF)
ok('raw 保留原始帧引用', groupMsg.raw === groupRaw)

const cardMsg = normalizeMessage(rawGroup({ segments: [text('x')], sender: { card: '群主小号' } }), SELF)
check('群名片单独保留', cardMsg.sender.card, '群主小号')
check('昵称不丢', cardMsg.sender.nickname, '群友')
check('sender.role 透传（群管要判群主/管理员）', cardMsg.sender.role, 'member')
check('sender.role=owner 也照抄', normalizeMessage(rawGroup({ segments: [text('x')], sender: { role: 'owner' } }), SELF).sender.role, 'owner')

group('normalize：@ 判定')

check('@ 别人不算提到我',
  normalizeMessage(rawGroup({ segments: [at(OWNER, '主人'), text(' 你好')] }), SELF).mentionsMe, false)
check('@全体成员不算提到我',
  normalizeMessage(rawGroup({ segments: [at('all')] }), SELF).mentionsMe, false)
check('纯文本没 @ 不算提到我',
  normalizeMessage(rawGroup({ segments: [text('在吗')] }), SELF).mentionsMe, false)
check('多个 @ 里只要有一个是我',
  normalizeMessage(rawGroup({ segments: [at(OWNER), at(SELF)] }), SELF).mentionsMe, true)
check('@ 目标写成数字也算',
  normalizeMessage(rawGroup({ segments: [at(Number(SELF))] }), SELF).mentionsMe, true)
check('段里的 CQ 码也认 @',
  normalizeMessage(rawPrivate({ segments: [text(`[CQ:at,qq=${SELF}] 在吗`)] }), SELF).mentionsMe, true)
check('字符串消息里的 CQ @ 也认',
  normalizeMessage({ ...rawPrivate({ segments: [] }), message: `[CQ:at,qq=${SELF},name=茶茶] 你好` }, SELF).mentionsMe, true)
check('CQ @ 别人不算',
  normalizeMessage({ ...rawPrivate({ segments: [] }), message: `[CQ:at,qq=${OWNER}] 你好` }, SELF).mentionsMe, false)
check('没传 selfId 时用帧里的 self_id 兜底',
  normalizeMessage(rawGroup({ segments: [at(SELF)] })).mentionsMe, true)

group('normalize：媒体')

const mediaMsg = normalizeMessage(rawGroup({
  segments: [
    { type: 'image', data: { file: 'abc.image', url: 'https://x/y.jpg' } },
    { type: 'record', data: { file: 'abc.amr' } },
    { type: 'video', data: { file: 'abc.mp4', url: 'https://x/v.mp4' } },
    { type: 'file', data: { file: 'f1', name: '报表.xlsx' } },
  ],
}), SELF)
check('媒体都收集到了', mediaMsg.media.map((item) => item.kind), ['image', 'record', 'video', 'file'])
check('图片 url', mediaMsg.media[0].url, 'https://x/y.jpg')
check('图片 fileId 取 file', mediaMsg.media[0].fileId, 'abc.image')
check('视频 url', mediaMsg.media[2].url, 'https://x/v.mp4')
check('文件 name', mediaMsg.media[3].name, '报表.xlsx')
check('file_id 字段也能当 fileId',
  normalizeMessage(rawGroup({ segments: [{ type: 'image', data: { file_id: 'fid-1' } }] }), SELF).media[0].fileId, 'fid-1')
check('没有媒体时是空数组', normalizeMessage(rawGroup({ segments: [text('hi')] }), SELF).media, [])

group('normalize：私聊整体')

const privateMsg = normalizeMessage(rawPrivate({ segments: [text('茶茶')] }), SELF)
check('scene=private', privateMsg.scene, 'private')
check('peerId 是对方 QQ', privateMsg.peerId, OWNER)
check('groupId 为空串', privateMsg.groupId, '')
check('userId 是对方 QQ', privateMsg.userId, OWNER)
check('私聊默认没 @ 我', privateMsg.mentionsMe, false)
check('私聊 sender.id 兜底 user_id', privateMsg.sender.id, OWNER)
check('私聊 sender.nickname', privateMsg.sender.nickname, '主人')
check('私聊 text', privateMsg.text, '茶茶')

group('normalize：边界与脏数据')

check('null 帧 → null', normalizeMessage(null, SELF), null)
check('undefined 帧 → null', normalizeMessage(undefined, SELF), null)
check('通知事件 → null', normalizeMessage({ post_type: 'notice', notice_type: 'group_recall' }, SELF), null)
check('message_sent 也当非消息 → null', normalizeMessage({ post_type: 'message_sent', message_type: 'private' }, SELF), null)

const emptyMsg = normalizeMessage(rawPrivate({ segments: [] }), SELF)
ok('空消息不是 null', emptyMsg !== null)
check('空消息 text 是空串', emptyMsg.text, '')
check('空消息 media 是空数组', emptyMsg.media, [])
check('空消息 segments 是空数组', emptyMsg.segments, [])
check('空消息没提到我', emptyMsg.mentionsMe, false)

const noSender = normalizeMessage({ ...rawPrivate({ segments: [text('x')] }), sender: undefined }, SELF)
check('没有 sender 时 id 兜底 user_id', noSender.sender.id, OWNER)
check('没有 sender 时 nickname 空串', noSender.sender.nickname, '')
check('没有 sender 时 role 空串', noSender.sender.role, '')
check('数字 message_id 转成字符串',
  normalizeMessage(rawPrivate({ segments: [text('x')], id: 778899 }), SELF).id, '778899')

const noTime = normalizeMessage({ ...rawPrivate({ segments: [text('x')] }), time: undefined }, SELF)
ok('没有 time 时用当前时间兜底', Number.isFinite(noTime.at) && noTime.at > 0)
check('缺 message_type 但有 group_id → 按群聊',
  normalizeMessage({ post_type: 'message', message_id: 'x', group_id: '999', user_id: STRANGER, message: [text('x')] }, SELF).scene, 'group')
check('字符串消息当纯文本',
  normalizeMessage({ ...rawPrivate({ segments: [] }), message: '纯字符串' }, SELF).text, '纯字符串')
check('段数组里的垃圾段被过滤',
  normalizeMessage(rawGroup({ segments: [null, { type: 'text', data: { text: '嗨' } }, 'x'] }), SELF).segments.length, 1)

group('normalize：umo / sessionId')

check('群聊 umo', umoOf(groupMsg), 'qq-group-999')
check('私聊 umo', umoOf(privateMsg), `qq-private-${OWNER}`)
check('群聊 sessionKey 默认 guest', sessionKeyOf(groupMsg), 'qq-group-999-guest')
check('群聊 sessionKey owner', sessionKeyOf(groupMsg, 'qq', 'owner'), 'qq-group-999-owner')
check('私聊 sessionKey 不分角色', sessionKeyOf(privateMsg, 'qq', 'owner'), `qq-private-${OWNER}`)
check('未知角色按 guest 处理', sessionKeyOf(groupMsg, 'qq', 'admin'), 'qq-group-999-guest')
check('sessionId 代次 0 无后缀', sessionIdOf(groupMsg, 'qq', 'guest', 0), 'qq-group-999-guest')
check('sessionId 代次 2 带 -g2', sessionIdOf(groupMsg, 'qq', 'guest', 2), 'qq-group-999-guest-g2')
check('代次传字符串也认', sessionIdOf(groupMsg, 'qq', 'owner', '3'), 'qq-group-999-owner-g3')
check('负数代次当 0', sessionIdOf(groupMsg, 'qq', 'guest', -1), 'qq-group-999-guest')
check('自定义前缀', sessionKeyOf(groupMsg, 'chacha', 'guest'), 'chacha-group-999-guest')
check('自定义前缀 + 代次', sessionIdOf(groupMsg, 'chacha', 'guest', 1), 'chacha-group-999-guest-g1')
check('主人和群友是两条会话',
  sessionIdOf(groupMsg, 'qq', 'owner') !== sessionIdOf(groupMsg, 'qq', 'guest'), true)
throws('umoOf(null) 抛错', () => umoOf(null), '需要一条 QqMessage')
throws('sessionKeyOf(null) 抛错', () => sessionKeyOf(null), '需要一条 QqMessage')
throws('sessionIdOf(null) 抛错', () => sessionIdOf(null), '需要一条 QqMessage')

// ══════════════════════════════════════════════════════════════
// 二、gateway（假 WebSocket 注入）
// ══════════════════════════════════════════════════════════════

const quietLog = { info() {}, warn() {}, error() {}, debug() {} }
const fakeSockets = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = () => sleep(0)

/** 假 WebSocket：只实现 gateway 用到的那几个口子（Node 内置 WebSocket 的 EventTarget 风格）。 */
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url) {
    this.url = String(url)
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    this.closeInfo = null
    this.listeners = new Map()
    fakeSockets.push(this)
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(fn)
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn)
  }

  /** 测试用：连上。 */
  open() {
    this.readyState = FakeWebSocket.OPEN
    this.dispatch('open', {})
  }

  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('假 socket 还没开就 send')
    this.sent.push(String(data))
  }

  close(code = 1000, reason = '') {
    this.closeInfo = { code, reason }
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatch('close', { code, reason })
  }

  /** 测试用：服务端推一帧。 */
  push(packet) {
    this.dispatch('message', { data: typeof packet === 'string' ? packet : JSON.stringify(packet) })
  }

  /** 测试用：服务端那边断开。 */
  serverClose(code = 1006, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatch('close', { code, reason })
  }

  serverError(error = new Error('假的上游出错')) {
    this.dispatch('error', error)
  }

  dispatch(type, event) {
    // 复制一份再遍历：监听器里可能摘别的监听器
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }
}

function resetFakes() {
  fakeSockets.length = 0
}

function newGateway(patch = {}) {
  const events = []
  const gateway = new OneBotGateway({
    wsUrl: 'ws://127.0.0.1:3001',
    log: quietLog,
    reconnect: { minDelayMs: 5, maxDelayMs: 20, factor: 2 },
    silenceWarnMs: 60000,
    WebSocketImpl: FakeWebSocket,
    ...patch,
  })
  for (const name of ['open', 'login', 'packet', 'heartbeat', 'stale', 'close', 'error']) {
    gateway.on(name, (payload) => events.push({ name, payload }))
  }
  return { gateway, events }
}

function connectFake(gateway) {
  gateway.connect()
  const socket = fakeSockets.at(-1)
  socket.open()
  return socket
}

const lastSent = (socket) => JSON.parse(socket.sent.at(-1))
const countOf = (events, name) => events.filter((item) => item.name === name).length

group('gateway：正常收发')

resetFakes()
{
  const { gateway, events } = newGateway()
  const socket = connectFake(gateway)
  check('连上后 connected=true', gateway.connected, true)
  check('open 事件发了', countOf(events, 'open'), 1)
  check('连上先问登录号', lastSent(socket).action, 'get_login_info')

  const loginFrame = lastSent(socket)
  socket.push({ status: 'ok', retcode: 0, data: { user_id: Number(SELF), nickname: '茶茶酱' }, echo: loginFrame.echo })
  await tick()
  check('selfId 记下来了', gateway.selfId, SELF)
  check('login 事件带原始 data', events.find((item) => item.name === 'login')?.payload?.user_id, Number(SELF))
  check('healthy 初始为 true', gateway.healthy, true)

  socket.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true, online: true }, interval: 30000 })
  check('heartbeat 事件发了', countOf(events, 'heartbeat'), 1)
  check('心跳间隔记下来了', gateway.heartbeatInterval, 30000)
  check('心跳 good=true → healthy', gateway.healthy, true)

  socket.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: false } })
  check('心跳 good=false → 不健康', gateway.healthy, false)
  socket.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true } })
  check('心跳恢复 good=true → 健康', gateway.healthy, true)

  const messageFrame = rawPrivate({ segments: [text('hi')] })
  socket.push(messageFrame)
  check('普通事件走 packet 事件', countOf(events, 'packet'), 1)
  check('packet 原样透传', events.find((item) => item.name === 'packet')?.payload, messageFrame)
  gateway.close()
}

group('gateway：echo 匹配、失败与超时')

resetFakes()
{
  const { gateway } = newGateway()
  const socket = connectFake(gateway)
  // 先把连上时自动发的 get_login_info 回掉，后面的 pending 计数才干净
  const loginFrame = lastSent(socket)
  socket.push({ status: 'ok', retcode: 0, data: { user_id: Number(SELF) }, echo: loginFrame.echo })
  await tick()

  const pending = gateway.call('send_group_msg', { group_id: '999', message: [text('hi')] })
  const frame = lastSent(socket)
  check('发出去的 action', frame.action, 'send_group_msg')
  check('参数原样带上', frame.params.group_id, '999')
  check('echo 是唯一的', typeof frame.echo, 'string')
  socket.push({ status: 'ok', retcode: 0, data: { message_id: 888 }, echo: frame.echo })
  check('回包 data 解出来', await pending, { message_id: 888 })
  check('成功后 pending 清空', gateway.pending.size, 0)

  const failing = gateway.call('send_private_msg', { user_id: '1', message: [] })
  const failFrame = lastSent(socket)
  socket.push({ status: 'failed', retcode: 100, message: '风控', echo: failFrame.echo })
  await rejects('retcode 非 0 会 reject', () => failing, 'retcode=100')
  await rejects('超时会 reject', () => gateway.call('get_group_list', {}, 30), '超时')
  check('超时后 pending 清空', gateway.pending.size, 0)

  socket.push({ status: 'ok', retcode: 0, echo: '不存在的 echo', data: {} })
  check('未知 echo 不会炸也不占 pending', gateway.pending.size, 0)
  ok('未知 echo 之后连接还在', gateway.connected)

  const hanging = gateway.call('get_group_list')
  socket.serverClose(1006)
  await rejects('断线让挂起的调用失败', () => hanging, '断开')
  check('断线后 connected=false', gateway.connected, false)
  gateway.close()

  const { gateway: offline } = newGateway()
  await rejects('没连上就 call 直接 reject', () => offline.call('get_group_list'), '未连接')
  offline.close()
}

group('gateway：断线与指数退避')

resetFakes()
{
  const { gateway, events } = newGateway()
  gateway.connect()
  const first = fakeSockets.at(-1)
  first.open()

  first.serverClose(1006)
  check('断线发 close 事件', countOf(events, 'close'), 1)
  check('第一次退避 5*2=10ms', gateway.delay, 10)
  await sleep(30)
  check('按退避时间重连了（第 2 条连接）', fakeSockets.length, 2)
  const second = fakeSockets.at(-1)
  check('新连接还没 open', second.readyState, FakeWebSocket.CONNECTING)
  second.open()
  check('重连后 connected', gateway.connected, true)
  check('连上成功后退避复位', gateway.delay, 5)

  second.serverClose(1006)
  check('第二次退避 5*2=10ms', gateway.delay, 10)
  await sleep(30)
  check('第二次重连（第 3 条连接）', fakeSockets.length, 3)
  const third = fakeSockets.at(-1)
  third.serverClose(1006)
  check('第三次退避翻倍到 20ms', gateway.delay, 20)
  await sleep(40)
  check('第三次重连（第 4 条连接）', fakeSockets.length, 4)
  const fourth = fakeSockets.at(-1)
  fourth.serverClose(1006)
  check('退避封顶在 maxDelayMs=20', gateway.delay, 20)
  gateway.close()
}

group('gateway：close 与 forceReconnect（v2 坑 15）')

resetFakes()
{
  const { gateway, events } = newGateway()
  const socket = connectFake(gateway)
  gateway.close()
  check('close 后 connected=false', gateway.connected, false)
  check('close 事件标记 intentional', events.filter((item) => item.name === 'close').at(-1)?.payload?.intentional, true)
  ok('旧 socket 真的被关了', socket.readyState === FakeWebSocket.CLOSED)

  const before = fakeSockets.length
  gateway.connect()
  check('close 之后 connect() 被 closing 拦住（这就是重连按钮不能用它的原因）', fakeSockets.length, before)

  gateway.forceReconnect()
  check('forceReconnect 复位 closing', gateway.closing, false)
  check('forceReconnect 真的新建了连接', fakeSockets.length, before + 1)
  const fresh = fakeSockets.at(-1)
  fresh.open()
  check('forceReconnect 的新连接能连上', gateway.connected, true)
  gateway.close()
}

resetFakes()
{
  const { gateway } = newGateway()
  const socket = connectFake(gateway)
  gateway.forceReconnect()
  check('forceReconnect 关掉旧连接', socket.readyState, FakeWebSocket.CLOSED)
  check('forceReconnect 建了新连接', fakeSockets.length, 2)
  const fresh = fakeSockets.at(-1)
  fresh.open()
  check('新连接可用', gateway.connected, true)
  gateway.close()
}

group('gateway：静默检测')

resetFakes()
{
  const { gateway, events } = newGateway({ silenceWarnMs: 60 })
  const socket = connectFake(gateway)
  check('刚连上是健康的', gateway.healthy, true)

  await sleep(260)
  check('静默超时 emit stale', countOf(events, 'stale'), 1)
  check('静默后 healthy=false', gateway.healthy, false)
  await sleep(200)
  check('一次静默只报一次', countOf(events, 'stale'), 1)

  socket.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true } })
  check('收到帧后恢复健康', gateway.healthy, true)
  gateway.close()
}

group('gateway：坏帧不拖垮连接')

resetFakes()
{
  const { gateway } = newGateway()
  const socket = connectFake(gateway)

  socket.push('这不是 JSON')
  ok('坏 JSON 之后连接还在', gateway.connected)

  const boom = () => {
    throw new Error('监听器炸了')
  }
  gateway.on('packet', boom)
  socket.push(rawPrivate({ segments: [text('炸一下')] }))
  gateway.removeListener('packet', boom)
  ok('监听器抛错也没把连接带崩', gateway.connected)

  // EventEmitter 的 'error' 特例：没人监听时会 throw，gateway 必须自己兜住
  const lone = new OneBotGateway({
    wsUrl: 'ws://127.0.0.1:3002',
    log: quietLog,
    silenceWarnMs: 60000,
    WebSocketImpl: FakeWebSocket,
  })
  lone.connect()
  const loneSocket = fakeSockets.at(-1)
  loneSocket.open()
  let crashed = false
  try {
    loneSocket.serverError(new Error('上游冒烟'))
  } catch {
    crashed = true
  }
  ok('没有 error 监听时也不会把进程带崩', !crashed)
  lone.close()

  const call = gateway.call('get_group_list')
  const frame = lastSent(socket)
  socket.push({ status: 'ok', retcode: 0, data: [{ group_id: 999 }], echo: frame.echo })
  check('坏帧之后 call 还能用', await call, [{ group_id: 999 }])
  gateway.close()
}

group('gateway：token')

resetFakes()
{
  const { gateway } = newGateway({ token: 'secret-123' })
  gateway.connect()
  const socket = fakeSockets.at(-1)
  ok('token 走 URL query 传过去', socket.url.includes('access_token=secret-123'), socket.url)
  gateway.close()
}

group('gateway：配置热更新 update()')

resetFakes()
{
  const { gateway } = newGateway()
  const socket = connectFake(gateway)

  check('参数没变 → 不重连', gateway.update({ wsUrl: 'ws://127.0.0.1:3001', token: '' }), false)
  check('参数没变 → 连接没动', fakeSockets.length, 1)
  ok('原连接还活着', socket.readyState === FakeWebSocket.OPEN)

  check('地址变了 → 重连', gateway.update({ wsUrl: 'ws://127.0.0.1:3999' }), true)
  check('确实新建了连接', fakeSockets.length, 2)
  ok('新连接用新地址', fakeSockets.at(-1).url.includes('3999'), fakeSockets.at(-1).url)

  check('token 变了 → 重连', gateway.update({ token: 'tk-1' }), true)
  ok('token 拼进新 URL', fakeSockets.at(-1).url.includes('access_token=tk-1'), fakeSockets.at(-1).url)

  check('只改退避 → 不重连', gateway.update({ reconnect: { minDelayMs: 7, maxDelayMs: 9, factor: 3 } }), false)
  check('新退避参数生效', gateway.reconnect.factor, 3)
  check('只改静默阈值 → 不重连', gateway.update({ silenceWarnMs: 12345 }), false)
  check('新静默阈值生效', gateway.silenceWarnMs, 12345)
  gateway.close()
}

// ══════════════════════════════════════════════════════════════
// 三、api（假网关 + 临时真文件）
// ══════════════════════════════════════════════════════════════

function fakeGateway(data = {}) {
  const calls = []
  return {
    calls,
    async call(action, params, timeoutMs) {
      calls.push({ action, params, timeoutMs })
      return data
    },
  }
}

group('api：发消息')

{
  const gateway = fakeGateway({ message_id: 1 })
  const api = createQqApi(gateway)
  check('私聊返回回包 data', await api.sendPrivate('123', '你好'), { message_id: 1 })
  check('私聊 action', gateway.calls[0].action, 'send_private_msg')
  check('私聊 user_id', gateway.calls[0].params.user_id, '123')
  check('字符串自动包成 text 段', gateway.calls[0].params.message, [text('你好')])
  await api.sendGroup('999', [text('大家好')])
  check('群聊 action', gateway.calls[1].action, 'send_group_msg')
  check('群聊 group_id', gateway.calls[1].params.group_id, '999')
  check('段数组原样透传', gateway.calls[1].params.message, [text('大家好')])
  await rejects('空消息拒绝', () => api.sendPrivate('123', ''), '消息内容为空')
  await rejects('缺 userId 拒绝', () => api.sendPrivate('', [text('x')]), '缺少userId')
  throws('createQqApi 校验网关', () => createQqApi(null), '需要一个能 call 的网关')
}

group('api：管理动作')

{
  const gateway = fakeGateway({})
  const api = createQqApi(gateway)
  await api.ban('999', '123', 600)
  check('禁言 action', gateway.calls[0].action, 'set_group_ban')
  check('禁言参数', gateway.calls[0].params, { group_id: '999', user_id: '123', duration: 600 })
  await api.ban('999', '123')
  check('禁言缺省 10 分钟', gateway.calls[1].params.duration, 600)
  await api.kick('999', '123')
  check('踢人 action', gateway.calls[2].action, 'set_group_kick')
  check('踢人默认不拒绝再加群', gateway.calls[2].params.reject_add_request, false)
  await api.kick('999', '123', true)
  check('踢人带拒绝加群', gateway.calls[3].params.reject_add_request, true)
  await api.recall('555')
  check('撤回 action', gateway.calls[4].action, 'delete_msg')
  check('撤回 message_id', gateway.calls[4].params, { message_id: '555' })
}

group('api：查询与请求')

{
  const gateway = fakeGateway([])
  const api = createQqApi(gateway)
  await api.getGroupList()
  check('群列表 action', gateway.calls[0].action, 'get_group_list')
  await api.getGroupMembers('999')
  check('群成员参数', gateway.calls[1].params, { group_id: '999' })
  await api.getGroupHistory('999', 5)
  check('群历史参数', gateway.calls[2].params, { group_id: '999', count: 5 })
  await api.getGroupHistory('999')
  check('群历史默认 20 条', gateway.calls[3].params.count, 20)
  await api.getFriendList()
  check('好友列表 action', gateway.calls[4].action, 'get_friend_list')
  await api.friendRequest('flag-1', true, '备注')
  check('好友请求参数', gateway.calls[5].params, { flag: 'flag-1', approve: true, remark: '备注' })
  await api.groupRequest('flag-2', false, '不认识')
  check('群请求默认 sub_type=add', gateway.calls[6].params, { flag: 'flag-2', sub_type: 'add', approve: false, reason: '不认识' })
  await api.groupRequest('flag-3', true, '', 'invite')
  check('群邀请 sub_type=invite', gateway.calls[7].params.sub_type, 'invite')
}

group('api：发文件（base64 坑）')

{
  const dir = await mkdtemp(join(tmpdir(), 'dsh-chacha-napcat-'))
  try {
    const imgPath = join(dir, 'pic.png')
    const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])
    const expectedRef = `base64://${imgBytes.toString('base64')}`
    await writeFile(imgPath, imgBytes)

    const txtPath = join(dir, 'note.txt')
    await writeFile(txtPath, 'hello', 'utf8')

    const gateway = fakeGateway({ message_id: 9 })
    const api = createQqApi(gateway)

    await api.sendFileGroup({ groupId: '999', file: imgPath })
    check('图片不走 upload_group_file', gateway.calls[0].action, 'send_group_msg')
    check('图片段类型是 image', gateway.calls[0].params.message[0].type, 'image')
    check('本地图片被读成 base64://（v2 坑）', gateway.calls[0].params.message[0].data.file, expectedRef)

    await api.sendFilePrivate({ userId: '123', file: pathToFileURL(imgPath).href })
    check('私聊图片走 send_private_msg', gateway.calls[1].action, 'send_private_msg')
    check('file:/// 也会被读成 base64://', gateway.calls[1].params.message[0].data.file, expectedRef)

    await api.sendFileGroup({ groupId: '999', file: txtPath })
    check('普通文件走 upload_group_file', gateway.calls[2].action, 'upload_group_file')
    check('普通文件直接传本机路径', gateway.calls[2].params.file, txtPath)
    check('name 默认取文件名', gateway.calls[2].params.name, 'note.txt')
    ok('上传文件给足超时', gateway.calls[2].timeoutMs > 15000, String(gateway.calls[2].timeoutMs))

    await api.sendFilePrivate({ userId: '123', file: pathToFileURL(txtPath).href, name: '说明书.txt' })
    check('私聊文件走 upload_private_file', gateway.calls[3].action, 'upload_private_file')
    check('file:/// 被还原成本地路径', gateway.calls[3].params.file, txtPath)
    check('显式 name 优先', gateway.calls[3].params.name, '说明书.txt')

    await api.sendFilePrivate({ userId: '123', file: imgBytes, name: 'inline.png' })
    check('Buffer 也能发图', gateway.calls[4].params.message[0].data.file, expectedRef)

    await api.sendFileGroup({ groupId: '999', file: 'https://example.com/a.jpg' })
    check('http 图片 URL 原样透传', gateway.calls[5].params.message[0].data.file, 'https://example.com/a.jpg')

    await api.sendFileGroup({ groupId: '999', file: txtPath, folder: '备份' })
    check('群文件可以指定 folder', gateway.calls[6].params.folder, '备份')

    await rejects('文件不存在时报错可读', () => api.sendFileGroup({ groupId: '999', file: join(dir, '没有这张图.png') }), '读不了文件')
    await rejects('缺目标拒绝', () => api.sendFile({ scene: 'group', file: txtPath }), '缺少群号')
    check('toFileRef 透传 base64://', await toFileRef('base64://YWJj'), 'base64://YWJj')
    check('toFileRef 透传 http URL', await toFileRef('https://x/y.png'), 'https://x/y.png')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

clearInterval(keepAlive)
report('NapCat L1 适配层测试')
