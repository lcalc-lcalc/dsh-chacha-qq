/**
 * 日程与当日状态（src/controller/life/）的测试套件。
 *
 * 跑法： cd E:\dsh-dev\dsh-chacha-qq-v3; node tests/life.mjs
 *
 * 这里要钉死的是 PLAN §3 的几条硬要求（不是「实现长什么样」）：
 *   ① 跨天：注入假 now，同一天第二次调用**不再调模型**；day 变了才重新生成
 *   ② work 模式不花钱：isOn('schedule') 为假时生成函数**一次都没被调用**
 *   ③ 生成结果校验：缺字段 / 时间倒序 / 只有 1 段 → 退回安全日程（不抛错）
 *   ④ 状态是合成视图：energy 累加 + clamp、moodBias 取最强、note 非空
 *   ⑤ 条件继承：带 endTs 的过了时间被清掉，没过期的跨天继承
 *   ⑥ 注入：companion 有内容，work 返回空串
 *
 * 约定：所有文件操作都在系统临时目录（fs.mkdtempSync），测完删干净 —— 绝不碰真实 data 目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { group, check, ok, notOk, report, seededRng } from './harness.mjs'

import {
  CONDITION_KINDS,
  ENERGY_MAX,
  ENERGY_MIN,
  LIFE_DEFAULTS,
  LifeState,
  MIN_VALID_SEGMENTS,
  SAFE_SCHEDULE,
  SCHEDULE_DEFAULTS,
  ScheduleBook,
  STATE_DEFAULTS,
  buildNote,
  buildSchedulePrompt,
  dayStamp,
  formatClock,
  hasCompanionSession,
  minutesOfDay,
  normalizeInjectMode,
  normalizeSegments,
  parseClock,
  parseScheduleOutput,
  resolveLifeConfig,
  resolveScheduleConfig,
  resolveStateConfig,
  safeSchedule,
  scheduleOnFor,
} from '../src/controller/life/index.js'

// --------------------------------------------------------------------------
// 测试脚手架
// --------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const DAY = 24 * HOUR

/** 本地时区的 2026-11-07 09:00 */
const DAY1 = new Date(2026, 10, 7, 9, 0, 0).getTime()
const DAY1_STAMP = '2026-11-07'
const DAY2_STAMP = '2026-11-08'
const DAY3_STAMP = '2026-11-09'

function createClock(start = DAY1) {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chacha-life-${prefix}-`))
  tmpRoots.push(dir)
  return dir
}

function listFiles(dir) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full).map((name) => path.join(entry.name, name)))
    else out.push(entry.name)
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

/** 一份「完全合法」的 6 段日程（测试里当生成函数的正常输出）。 */
function defaultPlan() {
  return [
    { time: '08:00', end: '09:00', activity: '在窗边晒太阳', mood: '安静', seed: '光落在键盘上' },
    { time: '10:00', end: '11:30', activity: '在写代码', mood: '专注', seed: '光标一闪一闪' },
    { time: '13:00', end: '13:45', activity: '弄吃的', mood: '轻快', seed: '锅里的水刚开' },
    { time: '15:00', end: '16:00', activity: '看动画', mood: '放松', seed: '外面的风很大' },
    { time: '18:00', end: '19:00', activity: '在群里潜水', mood: '安静', seed: '有人发了张猫的照片' },
    { time: '21:00', end: '22:00', activity: '收拾桌面', mood: '有点倦', seed: '屋里只留了一盏小灯' },
  ]
}

/** 计数假生成函数：`calls` 里是每次收到的入参（就是断言「有没有花钱」的依据）。 */
function makeGenerator(factory = defaultPlan) {
  const calls = []
  const generate = async (input) => {
    calls.push({ ...input })
    return typeof factory === 'function' ? factory(input) : factory
  }
  return { generate, calls }
}

/** life 配置：modes + life 段（键名跟 PLAN §3.2 / 任务书一致）。 */
function lifeConfig({ modes = { default: 'companion', peers: {} }, enabled = true, schedule = {}, state = {} } = {}) {
  return { modes, life: { enabled, schedule, state } }
}

const COMPANION_CONFIG = lifeConfig()
const WORK_PEER_CONFIG = lifeConfig({ modes: { default: 'companion', peers: { 'group-work': 'work' } } })

// ==========================================================================
// 一、纯函数：时间 / 时钟
// ==========================================================================

group('纯函数 · 时间戳与时钟')

check('dayStamp 用本地日期', dayStamp(DAY1), DAY1_STAMP)
check('dayStamp 在 0 点整还是前一天（跨天边界）', dayStamp(new Date(2026, 10, 7, 0, 0, 0).getTime()), DAY1_STAMP)
check('dayStamp 差一分钟就是新的一天', dayStamp(new Date(2026, 10, 8, 0, 0, 0).getTime()), DAY2_STAMP)
check('minutesOfDay：09:00 = 540', minutesOfDay(DAY1), 540)
check('minutesOfDay：00:00 = 0', minutesOfDay(new Date(2026, 10, 7, 0, 0, 0).getTime()), 0)
check('minutesOfDay：23:59 = 1439', minutesOfDay(new Date(2026, 10, 7, 23, 59, 0).getTime()), 1439)

check('parseClock：08:30', parseClock('08:30'), 8 * 60 + 30)
check('parseClock：8:30（一位小时）', parseClock('8:30'), 8 * 60 + 30)
check('parseClock：全角冒号', parseClock('08：30'), 8 * 60 + 30)
check('parseClock：00:00', parseClock('00:00'), 0)
check('parseClock：23:59', parseClock('23:59'), 23 * 60 + 59)
check('parseClock：24:00 不合法', parseClock('24:00'), null)
check('parseClock：08:60 不合法', parseClock('08:60'), null)
check('parseClock：乱写不合法', parseClock('早上八点'), null)
check('parseClock：空值不合法', parseClock(''), null)
check('formatClock：540', formatClock(540), '09:00')
check('formatClock：0', formatClock(0), '00:00')
check('formatClock：越界被夹住', formatClock(-5), '00:00')
check('formatClock：1440 被夹到 23:59', formatClock(1440), '23:59')

// ==========================================================================
// 二、日程校验：normalizeSegments
// ==========================================================================

group('日程 · 结果校验（不合格的丢掉，不抛错）')

{
  const out = normalizeSegments(defaultPlan())
  check('6 段合法的全部留下', out.length, 6)
  check('第一段时间', out[0].time, '08:00')
  check('end 原样保留', out[0].end, '09:00')
  check('activity 原文保留', out[0].activity, '在窗边晒太阳')
  check('mood / seed 保留', [out[0].mood, out[0].seed], ['安静', '光落在键盘上'])

  const missing = normalizeSegments([
    { time: '08:00', activity: '有时间的' },
    { activity: '缺时间的' },
    { time: '10:00' },
    { time: '11:00', activity: '   ' },
  ])
  check('缺 time 的丢掉', missing.length, 1)
  check('缺 activity 的丢掉', missing[0].activity, '有时间的')

  const reversed = normalizeSegments([
    { time: '10:00', activity: '后面的' },
    { time: '09:00', activity: '前面的' },
  ])
  check('时间倒序 → 只留严格递增的第一段', reversed.map((item) => item.time), ['10:00'])

  const repeated = normalizeSegments([
    { time: '09:00', activity: 'A' },
    { time: '09:00', activity: 'B' },
    { time: '09:30', activity: 'C' },
  ])
  check('重复时间只留第一条', repeated.map((item) => item.activity), ['A', 'C'])

  check('非数组 → 空（不抛错）', normalizeSegments('这不是数组'), [])
  check('null → 空', normalizeSegments(null), [])

  // end 的补法：模型经常漏 end / end 越过下一段
  const ends = normalizeSegments([
    { time: '08:00', activity: 'A' },
    { time: '10:00', end: '09:00', activity: 'B' },
    { time: '11:00', end: '12:30', activity: 'C' },
    { time: '14:00', activity: 'D' },
  ])
  check('缺 end → 接到下一段开始', ends[0].end, '10:00')
  check('end <= time → 接到下一段开始', ends[1].end, '11:00')
  check('正常 end 原样', ends[2].end, '12:30')
  check('最后一段缺 end → 默认一小时', ends[3].end, '15:00')

  const overrun = normalizeSegments([
    { time: '08:00', end: '09:30', activity: 'A' },
    { time: '09:00', end: '10:00', activity: 'B' },
  ])
  check('end 越过下一段开始 → 收在下一段开始', overrun[0].end, '09:00')

  const late = normalizeSegments([{ time: '23:30', activity: 'A' }])
  check('最后一段结束不超过 23:59', late[0].end, '23:59')

  check('时间超出 0:00~23:59 的丢掉', normalizeSegments([{ time: '24:00', activity: 'A' }]), [])
}

group('日程 · 解析模型输出（容错）')

{
  const fenced = parseScheduleOutput('```json\n[{"time":"08:00","activity":"在写东西"}]\n```')
  check('```json 围栏能剥', fenced.length, 1)
  check('围栏里的原字段', fenced[0].activity, '在写东西')

  const wrapped = parseScheduleOutput('{"date":"2026-11-07","segments":[{"time":"08:00","activity":"A"}]}')
  check('包了一层的 {segments:[…]} 也认', wrapped.length, 1)

  const prose = parseScheduleOutput('好的，这是今天的安排：\n[{"time":"08:00","activity":"A"}]\n希望合适。')
  check('前后有废话也能抠出数组', prose.length, 1)

  const trailing = parseScheduleOutput('[{"time":"08:00","activity":"A",}]')
  check('尾逗号也认', trailing.length, 1)

  check('空输入 → 空数组', parseScheduleOutput(''), [])
  check('纯文本 → 空数组', parseScheduleOutput('今天想休息'), [])

  const prompt = buildSchedulePrompt({ count: 7, date: DAY1_STAMP, persona: '主人叫阿明' })
  ok('提示词写明段数', prompt.includes('正好 7 段'), prompt.slice(0, 80))
  ok('提示词要求只输出 JSON 数组', prompt.includes('只输出一个 JSON 数组'))
  ok('提示词带上日期', prompt.includes(DAY1_STAMP))
  ok('提示词带人设', prompt.includes('阿明'))
  ok('提示词要求时间递增', prompt.includes('递增'))
  ok('提示词要求小意外', prompt.includes('小意外'))
}

// ==========================================================================
// 三、日程：每天只生成一次
// ==========================================================================

group('日程 · 每天只生成一次，当天不改')

{
  const clock = createClock(DAY1)
  const { generate, calls } = makeGenerator()
  const book = new ScheduleBook({ config: COMPANION_CONFIG, now: clock.now, generate })

  const first = await book.ensureToday({ peerKey: 'private-1' })
  check('第一次生成：段数按生成结果', first.length, 6)
  check('第一次确实调了生成函数', calls.length, 1)
  check('生成函数收到的段数', calls[0].count, SCHEDULE_DEFAULTS.segments)
  check('生成函数收到的日期', calls[0].date, DAY1_STAMP)

  const second = await book.ensureToday({ peerKey: 'private-1' })
  check('同一天第二次调用：不再调模型', calls.length, 1)
  check('同一天第二次调用：返回同一份日程', second, first)

  clock.advance(5 * HOUR)
  await book.ensureToday({ peerKey: 'private-1' })
  check('同一天晚上再用：还是不再调模型', calls.length, 1)
  check('缓存日期还是今天', book.date, DAY1_STAMP)

  // regenerateAllowed 默认 false：force 也不许改（防精神分裂）
  await book.ensureToday({ peerKey: 'private-1', force: true })
  check('默认不允许重生成：force 也无效', calls.length, 1)

  // 但配置显式打开以后，force 可以重生成（今天还是今天）
  const { generate: generate2, calls: calls2 } = makeGenerator()
  const openBook = new ScheduleBook({
    config: lifeConfig({ schedule: { regenerateAllowed: true } }),
    now: clock.now,
    generate: generate2,
  })
  await openBook.ensureToday({ peerKey: 'private-1' })
  await openBook.ensureToday({ peerKey: 'private-1', force: true })
  check('regenerateAllowed=true 时 force 会重生成', calls2.length, 2)
  check('重生成后还是同一天', openBook.date, DAY1_STAMP)
}

// ==========================================================================
// 四、日程：跨天
// ==========================================================================

group('日程 · 跨天重新生成（假 now 注入）')

{
  const clock = createClock(DAY1)
  const { generate, calls } = makeGenerator()
  const book = new ScheduleBook({ config: COMPANION_CONFIG, now: clock.now, generate })

  await book.ensureToday({ peerKey: 'private-1' })
  check('第一天生成一次', calls.length, 1)

  clock.set(new Date(2026, 10, 8, 9, 0, 0).getTime())
  const day2 = await book.ensureToday({ peerKey: 'private-1' })
  check('跨天后重新生成（调用 +1）', calls.length, 2)
  check('新生成收到的是新日期', calls[1].date, DAY2_STAMP)
  check('缓存日期换天了', book.date, DAY2_STAMP)
  check('新一天有自己的日程', day2.length, 6)

  clock.advance(60 * MINUTE)
  await book.ensureToday({ peerKey: 'private-1' })
  check('新一天的第二调用不再调模型', calls.length, 2)
}

group('日程 · generateAfter：过了这个点、当天第一次用到才生成')

{
  const clock = createClock(new Date(2026, 10, 7, 6, 0, 0).getTime())
  const { generate, calls } = makeGenerator()
  const book = new ScheduleBook({ config: COMPANION_CONFIG, now: clock.now, generate })

  const early = await book.ensureToday({ peerKey: 'private-1' })
  check('07:30 之前不生成（返回空）', early, [])
  check('07:30 之前一次模型调用都没有', calls.length, 0)

  clock.set(new Date(2026, 10, 7, 8, 0, 0).getTime())
  const late = await book.ensureToday({ peerKey: 'private-1' })
  check('过了生成点才生成', late.length, 6)
  check('过生成点后调用一次', calls.length, 1)

  // 凌晨那次不能留下「今天没日程」的缓存，不然 08:00 就永远不生成
  check('凌晨的空结果没有落盘', book.date, DAY1_STAMP)
}

{
  // generateAfter 写成空 / off = 不挡
  const clock = createClock(new Date(2026, 10, 7, 5, 0, 0).getTime())
  const { generate, calls } = makeGenerator()
  const book = new ScheduleBook({
    config: lifeConfig({ schedule: { generateAfter: '' } }),
    now: clock.now,
    generate,
  })
  const result = await book.ensureToday({ peerKey: 'private-1' })
  check('generateAfter 关掉后凌晨也能生成', result.length, 6)
  check('generateAfter 关掉后确实调了一次', calls.length, 1)
}

// ==========================================================================
// 五、日程：生成结果不合格 → 安全日程
// ==========================================================================

group('日程 · 生成失败 / 返回垃圾 → 安全日程（绝不抛错、绝不让它没日程）')

{
  const badCases = [
    { name: '缺 time', value: [{ activity: '只有活动名' }, { time: '09:00', activity: 'A' }] },
    { name: '时间倒序', value: [{ time: '10:00', activity: 'B' }, { time: '09:00', activity: 'A' }] },
    { name: '只有 1 段', value: [{ time: '09:00', activity: 'A' }] },
    { name: '空数组', value: [] },
    { name: 'null', value: null },
    { name: '字符串', value: '今天想休息' },
  ]

  for (const item of badCases) {
    const clock = createClock(DAY1)
    const book = new ScheduleBook({
      config: COMPANION_CONFIG,
      now: clock.now,
      generate: async () => item.value,
    })
    const plan = await book.ensureToday({ peerKey: 'private-1' })
    check(`生成结果不合格（${item.name}）→ 退回安全日程`, plan, safeSchedule())
  }

  // 生成函数直接抛错：不许把整条管线带崩
  const clock = createClock(DAY1)
  const throwing = new ScheduleBook({
    config: COMPANION_CONFIG,
    now: clock.now,
    generate: async () => {
      throw new Error('模型超时了')
    },
  })
  const recovered = await throwing.ensureToday({ peerKey: 'private-1' })
  check('生成函数抛错 → 安全日程', recovered, safeSchedule())
  check('抛错也落盘了（明天早上不用重新编）', throwing.date, DAY1_STAMP)

  // 根本没注入生成函数（Mind 还没接上）也不能没有日程
  const empty = new ScheduleBook({ config: COMPANION_CONFIG, now: clock.now })
  const fallback = await empty.ensureToday({ peerKey: 'private-1' })
  check('没注入生成函数 → 安全日程', fallback, safeSchedule())

  // 部分不合格：只丢坏的那几条，不整体作废
  const partial = new ScheduleBook({
    config: COMPANION_CONFIG,
    now: clock.now,
    generate: async () => [
      { time: '08:00', activity: 'A' },
      { time: '乱写', activity: 'B' },
      { time: '10:00', activity: 'C' },
      { time: '09:00', activity: 'D' },
      { time: '12:00', activity: 'E' },
    ],
  })
  const partialPlan = await partial.ensureToday({ peerKey: 'private-1' })
  check('坏的那几条丢掉，好的留下（不整体作废）', partialPlan.map((seg) => seg.activity), ['A', 'C', 'E'])

  ok('安全日程本身合法：6~8 段', SAFE_SCHEDULE.length >= 6 && SAFE_SCHEDULE.length <= 8, SAFE_SCHEDULE.length)
  ok(
    '安全日程时间递增',
    SAFE_SCHEDULE.every((seg, index) => index === 0 || parseClock(seg.time) > parseClock(SAFE_SCHEDULE[index - 1].time)),
  )
  ok('安全日程每段都有 activity', SAFE_SCHEDULE.every((seg) => String(seg.activity ?? '').trim().length > 0))
  ok('安全日程的 end 都晚于 time', SAFE_SCHEDULE.every((seg) => parseClock(seg.end) > parseClock(seg.time)))
  ok(
    '安全日程每段时长 30~90 分钟（契约）',
    SAFE_SCHEDULE.every((seg) => {
      const duration = parseClock(seg.end) - parseClock(seg.time)
      return duration >= 30 && duration <= 90
    }),
    SAFE_SCHEDULE.map((seg) => parseClock(seg.end) - parseClock(seg.time)),
  )
  ok(
    '安全日程段与段之间的空档 30~90 分钟（契约）',
    SAFE_SCHEDULE.every((seg, index) => {
      if (index === 0) return true
      const gap = parseClock(seg.time) - parseClock(SAFE_SCHEDULE[index - 1].end)
      return gap >= 30 && gap <= 90
    }),
    SAFE_SCHEDULE.map((seg, index) => (index === 0 ? 0 : parseClock(seg.time) - parseClock(SAFE_SCHEDULE[index - 1].end))),
  )
  ok('安全日程从起床覆盖到入睡前（08:00 起、22:30 前收）', parseClock(SAFE_SCHEDULE[0].time) <= 8 * 60 && parseClock(SAFE_SCHEDULE.at(-1).end) >= 22 * 60)
}

// ==========================================================================
// 六、⭐ work 模式不花钱（主人的核心诉求）
// ==========================================================================

group('⭐ 日程 · work 模式一次模型调用都不许发生')

{
  const clock = createClock(DAY1)
  const { generate, calls } = makeGenerator()
  const book = new ScheduleBook({ config: WORK_PEER_CONFIG, now: clock.now, generate })

  const workPlan = await book.ensureToday({ peerKey: 'group-work' })
  check('work 对话返回空日程', workPlan, [])
  check('⭐ work 对话生成函数一次都没被调用', calls.length, 0)
  check('work 对话连「今天有没有日程」都没落盘', book.date, '')

  // 另一个陪伴对话照样生成
  const companion = await book.ensureToday({ peerKey: 'private-1111111111' })
  check('同一个实例里陪伴对话正常生成', companion.length, 6)
  check('陪伴对话才真的调了模型', calls.length, 1)

  // 日程是全局一份：work 对话再进来时，缓存仍然在（但返回 []，不花一分钱）
  const again = await book.ensureToday({ peerKey: 'group-work' })
  check('work 对话仍返回空', again, [])
  check('work 对话没有触发第二次生成', calls.length, 1)
  check('日程是全局一份：work 对话读缓存也能看到', book.plan().length, 6)
}

{
  // 全局都是 work（没有 peerKey 的后台调用）：一次都不生成
  const clock = createClock(DAY1)
  const { generate, calls } = makeGenerator()
  const book = new ScheduleBook({
    config: lifeConfig({ modes: { default: 'work', peers: {} } }),
    now: clock.now,
    generate,
  })
  const plan = await book.ensureToday()
  check('全是 work 时后台预生成也返回空', plan, [])
  check('⭐ 全是 work 时一次模型调用都没有', calls.length, 0)
  check('hasCompanionSession 为假', hasCompanionSession(lifeConfig({ modes: { default: 'work', peers: {} } })), false)
}

{
  // 全局 work，但有一个陪伴对话：后台预生成值得做（她有生活）
  const clock = createClock(DAY1)
  const { generate, calls } = makeGenerator()
  const mixedConfig = lifeConfig({ modes: { default: 'work', peers: { 'private-1': 'companion' } } })
  const book = new ScheduleBook({ config: mixedConfig, now: clock.now, generate })

  check('混合模式：hasCompanionSession 为真', hasCompanionSession(mixedConfig), true)
  const plan = await book.ensureToday()
  check('混合模式：后台预生成会生成', plan.length, 6)
  check('混合模式：调用了一次', calls.length, 1)

  // 具体到某个 work 对话，仍然不许花
  const { generate: generate2, calls: calls2 } = makeGenerator()
  const book2 = new ScheduleBook({ config: mixedConfig, now: clock.now, generate: generate2 })
  check('work 对话不发钱', await book2.ensureToday({ peerKey: 'group-9' }), [])
  check('work 对话生成函数 0 次', calls2.length, 0)
}

{
  // isOn 这条规则本身（scheduleOnFor 是 modes.js 的薄包装，别在 life 里另写一套）
  ok('companion 对话 isOn 为真', scheduleOnFor('private-1', COMPANION_CONFIG))
  ok('work 对话 isOn 为假', !scheduleOnFor('group-work', WORK_PEER_CONFIG))
}

// ==========================================================================
// 七、日程：持久化 / 当天不改（重启也不改）
// ==========================================================================

group('日程 · 原子落盘 / 重启读回同一天不重生成')

{
  const dataDir = makeTmp('schedule')
  const clock = createClock(DAY1)
  const { generate, calls } = makeGenerator()
  const book = new ScheduleBook({ dataDir, config: COMPANION_CONFIG, now: clock.now, generate })
  const expectedPath = path.join(dataDir, 'life', 'schedule.json')
  check('日程文件路径 <dataDir>/life/schedule.json', book.path, expectedPath)

  const plan = await book.ensureToday({ peerKey: 'private-1' })
  ok('日程落盘了', fs.existsSync(expectedPath))
  const raw = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
  check('落盘结构：date', raw.date, DAY1_STAMP)
  check('落盘结构：segments', raw.segments.length, 6)
  check('落盘结构：generatedAt', raw.generatedAt, clock.value)
  check('只存 date/segments/generatedAt 三个键', Object.keys(raw).sort(), ['date', 'generatedAt', 'segments'])
  check('不留 .tmp', listFiles(path.join(dataDir, 'life')).filter((name) => name.endsWith('.tmp')), [])

  // 重启：新实例读回盘上的日程，同一天不许再调模型
  const { generate: generate2, calls: calls2 } = makeGenerator()
  const reloaded = new ScheduleBook({ dataDir, config: COMPANION_CONFIG, now: clock.now, generate: generate2 })
  check('重启后读回日期', reloaded.date, DAY1_STAMP)
  check('重启后读回日程', reloaded.plan(), plan)
  const reloadedPlan = await reloaded.ensureToday({ peerKey: 'private-1' })
  check('重启后同一天不再调模型', calls2.length, 0)
  check('重启后返回同一份日程', reloadedPlan, plan)

  // 盘上的文件坏了：不抛错，重新生成
  fs.writeFileSync(expectedPath, '这不是 JSON{{{', 'utf8')
  const { generate: generate3, calls: calls3 } = makeGenerator()
  const recovered = new ScheduleBook({ dataDir, config: COMPANION_CONFIG, now: clock.now, generate: generate3 })
  check('坏文件 → 当成没有，不抛错', recovered.date, '')
  const recoveredPlan = await recovered.ensureToday({ peerKey: 'private-1' })
  check('坏文件 → 重新生成', recoveredPlan.length, 6)
  check('坏文件 → 重新生成调了一次', calls3.length, 1)

  // 没给 dataDir：纯内存，不碰盘
  const memoryBook = new ScheduleBook({ config: COMPANION_CONFIG, now: clock.now, generate: () => defaultPlan() })
  check('没给 dataDir → 没有文件路径', memoryBook.path, '')
  check('纯内存也能生成', (await memoryBook.ensureToday({ peerKey: 'private-1' })).length, 6)
}

// ==========================================================================
// 八、日程：当前段 / 下一段 / 注入提示
// ==========================================================================

group('日程 · 当前段 / 下一段 / renderHint（只注入当前这一段）')

{
  const clock = createClock(new Date(2026, 10, 7, 10, 30, 0).getTime())
  const book = new ScheduleBook({
    config: COMPANION_CONFIG,
    now: clock.now,
    generate: async () => defaultPlan(),
  })
  await book.ensureToday({ peerKey: 'private-1' })

  const current = book.currentSegment()
  ok('10:30 正在「在写代码」那一段', current && current.activity === '在写代码', current)
  check('当前段的完整结构', current, {
    time: '10:00',
    end: '11:30',
    activity: '在写代码',
    mood: '专注',
    seed: '光标一闪一闪',
  })

  const next = book.nextSegment()
  ok('下一段是 13:00', next && next.time === '13:00', next)
  check('renderHint = 现在 + 等下', book.renderHint(), '现在在写代码，等下弄吃的')

  // 段与段之间的空档：没有「当前段」，但可以说「待会儿」
  clock.set(new Date(2026, 10, 7, 12, 0, 0).getTime())
  check('空档里没有当前段', book.currentSegment(), null)
  check('空档里给下一段', book.renderHint(), '待会儿（13:00 起）弄吃的')

  // 一天的事都过完了：不注入（省 token，也别把「今天结束了」当噪音）
  clock.set(new Date(2026, 10, 7, 23, 30, 0).getTime())
  check('今天过完：当前段为空', book.currentSegment(), null)
  check('今天过完：下一段为空', book.nextSegment(), null)
  check('今天过完：不注入提示', book.renderHint(), '')

  // 跨到第二天但还没刷新：昨天的日程不许当成今天的
  clock.set(new Date(2026, 10, 8, 10, 30, 0).getTime())
  check('第二天没刷新前：plan 为空（昨天的不能用）', book.plan(), [])
  check('第二天没刷新前：当前段为空', book.currentSegment(), null)
  check('第二天没刷新前：不注入提示', book.renderHint(), '')
}

// ==========================================================================
// 九、状态：合成视图（energy / moodBias / note）
// ==========================================================================

group('状态 · 合成视图（condition 现算，不是被改写的存储）')

{
  const clock = createClock(DAY1)
  const state = new LifeState({
    config: lifeConfig({ state: { energyBaseline: 75 } }),
    now: clock.now,
    rng: seededRng(3),
  })

  const base = state.get()
  ok('energy 是 10~100 的整数', Number.isInteger(base.energy) && base.energy >= ENERGY_MIN && base.energy <= ENERGY_MAX, base.energy)
  check('基线可配（75）', base.baseline, 75)
  ok('moodBias 是字符串', typeof base.moodBias === 'string' && base.moodBias.length > 0, base.moodBias)
  ok('note 非空', typeof base.note === 'string' && base.note.length > 0, base.note)
  check('默认配置下每天都有 sleep/hunger/mood 三条日抛', base.conditions.length >= 3, true)
  ok(
    '日抛项包含三种 kind',
    ['sleep', 'hunger', 'mood'].every((kind) => base.conditions.some((condition) => condition.kind === kind)),
    base.conditions.map((condition) => condition.kind),
  )
  ok(
    'condition 结构齐全（id/kind/title/mood/energyDelta/startTs/endTs/cause）',
    base.conditions.every(
      (condition) =>
        'id' in condition &&
        'kind' in condition &&
        'title' in condition &&
        'mood' in condition &&
        'energyDelta' in condition &&
        'startTs' in condition &&
        'endTs' in condition &&
        'cause' in condition,
    ),
  )

  // 现算：加一条就立刻反映，不需要「重新生成状态」
  const before = state.get().energy
  state.addCondition({ kind: 'health', title: '有点着凉', mood: '蔫蔫的', energyDelta: -20, cause: '昨晚窗户开着' })
  check('加一条 -20 的 condition，energy 立刻少 20', state.get().energy, Math.max(ENERGY_MIN, before - 20))

  // 强度最高的那条决定 moodBias
  check('moodBias 取强度最高那条', state.get().moodBias, '蔫蔫的')
  state.addCondition({ kind: 'mood', title: '想说话', mood: '轻快', energyDelta: 5 })
  check('加了更弱的一条，moodBias 不变', state.get().moodBias, '蔫蔫的')

  // clamp 下限
  for (let index = 0; index < 3; index += 1) {
    state.addCondition({ kind: 'sleep', title: '没睡好', mood: '有点倦', energyDelta: -40 })
  }
  check('energy 下限夹在 10', state.get().energy, ENERGY_MIN)
  ok('累到下限时 note 会说累', state.get().note.includes('累'), state.get().note)

  // clamp 上限
  for (let index = 0; index < 6; index += 1) {
    state.addCondition({ kind: 'mood', title: '精神很好', mood: '亮堂', energyDelta: 40 })
  }
  check('energy 上限夹在 100', state.get().energy, ENERGY_MAX)

  // 基线可配
  const baseline = new LifeState({
    config: lifeConfig({ state: { energyBaseline: 60 } }),
    now: clock.now,
    rng: seededRng(4),
  })
  check('energyBaseline 可配（60）', baseline.get().baseline, 60)
}

group('状态 · buildNote（一句话自我说明）')

check('基线附近：状态还行', buildNote({ energy: 75 }), '状态还行')
ok('累的时候会说可以短一点', buildNote({ energy: 30 }).includes('说话可以短一点'))
ok('精神好的时候鼓励多说', buildNote({ energy: 95 }).includes('精神不错'))
ok('moodBias 会拼进 note', buildNote({ energy: 75, moodBias: '安静' }).includes('心里安静'))
check('平稳不拼（不写成「心里平稳」这种废话）', buildNote({ energy: 75, moodBias: '平稳' }), '状态还行')
ok('塞垃圾也不炸', typeof buildNote({ energy: '不是数字', moodBias: null }) === 'string')

// ==========================================================================
// 十、状态：跨天（日抛重抽 / 带 endTs 继承）
// ==========================================================================

group('状态 · 跨天：同一天只生成一次')

{
  const dataDir = makeTmp('state-roll')
  const clock = createClock(DAY1)
  const { generate } = makeGenerator()
  const state = new LifeState({ dataDir, config: COMPANION_CONFIG, now: clock.now, rng: seededRng(7), generate })

  await state.ensureToday({ peerKey: 'private-1' })
  check('第一天结算出今日状态', state.status().day, DAY1_STAMP)
  const ids1 = state.get().conditions.map((condition) => condition.id)

  clock.advance(4 * HOUR)
  const idsSameDay = state.get().conditions.map((condition) => condition.id)
  check('同一天第二次读：不重抽（id 一模一样）', idsSameDay, ids1)
  check('同一天第二次读：day 没变', state.status().day, DAY1_STAMP)

  clock.set(new Date(2026, 10, 8, 9, 0, 0).getTime())
  state.get()
  check('跨天：generatedDay 换天', state.status().day, DAY2_STAMP)
  const ids2 = state.get().conditions.map((condition) => condition.id)
  notOk('跨天：日抛项重抽了（id 变了）', JSON.stringify(ids1) === JSON.stringify(ids2))
  ok(
    '跨天后仍然有 sleep/hunger/mood',
    ['sleep', 'hunger', 'mood'].every((kind) => state.get().conditions.some((condition) => condition.kind === kind)),
  )
  check('跨天：状态文件里也是新的一天', JSON.parse(fs.readFileSync(path.join(dataDir, 'life', 'state.json'), 'utf8')).generatedDay, DAY2_STAMP)
}

group('状态 · 带 endTs 的 condition 跨天继承，过期才清掉')

{
  const dataDir = makeTmp('state-inherit')
  const clock = createClock(DAY1)
  const state = new LifeState({ dataDir, config: COMPANION_CONFIG, now: clock.now, rng: seededRng(11) })

  // 感冒：第一天早上起，到第二天 12:00 才过期
  const health = state.addCondition({
    kind: 'health',
    title: '有点着凉',
    mood: '蔫蔫的',
    energyDelta: -8,
    endTs: DAY1 + 27 * HOUR,
    cause: '昨晚窗户开着睡的',
  })
  check('手动条件落在第一天', state.status().day, DAY1_STAMP)

  clock.set(new Date(2026, 10, 8, 9, 0, 0).getTime())
  const day2 = state.get()
  check('跨天：还没过期的 health 继承下来', day2.conditions.some((condition) => condition.id === health.id), true)
  check('跨天：继承的条件影响 energy（-8）', state.get().conditions.find((c) => c.id === health.id)?.energyDelta, -8)
  check('跨天：day 已切换', state.status().day, DAY2_STAMP)

  // 过了 endTs：视图里立刻消失
  clock.set(new Date(2026, 10, 8, 13, 0, 0).getTime())
  check('过了 endTs：get() 里不再出现', state.get().conditions.some((condition) => condition.id === health.id), false)

  // 下一个新的一天结算时，从存储里也清掉
  clock.set(new Date(2026, 10, 9, 9, 0, 0).getTime())
  state.ensureToday({ peerKey: 'private-1' })
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'life', 'state.json'), 'utf8'))
  check('跨天结算：过期条件从存储里清掉', raw.conditions.some((condition) => condition.id === health.id), false)
  check('跨天结算：日抛项还在', raw.conditions.length >= 3, true)
}

group('状态 · 持久化 / 坏文件容错')

{
  const dataDir = makeTmp('state-save')
  const clock = createClock(DAY1)
  const state = new LifeState({ dataDir, config: COMPANION_CONFIG, now: clock.now, rng: seededRng(13) })
  const expectedPath = path.join(dataDir, 'life', 'state.json')
  check('状态文件路径 <dataDir>/life/state.json', state.path, expectedPath)

  await state.ensureToday({ peerKey: 'private-1' })
  ok('状态落盘了', fs.existsSync(expectedPath))
  const raw = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
  check('落盘：generatedDay', raw.generatedDay, DAY1_STAMP)
  ok('落盘：conditions 是数组且非空', Array.isArray(raw.conditions) && raw.conditions.length >= 3)
  check('不留 .tmp', listFiles(path.join(dataDir, 'life')).filter((name) => name.endsWith('.tmp')), [])
  const before = state.get().conditions.map((condition) => condition.id)

  // 重启：读回同一天，不重抽
  const reloaded = new LifeState({ dataDir, config: COMPANION_CONFIG, now: clock.now, rng: seededRng(99) })
  check('重启后读回 day', reloaded.status().day, DAY1_STAMP)
  check('重启后读回同一批条件（没有重抽）', reloaded.get().conditions.map((condition) => condition.id), before)

  // 兼容任务书里的老键名 state_generated_day
  const legacyPath = path.join(dataDir, 'life', 'state.json')
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({
      state_generated_day: DAY1_STAMP,
      conditions: [{ id: 'old-1', kind: 'sleep', title: '老数据', mood: '安稳', energyDelta: -3, startTs: DAY1, endTs: null, cause: '' }],
    }),
    'utf8',
  )
  const legacy = new LifeState({ dataDir, config: COMPANION_CONFIG, now: clock.now, rng: seededRng(17) })
  check('兼容 state_generated_day 键名', legacy.status().day, DAY1_STAMP)
  check('兼容旧 condition 数据', legacy.get().conditions.some((condition) => condition.id === 'old-1'), true)

  // 坏文件：不抛错，重新结算
  fs.writeFileSync(legacyPath, '这不是 JSON{{{', 'utf8')
  const recovered = new LifeState({ dataDir, config: COMPANION_CONFIG, now: clock.now, rng: seededRng(19) })
  let recoveredDay = ''
  let recoveredError = null
  try {
    recoveredDay = recovered.status().day
  } catch (error) {
    recoveredError = error
  }
  check('坏文件 → 当成没有，不抛错', recoveredError, null)
  check('坏文件 → 重新结算出今天', recoveredDay, DAY1_STAMP)
  ok('坏文件 → 重新抽了今天的条件', recovered.get().conditions.length >= 3)

  // 没给 dataDir：纯内存
  const memory = new LifeState({ config: COMPANION_CONFIG, now: clock.now, rng: seededRng(21) })
  check('没给 dataDir → 没有文件路径', memory.path, '')
  ok('纯内存也能出状态', memory.get().note.length > 0)
}

// ==========================================================================
// 十一、注入：companion 有内容 / work 空串
// ==========================================================================

group('注入 · companion 有内容，work 返回空串')

{
  const dataDir = makeTmp('inject')
  const clock = createClock(new Date(2026, 10, 7, 10, 30, 0).getTime())
  const { generate } = makeGenerator()
  const state = new LifeState({
    dataDir,
    config: COMPANION_CONFIG,
    now: clock.now,
    rng: seededRng(23),
    generate,
  })
  await state.ensureToday({ peerKey: 'private-1' })

  const line = state.renderForMind({ mode: 'companion', peerKey: 'private-1' })
  ok('companion：有状态那句', line.includes('你今天的状态：'), line)
  ok('companion：带能量', line.includes('能量 '), line)
  ok('companion：有今天日程那句', line.includes('今天日程：'), line)
  ok('companion：日程是「现在这一段」', line.includes('今天日程：现在在写代码'), line)
  ok('companion：告诉她是底色别念出来', line.includes('不用念出来'))
  ok('companion：一句话（没有换行，省 token）', !line.includes('\n'), line)

  check('work：显式 mode 返回空串', state.renderForMind({ mode: 'work', peerKey: 'private-1' }), '')
  ok('work：状态照常维护（只记账不外露）', state.get().conditions.length >= 3)

  // ⚠️ 回归：at 显式传 null 时不许被 Number(null)=0 当成 1970（那会让「跨天」算成另一个世纪）
  await state.ensureToday({ peerKey: 'private-1', at: null })
  check('at 传 null 仍按 now() 算今天', state.status().day, DAY1_STAMP)
}

{
  // 全部 work：后台渲染也不许注入
  const clock = createClock(DAY1)
  const state = new LifeState({
    config: lifeConfig({ modes: { default: 'work', peers: {} } }),
    now: clock.now,
    rng: seededRng(25),
  })
  check('全局 work：不传 peerKey 也不注入', state.renderForMind(), '')
  check('全局 work：ensureToday 不生成日程', await state.ensureToday(), [])
}

{
  // work 对话用 work 配置，注入 / 生成都必须空
  const clock = createClock(DAY1)
  const { generate, calls } = makeGenerator()
  const state = new LifeState({ config: WORK_PEER_CONFIG, now: clock.now, rng: seededRng(27), generate })
  check('work 对话：ensureToday 返回空', await state.ensureToday({ peerKey: 'group-work' }), [])
  check('work 对话：生成函数 0 次', calls.length, 0)
  check('work 对话：renderForMind 空串', state.renderForMind({ peerKey: 'group-work' }), '')
  ok('work 对话：状态照常记账', state.get().conditions.length >= 3)
}

group('注入 · 总开关 / 注入口径 / 配置热改')

{
  const clock = createClock(DAY1)
  const { generate, calls } = makeGenerator()

  const off = new LifeState({
    config: lifeConfig({ enabled: false }),
    now: clock.now,
    rng: seededRng(29),
    generate,
  })
  check('life.enabled=false：不生成日程', await off.ensureToday({ peerKey: 'private-1' }), [])
  check('life.enabled=false：生成函数 0 次', calls.length, 0)
  check('life.enabled=false：不注入', off.renderForMind({ peerKey: 'private-1' }), '')

  const silent = new LifeState({
    config: lifeConfig({ state: { injectMode: 'off' } }),
    now: clock.now,
    rng: seededRng(31),
  })
  check('injectMode=off：不注入', silent.renderForMind({ peerKey: 'private-1' }), '')

  // 配置 getter 热改（面板改了立刻生效，不用重建实例）
  let current = lifeConfig()
  const live = new LifeState({ config: () => current, now: clock.now, rng: seededRng(33) })
  ok('热改前：注入有内容', live.renderForMind({ peerKey: 'private-1' }).length > 0)
  current = lifeConfig({ enabled: false })
  check('热改 enabled=false：立刻不注入', live.renderForMind({ peerKey: 'private-1' }), '')
  current = lifeConfig()
  ok('热改 enabled=true：又恢复了', live.renderForMind({ peerKey: 'private-1' }).length > 0)
}

// ==========================================================================
// 十二、配置默认值 / 归一化
// ==========================================================================

group('配置 · 默认值与归一化')

check('LIFE_DEFAULTS.enabled 默认开', LIFE_DEFAULTS.enabled, true)
check('LIFE_DEFAULTS.schedule.segments 默认 6', LIFE_DEFAULTS.schedule.segments, 6)
check('LIFE_DEFAULTS.schedule.generateAfter 默认 07:30', LIFE_DEFAULTS.schedule.generateAfter, '07:30')
check('LIFE_DEFAULTS.schedule.regenerateAllowed 默认 false', LIFE_DEFAULTS.schedule.regenerateAllowed, false)
check('LIFE_DEFAULTS.state.energyBaseline 默认 75', LIFE_DEFAULTS.state.energyBaseline, 75)
check('LIFE_DEFAULTS.state.injectMode 默认 companion-only', LIFE_DEFAULTS.state.injectMode, 'companion-only')
check('STATE_DEFAULTS 与 LIFE_DEFAULTS 一致', LIFE_DEFAULTS.state, STATE_DEFAULTS)
check('SCHEDULE_DEFAULTS 与 LIFE_DEFAULTS 一致', LIFE_DEFAULTS.schedule, SCHEDULE_DEFAULTS)
check('四种 condition kind', CONDITION_KINDS, ['sleep', 'hunger', 'health', 'mood'])
check('energy 边界', [ENERGY_MIN, ENERGY_MAX], [10, 100])
check('合法段数门槛 2', MIN_VALID_SEGMENTS, 2)

{
  // 缺配置 = 用默认（别让「没写这一项」把功能关掉）
  const resolved = resolveLifeConfig({})
  check('没配 life → enabled 默认开', resolved.enabled, true)
  check('没配 life → 段数默认 6', resolved.schedule.segments, 6)
  check('没配 life → 基线默认 75', resolved.state.energyBaseline, 75)

  // 传 life 段本身也认（装配层可能只传这一段）
  const segmentOnly = resolveLifeConfig({ enabled: true, schedule: { segments: 7 }, state: { energyBaseline: 68 } })
  check('只传 life 段：段数读到 7', segmentOnly.schedule.segments, 7)
  check('只传 life 段：基线读到 68', segmentOnly.state.energyBaseline, 68)

  // 段数夹在 6~8（契约：6~8 段，别做 10 段）
  check('段数 10 被夹到 8', resolveScheduleConfig({ life: { schedule: { segments: 10 } } }).segments, 8)
  check('段数 2 被夹到 6', resolveScheduleConfig({ life: { schedule: { segments: 2 } } }).segments, 6)
  check('段数非法值退回 6', resolveScheduleConfig({ life: { schedule: { segments: '很多段' } } }).segments, 6)

  // generateAfter 归一化
  check('generateAfter 07:30 → 450 分钟', resolveScheduleConfig({ life: { schedule: { generateAfter: '07:30' } } }).generateAfterMinutes, 450)
  check('generateAfter 乱写退回 07:30', resolveScheduleConfig({ life: { schedule: { generateAfter: '早上' } } }).generateAfterMinutes, 450)
  check('generateAfter off → 不挡', resolveScheduleConfig({ life: { schedule: { generateAfter: 'off' } } }).generateAfterMinutes, 0)

  // injectMode 归一化
  check('injectMode 乱写退回 companion-only', normalizeInjectMode('乱写'), 'companion-only')
  check('injectMode false → off', normalizeInjectMode(false), 'off')
  check('injectMode always 认', normalizeInjectMode('always'), 'always')
  check('energyBaseline 越界被夹', resolveStateConfig({ life: { state: { energyBaseline: 999 } } }).energyBaseline, 100)
}

{
  // 生成函数收到的段数按配置来
  const clock = createClock(DAY1)
  const { generate, calls } = makeGenerator()
  const book = new ScheduleBook({
    config: lifeConfig({ schedule: { segments: 8 } }),
    now: clock.now,
    generate,
  })
  await book.ensureToday({ peerKey: 'private-1' })
  check('配置 8 段 → 生成函数收到 8', calls[0].count, 8)

  const { generate: generate2, calls: calls2 } = makeGenerator()
  const book2 = new ScheduleBook({
    config: lifeConfig({ schedule: { segments: 1 } }),
    now: clock.now,
    generate: generate2,
  })
  await book2.ensureToday({ peerKey: 'private-1' })
  check('配置 1 段被夹到 6', calls2[0].count, 6)
}

// ==========================================================================
// 十三、生活日程 + 状态一起看（上层最可能的用法）
// ==========================================================================

group('联调 · ensureToday → renderForMind 一条龙')

{
  const dataDir = makeTmp('flow')
  const clock = createClock(new Date(2026, 10, 7, 10, 30, 0).getTime())
  const { generate, calls } = makeGenerator()
  const life = new LifeState({ dataDir, config: COMPANION_CONFIG, now: clock.now, rng: seededRng(37), generate })

  const plan = await life.ensureToday({ peerKey: 'private-1' })
  check('一条龙：日程生成', plan.length, 6)
  check('一条龙：只调一次模型', calls.length, 1)
  check('一条龙：当前段', life.currentSegment().activity, '在写代码')
  ok('一条龙：注入话同时有状态和日程', life.renderForMind({ mode: 'companion', peerKey: 'private-1' }).includes('你今天的状态：'))

  // 第二次（同一个对话）：不花钱
  await life.ensureToday({ peerKey: 'private-1' })
  check('一条龙：第二次不再调模型', calls.length, 1)

  // 面板快照
  const snapshot = life.status()
  check('快照：当天日期', snapshot.day, DAY1_STAMP)
  ok('快照：有条件', snapshot.conditions.length >= 3)
  check('快照：日程段数', snapshot.schedule.segments.length, 6)
  ok('快照：带当前状态', snapshot.live.energy >= ENERGY_MIN)

  life.dispose()
  check('dispose 后 ensureToday 返回空', await life.ensureToday({ peerKey: 'private-1' }), [])
}

// ==========================================================================
// 收尾
// ==========================================================================

cleanupTmp()
report('日程与当日状态')
