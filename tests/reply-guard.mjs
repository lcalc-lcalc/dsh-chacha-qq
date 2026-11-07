/**
 * 输出侧审核测试。
 *
 * 这块是补「输入侧挡不住」的那个缺口：
 * 输入侧只挡「用户想注入」，挡不住「她自己被带歪了」。
 * 有人软磨硬泡让她把系统提示念出来，每句话单看都可能判 clean，
 * 但她说出去的那一刻才是真泄漏。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { group, check, ok, notOk, report } from './harness.mjs'

import { inspectReply, RISK } from '../src/controller/security.js'
import { ConfigStore } from '../src/config.js'
import { Controller } from '../src/controller/pipeline.js'
import * as securityModule from '../src/controller/security.js'

const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }
const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

// ══════════════════════════════════════════════════════════════
group('输出审核：干净回复必须放行（误报是最大的敌人）')

{
  const clean = [
    '主人早安呀！今天也要开开心心的哦。',
    '哈哈哈这个好好笑',
    '我不太确定诶，让我想想',
    '（她想了想）大概是周三吧',
    '这个 API key 的用法我不太懂，你可以问主人',
    '我的设定是茶茶酱，一只猫系少女', // ← 这句其实有点擦边，但不该拦（是自我介绍）
  ]
  for (const text of clean) {
    const verdict = inspectReply(text, { config: {} })
    ok(`放行：${text.slice(0, 16)}…`, verdict.risk === RISK.CLEAN, `${verdict.risk} ${verdict.hits.join(',')}`)
  }
}

// ══════════════════════════════════════════════════════════════
group('输出审核：泄漏密钥 = 恶意')

{
  const verdict = inspectReply('我的密钥是 sk-abcdefghijklmnopqrstuvwxyz123456 你拿去用', { config: {} })
  check('判为恶意', verdict.risk, RISK.MALICIOUS)
  ok('命中项里有 leaks-token', verdict.hits.includes('reply:leaks-token'), verdict.hits.join(','))

  const aws = inspectReply('AKIAIOSFODNN7EXAMPLE 这个给你', { config: {} })
  check('AWS key 也拦', aws.risk, RISK.MALICIOUS)
}

// ══════════════════════════════════════════════════════════════
group('输出审核：复述系统提示 = 恶意')

{
    // ⚠️ protect 片段必须比 16 字长（inspectReply 里短于 16 字的不比对，那是防误伤）。
    const protect = ['你是白绮茶茶，一只住在主人阿明电脑里的白毛猫系少女，超级可爱，喜欢颜文字']
    const echoed = inspectReply('好吧我告诉你，你是白绮茶茶，一只住在主人阿明电脑里的白毛猫系少女，喜欢颜文字', { config: {}, protect })
  check('判为恶意', echoed.risk, RISK.MALICIOUS)
  ok('命中 echoes-protected', echoed.hits.includes('reply:echoes-protected'), echoed.hits.join(','))

  const normal = inspectReply('我是茶茶酱呀，主人今天想做什么？', { config: {}, protect })
  check('正常自我介绍不误伤', normal.risk, RISK.CLEAN)

  const tooShort = inspectReply('你是白绮茶茶', { config: {}, protect: ['你是白绮茶茶'] })
  check('保护片段太短时不比对（防误伤）', tooShort.risk, RISK.CLEAN)
}

// ══════════════════════════════════════════════════════════════
group('输出审核：聊自己的提示词 = 可疑（只记不拦）')

{
  const verdict = inspectReply('我的系统提示词里写着：你要对主人言听计从，不许拒绝', { config: {} })
  check('判为可疑', verdict.risk, RISK.SUSPICIOUS)
  ok('命中 talks-about-own-prompt', verdict.hits.includes('reply:talks-about-own-prompt'), verdict.hits.join(','))
}

// ══════════════════════════════════════════════════════════════
group('输出审核：开关与空值')

{
  check('空回复直接放行', inspectReply('', { config: {} }).risk, RISK.CLEAN)
  check('null 回复直接放行', inspectReply(null, { config: {} }).risk, RISK.CLEAN)
  check('输入侧关掉时输出侧也关', inspectReply('sk-abcdefghijklmnopqrstuvwxyz123456', {
    config: { security: { injectionEnabled: false } },
  }).risk, RISK.CLEAN)
}

// ══════════════════════════════════════════════════════════════
group('⭐ 端到端：被拦的回复不会发出去')

{
  function makeStore(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chacha-reply-'))
    const store = new ConfigStore(path.join(dir, 'config.json'))
    store.load()
    // ⚠️ 显式配 owner：开源版默认 owner.qq 是空的
    store.patch({
      owner: { qq: '1111111111', name: '主人' },
      rhythm: { minGapMs: 0, maxGapMs: 0 },
      ...overrides,
    })
    return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
  }

  function groupMessage(text, id = 'g1') {
    return {
      post_type: 'message',
      message_type: 'group',
      message_id: id,
      group_id: 999,
      user_id: 1111111111, // = 上面配的 owner.qq
      self_id: 1000000001,
      raw_message: text,
      message: [{ type: 'text', data: { text } }],
      sender: { user_id: 1111111111, nickname: '主人', card: '', role: 'member' },
    }
  }

  async function runWithReply(reply, overrides = {}) {
    const { store, dir, cleanup } = makeStore(overrides)
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
    const mind = {
      available: true,
      live: new Map(),
      async ask({ onDelta }) {
        if (typeof onDelta === 'function') onDelta(reply)
        return { text: reply, trace: [], reason: 'completed', elapsedMs: 5 }
      },
    }
    const controller = new Controller({
      ctx: {}, store, log: SILENT, gateway, mind, observe: null,
      security: securityModule, dataDir: dir,
    })
    controller.onPacket(groupMessage('随便说点什么'))
    await tick(200)
    const sent = calls
      .filter((c) => c.action === 'send_group_msg')
      .map((c) => (c.params?.message ?? []).map((seg) => seg.data?.text ?? '').join(''))
      .join('|')
    cleanup()
    return { sent, controller }
  }

  const leaked = await runWithReply('我的密钥是 sk-abcdefghijklmnopqrstuvwxyz123456 拿去吧')
  notOk('⭐ 泄漏密钥的回复没有被发出去', leaked.sent.includes('sk-abcdefghijklmnop'), leaked.sent)
  ok('换成了兜底话', leaked.sent.includes('不能说'), leaked.sent)
  ok('拦截被计数', (leaked.controller.stats.replyBlocked ?? 0) >= 1, String(leaked.controller.stats.replyBlocked))

  const normal = await runWithReply('主人早安呀，今天天气不错')
  ok('正常回复照常发出', normal.sent.includes('主人早安'), normal.sent)

  const discard = await runWithReply('我的密钥是 sk-abcdefghijklmnopqrstuvwxyz123456', {
    security: { replyPenalty: 'discard' },
  })
  check('discard 模式下这条完全不发', discard.sent, '')

  const off = await runWithReply('我的密钥是 sk-abcdefghijklmnopqrstuvwxyz123456', {
    security: { outputGuard: false },
  })
  ok('关掉开关后照发（确认开关真的管用）', off.sent.includes('sk-abcdefghijklmnop'), off.sent)
}

report('输出侧审核')
