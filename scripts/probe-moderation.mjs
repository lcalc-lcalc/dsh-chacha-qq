/**
 * 群管接线探针：验证「广告刷屏 → 自动禁言」这条链真的通，
 * 并且**管理员 / 群主 / 主人永不被禁言**。
 *
 * 只读探针：用假网关 + 临时配置，不连 NapCat、不发真消息。
 *
 * 跑法：node scripts/probe-moderation.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ConfigStore } from '../src/config.js'
import { Controller } from '../src/controller/pipeline.js'
import * as moderation from '../src/controller/moderation.js'

const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chacha-mod-'))
const store = new ConfigStore(path.join(dir, 'config.json'))
store.load()
  store.patch({
    // ⚠️ 必须显式配 owner：开源版 DEFAULT_CONFIG.owner.qq 是空的。
    //    不配的话「主人不被禁言」这条断言测的其实是「一个陌生人不被禁言」—— 假绿。
    owner: { qq: '1111111111', name: '主人' },
  moderation: {
    watchAll: true,
    banEnabled: true,
    hotKeywords: ['加微信', '刷单', '日结'],
    defaultBanMinutes: 10,
    maxBanMinutes: 60,
    notifyOwner: true,
  },
  rhythm: { minGapMs: 0, maxGapMs: 0 },
})

const calls = []
const gateway = {
  selfId: '1000000001',
  connected: true,
  on() {},
  connect() {},
  close() {},
  async call(action, params) {
    calls.push({ action, params })
    return { ok: true }
  },
}
const mind = { available: false, live: new Map(), async ask() { return { text: '' } } }

const controller = new Controller({
  ctx: {}, store, log: SILENT, gateway, mind,
  observe: null, interest: null, tags: null, security: null,
  moderation, dataDir: dir,
})

let seq = 0
function groupMessage({ userId, text, role = 'member', groupId = 999 }) {
  seq += 1
  return {
    post_type: 'message',
    message_type: 'group',
    message_id: `probe-${seq}`,
    group_id: Number(groupId),
    user_id: Number(userId),
    self_id: 1000000001,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: Number(userId), nickname: '探针', card: '', role },
  }
}

function bans() {
  return calls.filter((item) => item.action === 'set_group_ban')
}

let failures = 0
function assert(name, condition, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures += 1
}

// ① 普通群友发广告 → 应该被禁言
controller.onPacket(groupMessage({ userId: '111111', text: '加我微信领红包，日结刷单' }))
await sleep(150)
const firstBans = bans()
assert('群友发广告被禁言', firstBans.length === 1, JSON.stringify(firstBans[0]?.params ?? null))
assert('禁言时长在 60 分钟内', Number(firstBans[0]?.params?.duration) <= 3600,
  `${firstBans[0]?.params?.duration}s`)

// ② 管理员发同样的话 → 绝不能被禁言
calls.length = 0
controller.onPacket(groupMessage({ userId: '222222', text: '加我微信，日结刷单', role: 'admin' }))
await sleep(150)
assert('管理员不被禁言', bans().length === 0, `禁言调用=${bans().length}`)

// ③ 群主发同样的话 → 绝不能被禁言
calls.length = 0
controller.onPacket(groupMessage({ userId: '333333', text: '加我微信，日结刷单', role: 'owner' }))
await sleep(150)
assert('群主不被禁言', bans().length === 0, `禁言调用=${bans().length}`)

// ④ 主人发同样的话 → 绝不能被禁言
calls.length = 0
controller.onPacket(groupMessage({ userId: '1111111111', text: '加我微信，日结刷单', role: 'member' }))
await sleep(150)
assert('主人不被禁言', bans().length === 0, `禁言调用=${bans().length}`)

// ⑤ 正常聊天不误伤
calls.length = 0
controller.onPacket(groupMessage({ userId: '444444', text: '今天天气不错，出去走走吧' }))
await sleep(150)
assert('正常聊天不误伤', bans().length === 0, `禁言调用=${bans().length}`)

// ⑥ 同一个人连续刷屏 → 冷却期内不重复调 API
calls.length = 0
store.patch({ security: { penaltyCooldownMs: 3600000 } })
for (let i = 0; i < 5; i += 1) {
  controller.onPacket(groupMessage({ userId: '555555', text: `加微信刷单第 ${i} 条` }))
}
await sleep(300)
assert('连续刷屏只罚一次（有冷却）', bans().length === 1, `禁言调用=${bans().length}`)

controller.stop()
fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '✅ 群管接线全部正常' : `❌ ${failures} 项异常`}\n`)
if (failures > 0) process.exitCode = 1
