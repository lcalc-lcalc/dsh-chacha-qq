/**
 * 记忆 v3.2 测试套件：结构化事实 + 自动总结 + 「什么时候不查」路由 + 按相关注入。
 *
 * 跑法： cd E:\dsh-dev\dsh-chacha-qq-v3; node tests/memory-v2.mjs
 *
 * 约定：
 *   · 全部在系统临时目录里跑（fs.mkdtempSync），测完删干净 —— **绝不碰真实 data 目录**。
 *   · 时间一律注入假时钟（now），衰减/淘汰才能定点断言。
 *   · 模型一律注入假函数（runModel），测试不联网、不花钱。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { group, check, ok, notOk, report } from './harness.mjs'

import {
  FACT_KINDS,
  MEMORY_DEFAULTS,
  MemoryStore,
  factFingerprint,
  renderFactLine,
} from '../src/controller/memory/store.js'

import {
  Summarizer,
  buildSummaryPrompt,
  parseSummaryOutput,
} from '../src/controller/memory/summarize.js'

import { decideRetrieval } from '../src/controller/memory/route.js'

// --------------------------------------------------------------------------
// 脚手架
// --------------------------------------------------------------------------

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 本地时区的 2026-11-07 12:00（dayStamp 也是本地口径）。 */
const START = new Date(2026, 10, 7, 12, 0, 0).getTime()

function createClock(start = START) {
  let value = start
  return {
    now: () => value,
    get value() {
      return value
    },
    advance(ms) {
      value += ms
      return value
    },
    set(ms) {
      value = ms
      return value
    },
  }
}

const tmpRoots = []
function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chacha-memory-v2-${prefix}-`))
  tmpRoots.push(dir)
  return dir
}

function listFiles(dir, base = dir) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else out.push(path.relative(base, full))
  }
  return out
}

function cleanupTmp() {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结果
    }
  }
  tmpRoots.length = 0
}

/** 一个临时记忆库 + 假时钟。 */
function makeStore(prefix, config = {}, start = START) {
  const dataDir = makeTmp(prefix)
  const clock = createClock(start)
  const store = new MemoryStore({ dataDir, config, now: clock.now })
  return { dataDir, clock, store }
}

/** 假模型：返回一段固定 JSON，并记下调用次数 / 最后一次提示词。 */
function fakeModel(reply, counter = { calls: 0, prompts: [] }) {
  return {
    counter,
    run: async (prompt) => {
      counter.calls += 1
      counter.prompts.push(prompt)
      if (typeof reply === 'function') return reply(prompt)
      return reply
    },
  }
}

// ==========================================================================
// 一、结构化事实：写入 / 去重合并
// ==========================================================================

group('事实 · appendFact 去重合并（域内指纹）')

{
  const { store, clock } = makeStore('facts-dedup')

  check('facts.jsonl 路径在 memory/ 下', store.factsPath, path.join(store.root, 'facts.jsonl'))

  const first = await store.appendFact({
    text: '主人 喜欢吃辣。',
    kind: 'preference',
    importance: 0.6,
    confidence: 0.7,
    evidence: ['2026-11-05 12:03 主人：我喜欢吃辣'],
    tags: ['饮食'],
  })
  check('第一次写入不是去重', first.deduped, false)
  check('写成功', first.ok, true)
  ok('id 以 f_ 开头', first.id.startsWith('f_'), first.id)
  ok('facts.jsonl 真的建出来了', fs.existsSync(store.factsPath))
  check('落盘一条', store.listFacts().length, 1)
  check('来源默认 manual', store.listFacts()[0].source, 'manual')
  check('tags 落盘', store.listFacts()[0].tags, ['饮食'])

  // 归一化后（去空白/标点）同指纹 → 合并
  const second = await store.appendFact({
    text: '主人喜欢吃辣',
    kind: 'preference',
    importance: 0.4,
    confidence: 0.5,
    evidence: ['2026-11-06 09:00 主人：我超爱吃辣'],
  })
  check('同指纹第二次被合并（不是新增）', second.deduped, true)
  check('合并后 id 不变', second.id, first.id)
  check('仍然只有一条', store.listFacts().length, 1)

  const merged = store.listFacts()[0]
  check('importance 取大（0.6 没被 0.4 拉低）', merged.importance, 0.6)
  check('confidence 取大（0.7 没被 0.5 拉低）', merged.confidence, 0.7)
  check('evidence 追加到 2 条', merged.evidence.length, 2)
  ok('新证据也在', merged.evidence.includes('2026-11-06 09:00 主人：我超爱吃辣'))

  const raised = await store.appendFact({
    text: '主人喜欢吃辣',
    kind: 'preference',
    importance: 0.9,
    confidence: 0.95,
  })
  const stronger = store.listFacts()[0]
  check('importance 能被抬高（取大不是取新）', stronger.importance, 0.9)
  check('confidence 能被抬高', stronger.confidence, 0.95)
  check('at 更新成这次的时间', stronger.at, clock.value)
  check('抬高的也是同一条', raised.id, first.id)

  // 不同 kind 是不同「域」，不该互相合并（「喜欢吃辣」既是偏好也是事实时两条各有用）
  const otherKind = await store.appendFact({ text: '主人喜欢吃辣', kind: 'fact' })
  check('不同 kind 不合并（域内指纹）', otherKind.deduped, false)
  check('两条各归各的 kind', store.listFacts().length, 2)

  // evidence 上限 8，且保留最新的
  for (let i = 0; i < 10; i += 1) {
    await store.appendFact({
      text: '主人喜欢吃辣',
      kind: 'preference',
      evidence: [`ev-${i}`],
    })
  }
  const capped = store.listFacts({ kind: 'preference' })[0]
  check('evidence 上限 8 条', capped.evidence.length, 8)
  ok('留下的是最新的证据（ev-9 在）', capped.evidence.includes('ev-9'))
  notOk('最老的证据被挤掉（ev-0 不在）', capped.evidence.includes('ev-0'))

  // 垃圾字段 / 未知 kind / 空文本
  const junk = await store.appendFact({ text: '主人养了一只猫', kind: '这是什么类型' })
  check('未知 kind 归一化成 fact', store.listFacts().find((item) => item.id === junk.id).kind, 'fact')
  const empty = await store.appendFact({ text: '   ' })
  check('空文本不写', empty.ok, false)
  check('空文本不产生记录', store.listFacts().length, 3)
  ok('多行文本压成一行', !store.listFacts().some((item) => item.text.includes('\n')))

  check('kind 枚举就是五种', FACT_KINDS, ['preference', 'fact', 'promise', 'relationship', 'open_loop'])
  check('指纹只取归一化前 40 字', factFingerprint('字'.repeat(100)).length, 40)
  check('同内容不同空白/标点指纹一样', factFingerprint('主人 喜欢，吃辣。'), factFingerprint('主人喜欢吃辣'))

  await store.dispose()
}

group('事实 · listFacts 排序 / 过滤 / 坏行容错')

{
  const { store } = makeStore('facts-list')
  await store.appendFact({ text: '较早的一条', kind: 'fact', at: START - DAY })
  await store.appendFact({ text: '较晚的一条', kind: 'preference', at: START })
  await store.appendFact({ text: '没写时间的一条', kind: 'promise' })

  const all = store.listFacts()
  check('按时间新到旧', all[0].text, '较晚的一条')
  check('kind 过滤', store.listFacts({ kind: 'preference' }).length, 1)
  check('limit 生效', store.listFacts({ limit: 1 }).length, 1)
  check('未知 kind 过滤 → 空', store.listFacts({ kind: '不存在' }), [])
  check('数组 kind 也认', store.listFacts({ kind: ['fact', 'promise'] }).length, 2)

  // 手工插一行坏的 + 一行合法的（主人手改 / 断电容灾）
  fs.appendFileSync(
    store.factsPath,
    `这不是 JSON，应该被跳过\n${JSON.stringify({ text: '主人手写的一条', kind: '偏好', at: START })}\n`,
    'utf8',
  )
  const after = store.listFacts()
  check('坏行跳过、好行照读', after.length, 4)
  ok('手写记录认出来了', after.some((item) => item.text === '主人手写的一条'))
  ok('缺 id 的记录补了 id', after.find((item) => item.text === '主人手写的一条').id.startsWith('f_'))

  check('手写的「偏好」也被归一化', after.find((item) => item.text === '主人手写的一条').kind, 'preference')
  check('stats 数得清事实条数', store.stats().facts, 4)

  await store.dispose()
}

group('事实 · pruneFacts 按 (importance × 衰减) 淘汰 / removeFact')

{
  const { store } = makeStore('facts-prune', { factsHalfLifeDays: 30 })
  const oldStrong = await store.appendFact({ text: '重要的老事', importance: 0.9, at: START - 60 * DAY })
  await store.appendFact({ text: '中等的新事', importance: 0.5, at: START - 10 * DAY })
  await store.appendFact({ text: '很弱的新事', importance: 0.05, at: START })

  const pruned = await store.pruneFacts({ maxCount: 2 })
  check('淘汰 1 条', pruned.removed, 1)
  check('保留 2 条', store.listFacts().length, 2)
  const texts = store.listFacts().map((item) => item.text)
  ok('老的但重要的活下来（不是纯按时间砍）', texts.includes('重要的老事'))
  notOk('最新的弱事实先被淘汰', texts.includes('很弱的新事'))

  const noop = await store.pruneFacts({ maxCount: 10 })
  check('没超上限就不动', noop.removed, 0)

  check('删一条返回 true', await store.removeFact(oldStrong.id), true)
  check('删完只剩 1 条', store.listFacts().length, 1)
  check('删不存在的返回 false', await store.removeFact(oldStrong.id), false)
  check('空 id 返回 false', await store.removeFact(''), false)

  // 默认上限来自配置（设个很小的值验证 pruneFacts() 不传参也走配置）
  const tight = makeStore('facts-prune-config', { factsMaxCount: 10 })
  for (let i = 0; i < 12; i += 1) {
    await tight.store.appendFact({ text: `第${i}条`, importance: 0.5, at: START - i * DAY })
  }
  const viaConfig = await tight.store.pruneFacts()
  check('pruneFacts() 读配置上限（12 → 10）', viaConfig.removed, 2)
  check('配置上限守得住', tight.store.listFacts().length, 10)

  await store.dispose()
  await tight.store.dispose()
}

// ==========================================================================
// 二、自动总结：提示词
// ==========================================================================

group('总结 · buildSummaryPrompt（只抽值得长期记住的）')

{
  const prompt = buildSummaryPrompt({
    turns: [
      { speaker: 'owner', text: '我喜欢吃辣', at: START },
      { speaker: 'self', text: '记住啦', at: START + MINUTE },
    ],
    existingFacts: [{ text: '主人讨厌香菜', kind: 'preference' }],
  })

  ok('带上了对话原文', prompt.includes('我喜欢吃辣'))
  ok('带上了两边的说话人', prompt.includes('主人') && prompt.includes('茶茶酱'))
  ok('按真实先后排列', prompt.indexOf('我喜欢吃辣') < prompt.indexOf('记住啦'))
  ok('要求输出 JSON 数组', prompt.includes('JSON 数组'))
  ok('给了五个 kind', FACT_KINDS.every((kind) => prompt.includes(kind)))
  ok('给了四个字段', ['"text"', '"kind"', '"importance"', '"confidence"'].every((key) => prompt.includes(key)))
  ok('明确要求抽喜好/约定/关系/未完成', ['喜好', '约定', '关系', '没做完'].every((word) => prompt.includes(word)))
  ok('明确禁止抽一次性闲聊', prompt.includes('一次性的寒暄'))
  ok('明确禁止编造', prompt.includes('不要编'))
  ok('已有事实带进去了（防重复写）', prompt.includes('主人讨厌香菜'))
  ok('要求最多 8 条', prompt.includes('最多 8 条'))

  const noExisting = buildSummaryPrompt({ turns: [{ speaker: 'owner', text: '在吗' }] })
  notOk('没有已有事实时不出现「已经记过的」整段', noExisting.includes('## 已经记过的'))
  ok('字符串 turn 也认', buildSummaryPrompt({ turns: ['在吗', '我想吃火锅'] }).includes('我想吃火锅'))
  ok('空 turns 也要能给出合法提示词', buildSummaryPrompt({}).includes('没有拿到对话内容'))
  ok('超长对话只带最后 60 条（防止撑爆提示词）',
    buildSummaryPrompt({ turns: Array.from({ length: 80 }, (_, i) => `第${i}句`) }).includes('第79句'))
}

// ==========================================================================
// 三、自动总结：解析容错
// ==========================================================================

group('总结 · parseSummaryOutput 容错（围栏 / 缺字段 / 截断 / 非数组）')

{
  const plain = parseSummaryOutput(
    '[{"text":"主人喜欢吃辣","kind":"preference","importance":0.9,"confidence":0.8}]',
  )
  check('正常 JSON 数组：条数', plain.length, 1)
  check('正常 JSON：正文', plain[0].text, '主人喜欢吃辣')
  check('正常 JSON：kind', plain[0].kind, 'preference')
  check('正常 JSON：importance', plain[0].importance, 0.9)
  check('正常 JSON：confidence', plain[0].confidence, 0.8)

  const fenced = parseSummaryOutput(
    '```json\n[{"text":"主人讨厌香菜","kind":"preference","importance":0.7}]\n```',
  )
  check('```json 围栏能剥', fenced[0]?.text, '主人讨厌香菜')

  const prose = parseSummaryOutput(
    '好的，我整理如下：\n[{"text":"主人周六去看房","kind":"promise"}]\n完毕。',
  )
  check('前后有废话也能抠出数组', prose[0]?.text, '主人周六去看房')

  const missing = parseSummaryOutput('[{"text":"主人在做嵌入开发"}]')
  check('缺 kind → fact', missing[0].kind, 'fact')
  check('缺 importance → 0.5', missing[0].importance, 0.5)
  check('缺 confidence → 0.6', missing[0].confidence, 0.6)

  const truncated = parseSummaryOutput(
    '[{"text":"主人喜欢吃辣","kind":"preference","importance":0.9},' +
    '{"text":"主人讨厌香菜","kind":"preference","importance":0.7},' +
    '{"text":"主人答',
  )
  check('截断的 JSON：抢救出完整的 2 条', truncated.length, 2)
  check('截断抢救的第一条', truncated[0].text, '主人喜欢吃辣')
  check('截断抢救的第二条', truncated[1].text, '主人讨厌香菜')

  const wrapped = parseSummaryOutput(
    '{"facts":[{"text":"主人喜欢喝奶茶","kind":"偏好","importance":9},{"text":"主人怕冷","kind":"fact"}]}',
  )
  check('对象包装 {facts:[...]} 也认', wrapped.length, 2)
  check('中文 kind「偏好」→ preference', wrapped[0].kind, 'preference')
  check('百分制 importance 9 → 0.9', wrapped[0].importance, 0.9)
  check('中文「待办」→ open_loop', parseSummaryOutput('[{"text":"还在等面试结果","kind":"待办"}]')[0].kind, 'open_loop')

  const single = parseSummaryOutput('{"text":"主人养了一只猫","kind":"fact"}')
  check('单个对象也能当一条', single.length, 1)

  const percent = parseSummaryOutput('[{"text":"主人喜欢猫","kind":"fact","confidence":"90%","importance":"80%"}]')
  check('百分号 confidence', percent[0].confidence, 0.9)
  check('百分号 importance', percent[0].importance, 0.8)

  const clamped = parseSummaryOutput('[{"text":"主人很讨厌下雨","kind":"preference","importance":999,"confidence":-5}]')
  check('超范围 importance 夹到 1', clamped[0].importance, 1)
  check('负数 confidence 夹到 0', clamped[0].confidence, 0)

  check('非数组 JSON → 空数组', parseSummaryOutput('{"a":1}'), [])
  check('纯文本 → 空数组', parseSummaryOutput('这段聊天很愉快'), [])
  check('空串 → 空数组', parseSummaryOutput(''), [])
  check('null → 空数组', parseSummaryOutput('null'), [])
  check('[1,2,3] → 空数组（没有可用条目）', parseSummaryOutput('[1,2,3]'), [])

  const deduped = parseSummaryOutput(
    '[{"text":"主人喜欢吃辣","kind":"preference"},{"text":"主人 喜欢吃辣。","kind":"preference"}]',
  )
  check('输出内部去重（同指纹）', deduped.length, 1)

  const stringItems = parseSummaryOutput('["主人喜欢喝奶茶"]')
  check('数组里是字符串也认', stringItems[0]?.kind, 'fact')
}

// ==========================================================================
// 四、自动总结：攒批 / 成功清空 / 失败保留
// ==========================================================================

group('总结 · Summarizer 攒够才总结，成功的 turns 清掉')

{
  const { store, clock } = makeStore('summarizer-ok')
  const model = fakeModel(
    JSON.stringify([
      { text: '主人喜欢吃辣', kind: 'preference', importance: 0.9, confidence: 0.8 },
    ]),
  )
  const summarizer = new Summarizer({
    store,
    now: clock.now,
    config: { summarize: { minTurns: 3, maxChars: 10000 } },
    runModel: model.run,
  })

  summarizer.markTurn('owner-1', { speaker: 'owner', text: '我喜欢吃辣', at: START })
  summarizer.markTurn('owner-1', { speaker: 'owner', text: '我还喜欢喝奶茶', at: START + MINUTE })
  check('攒了 2 条', summarizer.pendingOf('owner-1').turns, 2)
  ok('字数也算得出来', summarizer.pendingOf('owner-1').chars > 0)

  // 重复标同一条不重复计数
  summarizer.markTurn('owner-1', { speaker: 'owner', text: '我喜欢吃辣', at: START })
  check('重复标记不重复计数', summarizer.pendingOf('owner-1').turns, 2)

  const notYet = await summarizer.maybeSummarize({ peerKey: 'owner-1' })
  check('没攒够不总结', notYet.summarized, false)
  ok('reason 说清了没攒够', notYet.reason.includes('还没攒够'), notYet.reason)
  check('没攒够不调模型（省钱）', model.counter.calls, 0)
  check('没攒够 turns 还在', summarizer.pendingOf('owner-1').turns, 2)

  summarizer.markTurn('owner-1', { speaker: 'owner', text: '周末想吃火锅', at: START + 2 * MINUTE })
  const done = await summarizer.maybeSummarize({ peerKey: 'owner-1' })
  check('攒够 3 条就总结', done.summarized, true)
  check('新写进去 1 条', done.added, 1)
  check('模型只调了一次', model.counter.calls, 1)
  check('成功的 turns 清掉了', summarizer.pendingOf('owner-1').turns, 0)
  check('facts 真落盘了', store.listFacts().length, 1)

  const fact = store.listFacts()[0]
  check('事实来源标成 summary', fact.source, 'summary')
  ok('事实带证据（哪句话来的）', fact.evidence.some((item) => item.includes('我喜欢吃辣')), fact.evidence)
  ok('提示词里带上了这轮对话', model.counter.prompts[0].includes('周末想吃火锅'))

  const again = await summarizer.maybeSummarize({ peerKey: 'owner-1' })
  check('总结完了再调不会重复总结', again.summarized, false)
  check('也不会再白花一次模型调用', model.counter.calls, 1)

  // reset / dispose
  summarizer.markTurn('owner-1', { speaker: 'owner', text: '新攒的一句', at: START + 3 * MINUTE })
  check('又攒了 1 条', summarizer.pendingOf('owner-1').turns, 1)
  summarizer.reset('owner-1')
  check('reset 清空待总结', summarizer.pendingOf('owner-1').turns, 0)
  summarizer.dispose()

  await store.dispose()
}

group('总结 · 失败不抛错、不吞 turns（下次还能接着试）')

{
  const { store, clock } = makeStore('summarizer-fail')
  const failing = new Summarizer({
    store,
    now: clock.now,
    config: { summarize: { minTurns: 2, maxChars: 10000 } },
    runModel: async () => {
      throw new Error('模型超时了')
    },
  })
  failing.markTurn('p-fail', { speaker: 'owner', text: '我喜欢吃辣', at: START })
  failing.markTurn('p-fail', { speaker: 'owner', text: '我也喜欢喝奶茶', at: START + MINUTE })

  const failed = await failing.maybeSummarize({ peerKey: 'p-fail' })
  check('模型挂了也不抛错', failed.summarized, false)
  ok('reason 里有失败原因', failed.reason.includes('总结失败'), failed.reason)
  check('失败的 turns 一条没丢', failing.pendingOf('p-fail').turns, 2)
  check('失败时不写事实', store.listFacts().length, 0)

  // 模型恢复 → 同一批 turns 还能被总结（证明真的留着）
  failing.runModel = async () =>
    JSON.stringify([{ text: '主人喜欢喝奶茶', kind: 'preference', importance: 0.7 }])
  const retried = await failing.maybeSummarize({ peerKey: 'p-fail' })
  check('下次重试成功', retried.summarized, true)
  check('重试后 turns 才清掉', failing.pendingOf('p-fail').turns, 0)
  check('重试后事实落盘', store.listFacts().length, 1)

  // 返回垃圾 → 同样保留 turns
  const garbage = new Summarizer({
    store,
    now: clock.now,
    config: { summarize: { minTurns: 2, maxChars: 10000 } },
    runModel: async () => '我觉得这段聊天挺开心的，没什么可记的',
  })
  garbage.markTurn('p-junk', { speaker: 'owner', text: '今天好累', at: START })
  garbage.markTurn('p-junk', { speaker: 'owner', text: '先睡了', at: START + MINUTE })
  const junk = await garbage.maybeSummarize({ peerKey: 'p-junk' })
  check('返回垃圾不算成功', junk.summarized, false)
  ok('reason 说明模型没给出条目', junk.reason.includes('有效条目'), junk.reason)
  check('垃圾输出时 turns 保留', garbage.pendingOf('p-junk').turns, 2)

  // 返回空数组也算「没东西可记」→ 保留，下次继续（不静默吞掉）
  const emptyModel = new Summarizer({
    store,
    now: clock.now,
    config: { summarize: { minTurns: 2, maxChars: 10000 } },
    runModel: async () => '[]',
  })
  emptyModel.markTurn('p-empty', { speaker: 'owner', text: '哈哈', at: START })
  emptyModel.markTurn('p-empty', { speaker: 'owner', text: '晚安', at: START + MINUTE })
  check('返回 [] 也保留 turns', (await emptyModel.maybeSummarize({ peerKey: 'p-empty' })).summarized, false)

  await store.dispose()
}

group('总结 · 触发条件（字数）/ 关掉 / 没注入模型 / 外部 turns')

{
  // 字数触发：1 条长消息（超过 maxChars）就该总结，不用等 12 条
  const { store, clock } = makeStore('summarizer-chars')
  const model = fakeModel(JSON.stringify([{ text: '主人今天工作很累', kind: 'fact', importance: 0.4 }]))
  const summarizer = new Summarizer({
    store,
    now: clock.now,
    config: { summarize: { minTurns: 10, maxChars: 50 } },
    runModel: model.run,
  })
  summarizer.markTurn(
    'p-long',
    { speaker: 'owner', text: '今天加班到很晚，累得不行，想早点睡。'.repeat(3), at: START },
  )
  check('1 条还没到条数门槛', summarizer.pendingOf('p-long').turns, 1)
  ok('但字数已经过了门槛', summarizer.pendingOf('p-long').chars >= 50)
  const byChars = await summarizer.maybeSummarize({ peerKey: 'p-long' })
  check('字数到了就总结（不用等条数）', byChars.summarized, true)
  check('模型被调了', model.counter.calls, 1)

  await store.dispose()
}

{
  const { store, clock } = makeStore('summarizer-gates')

  const disabled = new Summarizer({
    store,
    now: clock.now,
    config: { summarize: { enabled: false, minTurns: 1 } },
    runModel: async () => '[]',
  })
  disabled.markTurn('p', { speaker: 'owner', text: '我喜欢吃辣', at: START })
  const off = await disabled.maybeSummarize({ peerKey: 'p' })
  check('summarize.enabled=false → 不总结', off.summarized, false)
  ok('reason 说明关了', off.reason.includes('已关'))
  check('关掉时 turns 也留着（开了还能用）', disabled.pendingOf('p').turns, 1)

  const noModel = new Summarizer({
    store,
    now: clock.now,
    config: { summarize: { minTurns: 1, maxChars: 1 } },
  })
  noModel.markTurn('p', { speaker: 'owner', text: '我喜欢吃辣', at: START })
  const noRun = await noModel.maybeSummarize({ peerKey: 'p' })
  check('没有 runModel → 不总结而不是崩', noRun.summarized, false)
  ok('reason 说明缺少模型', noRun.reason.includes('runModel'))
  check('没模型也不吞 turns', noModel.pendingOf('p').turns, 1)

  const noStore = new Summarizer({
    config: { summarize: { minTurns: 1, maxChars: 1 } },
    runModel: async () => '[]',
  })
  noStore.markTurn('p', { speaker: 'owner', text: '我喜欢吃辣', at: START })
  check('没有 store → 不总结', (await noStore.maybeSummarize({ peerKey: 'p' })).summarized, false)

  await store.dispose()
}

{
  // 外部 turns：上层如果自己维护对话缓冲，可以直接递进来（不重复总结同一批）
  const { store, clock } = makeStore('summarizer-external')
  const model = fakeModel(
    JSON.stringify([
      { text: '主人对花生过敏', kind: 'fact', importance: 0.95 },
      { text: '主人讨厌香菜', kind: 'preference', importance: 0.8 },
    ]),
  )
  const summarizer = new Summarizer({
    store,
    now: clock.now,
    config: { summarize: { minTurns: 2, maxChars: 10000 } },
    runModel: model.run,
  })
  const turns = [
    { speaker: 'owner', text: '我对花生过敏', at: START },
    { speaker: 'owner', text: '还有我不吃香菜', at: START + MINUTE },
  ]
  const first = await summarizer.maybeSummarize({ peerKey: 'p-ext', turns })
  check('外部 turns 也能总结', first.summarized, true)
  check('两条事实都写进去了', store.listFacts().length, 2)

  const second = await summarizer.maybeSummarize({ peerKey: 'p-ext', turns })
  check('同一批 turns 不会被重复总结', second.summarized, false)
  check('模型只调了一次', model.counter.calls, 1)

  // 同样的内容再总结一次 → appendFact 合并，不会写重复
  const extra = new Summarizer({
    store,
    now: clock.now,
    config: { summarize: { minTurns: 1, maxChars: 10000 } },
    runModel: async () => JSON.stringify([{ text: '主人对花生过敏', kind: 'fact', importance: 0.6 }]),
  })
  const mergedAgain = await extra.maybeSummarize({
    peerKey: 'p-ext2',
    turns: [{ speaker: 'owner', text: '重申：我对花生过敏', at: START + 2 * MINUTE }],
  })
  check('重复事实走合并（仍然只有 2 条）', store.listFacts().length, 2)
  check('合并也算总结成功', mergedAgain.summarized, true)
  check('added 是新增条数（这次 0）', mergedAgain.added, 0)

  await store.dispose()
}

// ==========================================================================
// 五、路由：什么时候不查
// ==========================================================================

group('路由 · ① 太短 / 纯表情 / 纯语气词')

{
  const lowInfo = [
    ['嗯', '单字'],
    ['在么', '短又没问号'],
    ['哈哈哈哈', '纯语气词'],
    ['好的好的好的', '纯语气词重复'],
    ['？？？', '纯符号'],
    ['666', '纯数字'],
    ['[图片]', '只有图片码'],
    ['😂😂😂', '只有表情'],
  ]
  for (const [message, label] of lowInfo) {
    const verdict = decideRetrieval({ message })
    check(`① ${label}「${message}」→ 不查`, verdict.retrieve, false)
    check(`① ${label}「${message}」→ scope none`, verdict.scope, 'none')
    ok(`① ${label}「${message}」→ 说明是低信息`, verdict.reason.includes('低信息'), verdict.reason)
  }
}

group('路由 · ② 当前状态寒暄')

{
  for (const message of ['你在干嘛呀', '吃了吗？', '忙吗？', '睡了吗？', '在吗？']) {
    const verdict = decideRetrieval({ message })
    check(`② 寒暄「${message}」→ 不查`, verdict.retrieve, false)
    ok(`② 寒暄「${message}」→ 说明是寒暄`, verdict.reason.includes('寒暄'), verdict.reason)
    check(`② 寒暄「${message}」→ scope none`, verdict.scope, 'none')
  }
  // 带回忆标记的「在吗，你还记得…」不能被寒暄规则误杀
  const recallAfterGreeting = decideRetrieval({ message: '在吗？你还记得我上次说要搬家吗' })
  check('② 带回忆标记的问候 → 照查', recallAfterGreeting.retrieve, true)
  check('② 带回忆标记的问候 → scope all', recallAfterGreeting.scope, 'all')
}

group('路由 · ③ 纠错')

{
  for (const message of ['不是搬家，是换工作', '你说错了，不是周六', '搞错了，我说的是下个月']) {
    const verdict = decideRetrieval({ message })
    check(`③ 纠错「${message}」→ 不查`, verdict.retrieve, false)
    ok(`③ 纠错「${message}」→ 说明是纠错`, verdict.reason.includes('纠错'), verdict.reason)
  }
}

group('路由 · ④ 追问只查 open_loops')

{
  for (const message of ['后来呢', '然后呢？', '那个', '继续', '接着说']) {
    const verdict = decideRetrieval({ message })
    check(`④ 追问「${message}」→ 要查`, verdict.retrieve, true)
    check(`④ 追问「${message}」→ scope 只查 open_loops`, verdict.scope, 'open_loops')
  }
  notOk('④ 陈述句「然后我就买了」不当追问', decideRetrieval({ message: '然后我就买了' }).scope === 'open_loops')
}

group('路由 · ⑤ 新话题先不查（但打标记）')

{
  const verdict = decideRetrieval({
    message: '量子色动力学真有意思',
    recentTurns: ['今天加班到八点', '老板又催进度'],
  })
  check('⑤ 新话题 → 不查', verdict.retrieve, false)
  ok('⑤ 说明里点出「新话题」', verdict.reason.includes('新话题'), verdict.reason)
  check('⑤ 打上 newTopic 标记（上层据此决定要不要写记忆）', verdict.newTopic, true)
  check('⑤ scope none', verdict.scope, 'none')

  const related = decideRetrieval({
    message: '明天去看房，你觉得哪个区好？',
    recentTurns: ['周六去看房吧', '看房中介约了三点'],
  })
  check('⑤ 和最近话题有重合 → 不算新话题、照查', related.retrieve, true)
  check('⑤ 相关话题 scope all', related.scope, 'all')

  const withRecallMarker = decideRetrieval({
    message: '你记得我上次说要搬到哪儿吗？',
    recentTurns: ['今天加班到八点'],
  })
  check('⑤ 带「记得/上次」的回忆问题不能被当新话题', withRecallMarker.retrieve, true)
  check('⑤ 回忆问题 scope all', withRecallMarker.scope, 'all')

  const noRecent = decideRetrieval({ message: '你还记得我说过什么吗？', recentTurns: [] })
  check('⑤ 没有最近对话时不做新话题判断（照查）', noRecent.retrieve, true)
}

group('路由 · ⑥ 其他正常问题要查')

{
  const verdict = decideRetrieval({ message: '主人上次说想吃什么来着', recentTurns: [] })
  check('⑥ 正常问题 → 要查', verdict.retrieve, true)
  check('⑥ 正常问题 scope all', verdict.scope, 'all')
  ok('⑥ 说明是正常问题', verdict.reason.includes('正常'), verdict.reason)

  const plain = decideRetrieval({ message: '随便问一句' })
  check('⑥ 没有上下文时的普通问题也查', plain.retrieve, true)

  const disabled = decideRetrieval({ message: '你还记得吗？', config: { enabled: false } })
  check('⑥ 记忆关掉 → 不查', disabled.retrieve, false)
  check('⑥ 记忆关掉 reason 说明原因', disabled.reason.includes('已关'), true)
}

group('路由 · 冷却窗口（省 token 的可选闸）')

{
  const config = { route: { cooldownMs: 60000 }, now: () => START }
  const hot = decideRetrieval({ message: '你还记得我上次说的吗？', lastInjectedAt: START - 1000, config })
  check('刚注入过 → 冷却期内不重复查', hot.retrieve, false)
  ok('冷却 reason 说清楚', hot.reason.includes('冷却'), hot.reason)

  const cold = decideRetrieval({ message: '你还记得我上次说的吗？', lastInjectedAt: START - 2 * MINUTE, config })
  check('过了冷却期 → 照查', cold.retrieve, true)

  const defaultOff = decideRetrieval({ message: '你还记得我上次说的吗？', lastInjectedAt: START })
  check('默认 cooldownMs=0（不误伤正常查询）', defaultOff.retrieve, true)
}

// ==========================================================================
// 六、注入：按相关，不按时间
// ==========================================================================

group('注入 · facts 按问题检索（不是最近 3 天全塞）')

{
  const { store } = makeStore('ctx-relevance', { factsMaxItems: 6, injectMaxChars: 1600, injectRecentDays: 0 })
  await store.appendFact({
    text: '主人喜欢吃辣，周末想去吃火锅',
    kind: 'preference',
    importance: 0.8,
    at: START - 20 * DAY,
  })
  await store.appendFact({
    text: '主人今天买了新的机械键盘',
    kind: 'fact',
    importance: 0.9,
    at: START,
  })

  const hotpot = store.buildContext({ role: 'owner', question: '火锅' })
  ok('相关事实进来了（20 天前的也能翻到）', hotpot.includes('火锅'))
  notOk('不相关的新事实不会混进来', hotpot.includes('机械键盘'))
  ok('有单独的「相关记忆」标题', hotpot.includes('## 相关记忆'))

  const keyboard = store.buildContext({ role: 'owner', question: '键盘' })
  ok('换个问题就换一条事实', keyboard.includes('机械键盘'))
  notOk('这时火锅那条不出现', keyboard.includes('火锅'))

  check('有事实但完全不相关 + 没有日记 → 空串（省 token）',
    store.buildContext({ role: 'owner', question: '量子色动力学' }), '')
}

group('注入 · 相关事实按相关度排序（不是按时间）')

{
  const { store } = makeStore('ctx-order', { factsMaxItems: 6, injectRecentDays: 0 })
  await store.appendFact({
    text: '搬家定在周六上午十点，已经叫好车了',
    kind: 'fact',
    importance: 0.9,
    at: START - 60 * DAY,
  })
  await store.appendFact({
    text: '周六几点搬家来着，我也忘了',
    kind: 'fact',
    importance: 0.3,
    at: START,
  })

  const ctx = store.buildContext({ role: 'owner', question: '搬家定在周六几点' })
  ok('两条相关的都进来了', ctx.includes('上午十点') && ctx.includes('我也忘了'))
  ok(`更相关的那条排在前面（新但只沾一个词的不该赢）`, ctx.indexOf('上午十点') < ctx.indexOf('我也忘了'), ctx)
}

group('注入 · factsMaxItems 上限')

{
  const { store } = makeStore('ctx-max-items', { factsMaxItems: 3, injectRecentDays: 0 })
  for (let i = 0; i < 8; i += 1) {
    await store.appendFact({
      text: `主人喜欢喝茶的第${i}种方式`,
      kind: 'preference',
      importance: 0.5,
      at: START - i * MINUTE,
    })
  }
  const ctx = store.buildContext({ role: 'owner', question: '喜欢喝什么茶' })
  check('最多注入 factsMaxItems 条', (ctx.match(/^- \[/gm) ?? []).length, 3)
  ok('确实有内容', ctx.includes('喜欢喝茶'))
}

group('注入 · 最近 1 天流水压成 3~5 行（不是原文）')

{
  const { store } = makeStore('ctx-diary', { injectRecentDays: 1, injectDiaryLines: 3 })
  for (let i = 0; i < 20; i += 1) {
    await store.appendMemory(`第${i}条记录`, { at: START - (20 - i) * MINUTE })
  }
  const ctx = store.buildContext({ role: 'owner' })
  const block = ctx.slice(ctx.indexOf('## 最近几天的记忆'))
  check('流水压成 3 行', (block.match(/^- /gm) ?? []).length, 3)
  ok('最新的那条在', block.includes('第19条记录'))
  notOk('最老的整段不会原样塞进来（第0条不在）', block.includes('第0条记录'))

  // 默认 5 行；多天时每天先保一条
  const many = makeStore('ctx-diary-days', { injectRecentDays: 3, injectDiaryLines: 5 })
  for (let d = 0; d < 4; d += 1) {
    await many.store.appendMemory(`day${d} 的内容`, { at: START - d * DAY })
  }
  const multi = many.store.buildContext({ role: 'owner' })
  ok('最近 3 天每天都露一面（day0）', multi.includes('day0 的内容'))
  ok('最近 3 天每天都露一面（day1）', multi.includes('day1 的内容'))
  ok('最近 3 天每天都露一面（day2）', multi.includes('day2 的内容'))
  // ⚠️ 只在**日记段**里查 day3 —— facts.jsonl 里也有 day3（appendMemory 会双写），
  //    而 facts 是按相关检索的、不受 injectRecentDays 限制，那是设计如此。
  const diaryOf = (text) => {
    const from = text.indexOf('## 最近几天的记忆')
    if (from < 0) return ''
    const to = text.indexOf('## ', from + 1)
    return to < 0 ? text.slice(from) : text.slice(from, to)
  }
  notOk('超过 injectRecentDays 的日记不注入（day3）', diaryOf(multi).includes('day3 的内容'))
  const lines = (multi.slice(multi.indexOf('## 最近几天的记忆')).match(/^- /gm) ?? []).length
  ok('总行数不超过 injectDiaryLines', lines <= 5, lines)

  await many.store.dispose()
}

group('注入 · open_loops 范围只给未完成的事')

{
  const { store } = makeStore('ctx-open-loops', { injectRecentDays: 1 })
  await store.appendFact({ text: '还在等面试结果', kind: 'open_loop', importance: 0.8, at: START })
  await store.appendFact({ text: '主人喜欢吃辣', kind: 'preference', importance: 0.9, at: START })
  await store.appendMemory('今天聊了很多别的事', { at: START })

  const ctx = store.buildContext({ role: 'owner', question: '后来呢', scope: 'open_loops' })
  ok('open_loop 事实进来了', ctx.includes('面试结果'))
  notOk('普通偏好不进来', ctx.includes('喜欢吃辣'))
  notOk('日记也不塞（追问只关心那件事）', ctx.includes('今天聊了很多别的事'))
}

group('注入 · 没内容时返回空串 / core 永远注入 / 兼容旧调用')

{
  const { store } = makeStore('ctx-empty')
  check('空记忆库 → 空串（一点都不注入）', store.buildContext({ role: 'owner', question: '随便问' }), '')

  await store.appendMemory('主人讨厌香菜', { shared: true })
  const withCore = store.buildContext({ role: 'owner', question: '量子色动力学' })
  ok('core 永远注入（和问题无关也留着）', withCore.includes('主人讨厌香菜'))
  ok('core 段用旧标题（面板/旧测试都认）', withCore.includes('## 长期记忆'))

  // 旧调用：没有 question 也要能工作（Mind 还没接线时不能崩）
  const legacy = store.buildContext({ role: 'owner', peerId: 'qq-group-1' })
  ok('旧调用（无 question）也能返回字符串', typeof legacy === 'string' && legacy.length > 0)

  const disabled = makeStore('ctx-off', { enabled: false })
  check('memory.enabled=false → 空串', disabled.store.buildContext({ role: 'owner', question: '随便' }), '')
  await disabled.store.dispose()

  await store.dispose()
}

group('注入 · core 超限截断 / 总预算硬上限 / 月度摘要兼容')

{
  const { store } = makeStore('ctx-budget', { injectCoreMaxChars: 100, injectMaxChars: 1600 })
  await store.appendMemory(`核心事实${'啊'.repeat(300)}`, { shared: true })
  const ctx = store.buildContext({ role: 'owner', question: '核心' })
  ok('core 超限会被截断并注明', ctx.includes('截断了'))
  ok('截断后 core 段受控（≤ 标题 + 100）', ctx.length <= 110, ctx.length)

  const tight = makeStore('ctx-total', { injectMaxChars: 300, injectCoreMaxChars: 200, injectRecentDays: 1 })
  for (let i = 0; i < 6; i += 1) {
    await tight.store.appendMemory(`很长的一段日记内容${i}${'啊'.repeat(60)}`, { at: START - i * MINUTE })
  }
  await tight.store.appendMemory(`核心${'啊'.repeat(120)}`, { shared: true })
  const clipped = tight.store.buildContext({ role: 'owner' })
  ok('总预算硬上限守得住（≤ 300）', clipped.length <= 300, clipped.length)

  // 月度摘要是旧版就有的注入，不能因为重构丢掉
  const { store: summaryStore } = makeStore('ctx-summary')
  await summaryStore.appendMemory('今天记一条日记')
  await summaryStore.writeSummary('这个月主人开始健身了')
  const summaryCtx = summaryStore.buildContext({ role: 'owner' })
  ok('月度摘要仍然会注入', summaryCtx.includes('## 这个月的摘要') && summaryCtx.includes('这个月主人开始健身了'))

  await store.dispose()
  await tight.store.dispose()
  await summaryStore.dispose()
}

group('注入 · 隐私边界：群友只拿公用段，facts 一条都不给')

{
  const { store } = makeStore('ctx-guest')
  await store.appendMemory('公用的一条', { shared: true })
  await store.appendMemory('主人的私事', { section: 'owner' })
  await store.appendMemory('今天群里很热闹')
  await store.appendFact({ text: '主人对花生过敏', kind: 'fact', importance: 0.9 })

  const guest = store.buildContext({ role: 'guest', question: '过敏' })
  ok('群友看得到公用段', guest.includes('公用的一条'))
  notOk('群友看不到主人分区', guest.includes('主人的私事'))
  notOk('群友看不到当天日记', guest.includes('今天群里很热闹'))
  notOk('群友看不到 facts（有主人的私事）', guest.includes('花生过敏'))

  // 没有 core 的库，群友上下文就是空串（一点都不注入）
  const { store: emptyCore } = makeStore('ctx-guest-empty')
  await emptyCore.appendFact({ text: '主人对花生过敏', kind: 'fact' })
  check('群友在没有公用 core 时 → 空串', emptyCore.buildContext({ role: 'guest', question: '过敏' }), '')

  await store.dispose()
  await emptyCore.dispose()
}

// ==========================================================================
// 七、文件：原子写 / 并发 / 无 BOM
// ==========================================================================

group('文件 · 并发写不丢 / 原子写 / UTF-8 无 BOM')

{
  const { store } = makeStore('facts-concurrent')
  const tasks = []
  for (let i = 0; i < 20; i += 1) {
    tasks.push(store.appendFact({ text: `并发事实-${i}`, kind: 'fact', at: START + i }))
  }
  const results = await Promise.all(tasks)
  await store.flush()

  check('20 条并发全部成功', results.filter((item) => item.ok).length, 20)
  check('20 条一条不少', store.listFacts().length, 20)

  const raw = fs.readFileSync(store.factsPath, 'utf8')
  ok('facts.jsonl 是 UTF-8 无 BOM', raw.charCodeAt(0) !== 0xfeff)
  const lines = raw.trim().split(/\r?\n/)
  check('一行一条（20 行）', lines.length, 20)
  ok('每行都是合法 JSON', lines.every((line) => {
    try {
      JSON.parse(line)
      return true
    } catch {
      return false
    }
  }))
  ok('每条内容都在', [...Array(20).keys()].every((i) => raw.includes(`并发事实-${i}`)))
  check('整个 memory/ 没有残留 .tmp', listFiles(store.root).filter((name) => name.endsWith('.tmp')), [])

  await store.dispose()
}

group('兼容 · 默认值 / 旧接口签名')

{
  check('总预算默认从 6000 降到 1600', MEMORY_DEFAULTS.injectTotalMaxChars, 1600)
  check('core 默认 600', MEMORY_DEFAULTS.injectCoreMaxChars, 600)
  check('facts 默认 6 条', MEMORY_DEFAULTS.factsMaxItems, 6)
  check('最近流水默认 1 天', MEMORY_DEFAULTS.injectRecentDays, 1)
  check('recall 两项保留（旧测试钉着）', [MEMORY_DEFAULTS.recallEnabled, MEMORY_DEFAULTS.recallMaxTokens], [true, 1200])

  const { store } = makeStore('compat')
  ok('appendMemory(text, { shared }) 旧签名照旧', await store.appendMemory('一条共享记忆', { shared: true }))
  ok('buildContext 接受 peerId（装配层这么传）', typeof store.buildContext({ role: 'owner', peerId: 'qq-group-1' }) === 'string')
  ok('buildContext 同步返回字符串（Mind 的装配不能等 Promise）',
    typeof store.buildContext({ role: 'owner', question: '随便' }) === 'string')
  ok('renderFactLine 渲染中文标签', renderFactLine({ text: '主人喜欢吃辣', kind: 'preference' }).includes('[偏好]'))
  check('未知 kind 渲染成「事实」', renderFactLine({ text: '随便', kind: '??? ' }).includes('[事实]'), true)

  await store.dispose()
}

// ==========================================================================
// 收尾
// ==========================================================================

cleanupTmp()
report('记忆 v3.2（事实 + 自动总结 + 路由 + 按相关注入）')
