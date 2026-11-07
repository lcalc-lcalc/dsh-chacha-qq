/**
 * 情绪机制 + 记忆 + 跨会话回忆 的测试套件。
 *
 * 跑法： cd E:\dsh-dev\dsh-chacha-qq-v3; node tests/companion.mjs
 *
 * 约定：
 *   · 纯函数优先；有状态的类一律注入假时钟（`now`），衰减才能定点测。
 *   · 所有文件操作在系统临时目录里（fs.mkdtempSync），测完删干净 —— **绝不碰真实 data 目录**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { group, check, ok, notOk, throws, rejects, report } from './harness.mjs'

import {
  EMOTION_DEFAULTS,
  EmotionState,
  FEELINGS,
  FEELING_KEYS,
  SPEAKERS,
  buildJudgePrompt,
  decayToward,
  moodLabel,
  normalizeMode,
  normalizeSpeaker,
  parseJudgeOutput,
  renderForMind,
} from '../src/controller/emotion.js'

import {
  CORE_SECTIONS,
  MEMORY_DEFAULTS,
  MemoryStore,
  clipText,
  dayStamp,
  insertIntoSection,
  monthStamp,
  parseCore,
} from '../src/controller/memory/store.js'

import {
  Recall,
  clipToTokens,
  estimateTokens,
  extractKeywords,
  scoreFragment,
} from '../src/controller/memory/recall.js'

// --------------------------------------------------------------------------
// 测试脚手架
// --------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const DAY = 24 * HOUR

/** 本地时区的 2026-11-07 12:00（用本地时间构造，dayStamp 也是本地口径） */
const START = new Date(2026, 10, 7, 12, 0, 0).getTime()

/** 可推进的假时钟。所有跟时间有关的断言都靠它。 */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chacha-companion-${prefix}-`))
  tmpRoots.push(dir)
  return dir
}

/** 递归列文件（相对路径），用来保证临时目录里没有残留的 .tmp。 */
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

const zeroFeelings = () => Object.fromEntries(FEELING_KEYS.map((key) => [key, 0]))

// ==========================================================================
// 一、情绪：衰减
// ==========================================================================

group('情绪 · 衰减公式（指数半衰，不是线性）')

ok(
  '心情：3 小时（=1 个半衰期）后差值剩一半',
  Math.abs(decayToward(90, 70, 3 * HOUR, 3 * HOUR) - 80) < 1e-9,
  decayToward(90, 70, 3 * HOUR, 3 * HOUR),
)
ok(
  '心情：6 小时（=2 个半衰期）后差值剩四分之一',
  Math.abs(decayToward(90, 70, 3 * HOUR, 6 * HOUR) - 75) < 1e-9,
  decayToward(90, 70, 3 * HOUR, 6 * HOUR),
)
ok(
  '情绪：90 分钟（=1 个半衰期）后剩一半',
  Math.abs(decayToward(20, 0, 90 * MINUTE, 90 * MINUTE) - 10) < 1e-9,
  decayToward(20, 0, 90 * MINUTE, 90 * MINUTE),
)
ok('衰减是连续的（不是线性掉档）', decayToward(90, 70, 3 * HOUR, 30 * MINUTE) > decayToward(90, 70, 3 * HOUR, 90 * MINUTE))

{
  // 堆积到 82 再放 3 小时：应该正好回到「基线 + 一半的差值」
  const clock = createClock(START)
  const state = new EmotionState({
    config: { baseline: 70, halfLifeHours: 3, feelingHalfLifeMinutes: 90 },
    now: clock.now,
  })
  for (let i = 0; i < 4; i += 1) {
    state.apply({ moodDelta: 10, feelings: { happy: 10 }, reason: '主人夸她', confidence: 90 }, clock.now())
  }
  check('叠加 4 次 +10 → 心情 82（每轮只吃 1/3：+3×4）', state.get().mood, 82)
  check('叠加 4 次 +10 → 开心 40', state.get().feelings.happy, 40)

  clock.advance(3 * HOUR)
  check('3 小时后心情回落到 76（差值 12 → 6）', state.get().mood, 76)
  check('3 小时后开心从 40 掉到 10（2 个半衰期）', state.get().feelings.happy, 10)
}

{
  // 半群性质：同一个 3 小时，一次算完和拆成 18 次算必须相等。
  // （这是线上真实用法：每轮跑完判一次，一天几十次 decay；不满足就会随时间漂。）
  const oneClock = createClock(START)
  const oneShot = new EmotionState({ config: { baseline: 70 }, now: oneClock.now })
  const manyClock = createClock(START)
  const many = new EmotionState({ config: { baseline: 70 }, now: manyClock.now })
  for (let i = 0; i < 4; i += 1) {
    oneShot.apply({ moodDelta: 10, feelings: { happy: 10 }, reason: '高兴', confidence: 90 }, oneClock.now())
    many.apply({ moodDelta: 10, feelings: { happy: 10 }, reason: '高兴', confidence: 90 }, manyClock.now())
  }
  oneClock.advance(3 * HOUR)
  const single = oneShot.get()
  for (let i = 0; i < 18; i += 1) {
    manyClock.advance(10 * MINUTE)
    many.get()
  }
  const split = many.get()
  check('半群性质：一次 3 小时 == 18 次 10 分钟（心情）', split.mood, single.mood)
  check('半群性质：一次 3 小时 == 18 次 10 分钟（情绪）', split.feelings.happy, single.feelings.happy)
  check('两边都落在 76 / 10', [single.mood, single.feelings.happy], [76, 10])
}

{
  // 90 分钟单测：情绪正好减半；心情只掉一点点
  const clock = createClock(START)
  const state = new EmotionState({ config: { baseline: 70 }, now: clock.now })
  state.apply({ moodDelta: 9, feelings: { happy: 10 }, reason: '被夸了', confidence: 90 }, clock.now())
  clock.advance(90 * MINUTE)
  check('90 分钟后开心 10 → 5', state.get().feelings.happy, 5)
  const mood = state.get().mood
  ok('90 分钟后心情只掉一点（73 → 72.12）', mood > 72 && mood < 73, mood)
}

{
  // 衰减可以反复调用而不累积误差（面板每 20 秒轮询一次也不会算歪）
  const clock = createClock(START)
  const state = new EmotionState({ config: { baseline: 70 }, now: clock.now })
  for (let i = 0; i < 4; i += 1) {
    state.apply({ moodDelta: 10, feelings: { happy: 10 }, reason: '高兴', confidence: 90 }, clock.now())
  }
  for (let i = 0; i < 18; i += 1) {
    clock.advance(10 * MINUTE)
    state.get() // 反复衰减
  }
  check('3 小时被拆成 18 次调用，结果一样是 76', state.get().mood, 76)
}

// ==========================================================================
// 二、情绪：七根独立
// ==========================================================================

group('情绪 · 七根情绪各自独立')

check('正好七根', FEELING_KEYS.length, 7)
check('七根的名字', FEELINGS.map((item) => item.label), ['开心', '踏实', '甜蜜', '心疼', '担心', '难过', '吃醋'])

{
  const clock = createClock(START)
  const state = new EmotionState({ now: clock.now })
  state.apply(
    {
      moodDelta: 0,
      feelings: { happy: 5, calm: 3, sweet: 2, heartache: 1, worry: 4, sad: 2, jealous: 3 },
      reason: '七根一起动',
      confidence: 90,
    },
    clock.now(),
  )
  check(
    '七根各记各的',
    state.get().feelings,
    { happy: 5, calm: 3, sweet: 2, heartache: 1, worry: 4, sad: 2, jealous: 3 },
  )
  state.apply({ moodDelta: 0, feelings: { heartache: 5 }, reason: '心疼加重', confidence: 90 }, clock.now())
  check('只动心疼，别的根不受影响', state.get().feelings, {
    happy: 5,
    calm: 3,
    sweet: 2,
    heartache: 6,
    worry: 4,
    sad: 2,
    jealous: 3,
  })
  clock.advance(90 * MINUTE)
  check('90 分钟后七根一起减半', state.get().feelings, {
    happy: 2.5,
    calm: 1.5,
    sweet: 1,
    heartache: 3,
    worry: 2,
    sad: 1,
    jealous: 1.5,
  })
}

{
  // 心情下降的合法来源：心疼 / 担心 / 她自己难过（不是「被惹生气」）
  const clock = createClock(START)
  const state = new EmotionState({ now: clock.now })
  state.apply({ moodDelta: -6, feelings: { sad: 6 }, reason: '事情没办成，心里堵', confidence: 90 }, clock.now())
  ok('她自己难过时心情可以掉', state.get().mood < 70)
  state.apply({ moodDelta: 9, feelings: { sad: -6, happy: 8 }, reason: '主人来哄了，缓过来了', confidence: 90 }, clock.now())
  ok('难过散掉、心情回涨', state.get().mood > 70 && state.get().feelings.sad === 0)
}

// ==========================================================================
// 三、情绪：无变化不记账
// ==========================================================================

group('情绪 · 无变化的回合不记账')

{
  const clock = createClock(START)
  const state = new EmotionState({ now: clock.now })
  const result = state.apply({ moodDelta: 0, feelings: zeroFeelings(), reason: '没什么事', confidence: 90 }, clock.now())
  check('全 0 → applied=false', result.applied, false)
  check('全 0 → 时间线仍是空的', state.snapshot().timeline.length, 0)
  check('全 0 → updatedAt 不动', state.get().updatedAt, 0)
  check('全 0 → 心情还是基线', state.get().mood, 70)

  state.apply({ moodDelta: 1, feelings: zeroFeelings(), reason: '还是没什么事', confidence: 90 }, clock.now())
  check('心情 1 分（实际挪 0 格）也不记账', state.snapshot().timeline.length, 0)

  state.apply({ moodDelta: 9, feelings: { happy: 5 }, reason: '真的被夸了', confidence: 90 }, clock.now())
  check('有波动才记一条', state.snapshot().timeline.length, 1)
  check('时间线记的是实际心情变化', state.snapshot().timeline[0].delta, 3)

  state.apply(null, clock.now())
  check('垃圾 delta 不炸、也不记账', state.snapshot().timeline.length, 1)
}

// ==========================================================================
// 四、情绪：低置信度不注入 / 一次变化只说一次
// ==========================================================================

group('情绪 · 低置信度只记后台，不进她的嘴')

{
  const clock = createClock(START)
  const state = new EmotionState({ config: { minConfidence: 60 }, now: clock.now })
  state.apply({ moodDelta: 9, feelings: { happy: 10 }, reason: '大概是被夸了吧', confidence: 30 }, clock.now())
  check('低置信度也照样记账', state.snapshot().timeline.length, 1)
  check('低置信度不注入', state.takeInjection({ mode: 'event' }), '')
  check('处理过之后还是不说', state.takeInjection({ mode: 'event' }), '')

  state.apply({ moodDelta: 9, feelings: { happy: 10 }, reason: '主人明明白白夸了她', confidence: 90 }, clock.now())
  ok('置信度够了就注入', state.takeInjection({ mode: 'event' }).includes('主人明明白白夸了她'))
}

{
  const clock = createClock(START)
  const state = new EmotionState({ config: { minConfidence: 60 }, now: clock.now })
  state.apply({ moodDelta: 9, feelings: { sweet: 8 }, reason: '主人说想她', confidence: 95 }, clock.now())
  const first = state.takeInjection({ mode: 'event' })
  ok('第一次给出一句话', first.includes('（这会儿）') && first.includes('主人说想她'), first)
  check('同一次变化只说一次（第二次空）', state.takeInjection({ mode: 'event' }), '')
  check('第三次也空', state.takeInjection({ mode: 'event' }), '')
  state.apply({ moodDelta: -6, feelings: { worry: 6 }, reason: '主人熬到三点', confidence: 95 }, clock.now())
  ok('新变化才再说一次', state.takeInjection({ mode: 'event' }).includes('主人熬到三点'))
}

{
  // minor：小波动先攒着，攒够 sigMood 再抬成「该告诉她」
  const clock = createClock(START)
  const state = new EmotionState({ config: { sigMood: 3 }, now: clock.now })
  state.apply({ moodDelta: 2, reason: '一点点高兴', confidence: 90 }, clock.now())
  check('小波动（+1 格）先不说', state.takeInjection({ mode: 'event' }), '')
  state.apply({ moodDelta: 2, reason: '又一点高兴', confidence: 90 }, clock.now())
  ok('累计到门槛后说出来（不然数字在动、她不知道）', state.takeInjection({ mode: 'event' }).includes('又一点高兴'))
}

{
  // 「不告诉」模式：不说；而且**这次变化就此打住** ——
  // 主人把 tellIt 从 none 切回 event 时，绝不能把几天前的旧账突然翻出来说给她听。
  const clock = createClock(START)
  const state = new EmotionState({ config: { tellIt: 'none' }, now: clock.now })
  state.apply({ moodDelta: 9, feelings: { happy: 10 }, reason: '被夸了', confidence: 90 }, clock.now())
  check('none 模式不说', state.takeInjection(), '')
  check('none 模式消费掉这次变化（切回 event 不翻旧账）', state.takeInjection({ mode: 'event' }), '')
  state.apply({ moodDelta: 9, feelings: { happy: 10 }, reason: '又被夸了', confidence: 90 }, clock.now())
  ok('新变化照常能说', state.takeInjection({ mode: 'event' }).includes('又被夸了'))
  ok('不带参数时按配置的 tellIt（Mind 就是这么调的）', typeof state.takeInjection() === 'string')
}

// ==========================================================================
// 五、情绪：解析容错
// ==========================================================================

group('情绪 · parseJudgeOutput 畸形输入')

{
  const good = parseJudgeOutput('{"moodDelta":5,"feelings":{"happy":6,"sweet":2},"reason":"被夸了","confidence":88}')
  check('正常 JSON 心情', good.moodDelta, 5)
  check('正常 JSON 情绪', good.feelings.happy, 6)
  check('正常 JSON 理由', good.reason, '被夸了')
  check('正常 JSON 置信度', good.confidence, 88)

  const fenced = parseJudgeOutput(
    '```json\n{"moodDelta":-4,"feelings":{"heartache":5},"reason":"主人说好累，她心疼","confidence":88}\n```',
  )
  check('带 ```json 围栏也能解析', fenced.moodDelta, -4)
  check('带围栏的情绪值', fenced.feelings.heartache, 5)

  const prose = parseJudgeOutput('好的，我的判断如下：{"moodDelta":3,"feelings":{"happy":2},"reason":"开心","confidence":70} 完毕。')
  check('前后有杂字也能抠出来', prose.moodDelta, 3)

  const trailing = parseJudgeOutput('{"moodDelta":3,"feelings":{"happy":2,},"reason":"开心",}')
  check('尾巴多余的逗号也认', trailing.moodDelta, 3)
  check('尾逗号的情绪值也认', trailing.feelings.happy, 2)

  const missing = parseJudgeOutput('{"moodDelta":3}')
  check('缺 fields → 情绪全 0', missing.feelings, zeroFeelings())
  check('缺 reason → 空串', missing.reason, '')
  check('缺 confidence → 按 70 算（不因漏字段就整轮不判）', missing.confidence, 70)

  const dimsAlias = parseJudgeOutput('{"moodDelta":1,"dims":{"happy":4},"reason":"开心","confidence":80}')
  check('兼容参考实现的 dims 字段名', dimsAlias.feelings.happy, 4)

  const strings = parseJudgeOutput('{"moodDelta":"+5","feelings":{"happy":"5分"},"confidence":"80%"}')
  check('字符串数字也能取', strings.moodDelta, 5)
  check('带单位的数字也能取', strings.feelings.happy, 5)
  check('百分号数字也能取', strings.confidence, 80)

  const clamped = parseJudgeOutput('{"moodDelta":99,"feelings":{"happy":-99},"confidence":999}')
  check('心情涨跌夹在 ±10', clamped.moodDelta, 10)
  check('情绪涨跌夹在 ±10', clamped.feelings.happy, -10)
  check('置信度夹在 0-100', clamped.confidence, 100)

  const plain = parseJudgeOutput('这轮挺平淡的')
  check('纯文本 → 全 0', plain.moodDelta, 0)
  check('纯文本 → feelings 全 0', plain.feelings, zeroFeelings())
  check('纯文本 → confidence 0（一定低于门槛，不会进嘴）', plain.confidence, 0)
  check('纯文本 → reason 空', plain.reason, '')

  check('空输入 → null（根本没判）', parseJudgeOutput(''), null)
  check('空白输入 → null', parseJudgeOutput('   \n '), null)
  check('JSON null → 退化成全 0', parseJudgeOutput('null').confidence, 0)
  check('JSON 数组 → 退化成全 0', parseJudgeOutput('[1,2,3]').moodDelta, 0)
  check('中文理由字段也认', parseJudgeOutput('{"moodDelta":2,"理由":"开心了"}').reason, '开心了')
}

// ==========================================================================
// 六、情绪：口径分开（谁在说话决定怎么判）
// ==========================================================================

group('情绪 · 判断口径：主人 / 她自己 / 群友')

{
  const turns = [
    { speaker: 'owner', text: '今天被领导骂了' },
    { speaker: 'self', text: '抱抱，先别想那么多' },
  ]
  const owner = buildJudgePrompt({ recentTurns: turns, speaker: 'owner' })
  const self = buildJudgePrompt({ recentTurns: turns, speaker: 'self' })
  const guest = buildJudgePrompt({ recentTurns: turns, speaker: 'guest' })

  ok('主人口径写明「主人在跟她说话」', owner.includes('主人在跟她说话'))
  ok('她自己口径写明「主动去找人搭话」', self.includes('主动去找人搭话'))
  ok('群友口径写明「群友 / 陌生人在说话」', guest.includes('群友 / 陌生人在说话'))
  notOk('三种口径的提示词不能一样（判错会得出相反结论）', owner === self || owner === guest || self === guest)

  ok('三种口径都给了结构化输出格式', [owner, self, guest].every((text) => text.includes('"feelings"')))
  ok('三种口径都给了七根情绪', [owner, self, guest].every((text) => text.includes('"heartache"')))
  ok('三种口径都禁止「被惹生气就掉心情」', [owner, self, guest].every((text) => text.includes('被惹生气')))
  ok('三种口径都要求无变化给 0', [owner, self, guest].every((text) => text.includes('无变化')))
  ok('三种口径都要求自评 confidence', [owner, self, guest].every((text) => text.includes('confidence')))
  ok('对话按真实先后摆在提示词里', owner.indexOf('今天被领导骂了') < owner.indexOf('抱抱，先别想那么多'))
  ok('群友口径强调不许吃醋', guest.includes('不许吃醋'))

  const unknown = buildJudgePrompt({ recentTurns: turns, speaker: '乱写的口径' })
  check('认不出的口径按群友处理（保守：宁可比主人淡，不能对陌生人亲昵）', unknown, guest)

  ok('persona 会被带进去', buildJudgePrompt({ recentTurns: turns, speaker: 'owner', persona: '她叫茶茶酱，主人叫阿明' }).includes('阿明'))

  const empty = buildJudgePrompt({ recentTurns: [], speaker: 'owner' })
  ok('没有对话内容时要她别猜', empty.includes('没有拿到任何对话内容'))
  ok('字符串条目按口径当说话人', buildJudgePrompt({ recentTurns: ['在吗'], speaker: 'owner' }).includes('【主人】在吗'))
}

group('情绪 · 口径与模式的归一化')

check('owner 归一化', normalizeSpeaker('OWNER'), 'owner')
check('她自己归一化', normalizeSpeaker('assistant'), 'self')
check('群友归一化', normalizeSpeaker('member'), 'guest')
check('乱写字归一化到群友', normalizeSpeaker('啥'), 'guest')
check('none', normalizeMode('off'), 'none')
check('mood-only', normalizeMode('label'), 'mood-only')
check('event 是默认', normalizeMode(undefined), 'event')
check('未知模式按 event', normalizeMode('乱写'), 'event')

// ==========================================================================
// 七、情绪：注入渲染
// ==========================================================================

group('情绪 · renderForMind 三种模式')

{
  const now = START
  const snapshot = {
    mood: 82,
    feelings: { happy: 40, calm: 0, sweet: 12, heartache: 0, worry: 0, sad: 0, jealous: 0 },
    lastReason: '主人夸她今天乖，她尾巴都要翘起来了',
    kind: '',
    updatedAt: now - 5 * HOUR,
    lastConfidence: 90,
  }

  check('none 什么都不说', renderForMind(snapshot, { mode: 'none' }), '')

  const moodOnly = renderForMind(snapshot, { mode: 'mood-only', now })
  ok('mood-only 只说心情', moodOnly.includes('心情') && moodOnly.includes('别把这句话念出来'))
  notOk('mood-only 不夹带事件', moodOnly.includes('尾巴都要翘起来'))
  ok('mood-only 是「背景」不是命令', moodOnly.includes('这是背景'))

  const event = renderForMind(snapshot, { mode: 'event', now })
  ok('event 带「这会儿」的底子', event.includes('（这会儿）'))
  ok('event 带她自己那件事', event.includes('尾巴都要翘起来'))
  ok('event 带距今的措辞（5 小时前 → 早些时候）', event.includes('（早些时候）'))
  ok('event 允许她不被定调', event.includes('不是非这样不可'))

  const noReason = renderForMind({ ...snapshot, lastReason: '' }, { mode: 'event', now })
  check('event 没有具体事件就什么都不说（不拿空标签凑数）', noReason, '')

  const decayed = renderForMind(
    { ...snapshot, lastReason: '过了几个钟头，刚才那点劲儿慢慢淡了，心里回到平常的样子', kind: 'decay', updatedAt: now },
    { mode: 'event', now },
  )
  ok('自然平复的那条不再套「（刚才）」（自相矛盾）', decayed.includes('过了几个钟头') && !decayed.includes('（刚才）'))

  const customWho = renderForMind(snapshot, { mode: 'mood-only', now, who: '可可' })
  ok('称呼可配（别写死她/他）', customWho.includes('可可'))
}

group('情绪 · 五档心情标签')

check('80 → 欢喜', moodLabel(80), '欢喜')
check('62 → 开心', moodLabel(62), '开心')
check('42 → 一般', moodLabel(42), '一般')
check('25 → 心疼', moodLabel(25), '心疼')
check('24 → 难过', moodLabel(24), '难过')
check('超范围也稳', moodLabel(999), '欢喜')

// ==========================================================================
// 八、情绪：持久化 / reset / 坏数据
// ==========================================================================

group('情绪 · 持久化（原子写 + 时间线 200 条）')

{
  const dataDir = makeTmp('emotion-state')
  const clock = createClock(START)
  const config = { baseline: 70, timelineMax: 200 }
  const state = new EmotionState({ dataDir, config, now: clock.now })
  ok('状态文件路径在 <dataDir>/emotion/state.json', state.path === path.join(dataDir, 'emotion', 'state.json'))
  state.apply({ moodDelta: 9, feelings: { happy: 10 }, reason: '主人夸她', confidence: 90 }, clock.now())
  ok('落盘成功', fs.existsSync(state.path))

  const raw = JSON.parse(fs.readFileSync(state.path, 'utf8'))
  check('落盘的心情值', raw.mood, 73)
  check('落盘的情绪值', raw.feelings.happy, 10)
  check('落盘的时间线', raw.timeline.length, 1)
  check('落盘不留 .tmp', listFiles(path.dirname(state.path)).filter((name) => name.endsWith('.tmp')), [])

  clock.advance(3 * HOUR)
  const reloaded = new EmotionState({ dataDir, config, now: clock.now })
  check('新实例读回同一份心情（并且立刻衰减过）', reloaded.get().mood, 71.5)
  check('新实例读回理由', reloaded.get().lastReason, '主人夸她')

  for (let i = 0; i < 130; i += 1) {
    state.apply({ moodDelta: -10, feelings: { sad: 10 }, reason: `第 ${i} 次难过`, confidence: 90 }, clock.now())
  }
  ok('时间线保留最近 200 条（不会无限长）', state.snapshot().timeline.length <= 200, state.snapshot().timeline.length)
  ok('保留的是最近的', state.snapshot().timeline.at(-1).reason === '第 129 次难过', state.snapshot().timeline.at(-1).reason)

  const snapshot = state.reset(clock.now())
  check('reset 回到基线', snapshot.mood, 70)
  check('reset 清空七根情绪', snapshot.feelings, zeroFeelings())
  check('reset 清空时间线', snapshot.timeline.length, 0)
  check('reset 后落盘也是基线', JSON.parse(fs.readFileSync(state.path, 'utf8')).mood, 70)

  // 坏文件：宁可回到空白，也不能让插件起不来
  fs.writeFileSync(state.path, '这不是 JSON{{{', 'utf8')
  const recovered = new EmotionState({ dataDir, config, now: clock.now })
  check('状态文件坏了 → 退回基线，不抛错', recovered.get().mood, 70)
}

group('情绪 · 配置开关与下限')

{
  const clock = createClock(START)
  const disabled = new EmotionState({ config: { enabled: false }, now: clock.now })
  disabled.apply({ moodDelta: 9, feelings: { happy: 10 }, reason: '被夸了', confidence: 90 }, clock.now())
  check('关掉情绪 → 不注入', disabled.takeInjection({ mode: 'event' }), '')

  const baseline = new EmotionState({ config: { baseline: 60 }, now: clock.now })
  check('基线可配（60）', baseline.get().mood, 60)

  const floored = new EmotionState({ config: { floor: 30 }, now: clock.now })
  for (let i = 0; i < 40; i += 1) {
    floored.apply({ moodDelta: -10, feelings: { sad: 10 }, reason: '难过', confidence: 90 }, clock.now())
  }
  check('心情下限守得住', floored.get().mood, 30)

  // 情绪关掉再打开，不能把关掉期间那条旧账翻出来说
  const toggle = { enabled: false }
  const toggleState = new EmotionState({ config: () => toggle, now: clock.now })
  toggleState.apply(
    { moodDelta: 9, feelings: { happy: 10 }, reason: '关掉期间被夸了', confidence: 90 },
    clock.now(),
  )
  check('关掉时不说', toggleState.takeInjection(), '')
  toggle.enabled = true
  check('重新打开也不翻旧账', toggleState.takeInjection(), '')
  toggleState.apply(
    { moodDelta: 9, feelings: { happy: 10 }, reason: '打开后又被夸了', confidence: 90 },
    clock.now(),
  )
  ok('打开后新变化照常说', toggleState.takeInjection().includes('打开后又被夸了'))

  const fallback = new EmotionState({ config: { baseline: '不是数字', halfLifeHours: -3 }, now: clock.now })
  check('配置塞垃圾也退回默认基线', fallback.get().mood, EMOTION_DEFAULTS.baseline)
  check('默认口径名单', SPEAKERS, ['owner', 'self', 'guest'])
}

{
  // 「心情下降只能因为心疼/担心/她自己难过」——这条是判断规则，不是数值后门；
  // 这里验证规则真的写进了提示词，并且数值上没有别的掉心情的路子。
  const clock = createClock(START)
  const state = new EmotionState({ now: clock.now })
  state.apply({ moodDelta: 10, feelings: { happy: 5 }, reason: '被夸', confidence: 90 }, clock.now())
  const before = state.get().mood
  state.apply({ moodDelta: 0, feelings: { happy: 0 }, reason: '她生气了但什么都没发生', confidence: 90 }, clock.now())
  check('判 0 的回合不会偷偷掉心情', state.get().mood, before)
  ok('提示词里写死了「绝不许因为被惹生气而降」', buildJudgePrompt({ speaker: 'owner' }).includes('绝不许因为「被惹生气'))
}

// ==========================================================================
// 九、记忆：目录 / 写入 / 分区
// ==========================================================================

group('记忆 · 目录结构与按天写入')

{
  const dataDir = makeTmp('memory-day')
  const clock = createClock(START)
  const store = new MemoryStore({ dataDir, now: clock.now })

  ok('构造时就把 memory/ 建好了', fs.existsSync(store.root))
  check('memory/ 刚开始是空的', listFiles(store.root), [])

  const written = await store.appendMemory('主人今天加班到很晚', { tag: '主人' })
  check('写成功的返回值', written, true)
  const expectedDay = path.join(store.root, '2026-11', '2026-11-07.md')
  check('按天文件路径（YYYY-MM/YYYY-MM-DD.md）', store.dayPath(clock.value), expectedDay)
  ok('按天文件真的建出来了', fs.existsSync(expectedDay))
  const dayText = fs.readFileSync(expectedDay, 'utf8')
  ok('按天文件带日期标题', dayText.startsWith('# 2026-11-07'))
  ok('写了时间与标签', dayText.includes('- 12:00 [主人] 主人今天加班到很晚'))

  await store.appendMemory('主人还说明天想吃火锅', { tag: '主人' })
  const dayText2 = fs.readFileSync(expectedDay, 'utf8')
  check('同一天的标题只有一份', (dayText2.match(/^# 2026-11-07/m) ?? []).length, 1)
  check('同一天的两条都在', (dayText2.match(/^- /gm) ?? []).length, 2)

  check('空内容不写', await store.appendMemory('   '), false)
  check('空内容也不会多出空行', (fs.readFileSync(expectedDay, 'utf8').match(/^- /gm) ?? []).length, 2)

  clock.advance(DAY)
  await store.appendMemory('第二天的记忆')
  ok('跨天会新建文件', fs.existsSync(path.join(store.root, '2026-11', '2026-11-08.md')))
  check('旧文件没被改动', (fs.readFileSync(expectedDay, 'utf8').match(/^- /gm) ?? []).length, 2)

  await store.dispose()
}

group('记忆 · core 与当天分离 / 三分区')

{
  const dataDir = makeTmp('memory-core')
  const clock = createClock(START)
  const store = new MemoryStore({ dataDir, now: clock.now })

  await store.appendMemory('主人讨厌香菜', { shared: true })
  await store.appendMemory('主人是做嵌入开发的', { section: 'owner' })
  await store.appendMemory('茶茶决定以后少熬夜', { section: 'self' })
  await store.appendMemory('群里今天很热闹', { tag: '群 123' })
  await store.flush()

  ok('core.md 建出来了', fs.existsSync(store.corePath))
  const core = store.readCore()
  ok('core 里带三个分区标题', ['## 公用', '## 主人', '## 茶茶自己'].every((title) => core.includes(title)))
  ok('公用那条进 core', core.includes('主人讨厌香菜'))
  ok('主人那条进 core', core.includes('主人是做嵌入开发的'))
  ok('自己那条进 core', core.includes('茶茶决定以后少熬夜'))
  notOk('当天的事不写进 core', core.includes('群里今天很热闹'))

  const dayText = fs.readFileSync(store.dayPath(clock.value), 'utf8')
  ok('群里那条进当天日记', dayText.includes('群里今天很热闹'))
  notOk('core 的内容不重复写进当天', dayText.includes('主人讨厌香菜'))

  check('分区读得回来', store.readSection('shared').includes('主人讨厌香菜'), true)
  check('主人分区读得回来', store.readSection('owner').includes('主人是做嵌入开发的'), true)

  await rejects(
    '未知分区抛 TypeError',
    () => store.appendMemory('乱写', { section: '不存在的分区' }),
    '未知的记忆分区',
  )

  // buildContext：主人看得到三段，群友只看得到公用
  const ownerCtx = store.buildContext({ role: 'owner' })
  const guestCtx = store.buildContext({ role: 'guest' })
  ok('主人上下文有公用段', ownerCtx.includes('主人讨厌香菜'))
  ok('主人上下文有主人段', ownerCtx.includes('主人是做嵌入开发的'))
  ok('主人上下文有她自己那段', ownerCtx.includes('茶茶决定以后少熬夜'))
  ok('主人上下文有当天日记', ownerCtx.includes('群里今天很热闹'))
  ok('群友上下文只有公用段', guestCtx.includes('主人讨厌香菜'))
  notOk('群友看不到主人的私事', guestCtx.includes('主人是做嵌入开发的'))
  notOk('群友看不到她自己的心事', guestCtx.includes('茶茶决定以后少熬夜'))
  notOk('群友看不到当天日记', guestCtx.includes('群里今天很热闹'))

  check('分区可见性声明（公用：主人都能看到）', CORE_SECTIONS.find((item) => item.key === 'shared').visibility, [
    'owner',
    'guest',
  ])
  check('分区可见性声明（主人：只有 owner）', CORE_SECTIONS.find((item) => item.key === 'owner').visibility, ['owner'])

  const guide = store.renderGuide({ role: 'guest' })
  ok('约定里写明当天日记「只追加」', guide.includes('只追加'))
  ok('约定里写明月度摘要「只读」', guide.includes('只读'))
  ok('约定里写明三段分区', ['公用', '主人', '茶茶自己'].every((name) => guide.includes(name)))
  ok('群友那份约定提醒「看不到主人的私事」', guide.includes('只看得见**公用**'))

  await store.dispose()
}

group('记忆 · core.md 解析（含 v2 老格式迁移）')

{
  const oldFlat = '# 核心记忆\n\n- 主人叫阿明\n- 主人喜欢喝奶茶\n'
  check('v2 平铺 core → 整份算公用', parseCore(oldFlat).shared.trim(), '- 主人叫阿明\n- 主人喜欢喝奶茶')

  const modern = `# 核心记忆（core.md）

> 说明行不算内容

## 公用
- 公用的一条

## 主人
- 主人的一条

## 茶茶自己
- 她自己的一条
`
  const parsed = parseCore(modern)
  check('分区：公用', parsed.shared.trim(), '- 公用的一条')
  check('分区：主人', parsed.owner.trim(), '- 主人的一条')
  check('分区：自己', parsed.self.trim(), '- 她自己的一条')
  notOk('结构行（> 说明）不会被当成记忆注入', parsed.shared.includes('说明行不算内容'))
  notOk('HTML 注释不会被注入', parsed.shared.includes('<!--'))

  const inserted = insertIntoSection(modern, 'owner', '- 主人的第二条')
  check('插进主人段后，公用段没被影响', parseCore(inserted).shared.trim(), '- 公用的一条')
  check('插进主人段的两条都在', parseCore(inserted).owner.trim(), '- 主人的一条\n- 主人的第二条')
  check('分区顺序不乱', parseCore(inserted).self.trim(), '- 她自己的一条')

  const fromEmpty = insertIntoSection('', 'self', '- 第一条自己的记忆')
  ok('空文件也能建出分区骨架', fromEmpty.includes('## 茶茶自己') && fromEmpty.includes('第一条自己的记忆'))
  check('空文件建出来的自己段内容', parseCore(fromEmpty).self.trim(), '- 第一条自己的记忆')

  throws('insertIntoSection 未知分区抛错', () => insertIntoSection('', '不存在的分区', '- a'), '未知的记忆分区')

  check('clipText 不超限', clipText('字'.repeat(500), 100).length, 100)
  ok('clipText 超限时注明', clipText('字'.repeat(500), 100).includes('截断了'))
  check('clipText 没超限就原样', clipText('短内容', 100), '短内容')
}

// ==========================================================================
// 十、记忆：注入限制（截断）
// ==========================================================================

group('记忆 · 注入受 core 上限 / 最近几天限制')

{
  const dataDir = makeTmp('memory-inject')
  const clock = createClock(START)
  const store = new MemoryStore({
    dataDir,
    config: { injectCoreMaxChars: 2000, injectRecentDays: 3 },
    now: clock.now,
  })

  for (let i = 0; i < 5; i += 1) {
    await store.appendMemory(`day${i} 的记忆内容`, { at: clock.value - i * DAY })
  }
  await store.appendMemory('公用的一条很长的核心记忆', { shared: true })
  await store.flush()

  const ctx3 = store.buildContext({ role: 'owner' })
  ok('最近 3 天：day0 在', ctx3.includes('day0'))
  ok('最近 3 天：day1 在', ctx3.includes('day1'))
  ok('最近 3 天：day2 在', ctx3.includes('day2'))
  // ⚠️ 这里断言的是「**日记段**」不注入旧日子，不是「整篇上下文」里不出现 day3。
  //    v3.2 起 appendMemory 也会把内容写进 facts.jsonl，而 facts 是**按相关检索**的、
  //    不受 injectRecentDays 限制 —— 这正是主人要的「不按时间算」。
  //    所以只在日记段里查，才是这条断言真正想测的东西。
  const diarySection = (text) => {
    const from = text.indexOf('## 最近几天的记忆')
    if (from < 0) return ''
    const to = text.indexOf('## ', from + 1)
    return to < 0 ? text.slice(from) : text.slice(from, to)
  }
  const diary3 = diarySection(ctx3)
  notOk('超过 injectRecentDays 的日记不注入（day3）', diary3.includes('day3'))
  notOk('超过 injectRecentDays 的日记不注入（day4）', diary3.includes('day4'))
  ok('core 永远注入', ctx3.includes('公用的一条很长的核心记忆'))

  const tight = new MemoryStore({
    dataDir,
    config: { injectCoreMaxChars: 120, injectTotalMaxChars: 500 },
    now: clock.now,
  })
  await tight.appendMemory(`很长的核心记忆${'啊'.repeat(400)}`, { shared: true })
  await tight.flush()
  const tightCtx = tight.buildContext({ role: 'owner' })
  const coreSection = tightCtx.slice(tightCtx.indexOf('## 长期记忆'), tightCtx.indexOf('## 最近几天的记忆'))
  ok('core 超过 injectCoreMaxChars 会被截断', coreSection.includes('截断了'), coreSection)
  // 上限 120 字 + 标题 + 截断标记 + 可能夹一条 facts。给足余量：
  // 这条测的是「**受控**」（没有把 400 字的原文整段塞进来），不是精确字节数。
  ok('截断后 core 段长度受控', coreSection.length <= 300, coreSection.length)
  ok('总上下文不超过硬上限', tightCtx.length <= 500, tightCtx.length)

  const noDays = new MemoryStore({ dataDir, config: { injectRecentDays: 0 }, now: clock.now })
  // 同样只看日记段：facts 里有 day0 是**正确**的（按相关检索，不按时间）
  notOk('injectRecentDays=0 → 不注入日记', diarySection(noDays.buildContext({ role: 'owner' })).includes('day0 的记忆内容'))

  const wide = new MemoryStore({ dataDir, config: { injectTotalMaxChars: 200 }, now: clock.now })
  ok('整段记忆的硬上限是硬的（不撑爆上下文）', wide.buildContext({ role: 'owner' }).length <= 200)

  await store.dispose()
}

group('记忆 · 月度摘要与关闭开关')

{
  const dataDir = makeTmp('memory-summary')
  const clock = createClock(START)
  const store = new MemoryStore({ dataDir, now: clock.now })
  await store.appendMemory('今天记一条日记')
  await store.appendMemory('一条核心事实', { shared: true })
  check('摘要路径', store.summaryPath(clock.value), path.join(store.root, `summary-${monthStamp(clock.value)}.md`))
  check('摘要写成功', await store.writeSummary('这个月主人开始健身了', { month: monthStamp(clock.value) }), true)
  const ctx = store.buildContext({ role: 'owner' })
  ok('本月摘要会注入', ctx.includes('这个月的摘要') && ctx.includes('这个月主人开始健身了'))
  notOk('群友看不到摘要', store.buildContext({ role: 'guest' }).includes('这个月主人开始健身了'))

  const off = new MemoryStore({ dataDir, config: { enabled: false }, now: clock.now })
  check('memory.enabled=false → 不注入任何记忆', off.buildContext({ role: 'owner' }), '')

  const stats = store.stats()
  ok('stats 数得清天数', stats.days >= 1, stats)
  ok('stats 有 core 大小', stats.coreBytes > 0, stats)
  check('默认配置里有 recall 两项', [MEMORY_DEFAULTS.recallEnabled, MEMORY_DEFAULTS.recallMaxTokens], [true, 1200])

  await store.dispose()
}

// ==========================================================================
// 十一、记忆：原子写 / 并发
// ==========================================================================

group('记忆 · 并发写不互相踩 / 不留半截文件')

{
  const dataDir = makeTmp('memory-concurrent')
  const clock = createClock(START)
  const store = new MemoryStore({ dataDir, now: clock.now })

  const tasks = []
  for (let i = 0; i < 40; i += 1) tasks.push(store.appendMemory(`并发-${i}`))
  const results = await Promise.all(tasks)
  await store.flush()

  ok('40 条并发追加全部成功', results.every((item) => item === true), results.filter((item) => item !== true).length)
  const dayText = fs.readFileSync(store.dayPath(clock.value), 'utf8')
  check('40 条一条不少', (dayText.match(/^- /gm) ?? []).length, 40)
  check('标题没被重复写', (dayText.match(/^# /gm) ?? []).length, 1)
  ok('每条内容都在', [...Array(40).keys()].every((i) => dayText.includes(`并发-${i}`)))

  const coreTasks = []
  for (let i = 0; i < 15; i += 1) coreTasks.push(store.appendMemory(`核心并发-${i}`, { shared: true }))
  const ownerTasks = []
  for (let i = 0; i < 5; i += 1) ownerTasks.push(store.appendMemory(`主人并发-${i}`, { section: 'owner' }))
  await Promise.all([...coreTasks, ...ownerTasks])
  await store.flush()

  const core = store.readCore()
  const sections = parseCore(core)
  check('15 条核心并发都在公用段', (sections.shared.match(/^- /gm) ?? []).length, 15)
  check('5 条主人并发都在主人段', (sections.owner.match(/^- /gm) ?? []).length, 5)
  ok('公用段一条不少', [...Array(15).keys()].every((i) => sections.shared.includes(`核心并发-${i}`)))
  ok('主人段没被公用段串味', !sections.owner.includes('核心并发-0'))
  check('整个 memory/ 没有残留 .tmp', listFiles(store.root).filter((name) => name.endsWith('.tmp')), [])

  await store.dispose()
}

// ==========================================================================
// 十一（补）、装配层契约：config getter / 整份 config / 键名别名
// ==========================================================================

group('装配 · config getter / 整份 config / 键名别名')

{
  const clock = createClock(START)
  // 跟 index.js / pipeline.js 的真实传法一致：getter 返回整份 config（也有直接返回段的情况）
  const fullConfig = {
    emotion: {
      baseline: 85,
      moodHalfLifeHours: 1,
      feelingHalfLifeMinutes: 90,
      confidenceThreshold: 40,
      tellIt: 'mood-only',
    },
    memory: {
      injectCoreMaxChars: 2000,
      injectRecentDays: 3,
      injectMaxChars: 220,
      recallEnabled: true,
      recallMaxTokens: 60,
      recallScanDays: 1,
    },
  }

  const state = new EmotionState({ config: () => fullConfig, now: clock.now })
  check('getter + 整份 config：基线读到了（85）', state.get().mood, 85)
  state.apply({ moodDelta: 10, feelings: { happy: 10 }, reason: '被夸了', confidence: 50 }, clock.now())
  ok('confidenceThreshold 别名生效（50 分过了 40 的门槛）', state.takeInjection({ mode: 'event' }).length > 0)

  // 注意：基线 85 已经贴着「饱和线」（≥85 正向减半），测别名要换个不饱和的基线
  const decayState = new EmotionState({
    config: () => ({ emotion: { baseline: 70, moodHalfLifeHours: 1 } }),
    now: clock.now,
  })
  decayState.apply({ moodDelta: 10, feelings: { happy: 10 }, reason: '被夸了', confidence: 90 }, clock.now())
  clock.advance(HOUR)
  check('moodHalfLifeHours 别名生效（1 小时半衰：73 → 71.5；默认 3h 会是 72.38）', decayState.get().mood, 71.5)

  ok('buildJudgePrompt 也认整份 config（基线 85 带进提示词）',
    buildJudgePrompt({ speaker: 'owner', config: fullConfig }).includes('基线 85'))

  const dataDir = makeTmp('config-alias')
  const store = new MemoryStore({ dataDir, config: () => fullConfig, now: clock.now })
  for (let i = 0; i < 3; i += 1) await store.appendMemory(`很长的记忆${'啊'.repeat(200)}`)
  await store.appendMemory(`很长的核心${'啊'.repeat(200)}`, { shared: true })
  await store.flush()
  const ctx = store.buildContext({ role: 'owner' })
  ok('injectMaxChars 别名生效（整段记忆 ≤ 220）', ctx.length <= 220, ctx.length)
  ok('buildContext 接受 peerId（装配层这么传）', typeof store.buildContext({ role: 'owner', peerId: 'qq-group-1' }) === 'string')
  ok('appendMemory 签名 (text, {shared}) 照旧', await store.appendMemory('一条共享记忆', { shared: true }))

  const archiveDir = path.join(dataDir, 'archive')
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.writeFileSync(
    path.join(archiveDir, `${dayStamp(START - 3 * DAY)}.jsonl`),
    `${JSON.stringify({ sessionId: 's-old', at: START - 3 * DAY, text: '很久以前聊过恐龙' })}\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(archiveDir, `${dayStamp(START)}.jsonl`),
    `${JSON.stringify({ sessionId: 's-new', at: START, text: '今天聊了天气' })}\n`,
    'utf8',
  )
  const recall = new Recall({ dataDir, config: () => fullConfig, now: clock.now, log: null })
  check('recallScanDays 别名生效（只扫最近 1 天，恐龙翻不到）', await recall.recall({ question: '恐龙' }), '')
  ok('最近一天的还能翻到', (await recall.recall({ question: '天气' })).includes('天气'))

  await store.dispose()
}

// ==========================================================================
// 十二、跨会话回忆
// ==========================================================================

group('回忆 · 纯函数（token 估算 / 关键词 / 打分）')

check('estimateTokens：两个汉字 = 2', estimateTokens('你好'), 2)
check('estimateTokens：5 个字母 = 2', estimateTokens('hello'), 2)
check('estimateTokens：空串 = 0', estimateTokens(''), 0)
ok('clipToTokens 砍到预算内', estimateTokens(clipToTokens('字'.repeat(5000), 100)) <= 100)
ok('clipToTokens 砍了会注明', clipToTokens('字'.repeat(5000), 100).includes('已截断'))
check('clipToTokens 没超预算就原样', clipToTokens('短短一句', 100), '短短一句')

{
  const keywords = extractKeywords('主人上次说想吃火锅？')
  ok('关键词里有「火锅」', keywords.includes('火锅'))
  ok('关键词里有「主人」', keywords.includes('主人'))
  notOk('停用词不当关键词', keywords.includes('上次'))
  notOk('标点不会进关键词', keywords.some((word) => /[？?]/.test(word)))
  ok('英文停用词被过滤', !extractKeywords('the cookie').includes('the'))
}

{
  const now = START
  const fresh = { text: '主人想吃火锅', at: now - HOUR, source: 'archive' }
  const stale = { text: '主人想吃火锅', at: now - 30 * DAY, source: 'archive' }
  const irrelevant = { text: '群里在聊养猫', at: now - HOUR, source: 'archive' }
  ok(
    '同样命中关键词，新的分更高（时间衰减）',
    scoreFragment(fresh, ['火锅'], now, 7) > scoreFragment(stale, ['火锅'], now, 7),
  )
  check('关键词没命中就是 0 分（再新也不要）', scoreFragment(irrelevant, ['火锅'], now, 7), 0)
  ok(
    '没有关键词时退化成纯时间排序',
    scoreFragment(fresh, [], now, 7) > scoreFragment(stale, [], now, 7),
  )
}

group('回忆 · 无数据时降级')

{
  const dataDir = makeTmp('recall-empty')
  let calls = 0
  const recall = new Recall({
    dataDir,
    runSubagent: async () => {
      calls += 1
      return '不该被调用'
    },
    now: createClock(START).now,
  })
  check('没有数据 → 空串（不是抛错）', await recall.recall({ question: '主人上次说想吃什么？' }), '')
  check('没有数据就不该浪费子 Agent', calls, 0)

  const closed = new Recall({ dataDir, config: { recallEnabled: false }, now: createClock(START).now })
  check('recallEnabled=false → 空串', await closed.recall({ question: '随便问' }), '')
}

group('回忆 · 检索 + 子 Agent 复盘')

{
  const dataDir = makeTmp('recall-data')
  const clock = createClock(START)
  const archiveDir = path.join(dataDir, 'archive')
  fs.mkdirSync(archiveDir, { recursive: true })

  const oldDay = dayStamp(START - 2 * DAY)
  const today = dayStamp(START)
  fs.writeFileSync(
    path.join(archiveDir, `${oldDay}.jsonl`),
    [
      JSON.stringify({ sessionId: 's-other', at: START - 2 * DAY, groupId: '111', text: '主人说周末想去吃火锅' }),
      JSON.stringify({ sessionId: 's-current', at: START - 2 * DAY + 1000, groupId: '111', text: '火锅店要排队很久' }),
    ].join('\n') + '\n',
    'utf8',
  )
  fs.writeFileSync(
    path.join(archiveDir, `${today}.jsonl`),
    `${JSON.stringify({ sessionId: 's-other', at: START, groupId: '222', text: '群友在聊养猫的事情' })}\n`,
    'utf8',
  )

  // 记忆目录也参与检索
  const store = new MemoryStore({ dataDir, now: clock.now })
  await store.appendMemory('主人喜欢喝奶茶')
  await store.flush()

  let captured = ''
  const recall = new Recall({
    dataDir,
    now: clock.now,
    runSubagent: async (prompt) => {
      captured = prompt
      return '翻到了：主人之前说想吃火锅。'
    },
  })

  const hotpot = await recall.recall({ question: '主人想吃火锅' })
  check('子 Agent 的结果原样返回', hotpot, '翻到了：主人之前说想吃火锅。')
  ok('子 Agent 拿到的提示词包含问题', captured.includes('主人想吃火锅'))
  ok('子 Agent 拿到的提示词包含检索到的片段', captured.includes('主人说周末想去吃火锅'))
  ok('子 Agent 被要求不许编', captured.includes('不许编'))
  ok('提示词里带预算要求', captured.includes('token'))

  const catRecall = new Recall({ dataDir, now: clock.now })
  const cat = await catRecall.recall({ question: '养猫' })
  ok('能翻到别的会话的事', cat.includes('养猫'), cat)
  notOk('不相干的片段不会混进来', cat.includes('火锅'), cat)

  const milkTea = await catRecall.recall({ question: '奶茶' })
  ok('记忆目录也参与检索', milkTea.includes('主人喜欢喝奶茶'), milkTea)

  const excluded = await catRecall.recall({ question: '火锅店要排队', excludeSessionId: 's-current' })
  ok('排除掉的会话不进回忆', !excluded.includes('火锅店要排队很久'), excluded)
  ok('别的会话还在', excluded.includes('主人说周末想去吃火锅'), excluded)

  // 预算：子 Agent 写超了也要砍
  const longText = '很长的回忆内容'.repeat(800)
  const budgeted = new Recall({ dataDir, now: clock.now, runSubagent: async () => longText })
  const clipped = await budgeted.recall({ question: '火锅', budgetTokens: 120 })
  ok('产出不超过 budgetTokens', estimateTokens(clipped) <= 120, estimateTokens(clipped))
  ok('截断有注明', clipped.includes('已截断'), clipped.slice(-40))

  // 子 Agent 挂了 → 降级成原始片段，不能拖垮主流程
  const failing = new Recall({
    dataDir,
    now: clock.now,
    runSubagent: async () => {
      throw new Error('子 Agent 超时了')
    },
  })
  const fallback = await failing.recall({ question: '火锅' })
  ok('子 Agent 失败时降级成原始片段', fallback.includes('原始片段'), fallback)
  ok('降级结果里还有真内容', fallback.includes('主人说周末想去吃火锅'), fallback)

  const emptyAgent = new Recall({ dataDir, now: clock.now, runSubagent: async () => '' })
  const fallback2 = await emptyAgent.recall({ question: '火锅' })
  ok('子 Agent 返回空也降级', fallback2.includes('原始片段'), fallback2)

  // 没注入子 Agent 时直接用原始片段（Mind 层还没接上也不能崩）
  const noAgent = new Recall({ dataDir, now: clock.now })
  const rawDigest = await noAgent.recall({ question: '火锅', budgetTokens: 200 })
  ok('没有子 Agent 也能给出片段摘要', rawDigest.includes('主人说周末想去吃火锅'))

  await store.dispose()
}

group('回忆 · 空问题 / 不相关问题的降级')

{
  const dataDir = makeTmp('recall-question')
  fs.mkdirSync(path.join(dataDir, 'archive'), { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'archive', `${dayStamp(START)}.jsonl`),
    `${JSON.stringify({ sessionId: 's1', at: START, text: '群友在聊天气' })}\n`,
    'utf8',
  )
  const recall = new Recall({ dataDir, now: createClock(START).now })
  const emptyQuestion = await recall.recall({ question: '' })
  ok('空问题按时间给最近的片段', emptyQuestion.includes('群友在聊天气'), emptyQuestion)
  check('完全不相关的问题 → 空串（不硬凑）', await recall.recall({ question: '量子色动力学' }), '')
  check('预算非法值也能兜住', typeof (await recall.recall({ question: '天气', budgetTokens: -5 })), 'string')
}

// ==========================================================================
// 收尾
// ==========================================================================

cleanupTmp()
report('情绪 + 记忆 + 跨会话回忆')
