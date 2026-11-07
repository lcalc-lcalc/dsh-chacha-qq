/**
 * L2 Controller 出站/入站层测试：rhythm / outbox / inbound / moderation。
 *
 * 跑法：cd E:\dsh-dev\dsh-chacha-qq-v3; node tests/controller-io.mjs
 *
 * 重点：
 *  - 分片是主人点名的核心机制，覆盖中文 200 字、无标点长串、英文、emoji、换行、
 *    纯标点、maxParts 兜底、碎片合并（「嗯。」不单发）、不丢字、无空片；
 *  - 节奏状态机：间隔、取消、dispose 定时器不泄漏、单片失败不拖垮整轮；
 *  - 群管必须有权限反向测试：群主 / 管理员 / 主人永不被建议禁言；
 *  - 媒体落盘全程用注入的 fetchImpl，不碰网络；临时目录用完即删。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { group, check, ok, notOk, report, seededRng } from './harness.mjs'
import { estimateTokens, splitByTokens, gapMs, createRhythmSender } from '../src/controller/rhythm.js'
import { markdownToPlain, Outbox } from '../src/controller/outbox.js'
import { Inbound } from '../src/controller/inbound.js'
import {
  inspectBatch,
  matchHotKeywords,
  clampBanMinutes,
  normalizeHotKeywords,
  normalizeRole,
} from '../src/controller/moderation.js'
import * as rhythmModule from '../src/controller/rhythm.js'

// ── 小工具 ──────────────────────────────────────────────────────

const zeroRhythm = {
  minGapMs: 0,
  maxGapMs: 0,
  maxTokensPerPiece: 20,
  maxPiecesPerTurn: 20,
  maxCharsPerMessage: 2000,
}

const storeOf = (config) => ({ get: () => config })
const zeroStore = () => storeOf({ rhythm: { ...zeroRhythm } })

function makeLogger() {
  const entries = { debug: [], info: [], warn: [], error: [] }
  const push = (kind) => (...args) => {
    entries[kind].push(args.map((item) => String(item?.message ?? item)).join(' '))
  }
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

/** 检查有没有被切坏的代理对（emoji 切一半）。 */
function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

const textOfSegments = (segments) =>
  segments
    .filter((segment) => segment?.type === 'text')
    .map((segment) => String(segment.data?.text ?? ''))
    .join('')

const replySegmentOf = (segments) => segments.find((segment) => segment?.type === 'reply')

/** 假 api：sendGroup/sendPrivate 都记调用，可以预设前 N 次失败或一直失败。 */
function makeApi({ failFirst = 0, failAlways = false } = {}) {
  let failuresLeft = failFirst
  const calls = []
  const attempt = (scene, id, segments) => {
    calls.push({ scene, id, segments })
    if (failAlways) throw new Error('api down')
    if (failuresLeft > 0) {
      failuresLeft -= 1
      throw new Error('api flaky')
    }
    return { message_id: calls.length }
  }
  return {
    calls,
    failNext(count = 1) {
      failuresLeft = count
    },
    async sendPrivate(userId, segments) {
      return attempt('private', userId, segments)
    },
    async sendGroup(groupId, segments) {
      return attempt('group', groupId, segments)
    },
  }
}

const groupMessage = (overrides = {}) => ({
  id: 'm1',
  scene: 'group',
  groupId: 'g1',
  peerId: 'g1',
  userId: 'u1',
  ...overrides,
})

const privateMessage = (overrides = {}) => ({
  id: 'm2',
  scene: 'private',
  peerId: 'u2',
  userId: 'u2',
  ...overrides,
})

/** 造一个节奏发送器测试床：记录发出的每一片。 */
function makeSender({ store = zeroStore(), now, rng, plain, failIndexes = [], throwIndexes = [], log } = {}) {
  const pieces = []
  const outbox = {
    plain: plain ?? ((text) => String(text)),
    async sendPiece(message, text, options = {}) {
      pieces.push({ message, text, options })
      const index = pieces.length - 1
      if (throwIndexes.includes(index)) throw new Error(`boom-${index}`)
      return !failIndexes.includes(index)
    },
  }
  const sender = createRhythmSender({ outbox, store, now, rng, log })
  return { sender, outbox, pieces }
}

// ══════════════════════════════════════════════════════════════
group('导出签名（和 DESIGN §4 / 任务书对齐）')

check('estimateTokens 是函数', typeof estimateTokens, 'function')
check('splitByTokens 是函数', typeof splitByTokens, 'function')
check('gapMs 是函数', typeof gapMs, 'function')
check('createRhythmSender 是函数', typeof createRhythmSender, 'function')
check('markdownToPlain 是函数', typeof markdownToPlain, 'function')
check('Outbox 是类', typeof Outbox, 'function')
check('Inbound 是类', typeof Inbound, 'function')
check('inspectBatch 是函数', typeof inspectBatch, 'function')
{
  const { sender } = makeSender()
  check('sender.send 是函数', typeof sender.send, 'function')
  check('sender.cancel 是函数', typeof sender.cancel, 'function')
  check('sender.dispose 是函数', typeof sender.dispose, 'function')
  sender.dispose()
}

// ══════════════════════════════════════════════════════════════
group('estimateTokens：近似 token 估算')

check('中文汉字 1 字 1 token', estimateTokens('你好世界'), 4)
check('全角标点算 1', estimateTokens('。！？；…'), 5)
check('英文 4 字符 1 token（整除）', estimateTokens('abcd'), 1)
check('英文不足 4 字符向上取整', estimateTokens('hello'), 2)
check('英文 8 字符 = 2 token', estimateTokens('abcdefgh'), 2)
check('中英混合', estimateTokens('你好hello'), 4)
check('数字按 4 字符 1 token', estimateTokens('12345'), 2)
check('emoji 按 1 token', estimateTokens('😀😀'), 2)
check('换行算 1 token', estimateTokens('你好\n世界'), 5)
check('空串 0 token', estimateTokens(''), 0)
check('null 安全', estimateTokens(null), 0)
check('undefined 安全', estimateTokens(undefined), 0)
check('100 个 a = 25 token', estimateTokens('a'.repeat(100)), 25)
check('日文假名按宽字符 1 token', estimateTokens('こんにちは'), 5)

// ══════════════════════════════════════════════════════════════
group('splitByTokens：200 字必须切多片且每片 <= 20 token')

{
  const text200 = ('春'.repeat(19) + '。').repeat(10) // 正好 200 字、200 tokens
  const pieces = splitByTokens(text200)
  check('200 字被切成多片', pieces.length > 1, true)
  check('200 字片数（每片 20 token）', pieces.length, 10)
  ok('每片 <= 20 token', pieces.every((piece) => estimateTokens(piece) <= 20), JSON.stringify(pieces.map(estimateTokens)))
  ok('没有空片', pieces.every((piece) => piece.length > 0 && piece.trim().length > 0))
  check('拼回去 === 原文', pieces.join(''), text200)
  ok('不会把整段 200 字塞一条', pieces.length >= 10, String(pieces.length))
}

{
  // 完全没有标点的 200 字：只能硬切，但仍然是 10 片均分，不会出现 20+1 的碎尾
  const noPunct = '春'.repeat(200)
  const pieces = splitByTokens(noPunct)
  check('无标点 200 字片数', pieces.length, 10)
  ok('无标点每片 <= 20 token', pieces.every((piece) => estimateTokens(piece) <= 20))
  check('无标点拼回去', pieces.join(''), noPunct)
  check(
    '无标点每片均匀（20 字）',
    pieces.every((piece) => piece.length === 20),
    true,
  )
}

// ══════════════════════════════════════════════════════════════
group('splitByTokens：自然边界优先（句末 > 逗号 > 硬切）')

{
  const sentences = ('甲'.repeat(17) + '。').repeat(4) // 每句 18 token
  const pieces = splitByTokens(sentences)
  check('按句末切：4 片', pieces.length, 4)
  ok('每片都在句号后切', pieces.every((piece) => piece.endsWith('。')), JSON.stringify(pieces))
  ok('每片 <= 20 token', pieces.every((piece) => estimateTokens(piece) <= 20))
  check('拼回去', pieces.join(''), sentences)
}

{
  const commaText = '一'.repeat(10) + '，' + '二'.repeat(10) + '，' + '三'.repeat(8) + '。'
  const pieces = splitByTokens(commaText)
  check('逗号优先：2 片', pieces.length, 2)
  ok('第一片切在逗号后', pieces[0].endsWith('，'), pieces[0])
  ok('第二片收在句号', pieces[1].endsWith('。'), pieces[1])
  ok('每片 <= 20 token', pieces.every((piece) => estimateTokens(piece) <= 20))
  check('拼回去', pieces.join(''), commaText)
}

{
  const english = 'The quick brown fox jumps over the lazy dog. '.repeat(10)
  const pieces = splitByTokens(english)
  check('英文长句：10 片', pieces.length, 10)
  ok('英文每片 <= 20 token', pieces.every((piece) => estimateTokens(piece) <= 20))
  ok(
    '英文在句号处切',
    pieces.every((piece) => piece.trimEnd().endsWith('.')),
    JSON.stringify(pieces.map((piece) => piece.trimEnd().slice(-3))),
  )
  check('英文拼回去 === trim 后原文', pieces.join(''), english.trim())
}

{
  // 200 字符无空格大单词：只能硬切，但按码点切，不制造代理对半截
  const word = 'supercalifragilistic'.repeat(10)
  const pieces = splitByTokens(word)
  check('超长无标点英文串切成多片', pieces.length > 1, true)
  ok('长单词每片 <= 20 token', pieces.every((piece) => estimateTokens(piece) <= 20))
  check('长单词拼回去', pieces.join(''), word)
}

{
  const newlines = '第一行内容。\n第二行内容。\n第三行内容。\n第四行内容。'
  const pieces = splitByTokens(newlines)
  check('换行输入：2 片', pieces.length, 2)
  check('换行切点保留换行', pieces[0].endsWith('\n'), true)
  ok('换行每片 <= 20 token', pieces.every((piece) => estimateTokens(piece) <= 20))
  check('换行拼回去', pieces.join(''), newlines)
}

// ══════════════════════════════════════════════════════════════
group('splitByTokens：emoji / 纯标点 / 上限与兜底')

{
  const emojiText = '开心😀'.repeat(20) // 60 token
  const pieces = splitByTokens(emojiText)
  check('emoji 文本切成 3 片', pieces.length, 3)
  ok('emoji 每片 <= 20 token', pieces.every((piece) => estimateTokens(piece) <= 20))
  ok('emoji 没被切成半截代理对', pieces.every((piece) => !hasLoneSurrogate(piece)))
  check('emoji 拼回去', pieces.join(''), emojiText)
}

{
  const punctuation = '。。。！？'
  check('纯标点默认一片', splitByTokens(punctuation).length, 1)
  const small = splitByTokens(punctuation, 2)
  ok('纯标点 maxTokens=2 也守上限', small.every((piece) => estimateTokens(piece) <= 2), JSON.stringify(small.map(estimateTokens)))
  check('纯标点拼回去', small.join(''), punctuation)
}

{
  const pieces = splitByTokens('一二三四五六七八九十', 5)
  check('maxTokens=5 切 2 片', pieces.length, 2)
  check('maxTokens=5 每片 5 token', pieces.map(estimateTokens), [5, 5])
}

{
  const longText = '春'.repeat(600) // 600 token，不兜底会是 30 片
  const pieces = splitByTokens(longText)
  check('maxParts 兜底后片数 <= 20', pieces.length, 20)
  ok('前 19 片仍守 20 token 上限', pieces.slice(0, 19).every((piece) => estimateTokens(piece) <= 20))
  ok('溢出的尾巴并进最后一片（不丢字）', estimateTokens(pieces[19]) > 20, String(estimateTokens(pieces[19])))
  check('兜底拼回去', pieces.join(''), longText)
}

{
  const pieces = splitByTokens('春'.repeat(100), 20, 1)
  check('maxParts=1 时压成一片', pieces.length, 1)
  check('maxParts=1 不丢字', pieces[0], '春'.repeat(100))
}

// ══════════════════════════════════════════════════════════════
group('splitByTokens：碎片合并（「嗯。」不单独发）')

{
  // 「嗯。」2 token，后面是一整段 21 字没标点的长句
  const text = '嗯。' + '今天天气真的特别特别好我们一起去公园散步吧'
  const pieces = splitByTokens(text)
  check('碎片不单发：切成 2 片', pieces.length, 2)
  notOk('第一片不是孤零零的「嗯。」', pieces[0] === '嗯。', pieces[0])
  ok('第一片以「嗯。」开头（往后并）', pieces[0].startsWith('嗯。'), pieces[0])
  ok('每片都 >= 3 token', pieces.every((piece) => estimateTokens(piece) >= 3), JSON.stringify(pieces.map(estimateTokens)))
  ok('每片 <= 20 token', pieces.every((piece) => estimateTokens(piece) <= 20))
  check('拼回去', pieces.join(''), text)
}

{
  // 尾巴上的碎片：「……吧。嗯。」→ 嗯。不能单独成最后一片
  const text = '今天天气真的特别特别好我们一起去公园散步吧。嗯。'
  const pieces = splitByTokens(text)
  check('尾巴碎片：切成 2 片', pieces.length, 2)
  notOk('最后一片不是孤零零的「嗯。」', pieces[pieces.length - 1] === '嗯。', pieces[pieces.length - 1])
  ok('最后一片包含「嗯。」', pieces[pieces.length - 1].endsWith('嗯。'), pieces[pieces.length - 1])
  ok('最后一片 >= 3 token', estimateTokens(pieces[pieces.length - 1]) >= 3)
  check('拼回去', pieces.join(''), text)
}

{
  // 整条回复就只有「嗯。」：必须照发，不能吞掉
  check('只有「嗯。」时仍返回 1 片', splitByTokens('嗯。'), ['嗯。'])
  check('短句不切', splitByTokens('短句。'), ['短句。'])
  check('首尾空白被 trim', splitByTokens('  你好。  '), ['你好。'])
  check('纯空白返回空数组', splitByTokens('   '), [])
  check('空串返回空数组', splitByTokens(''), [])
  check('null 返回空数组', splitByTokens(null), [])
}

// ══════════════════════════════════════════════════════════════
group('splitByTokens：不丢字 / 无空片 / 稳定')

{
  const battery = [
    '你好。',
    '嗯。' + '今天天气真的特别特别好我们一起去公园散步吧',
    '今天天气真的特别特别好我们一起去公园散步吧。嗯。',
    '一二三四五六七八九十，' + '甲乙丙丁戊己庚辛壬癸。',
    'Hello world. This is a test! Are you ready?',
    'a'.repeat(333),
    '开心😀'.repeat(20),
    '第一行\n第二行\n第三行\n第四行\n第五行\n第六行',
    '。。。！？',
    '。'.repeat(50),
    '  前后都有空白。  ',
    '短。',
  ]
  const joinOk = battery.every((input) => splitByTokens(input).join('') === String(input).trim())
  ok('一组输入拼回去都 === trim 后原文', joinOk)
  const noEmpty = battery.every((input) => splitByTokens(input).every((piece) => piece.trim().length > 0))
  ok('一组输入都没有空片', noEmpty)
  const noLone = battery.every((input) => splitByTokens(input).every((piece) => !hasLoneSurrogate(piece)))
  ok('一组输入都没切坏 emoji', noLone)
  const stable = battery.every((input) => {
    const a = splitByTokens(input)
    const b = splitByTokens(input)
    return a.length === b.length && a.every((piece, index) => piece === b[index])
  })
  ok('同一输入分片结果稳定（纯函数、无随机）', stable)
}

// ══════════════════════════════════════════════════════════════
group('splitByTokens：叠词不劈开（lead 反馈回归）')

{
  // 领队实测样本：旧实现把「一起去看看」劈成「…一起去看」+「看那个…」
  const sample =
    '主人早安呀！今天也要开开心心的哦。茶茶酱已经把早饭准备好啦，记得吃哦。' +
    '对了，下午我们要不要一起去看看那个新开的花店呢？我听说里面有很多好看的花。'
  const pieces = splitByTokens(sample)
  ok('领队样本：仍然切成多片', pieces.length > 1, String(pieces.length))
  ok(
    '领队样本：每片 <= 20 token',
    pieces.every((piece) => estimateTokens(piece) <= 20),
    JSON.stringify(pieces.map(estimateTokens)),
  )
  check('领队样本：拼回去 === 原文', pieces.join(''), sample)
  const splitsPair = pieces.some((piece, index) => {
    const next = pieces[index + 1]
    return Boolean(next) && piece.endsWith('看') && next.startsWith('看')
  })
  notOk('领队样本：「看看」没有被从中间劈开', splitsPair)
  ok('领队样本：「看看」完整留在某一手里', pieces.some((piece) => piece.includes('看看')), JSON.stringify(pieces))
}

for (const pair of ['看看', '的的', '哈哈哈']) {
  const text = '甲'.repeat(10) + pair + '乙'.repeat(10)
  const pieces = splitByTokens(text)
  check(`叠词「${pair}」：切成 2 片`, pieces.length, 2)
  ok(`叠词「${pair}」：完整留在第一片`, pieces[0].endsWith(pair), pieces[0])
  ok(`叠词「${pair}」：每片 <= 20 token`, pieces.every((piece) => estimateTokens(piece) <= 20))
  check(`叠词「${pair}」：拼回去`, pieces.join(''), text)
}

{
  // 往后挪会撑破 20 token 上限 → 改成往前挪，叠词整段留给下一片
  const text = '甲'.repeat(19) + '看看' + '乙'.repeat(19)
  const pieces = splitByTokens(text)
  check('叠词触上限：拼回去', pieces.join(''), text)
  ok(
    '叠词触上限：每片仍 <= 20 token',
    pieces.every((piece) => estimateTokens(piece) <= 20),
    JSON.stringify(pieces.map(estimateTokens)),
  )
  const splitsPair = pieces.some((piece, index) => {
    const next = pieces[index + 1]
    return Boolean(next) && piece.endsWith('看') && next.startsWith('看')
  })
  notOk('叠词触上限：「看看」仍不劈开', splitsPair)
}

{
  // 长串同字属于填充/测试数据，不能被叠词保护打乱均分（回归 200 字用例）
  const filler = '春'.repeat(200)
  const pieces = splitByTokens(filler)
  check('长串同字：仍然是 10 片', pieces.length, 10)
  ok('长串同字：每片 20 token', pieces.every((piece) => estimateTokens(piece) === 20))
}

// ══════════════════════════════════════════════════════════════
group('gapMs：2~5 秒随机间隔，rng 可注入')

{
  const rng = seededRng(42)
  const values = []
  let inRange = true
  let integer = true
  for (let index = 0; index < 500; index += 1) {
    const value = gapMs({}, rng)
    values.push(value)
    if (!Number.isInteger(value)) integer = false
    if (value < 2000 || value > 5000) inRange = false
  }
  ok('500 次都落在 [2000, 5000]', inRange)
  ok('500 次都是整数', integer)
  check('rng 返回 0 → 下界', gapMs({}, () => 0), 2000)
  check('rng 返回 1 → 上界（含钳制）', gapMs({}, () => 1), 5000)
  check('rng 返回 0.999999 → 上界', gapMs({}, () => 0.999999), 5000)
  check('自定义区间 min=max', gapMs({ minMs: 10, maxMs: 10 }, () => 0.5), 10)
  check('min/max 传反自动换位', gapMs({ minMs: 5000, maxMs: 2000 }, () => 0), 2000)
  check('负数归零', gapMs({ minMs: -100, maxMs: -50 }, () => 0.5), 0)
  check('非法配置回落默认 2000~5000', gapMs({ minMs: 'abc', maxMs: undefined }, () => 0.5), 3500)
  const rngA = seededRng(7)
  const rngB = seededRng(7)
  const seqA = Array.from({ length: 10 }, () => gapMs({ minMs: 2000, maxMs: 5000 }, rngA))
  const seqB = Array.from({ length: 10 }, () => gapMs({ minMs: 2000, maxMs: 5000 }, rngB))
  check('同种子 rng 结果可复现', seqA, seqB)
}

// ══════════════════════════════════════════════════════════════
group('createRhythmSender：逐条发 + 片间随机等待')

{
  const { sender, pieces } = makeSender()
  const text = '春'.repeat(45) // 3 片 × 15 token
  const result = await sender.send(privateMessage(), text, { quote: true })
  check('分 3 片发完', result, { sent: 3, total: 3, cancelled: false })
  check('真的调了 3 次 sendPiece', pieces.length, 3)
  check('分片拼回去 === 原文', pieces.map((piece) => piece.text).join(''), text)
  check('片间 quote 只有第一片', pieces.map((piece) => piece.options.quote), [true, false, false])
  check('无残留定时器', sender.pendingTimers, 0)
  sender.dispose()
}

{
  // 会真的 setTimeout：40ms × 2 个缝隙，断言用时下限
  const { sender, pieces } = makeSender({ store: storeOf({ rhythm: { minGapMs: 40, maxGapMs: 40 } }) })
  const startedAt = Date.now()
  const result = await sender.send(privateMessage(), '春'.repeat(45))
  const elapsed = Date.now() - startedAt
  check('3 片都发出去', result.sent, 3)
  check('sendPiece 调用 3 次', pieces.length, 3)
  ok('两条之间有间隔（>= 60ms）', elapsed >= 60, `${elapsed}ms`)
  check('间隙等待后定时器清零', sender.pendingTimers, 0)
  sender.dispose()
}

{
  // now 注入：每次跳 10 秒，间隔计算仍然执行但从不再真等
  let clock = 0
  const { sender, pieces } = makeSender({
    store: storeOf({ rhythm: { minGapMs: 2000, maxGapMs: 5000 } }),
    now: () => {
      clock += 10000
      return clock
    },
    rng: seededRng(3),
  })
  const startedAt = Date.now()
  const result = await sender.send(privateMessage(), '春'.repeat(45))
  const elapsed = Date.now() - startedAt
  check('now 注入：3 片都发出', result, { sent: 3, total: 3, cancelled: false })
  check('now 注入：3 次调用', pieces.length, 3)
  ok('now 注入：没有真等待', elapsed < 1000, `${elapsed}ms`)
  sender.dispose()
}

{
  // store 缺失 → 用默认 2~5 秒；用跳表 now 避免真等，验证默认配置路径不炸
  let clock = 0
  const recorder = []
  const sender = createRhythmSender({
    outbox: {
      plain: (text) => text,
      async sendPiece(message, text) {
        recorder.push(text)
        return true
      },
    },
    now: () => {
      clock += 10000
      return clock
    },
  })
  const result = await sender.send(privateMessage(), '春'.repeat(45))
  check('无 store 时用默认节奏也能发', result.sent, 3)
  check('无 store 时调用次数', recorder.length, 3)
  sender.dispose()
}

{
  // 单片失败不拖垮整轮
  const { sender, pieces } = makeSender({ failIndexes: [1] })
  const result = await sender.send(privateMessage(), '春'.repeat(45))
  check('失败一片：仍发完 3 次', pieces.length, 3)
  check('失败一片：sent 只数成功的', result, { sent: 2, total: 3, cancelled: false })
  sender.dispose()
}

{
  // sendPiece 抛异常也不拖垮整轮
  const { sender, pieces } = makeSender({ throwIndexes: [1] })
  const result = await sender.send(privateMessage(), '春'.repeat(45))
  check('抛异常：仍发完 3 次', pieces.length, 3)
  check('抛异常：sent = 2', result, { sent: 2, total: 3, cancelled: false })
  sender.dispose()
}

{
  const { sender, pieces } = makeSender()
  const result = await sender.send(privateMessage(), '')
  check('空文本：什么都不发', result, { sent: 0, total: 0, cancelled: false })
  check('空文本：没调 sendPiece', pieces.length, 0)
  sender.dispose()
}

{
  // Markdown 降级在分片之前：`**` 不会把分片边界搞乱
  const { sender, pieces } = makeSender({ plain: markdownToPlain })
  await sender.send(privateMessage(), '**粗体**第一句。`代码`第二句。')
  ok('发送内容已降级 Markdown', pieces.every((piece) => !piece.text.includes('**') && !piece.text.includes('`')), JSON.stringify(pieces.map((piece) => piece.text)))
  sender.dispose()
}

{
  // maxCharsPerMessage 是 QQ 单条长度保险丝
  const { sender, pieces } = makeSender({
    store: storeOf({ rhythm: { minGapMs: 0, maxGapMs: 0, maxCharsPerMessage: 10 } }),
  })
  const result = await sender.send(privateMessage(), '12345678901234567890')
  check('超长单条被 maxCharsPerMessage 再切', result.total, 2)
  ok('每片 <= 10 字符', pieces.every((piece) => piece.text.length <= 10), JSON.stringify(pieces.map((piece) => piece.text.length)))
  check('拼回去', pieces.map((piece) => piece.text).join(''), '12345678901234567890')
  sender.dispose()
}

{
  // maxTokensPerPiece 从 store 读，不是写死
  const { sender, pieces } = makeSender({
    store: storeOf({ rhythm: { minGapMs: 0, maxGapMs: 0, maxTokensPerPiece: 5 } }),
  })
  await sender.send(privateMessage(), '一二三四五六七八九十')
  check('store.maxTokensPerPiece=5 生效', pieces.map((piece) => piece.text), ['一二三四五', '六七八九十'])
  sender.dispose()
}

// ══════════════════════════════════════════════════════════════
group('createRhythmSender：cancel / dispose（抢占 + 不泄漏）')

{
  const { sender, pieces } = makeSender({ store: storeOf({ rhythm: { minGapMs: 10000, maxGapMs: 10000 } }) })
  const promise = sender.send(privateMessage(), '春'.repeat(45))
  await new Promise((resolve) => setImmediate(resolve))
  const wasSending = sender.cancel('新消息抢占')
  const result = await promise
  check('cancel 报告有在途批次', wasSending, true)
  check('cancel 后不再发后续分片', result, { sent: 1, total: 3, cancelled: true })
  check('cancel 后只调了 1 次', pieces.length, 1)
  check('cancel 清掉所有定时器', sender.pendingTimers, 0)
  sender.dispose()
}

{
  const { sender } = makeSender()
  check('空闲时 cancel 返回 false', sender.cancel(), false)
  sender.dispose()
}

{
  const { sender, pieces } = makeSender({ store: storeOf({ rhythm: { minGapMs: 10000, maxGapMs: 10000 } }) })
  const promise = sender.send(privateMessage(), '春'.repeat(45))
  await new Promise((resolve) => setImmediate(resolve))
  sender.dispose()
  const result = await promise
  check('dispose 中断在途发送', result, { sent: 1, total: 3, cancelled: true })
  check('dispose 后只调了 1 次', pieces.length, 1)
  check('dispose 标记', sender.disposed, true)
  check('dispose 清掉定时器', sender.pendingTimers, 0)
  const after = await sender.send(privateMessage(), '再来一条。')
  check('dispose 后 send 直接返回 cancelled', after, { sent: 0, total: 0, cancelled: true })
  sender.dispose() // 可重复调用
  check('dispose 幂等', sender.disposed, true)
}

// ══════════════════════════════════════════════════════════════
group('markdownToPlain：QQ 不渲染 Markdown（每条规则）')

check('代码块围栏去掉', markdownToPlain('```js\nconst a = 1\n```'), 'const a = 1')
check('行内代码去反引号', markdownToPlain('`code`'), 'code')
check('标题去 #', markdownToPlain('# 标题'), '标题')
check('粗体去 **', markdownToPlain('**粗体**'), '粗体')
check('粗斜体去 ***', markdownToPlain('***粗斜体***'), '粗斜体')
check('斜体去 *', markdownToPlain('*斜体*'), '斜体')
check('删除线去 ~~', markdownToPlain('~~删除~~'), '删除')
check('图片变 [图片]', markdownToPlain('![图片说明](https://x/y.png)'), '[图片]')
check('链接保留 文字 (地址)', markdownToPlain('[点我](https://a.b/c)'), '点我 (https://a.b/c)')
check('分隔线去掉', markdownToPlain('---'), '')
check('引用去 >', markdownToPlain('> 引用'), '引用')
check('无序列表变 ·', markdownToPlain('- a\n- b'), '· a\n· b')
check('有序列表保留编号', markdownToPlain('1. 第一'), '1. 第一')
check('表格转空格分隔', markdownToPlain('| a | b |\n|---|---|\n| 1 | 2 |'), 'a  b\n\n1  2')
check('多余空行压成两行', markdownToPlain('a\n\n\n\nb'), 'a\n\nb')
check('null 安全', markdownToPlain(null), '')
check('undefined 安全', markdownToPlain(undefined), '')
check('数字安全', markdownToPlain(0), '0')
check('中文和 emoji 原样保留', markdownToPlain('你好😀'), '你好😀')
check('组合文档整体降级', markdownToPlain('# 标题\n> 引用\n- **粗体** 列表\n[链接](https://a.b)\n![图片说明](https://img.png)'), '标题\n引用\n· 粗体 列表\n链接 (https://a.b)\n[图片]')
check('加粗 + 行内代码组合', markdownToPlain('**加粗** 和 `代码`'), '加粗 和 代码')
check('图片规则先于链接（不会留孤零零 !）', markdownToPlain('看图 ![x](https://y/z.png)'), '看图 [图片]')

// ══════════════════════════════════════════════════════════════
group('Outbox：降级 / 分片 / 引用 / 重试 / 不抛')

{
  const api = makeApi()
  const log = makeLogger()
  const outbox = new Outbox({ api, store: zeroStore(), log, retryDelayMs: 0 })
  const result = await outbox.send(groupMessage(), '**第一句**很长很长很长很长。**第二句**也很长很长很长。', { quote: true })
  check('群聊：走 sendGroup', api.calls[0]?.scene, 'group')
  check('群聊：目标群号正确', api.calls[0]?.id, 'g1')
  check('引用段只加在第一片', replySegmentOf(api.calls[0].segments)?.data.id, 'm1')
  check('第二片没有引用段', replySegmentOf(api.calls[1].segments), undefined)
  ok('发送文本已降级', api.calls.every((call) => !textOfSegments(call.segments).includes('**')))
  check('返回 sent/total', result, { sent: 2, total: 2, cancelled: false })
  outbox.dispose()
}

{
  const api = makeApi()
  const outbox = new Outbox({ api, store: zeroStore(), log: makeLogger(), retryDelayMs: 0 })
  const result = await outbox.send(privateMessage(), '你好呀。', { quote: true })
  check('私聊：走 sendPrivate', api.calls[0]?.scene, 'private')
  check('私聊：目标 QQ 正确', api.calls[0]?.id, 'u2')
  check('私聊：即使 quote 也不加 reply 段', replySegmentOf(api.calls[0].segments), undefined)
  check('私聊：发送成功 1 条', result.sent, 1)
  outbox.dispose()
}

{
  const api = makeApi()
  const outbox = new Outbox({ api, store: zeroStore(), log: makeLogger(), retryDelayMs: 0 })
  const text = '春'.repeat(200)
  const result = await outbox.send(groupMessage(), text)
  check('200 字分 10 次 api 调用', api.calls.length, 10)
  ok('每条都 <= 20 token', api.calls.every((call) => estimateTokens(textOfSegments(call.segments)) <= 20), JSON.stringify(api.calls.map((call) => estimateTokens(textOfSegments(call.segments)))))
  check('发完 10 条', result.sent, 10)
  check('api 文本拼回去 === 原文', api.calls.map((call) => textOfSegments(call.segments)).join(''), text)
  outbox.dispose()
}

{
  const api = makeApi({ failFirst: 1 })
  const log = makeLogger()
  const outbox = new Outbox({ api, store: zeroStore(), log, retryDelayMs: 0 })
  const result = await outbox.send(groupMessage(), '你好。')
  check('失败重试一次成功：2 次调用', api.calls.length, 2)
  check('重试后发送成功', result, { sent: 1, total: 1, cancelled: false })
  ok('重试有 warn 日志', log.entries.warn.some((line) => line.includes('重试')), JSON.stringify(log.entries.warn))
  outbox.dispose()
}

{
  const api = makeApi({ failFirst: 2 })
  const log = makeLogger()
  const outbox = new Outbox({ api, store: zeroStore(), log, retryDelayMs: 0 })
  const result = await outbox.send(groupMessage(), '你好。', { quote: true })
  check('两次失败后降级纯文本：3 次调用', api.calls.length, 3)
  check('降级纯文本：没有再带 reply 段', replySegmentOf(api.calls[2].segments), undefined)
  check('降级纯文本：文本正确', textOfSegments(api.calls[2].segments), '你好。')
  check('降级后发送成功', result, { sent: 1, total: 1, cancelled: false })
  ok('降级有 warn 日志', log.entries.warn.some((line) => line.includes('降级纯文本')), JSON.stringify(log.entries.warn))
  outbox.dispose()
}

{
  const api = makeApi({ failAlways: true })
  const log = makeLogger()
  const outbox = new Outbox({ api, store: zeroStore(), log, retryDelayMs: 0 })
  const result = await outbox.send(groupMessage(), '你好。', { quote: true })
  check('全失败不抛：返回 0 条', result, { sent: 0, total: 1, cancelled: false })
  ok('全失败有 error 日志', log.entries.error.length > 0, JSON.stringify(log.entries.error))
  notOk('全失败不抛出异常（await 正常返回）', false)
  outbox.dispose()
}

{
  // 没有 api / gateway：也不能抛
  const log = makeLogger()
  const outbox = new Outbox({ store: zeroStore(), log, retryDelayMs: 0 })
  const result = await outbox.send(groupMessage(), '你好。')
  check('没通道：返回 0 条', result, { sent: 0, total: 1, cancelled: false })
  ok('没通道：有 warn 日志', log.entries.warn.some((line) => line.includes('没有可用的')), JSON.stringify(log.entries.warn))
  outbox.dispose()
}

{
  // 兼容 pipeline.js 现在传的 gateway（不是 api）
  const calls = []
  const gateway = {
    async call(action, params) {
      calls.push({ action, params })
      return { message_id: 1 }
    },
  }
  const outbox = new Outbox({ gateway, store: zeroStore(), log: makeLogger(), retryDelayMs: 0 })
  const result = await outbox.send(privateMessage(), '你好。')
  check('gateway 兼容：action 是 send_private_msg', calls[0]?.action, 'send_private_msg')
  check('gateway 兼容：user_id 正确', calls[0]?.params.user_id, 'u2')
  check('gateway 兼容：message 段正确', calls[0]?.params.message?.[0]?.data?.text, '你好。')
  check('gateway 兼容：发送成功', result.sent, 1)
  outbox.dispose()
}

{
  // 兼容 pipeline.js 现在传的 rhythm 模块命名空间（不是发送器实例）
  const api = makeApi()
  const outbox = new Outbox({ api, store: zeroStore(), rhythm: rhythmModule, log: makeLogger(), retryDelayMs: 0 })
  const result = await outbox.send(groupMessage(), '模块命名空间注入也要能发。')
  check('rhythm 模块命名空间可接受', result.sent, 1)
  check('rhythm 模块命名空间：api 被调用', api.calls.length, 1)
  outbox.dispose()
}

{
  const api = makeApi()
  const outbox = new Outbox({ api, store: zeroStore(), log: makeLogger(), retryDelayMs: 0 })
  const privateResult = await outbox.push({ scene: 'private', peerId: 'u9', userId: 'u9' }, '在吗？')
  check('push 私聊：走 sendPrivate', api.calls[0]?.scene, 'private')
  check('push 私聊：目标正确', api.calls[0]?.id, 'u9')
  check('push 私聊：发送成功', privateResult.sent, 1)
  const groupResult = await outbox.push({ scene: 'group', peerId: 'g9', userId: 'u9' }, '通知一下。')
  const groupCall = api.calls.find((call) => call.scene === 'group')
  check('push 群聊：走 sendGroup', groupCall?.scene, 'group')
  check('push 群聊：目标正确', groupCall?.id, 'g9')
  check('push 群聊：发送成功', groupResult.sent, 1)
  outbox.dispose()
}

{
  const api = makeApi()
  const outbox = new Outbox({ api, store: zeroStore(), log: makeLogger(), retryDelayMs: 0 })
  const result = await outbox.send(groupMessage(), '')
  check('空文本不发', result, { sent: 0, total: 0, cancelled: false })
  check('空文本没有 api 调用', api.calls.length, 0)
  outbox.dispose()
  const after = await outbox.send(groupMessage(), 'dispose 之后的。')
  check('Outbox dispose 后不再发', after, { sent: 0, total: 0, cancelled: true })
  check('Outbox dispose 后没有新调用', api.calls.length, 0)
}

// ══════════════════════════════════════════════════════════════
group('Inbound：媒体落盘 / 限额 / 失败不抛')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chacha-inbound-test-'))
const dayDir = path.join(tmpRoot, 'incoming', '2026-11-07')

function fakeResponse(buffer, { status = 200, headers = {} } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase()
        return headerMap.has(key) ? headerMap.get(key) : null
      },
    },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
  }
}

function makeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return handler(url, options)
  }
  return { calls, fetchImpl }
}

const inboundStore = (inbound = {}) => storeOf({ inbound: { maxBytes: 1024, maxImages: 2, ...inbound } })
const fixedNow = () => new Date('2026-11-07T12:00:00').getTime()
const imageBytes = Buffer.from('hello-image-bytes')

try {
  {
    const { calls, fetchImpl } = makeFetch(() => fakeResponse(imageBytes))
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    const results = await inbound.collect({
      id: 'msg-1',
      media: [{ kind: 'image', url: 'https://cdn.example/a.png', name: '' }],
    })
    check('图片下载：1 条结果', results.length, 1)
    check('图片下载：成功', results[0].failed, false)
    check('图片下载：kind', results[0].kind, 'image')
    check('图片下载：字节数', results[0].bytes, imageBytes.byteLength)
    check('图片下载：落在日期目录', path.dirname(results[0].path), dayDir)
    check('图片下载：文件真的存在', fs.existsSync(results[0].path), true)
    check('图片下载：内容一致', fs.readFileSync(results[0].path, 'utf8'), imageBytes.toString('utf8'))
    check('图片下载：扩展名', results[0].path.endsWith('.png'), true)
    check('图片下载：fetch 调用 1 次', calls.length, 1)
    inbound.dispose()
    check('Inbound dispose 标记', inbound.disposed, true)
  }

  {
    const { calls, fetchImpl } = makeFetch(() => fakeResponse(imageBytes))
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    const results = await inbound.collect({
      id: 'msg-multi',
      media: [
        { kind: 'image', url: 'https://cdn.example/1.png' },
        { kind: 'image', url: 'https://cdn.example/2.png' },
        { kind: 'image', url: 'https://cdn.example/3.png' },
        { kind: 'file', url: 'https://cdn.example/x.pdf', name: 'x.pdf' },
      ],
    })
    check('多图：结果 4 条（含被限额的）', results.length, 4)
    check('多图：第 1 张成功', results[0].failed, false)
    check('多图：第 2 张成功', results[1].failed, false)
    check('多图：第 3 张被 maxImages=2 拦下', results[2].failed, true)
    ok('多图：限额原因可读', results[2].reason.includes('2 张图片上限'), results[2].reason)
    check('多图：限额的不落盘', results[2].path, '')
    check('多图：文件成功', results[3].failed, false)
    check('多图：文件扩展名', results[3].path.endsWith('.pdf'), true)
    check('多图：只下载了 3 个（第 3 张图没请求）', calls.length, 3)
    inbound.dispose()
  }

  {
    const big = Buffer.alloc(20, 0x61)
    const { fetchImpl } = makeFetch(() => fakeResponse(big))
    const inbound = new Inbound({ store: inboundStore({ maxBytes: 10 }), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    const results = await inbound.collect({ id: 'msg-big', media: [{ kind: 'image', url: 'https://cdn.example/big.png' }] })
    check('超限文件：失败', results[0].failed, true)
    ok('超限文件：原因含「过大」', results[0].reason.includes('过大'), results[0].reason)
    check('超限文件：没有落盘路径', results[0].path, '')
    inbound.dispose()
  }

  {
    const small = Buffer.from('abc')
    const { fetchImpl } = makeFetch(() => fakeResponse(small, { headers: { 'content-length': '9999' } }))
    const inbound = new Inbound({ store: inboundStore({ maxBytes: 10 }), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    const results = await inbound.collect({ id: 'msg-head', media: [{ kind: 'image', url: 'https://cdn.example/big2.png' }] })
    check('Content-Length 提前拒绝', results[0].failed, true)
    ok('Content-Length 拒绝原因', results[0].reason.includes('过大'), results[0].reason)
    inbound.dispose()
  }

  {
    const { fetchImpl } = makeFetch(() => fakeResponse(Buffer.from('x'), { status: 500 }))
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    const results = await inbound.collect({ id: 'msg-500', media: [{ kind: 'image', url: 'https://cdn.example/e.png' }] })
    check('HTTP 500：失败', results[0].failed, true)
    ok('HTTP 500：原因含状态码', results[0].reason.includes('HTTP 500'), results[0].reason)
    inbound.dispose()
  }

  {
    const { fetchImpl } = makeFetch(() => {
      throw new Error('boom-net')
    })
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    const results = await inbound.collect({ id: 'msg-net', media: [{ kind: 'image', url: 'https://cdn.example/n.png' }] })
    check('网络异常：不抛、返回失败', results[0].failed, true)
    ok('网络异常：原因带原错误', results[0].reason.includes('boom-net'), results[0].reason)
    inbound.dispose()
  }

  {
    const { calls, fetchImpl } = makeFetch(() => fakeResponse(imageBytes))
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    const results = await inbound.collect({ id: 'msg-file', media: [{ kind: 'image', url: 'file:///C:/Windows/win.ini' }] })
    check('非 http 协议：拒绝', results[0].failed, true)
    ok('非 http 协议：原因说明', results[0].reason.includes('协议'), results[0].reason)
    check('非 http 协议：不发请求', calls.length, 0)
    inbound.dispose()
  }

  {
    const { fetchImpl } = makeFetch(() => fakeResponse(imageBytes))
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    const results = await inbound.collect({ id: 'msg-nourl', media: [{ kind: 'image', url: '' }] })
    check('没有 url：失败', results[0].failed, true)
    ok('没有 url：原因含「地址」', results[0].reason.includes('地址'), results[0].reason)
    inbound.dispose()
  }

  {
    const { calls, fetchImpl } = makeFetch(() => fakeResponse(imageBytes))
    const gatewayCalls = []
    const gateway = {
      async call(action, params) {
        gatewayCalls.push({ action, params })
        return { url: 'https://cdn.example/resolved.png', file: 'ignored' }
      },
    }
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: fixedNow, gateway })
    const results = await inbound.collect({ id: 'msg-resolve', media: [{ kind: 'image', url: '', fileId: 'f-1' }] })
    check('gateway 兜底换地址：成功', results[0].failed, false)
    check('gateway 兜底换地址：用了换来的 url', results[0].url, 'https://cdn.example/resolved.png')
    check('gateway 兜底换地址：get_image 被调用', gatewayCalls[0]?.action, 'get_image')
    check('gateway 兜底换地址：file 参数正确', gatewayCalls[0]?.params.file, 'f-1')
    check('gateway 兜底换地址：fetch 用了换来的地址', calls[0]?.url, 'https://cdn.example/resolved.png')
    inbound.dispose()
  }

  {
    const { calls, fetchImpl } = makeFetch(() => fakeResponse(imageBytes))
    const gateway = {
      async call() {
        throw new Error('get_image failed')
      },
    }
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: fixedNow, gateway })
    const results = await inbound.collect({ id: 'msg-resolve-fail', media: [{ kind: 'image', url: '', fileId: 'f-2' }] })
    check('gateway 换地址失败：返回失败', results[0].failed, true)
    check('gateway 换地址失败：没有发请求', calls.length, 0)
    inbound.dispose()
  }

  {
    const { fetchImpl } = makeFetch(() => fakeResponse(Buffer.from('12345')))
    const inbound = new Inbound({ store: inboundStore({ maxImages: 5 }), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    const results = await inbound.collect({
      id: 'msg-ext',
      media: [
        { kind: 'file', url: 'https://cdn.example/download?id=1', name: '报告.pdf' },
        { kind: 'record', url: 'https://cdn.example/voice.amr' },
        { kind: 'video', url: 'https://cdn.example/v.mp4?token=abc#t' },
        { kind: 'image', url: 'https://cdn.example/noext' },
      ],
    })
    check('扩展名：file 用 name 猜 .pdf', results[0].path.endsWith('.pdf'), true)
    check('扩展名：record 用 url 猜 .amr', results[1].path.endsWith('.amr'), true)
    check('扩展名：video 用 url 猜 .mp4', results[2].path.endsWith('.mp4'), true)
    check('扩展名：image 猜不到用 .jpg', results[3].path.endsWith('.jpg'), true)
    inbound.dispose()
  }

  {
    const { fetchImpl } = makeFetch(() => fakeResponse(imageBytes))
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    const results = await inbound.collect({
      id: 'msg/../evil',
      media: [{ kind: 'image', url: 'https://cdn.example/a.png' }],
    })
    check('恶意 message id：路径仍在日期目录内', path.dirname(results[0].path), dayDir)
    const relative = path.relative(tmpRoot, results[0].path)
    notOk('恶意 message id：没有目录穿越', relative.startsWith('..'), relative)
    inbound.dispose()
  }

  {
    const { fetchImpl } = makeFetch(() => fakeResponse(imageBytes))
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: () => new Date('2026-11-07T12:00:00') })
    const results = await inbound.collect({ id: 'msg-date', media: [{ kind: 'image', url: 'https://cdn.example/d.png' }] })
    check('now 返回 Date 也能算日期目录', path.dirname(results[0].path), dayDir)
    inbound.dispose()
  }

  {
    const { fetchImpl } = makeFetch(() => fakeResponse(imageBytes))
    const inbound = new Inbound({ store: inboundStore(), dataDir: tmpRoot, fetchImpl, now: fixedNow })
    check('无 media 返回空数组', await inbound.collect({ id: 'x' }), [])
    check('null message 不抛', await inbound.collect(null), [])
    const results = await inbound.collect({ id: 'msg-null', media: [null, { kind: 'image', url: '' }] })
    check('media 里有 null 也不抛', results.length, 2)
    check('media 里的 null 记为失败', results[0].failed, true)
    const text = Inbound.describe(results)
    ok('describe：失败项写「没取到」', text.includes('没取到'), text)
    check('describe：空数组返回空串', Inbound.describe([]), '')
    const successLine = Inbound.describe([{ kind: 'image', path: 'C:/x/a.png', failed: false }])
    ok('describe：成功项写路径', successLine.includes('图片：已存到 C:/x/a.png'), successLine)
    inbound.dispose()
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
group('moderation：热词命中 / 时长钳制')

const moderationConfig = (overrides = {}) => ({
  owner: { qq: '1001' },
  moderation: {
    watchAll: true,
    hotKeywords: [{ category: 'ad', words: ['加微信', '刷单'] }, { category: 'fraud', keyword: '转账', minutes: 999 }, '裸聊'],
    banEnabled: true,
    defaultBanMinutes: 10,
    maxBanMinutes: 60,
    ...overrides,
  },
})

check('member 命中热词：生成 1 条建议', inspectBatch([{ userId: '2001', role: 'member', text: '加微信' }], moderationConfig()).suggest.length, 1)
check('默认禁言时长 defaultBanMinutes', inspectBatch([{ userId: '2001', role: 'member', text: '加微信' }], moderationConfig()).suggest[0].minutes, 10)
check('规则自带时长优先', inspectBatch([{ userId: '2001', role: 'member', text: '转账' }], moderationConfig()).suggest[0].minutes, 60)
check('规则时长超上限被钳制到 maxBanMinutes', clampBanMinutes(999, moderationConfig()), 60)
check('规则时长 0 被钳制到 1', clampBanMinutes(0, moderationConfig()), 1)
check('规则时长负数被钳制到 1', clampBanMinutes(-5, moderationConfig()), 1)
check('规则时长正常值不变', clampBanMinutes(5, moderationConfig()), 5)
check('未给时长用 defaultBanMinutes', clampBanMinutes(undefined, moderationConfig()), 10)
check('单段配置也能钳制', clampBanMinutes(999, { defaultBanMinutes: 5, maxBanMinutes: 20 }), 20)
check('suggest 项形状只有 userId/minutes/reason', Object.keys(inspectBatch([{ userId: '2001', role: 'member', text: '加微信' }], moderationConfig()).suggest[0]).sort(), ['minutes', 'reason', 'userId'])

{
  const result = inspectBatch([{ userId: '2001', role: 'member', text: '加微信刷单，日结' }], moderationConfig())
  ok('建议 reason 说明命中了什么', result.suggest[0].reason.includes('广告') && result.suggest[0].reason.includes('加微信'), result.suggest[0].reason)
  ok('整批 reason 说明审查条数', result.reason.includes('审查 1 条消息'), result.reason)
  ok('整批 reason 说明建议人数', result.reason.includes('建议禁言 1 人'), result.reason)
}

{
  const result = inspectBatch([{ userId: '2001', role: 'member', text: '今天天气不错' }], moderationConfig())
  check('未命中热词：没有建议', result.suggest, [])
  ok('未命中热词：reason 说命中 0 条', result.reason.includes('命中热词 0 条'), result.reason)
}

// ── 权限反向测试（核心） ───────────────────────────────────────
{
  const ownerResult = inspectBatch([{ userId: '3001', role: 'owner', text: '加微信' }], moderationConfig())
  check('反向测试：群主不会被建议禁言', ownerResult.suggest, [])
  ok('反向测试：reason 说明是群主', ownerResult.reason.includes('群主，永不禁言'), ownerResult.reason)

  const adminResult = inspectBatch([{ userId: '3002', role: 'admin', text: '转账' }], moderationConfig())
  check('反向测试：管理员不会被建议禁言', adminResult.suggest, [])
  ok('反向测试：reason 说明是管理员', adminResult.reason.includes('管理员，永不禁言'), adminResult.reason)

  const masterResult = inspectBatch([{ userId: '1001', role: 'member', text: '裸聊' }], moderationConfig())
  check('反向测试：主人（按 owner.qq）不会被建议禁言', masterResult.suggest, [])
  ok('反向测试：reason 说明是主人', masterResult.reason.includes('主人，永不禁言'), masterResult.reason)

  const unknownRole = inspectBatch([{ userId: '4001', text: '加微信' }], moderationConfig())
  check('反向测试：role 缺失保守跳过', unknownRole.suggest, [])
  ok('反向测试：reason 说明角色未知', unknownRole.reason.includes('角色未知'), unknownRole.reason)

  const botSelf = inspectBatch([{ userId: '9001', selfId: '9001', role: 'member', text: '加微信' }], moderationConfig())
  check('反向测试：机器人自己跳过', botSelf.suggest, [])
  ok('反向测试：reason 说明是机器人自己', botSelf.reason.includes('机器人自己'), botSelf.reason)

  const chineseRoles = inspectBatch(
    [
      { userId: '3003', role: '群主', text: '加微信' },
      { userId: '3004', role: '管理员', text: '加微信' },
    ],
    moderationConfig(),
  )
  check('反向测试：中文角色名也拦得住', chineseRoles.suggest, [])
}

// ── 多条 / 多人 / 聚合 ────────────────────────────────────────
{
  const result = inspectBatch(
    [
      { userId: '2002', role: 'member', text: '加微信' },
      { userId: '2002', role: 'member', text: '帮我转账' },
      { userId: '2003', role: 'member', text: '刷单' },
    ],
    moderationConfig(),
  )
  check('同一人命中多条只给 1 条建议', result.suggest.length, 2)
  check('同一人聚合后时长取更严的', result.suggest[0].minutes, 60)
  ok('聚合 reason 同时出现两类', result.suggest[0].reason.includes('广告') && result.suggest[0].reason.includes('涉诈'), result.suggest[0].reason)
  check('多人保持首次命中顺序', result.suggest.map((item) => item.userId), ['2002', '2003'])
}

// ── 开关 / 配置形态 / 热词归一化 ──────────────────────────────
{
  const disabled = inspectBatch([{ userId: '2001', role: 'member', text: '加微信' }], moderationConfig({ banEnabled: false }))
  check('banEnabled=false：不生成建议', disabled.suggest, [])
  ok('banEnabled=false：reason 说明开关关闭', disabled.reason.includes('禁言开关已关闭'), disabled.reason)

  const notWatchAll = inspectBatch([{ userId: '2001', role: 'member', text: '加微信' }], moderationConfig({ watchAll: false }))
  check('watchAll=false + 没 @：不审查', notWatchAll.suggest, [])
  ok('watchAll=false：reason 说明只看 @', notWatchAll.reason.includes('watchAll=false'), notWatchAll.reason)

  const mentioned = inspectBatch([{ userId: '2001', role: 'member', text: '加微信', mentionsMe: true }], moderationConfig({ watchAll: false }))
  check('watchAll=false + 被 @：照查', mentioned.suggest.length, 1)

  const sectionOnly = inspectBatch([{ userId: '2001', role: 'member', text: '加微信' }], { hotKeywords: ['加微信'], defaultBanMinutes: 5, maxBanMinutes: 20 })
  check('只传 moderation 段也能工作', sectionOnly.suggest.length, 1)
  check('只传 moderation 段：时长用段里的默认值', sectionOnly.suggest[0].minutes, 5)

  const explicitEmpty = inspectBatch([{ userId: '2001', role: 'member', text: '加微信' }], { moderation: { hotKeywords: [] } })
  check('显式空热词表：不命中', explicitEmpty.suggest, [])

  const defaultFallback = inspectBatch([{ userId: '2001', role: 'member', text: '加微信' }])
  check('完全没配置时回落到内置热词表', defaultFallback.suggest.length, 1)

  check('空数组输入安全', inspectBatch([], moderationConfig()), { suggest: [], reason: '没有可审查的文本消息' })
  check('非数组输入安全', inspectBatch(null, moderationConfig()).suggest, [])

  const ignoreNoise = inspectBatch(
    [
      null,
      42,
      { role: 'member', text: '加微信' }, // 没有 userId
      { userId: '2001', role: 'member', text: '' }, // 没有文本
    ],
    moderationConfig(),
  )
  check('无效消息条目被跳过', ignoreNoise.suggest, [])
  ok('无效消息条目不计入审查数', ignoreNoise.reason.includes('没有可审查的文本消息'), ignoreNoise.reason)
}

check('normalizeHotKeywords：字符串/words/keyword 三种写法', normalizeHotKeywords([
  '加微信',
  { category: '广告', words: ['刷单', ' 推广 '] },
  { keyword: '裸聊', category: 'porn', minutes: 30 },
  null,
  42,
  { category: 'ad' },
]), [
  { keyword: '加微信', category: 'hot', minutes: null },
  { keyword: '刷单', category: 'ad', minutes: null },
  { keyword: '推广', category: 'ad', minutes: null },
  { keyword: '裸聊', category: 'porn', minutes: 30 },
])

check('matchHotKeywords：区分分类与标签', matchHotKeywords('加微信 转账', moderationConfig()).map((hit) => [hit.category, hit.label]).sort(), [
  ['ad', '广告'],
  ['fraud', '涉诈'],
])

{
  const lowercase = matchHotKeywords('FREEMONEY', { hotKeywords: [{ category: 'ad', words: ['FreeMoney'] }] })
  check('matchHotKeywords：英文大小写不敏感', lowercase.length, 1)
  check('matchHotKeywords：没命中返回空数组', matchHotKeywords('今天天气不错', moderationConfig()), [])
  check('matchHotKeywords：空文本返回空数组', matchHotKeywords('', moderationConfig()), [])
}

check('normalizeRole：英文 owner', normalizeRole('owner'), 'owner')
check('normalizeRole：admin', normalizeRole('administrator'), 'admin')
check('normalizeRole：member', normalizeRole('member'), 'member')
check('normalizeRole：中文群主', normalizeRole('群主'), 'owner')
check('normalizeRole：未知角色返回空串', normalizeRole('vip'), '')
check('normalizeRole：null 安全', normalizeRole(null), '')

// ══════════════════════════════════════════════════════════════
group('文件编码：UTF-8 无 BOM（DESIGN §10 血泪）')

for (const file of ['rhythm.js', 'outbox.js', 'inbound.js', 'moderation.js']) {
  const buffer = fs.readFileSync(new URL(`../src/controller/${file}`, import.meta.url))
  const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  ok(`无 BOM：${file}`, !hasBom)
}

// ══════════════════════════════════════════════════════════════
report('L2 Controller 出站/入站层（rhythm / outbox / inbound / moderation）')
