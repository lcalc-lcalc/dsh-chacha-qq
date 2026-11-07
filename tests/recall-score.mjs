/**
 * 记忆召回的打分测试 —— 专门钉住一个真 bug 的修复。
 *
 * 背景（分身读「我会牢牢记住你」时反查出来的）：
 *   旧 `scoreFragment` 直接拿「关键词命中个数」当分数，于是**越长的片段越容易赢**。
 *   月度摘要当时是整份 2000 字砸成一条 fragment，而对话片段只有几十到几百字，
 *   结果问「上次说的那家店」，回来的全是月度摘要，真正那条对话被挤掉。
 *
 * 这个套件同时钉两件事：
 *   ① 长度归一化（长片段不再靠堆命中数赢）
 *   ② 词法硬顶（防止某条超长片段吃掉整个榜单）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { group, check, ok, notOk, report } from './harness.mjs'

import {
  LEXICAL_CAP,
  LENGTH_BASELINE,
  Recall,
  extractKeywords,
  scoreFragment,
} from '../src/controller/memory/recall.js'

const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0) // 2026-11-07 12:00 UTC
const HALF_LIFE = 7

/** 造一段指定长度的填充文本，里面嵌进给定关键词。 */
function filler(length, keywords = []) {
  let text = ''
  let i = 0
  while (text.length < length) {
    const word = keywords[i % Math.max(1, keywords.length)]
    text += word ? `${word}的内容` : '无关内容'
    i += 1
  }
  return text.slice(0, length)
}

// ══════════════════════════════════════════════════════════════
group('常量：归一化基准与硬顶')

ok('长度基准是正数', LENGTH_BASELINE > 0, String(LENGTH_BASELINE))
ok('词法硬顶是正数', LEXICAL_CAP > 0, String(LEXICAL_CAP))

// ══════════════════════════════════════════════════════════════
group('⭐ 长度归一化：长片段不再靠堆命中数赢')

{
  const keywords = ['搬家', '周六', '几点']

  // 摘要：2000 字，三个词都命中（因为它覆盖面广）
  const summaryText = filler(2000, keywords)
  const summary = { text: summaryText, at: NOW, source: 'summary' }

  // 对话片段：200 字，只命中两个词，但它才是真正相关的那条
  // （故意避开「几点」，让摘要的命中数 3 > 对话的 2 —— 这才复现旧实现的 bug 场景）
  const dialogText = `上次你说搬家定在周六，我问你什么时候开始，你说上午十点。${filler(120)}`
  const dialog = { text: dialogText, at: NOW, source: 'archive' }

  const summaryScore = scoreFragment(summary, keywords, NOW, HALF_LIFE)
  const dialogScore = scoreFragment(dialog, keywords, NOW, HALF_LIFE)

  ok('⭐ 对话片段赢了摘要（旧实现是反过来的）', dialogScore > summaryScore,
    `dialog=${dialogScore.toFixed(2)} vs summary=${summaryScore.toFixed(2)}`)

  check('摘要里确实命中了三个词', keywords.filter((k) => summaryText.includes(k)).length, 3)
  check('对话里只命中了两个词', keywords.filter((k) => dialogText.includes(k)).length, 2)
  // ↑ 这就是关键对照：**命中数更多的是摘要（3 > 2），但赢的是对话** —— 旧实现必输。
}

// ══════════════════════════════════════════════════════════════
group('长度归一化：同样内容，越长分越低')

{
  const keywords = ['搬家']
  const short = { text: `搬家${filler(80, keywords)}`, at: NOW, source: 'archive' }
  const long = { text: `搬家${filler(1200, keywords)}`, at: NOW, source: 'archive' }

  const a = scoreFragment(short, keywords, NOW, HALF_LIFE)
  const b = scoreFragment(long, keywords, NOW, HALF_LIFE)
  ok('短片段得分更高', a > b, `short=${a.toFixed(2)} vs long=${b.toFixed(2)}`)
}

// ══════════════════════════════════════════════════════════════
group('长度归一化：不到基准长度不惩罚')

{
  const keywords = ['茶', '好']
  const tiny = { text: '茶好', at: NOW, source: 'archive' } // 2 字，远小于 LENGTH_BASELINE
  const score = scoreFragment(tiny, keywords, NOW, HALF_LIFE)
  ok('极短片段也能拿到分（不会被归一化压成 0）', score > 0, String(score))
}

// ══════════════════════════════════════════════════════════════
group('词法硬顶：超长片段不会吃掉整个榜单')

{
  // 造一条又长又「全中」的片段
  const keywords = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']
  const monster = { text: keywords.join('').repeat(200), at: NOW, source: 'summary' }
  const score = scoreFragment(monster, keywords, NOW, HALF_LIFE)
  // 上限 = 硬顶 + 时间衰减(1.0 * 0.8) + 来源加成(0.3)
  const ceiling = LEXICAL_CAP + 0.8 + 0.3 + 0.01
  ok(`超长片段得分被硬顶拦住（${score.toFixed(2)} ≤ ${ceiling.toFixed(2)}）`, score <= ceiling,
    `score=${score}`)
}

// ══════════════════════════════════════════════════════════════
group('基础行为没有坏')

{
  const keywords = ['搬家']

  check('完全无关的片段得 0 分', scoreFragment({ text: '今天天气不错', at: NOW, source: 'archive' }, keywords, NOW, HALF_LIFE), 0)

  const fresh = scoreFragment({ text: '搬家的事', at: NOW, source: 'archive' }, keywords, NOW, HALF_LIFE)
  const old = scoreFragment({ text: '搬家的事', at: NOW - 30 * DAY, source: 'archive' }, keywords, NOW, HALF_LIFE)
  ok('越旧分越低（时间衰减还在）', fresh > old, `fresh=${fresh.toFixed(2)} vs old=${old.toFixed(2)}`)

  const core = scoreFragment({ text: '搬家的事', at: NOW - 30 * DAY, source: 'core' }, keywords, NOW, HALF_LIFE)
  const archive = scoreFragment({ text: '搬家的事', at: NOW - 30 * DAY, source: 'archive' }, keywords, NOW, HALF_LIFE)
  ok('core 有来源加成', core > archive, `core=${core.toFixed(2)} vs archive=${archive.toFixed(2)}`)

  const noKeywords = scoreFragment({ text: '随便什么', at: NOW, source: 'archive' }, [], NOW, HALF_LIFE)
  ok('没给关键词时退回纯时间排序（有分）', noKeywords > 0, String(noKeywords))
}

// ══════════════════════════════════════════════════════════════
group('关键词抽取')

{
  const kws = extractKeywords('上次说的那家搬家的店叫什么？')
  ok('抽出了中文 2-gram', kws.length > 0, kws.slice(0, 8).join(','))
  ok('包含「搬家」', kws.includes('搬家'))
  ok('去重了', new Set(kws).size === kws.length)

  const english = extractKeywords('what about the moving plan')
  ok('英文也抽词', english.includes('moving'), english.join(','))
  ok('单字母/单字被过滤', !english.includes('a'))
}

// ══════════════════════════════════════════════════════════════
group('⭐ 端到端：月度摘要不会碾掉真正的对话片段')

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chacha-recall-'))
  const memoryDir = path.join(dir, 'memory')
  const archiveDir = path.join(dir, 'archive')
  fs.mkdirSync(memoryDir, { recursive: true })
  fs.mkdirSync(archiveDir, { recursive: true })

  // 月度摘要：写得又长又全，覆盖很多话题
  const summaryBody = [
    '# 2026-11 月度摘要',
    '',
    '- 这个月聊了很多事：搬家、工作、养猫、做饭、天气、游戏、电影、音乐。',
    ...Array.from({ length: 40 }, (_, i) => `- 第 ${i + 1} 条：聊了搬家的事，周六要搬，还有工作和养猫。`),
  ].join('\n')
  fs.writeFileSync(path.join(memoryDir, 'summary-2026-11.md'), summaryBody, 'utf8')

  // 对话轨迹：一条真正相关、而且说得很具体的
  const line = JSON.stringify({
    sessionId: 'qq-private-1',
    scene: 'private',
    userId: '1',
    at: NOW - 2 * DAY,
    kind: 'reply',
    text: '搬家定在周六上午十点，我已经叫好车了。',
  })
  fs.writeFileSync(path.join(archiveDir, '2026-11-05.jsonl'), `${line}\n`, 'utf8')

  const recall = new Recall({
    dataDir: dir,
    config: {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    runSubagent: null, // 不给子 Agent → 走降级，直接返回片段摘要
    now: () => NOW,
  })

  const answer = await recall.recall({ question: '搬家定在周六几点来着' })
  ok('回忆有返回内容', answer.length > 0, `${answer.length} 字`)
  ok('⭐ 召回里带上了那句具体的对话', answer.includes('十点') || answer.includes('叫好车'),
    answer.slice(0, 200))
  ok('没有只返回月度摘要', !(answer.includes('月度摘要') && !answer.includes('十点') && !answer.includes('叫好车')),
    answer.slice(0, 200))

  fs.rmSync(dir, { recursive: true, force: true })
}

report('记忆召回打分（长度归一化修复）')
