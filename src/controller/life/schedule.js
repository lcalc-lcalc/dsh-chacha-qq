/**
 * life/schedule.js —— 她今天的日程（v3.1 PLAN §3.2）。
 *
 * 主人的原话：
 *   「一天 0 点（后）只能改一次，防止精神分裂」
 *   「我可能有时候要她纯干活，加日程影响工作加大消耗，但是日程真非常好玩」
 *
 * 所以这个模块的边界很硬，四条都不许破：
 *   ① **生成要靠模型，但本模块不自己调模型** —— 上层注入 `generate({ count, date })`
 *      （用 Mind 跑一次）。这里只负责「今天要不要生成、要几段、收不收这份结果」。
 *      ≈ emotion.js 的分工：它也不调模型，只给提示词 + 状态机。
 *   ② **每天只生成一次** —— `life/schedule.json` 存 `{ date, segments, generatedAt }`；
 *      date 不是今天就重新生成，同一天无论被调用多少次都只读缓存（当天不改）。
 *   ③ **work 模式一次模型调用都不许发生** —— 在 ensureToday() 最前面 return []，
 *      连「今天有没有日程」都不看。这是主人的核心诉求：省消耗。
 *   ④ **生成失败不许把她搞成没日程** —— 校验不过就退回固定的安全日程，且绝不抛错。
 *
 * 为什么「日程是全局一份」而「注入是按对话判」：
 *   模式是按对话设的（modes.peers[peerKey]），可一天只该有一份日程 —— 两个群里的她
 *   说着两套「今天在干什么」就是精神分裂。所以生成是全局的，注入才是 per-peer 的。
 *
 * 时间一律走注入的 `now()`（跨天逻辑全靠它测）；随机不走 Math.random（这里其实不用随机）。
 * 所有文件 UTF-8 无 BOM；零外部依赖。
 */
import fs from 'node:fs'
import path from 'node:path'

import { isOn } from '../../modes.js'

// --------------------------------------------------------------------------
// 常量
// --------------------------------------------------------------------------

/** 契约：6~8 段，别做 10 段（段多了就成了流水账，也更容易自相矛盾）。 */
export const SCHEDULE_SEGMENT_MIN = 6
export const SCHEDULE_SEGMENT_MAX = 8

/**
 * 少于这么多**合格**段就整份作废、退回安全日程。
 * 1 段日程等于没有日程 —— 宁可要一份默认的，也不能让她「今天只有一件事」。
 */
export const MIN_VALID_SEGMENTS = 2

/** 生成结果最多收多少段（防一个抽风的模型扔回来几百段；正常 6~8）。 */
const MAX_KEPT_SEGMENTS = 24

/** 23:59 的分钟数（时间范围硬上限）。 */
const LAST_MINUTE = 23 * 60 + 59

/**
 * 默认配置。外面传进来的 `config.life.schedule` 会盖在上面。
 * 这三个键就是契约里的那三个（`segments` / `generateAfter` / `regenerateAllowed`），别自己发明新的。
 */
export const SCHEDULE_DEFAULTS = Object.freeze({
  /** 生成时请求几段（会被夹到 6~8） */
  segments: 6,
  /** 过了这个点、当天第一次用到才生成（凌晨别把一天的日程先编好） */
  generateAfter: '07:30',
  /** 当天生成后默认不再改；true 只是给「显式 force」开个口子，正常路径仍然不动它 */
  regenerateAllowed: false,
})

/**
 * 生成失败时用的固定安全日程。
 *
 * 为什么要有它：模型挂了/返回垃圾/根本没接上，都不该让她「今天什么都不干」——
 * 那比日程不准更像精神分裂。这份是手写的、必然合法的：8 段、覆盖 08:00~22:30、
 * 每段 40~90 分钟、段与段之间的空档也是 30~90 分钟。
 * 里面故意留了一段「小意外」（被弹窗打断），这是契约要求的「1~2 段小意外」的手写版。
 */
export const SAFE_SCHEDULE = Object.freeze(
  [
    { time: '08:00', end: '08:40', activity: '在窗边晒太阳，顺便醒神', mood: '安静', seed: '光落在键盘上，杯子还冒着热气' },
    { time: '09:10', end: '10:20', activity: '整理昨天聊过的笔记', mood: '踏实', seed: '翻到一句没回的话，想了想还是记下来' },
    { time: '10:50', end: '11:40', activity: '在厨房给自己弄点吃的', mood: '轻快', seed: '锅里的水刚开' },
    { time: '13:00', end: '13:45', activity: '被一个弹窗打断，顺手帮主人看了眼屏幕', mood: '毛毛躁躁', seed: '本来是要打盹的' },
    { time: '14:30', end: '16:00', activity: '在敲一小段代码，写写停停', mood: '专注', seed: '光标一闪一闪的' },
    { time: '16:30', end: '17:30', activity: '在群里潜着，看大家聊天', mood: '放松', seed: '有人发了张猫的照片' },
    { time: '19:00', end: '20:30', activity: '窝着看动画，看一集停一下', mood: '软软的', seed: '片尾曲有点好听' },
    { time: '21:30', end: '22:30', activity: '收拾桌面，准备窝起来', mood: '有点倦', seed: '屋里只留了一盏小灯' },
  ].map((segment) => Object.freeze(segment)),
)

/** 深拷贝一份安全日程（每次用新对象，免得调用方改了它把全局兜底弄脏）。 */
export function safeSchedule() {
  return SAFE_SCHEDULE.map((segment) => ({ ...segment }))
}

// --------------------------------------------------------------------------
// 小工具（纯函数）
// --------------------------------------------------------------------------

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/** 宽松取数：模型 / 旧数据什么都可能有，取不到就给 fallback，不抛错。 */
function toNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return fallback
  const found = value.match(/-?\d+(?:\.\d+)?/)
  return found ? Number(found[0]) : fallback
}

/** 收敛空白 + 截断：写进提示词/落盘的东西不能带换行。 */
function clipText(value, max) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? text.slice(0, max) : text
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on', '开'].includes(text)) return true
  if (['false', '0', 'no', 'off', '关'].includes(text)) return false
  return fallback
}

/**
 * 本地时区的「日」戳：YYYY-MM-DD。
 * ⚠️ 用本地日期而不是 UTC：主人在 +08:00，「今天几点起床」按北京时间算才像人。
 */
export function dayStamp(at = Date.now()) {
  const date = new Date(toNumber(at, Date.now()))
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 本地时区的「今天过了多少分钟」。 */
export function minutesOfDay(at = Date.now()) {
  const date = new Date(toNumber(at, Date.now()))
  if (Number.isNaN(date.getTime())) return 0
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * 把 "08:30" / "8:30" / "08：30" 解析成分钟数（0~1439）。
 * 不合法返回 null —— 校验日程时这一条就是「时间字段合格」的判据。
 */
export function parseClock(text) {
  if (typeof text === 'number' && Number.isFinite(text)) {
    return clamp(Math.round(text), 0, LAST_MINUTE)
  }
  const value = String(text ?? '').trim()
  const matched = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(value)
  if (!matched) return null
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

/** 分钟数 → "HH:MM"（越界会被夹住，永远不会输出 24:xx）。 */
export function formatClock(minutes) {
  const total = clamp(Math.round(toNumber(minutes, 0)), 0, LAST_MINUTE)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * 校验 + 归一化模型给的日程。
 *
 * 契约：「段必须有 time/activity，时间必须递增且在 0:00~23:59 内，不合格的丢掉」。
 * 这里**只做这三条硬校验**，外加把缺失/越界的 `end` 补好（模型经常漏 end）：
 *   · 缺 time / time 解析不出来 → 丢
 *   · 缺 activity（或全是空白）→ 丢
 *   · time 没比上一段严格大（倒序 / 重复）→ 丢
 *   · `end` 缺失、<= time、或越过下一段开始 → 接到下一段开始（最后一段默认一小时，封顶 23:59）
 *
 * ⚠️ 这里**不**要求凑满 6~8 段，也不按 30~90 分钟的间隔卡：
 *    模型只是「排日程」，不是「填表」，为了格式漂亮丢掉一条真内容反而更糟。
 *    段数不够（< MIN_VALID_SEGMENTS）由 ensureToday() 整体退回安全日程，那才是该管的地方。
 *
 * @param {unknown} input 模型输出（数组；不是数组一律当空）
 * @returns {Array<{time:string, end:string, activity:string, mood:string, seed:string}>}
 */
export function normalizeSegments(input) {
  const list = Array.isArray(input) ? input : []
  const kept = []
  let lastStart = -1

  for (const item of list) {
    if (kept.length >= MAX_KEPT_SEGMENTS) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const start = parseClock(item.time)
    if (start === null) continue
    const activity = clipText(item.activity, 60)
    if (!activity) continue
    // ⚠️ 严格递增：相等也算不合格（同一分钟两件事，她又不是分身）
    if (start <= lastStart) continue

    kept.push({
      start,
      end: parseClock(item.end),
      activity,
      mood: clipText(item.mood, 12),
      seed: clipText(item.seed, 40),
    })
    lastStart = start
  }

  for (let index = 0; index < kept.length; index += 1) {
    const current = kept[index]
    const nextStart = index + 1 < kept.length ? kept[index + 1].start : null
    let end = current.end
    if (end === null || end <= current.start) {
      end = nextStart ?? Math.min(current.start + 60, LAST_MINUTE)
    }
    if (nextStart !== null && end > nextStart) end = nextStart
    current.end = clamp(end, current.start + 1, LAST_MINUTE)
  }

  return kept.map((item) => ({
    time: formatClock(item.start),
    end: formatClock(item.end),
    activity: item.activity,
    mood: item.mood,
    seed: item.seed,
  }))
}

// --------------------------------------------------------------------------
// ① 怎么问：给上层跑 Mind 用的提示词（可选，但建议用）
// --------------------------------------------------------------------------

/**
 * 生成日程的提示词。
 *
 * 本模块不调模型，所以这个函数是「免费送」的：上层拿它去跑一次 Mind，
 * 再把输出喂给 `parseScheduleOutput()`，就能保证格式和 normalizeSegments 对得上。
 * 上层想自己写提示词也行（契约只要求生成函数返回 Segment[]）。
 *
 * @param {object} [options]
 * @param {number} [options.count] 段数（6~8）
 * @param {string} [options.date]  今天（YYYY-MM-DD）
 * @param {string} [options.persona] 她的人设/称呼，原样塞进去
 * @returns {string}
 */
export function buildSchedulePrompt({ count = SCHEDULE_DEFAULTS.segments, date = '', persona = '' } = {}) {
  const total = clamp(Math.round(toNumber(count, SCHEDULE_DEFAULTS.segments)), MIN_VALID_SEGMENTS, MAX_KEPT_SEGMENTS)
  const who = String(persona ?? '').trim()

  return `你是「茶茶酱」，一只住在主人电脑里、在 QQ 上跟人聊天的猫系少女。${who ? `\n${who}` : ''}

请给**今天（${date || '今天'}）**编一份日程。这不是任务清单，是「她今天大概在过日子」的轮廓。

## 规则（一条都不许漏）
1. 正好 ${total} 段，从早上起床排到睡前（大约 07:30 ~ 23:30），\`time\` 必须**递增**，格式 HH:MM（24 小时制，0:00~23:59）。
2. 每段有 \`end\`，一段活动 30~90 分钟；相邻两段的空档也在 30~90 分钟之间 —— 她不是连轴转的机器，但空档也别长到一下午。
3. \`activity\` 写一句具体的生活动作（15 字内），像「在咖啡厅写东西」「收拾桌面」「窝着看动画」；
   ⛔ 不写工作汇报、不写天气、不写生理期、不写「提醒主人」之类的事 —— 她只是过自己的日子。
4. 其中 1~2 段是「小意外」：临时被打断、被叫走、计划没成（直接写进 activity，不要解释）。
5. \`mood\` 两三个字（安静 / 轻快 / 有点倦 / 毛毛躁躁），\`seed\` 是这一刻的一个具体细节（10~20 字，比如「刚坐下，杯子还是烫的」）。
6. ⛔ 不写日期、不写星期。

## 输出格式
**只输出一个 JSON 数组**，不要 markdown 代码块、不要任何解释文字：
[{"time":"08:30","end":"10:00","activity":"在咖啡厅写东西","mood":"安静","seed":"刚坐下，杯子还是烫的"}]

一共 ${total} 段。`
}

/** 剥掉模型爱加的 ``` 围栏。 */
function stripFence(text) {
  const value = String(text ?? '').trim()
  const fenced = value.match(/```[a-zA-Z]*\s*([\s\S]*?)```/)
  return fenced ? fenced[1].trim() : value
}

/** 宽松解析：先原样，再抠第一个 [ 到最后一个 ]，最后顺手修尾逗号。 */
function parseLooseJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const candidates = [raw]
  const first = raw.indexOf('[')
  const last = raw.lastIndexOf(']')
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // 试下一个
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'))
    } catch {
      // 试下一个
    }
  }
  return null
}

/**
 * 解析模型输出 → 段数组（**不保证合格**，合格判定在 normalizeSegments）。
 * 容忍：```json 围栏、前后废话、`{ "segments": [...] }` 这种包了一层的写法、尾逗号。
 *
 * @param {string} text 模型原样输出
 * @returns {Array<object>} 解析不出来就是 []
 */
export function parseScheduleOutput(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return []
  const stripped = stripFence(raw)
  const candidates = [stripped]
  const first = stripped.indexOf('[')
  const last = stripped.lastIndexOf(']')
  if (first >= 0 && last > first) candidates.push(stripped.slice(first, last + 1))

  for (const candidate of candidates) {
    const parsed = parseLooseJson(candidate)
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') {
      // 有的模型会给 {"date":"…","segments":[...]}，多包一层也认
      for (const key of ['segments', 'plan', 'schedule', 'day']) {
        if (Array.isArray(parsed[key])) return parsed[key]
      }
    }
  }
  return []
}

// --------------------------------------------------------------------------
// ② 配置与模式（schedule 和 state 共用这几只读法，所以放在这里）
// --------------------------------------------------------------------------

/** 整个 config 可能是对象、也可能是 getter（面板热改要立刻生效，不能传快照）。 */
export function readRootConfig(config) {
  let raw = config
  if (typeof config === 'function') {
    try {
      raw = config()
    } catch {
      raw = null
    }
  }
  return raw && typeof raw === 'object' ? raw : {}
}

/**
 * 从「整份 config」里取 life 段；如果传进来的本来就是 life 段，就原样用。
 * 兼容三种传法（装配层的写法不统一，别让字段名把功能悄悄关掉）：
 *   1. 整份 config：{ life: {...}, modes: {...}, mind: {...} }
 *   2. life 段本身：{ enabled, schedule, state }
 *   3. getter：() => store.get()
 */
export function readLifeSegment(config) {
  const root = readRootConfig(config)
  const life = root.life
  return life && typeof life === 'object' && !Array.isArray(life) ? life : root
}

/** life 总开关（work/companion 之外的那一道：主人可能整个关掉）。 */
export function lifeEnabled(config) {
  return readLifeSegment(config).enabled !== false
}

/** modes 段（安全取；没配就是 {}，resolveMode 会当 companion 处理）。 */
export function readModes(config) {
  const root = readRootConfig(config)
  return root.modes && typeof root.modes === 'object' && !Array.isArray(root.modes) ? root.modes : {}
}

/**
 * 「这个对话里要不要生成/注入日程」。
 * 直接用 modes.js 的 isOn：work → false（生成前就必须挡住，不是生成了再藏起来）。
 */
export function scheduleOnFor(peerKey, config) {
  return isOn('schedule', peerKey, { modes: readModes(config) })
}

/**
 * 全局还有没有「陪伴」对话。
 *
 * 只在调用方没给 peerKey（后台 tick / 预热）时用：日程是全局一份，
 * 只要还有一个陪伴对话，就值得给她生成一天；全都是 work 就一次都不生成。
 * 口径跟 modes.js 保持一致：default 缺省 = companion，只有明确写 'work' 才算纯干活。
 */
export function hasCompanionSession(config) {
  const modes = readModes(config)
  const peers = modes.peers && typeof modes.peers === 'object' ? modes.peers : {}
  for (const value of Object.values(peers)) {
    if (value === 'companion') return true
  }
  return modes.default !== 'work'
}

/**
 * 归一化 life.schedule 段。返回的都是可直接用的数值，调用方不用再判空。
 * @returns {{enabled:boolean, segments:number, generateAfter:string, generateAfterMinutes:number, regenerateAllowed:boolean}}
 */
export function resolveScheduleConfig(config) {
  const life = readLifeSegment(config)
  const raw = life.schedule && typeof life.schedule === 'object' && !Array.isArray(life.schedule) ? life.schedule : {}

  const segments = clamp(
    Math.round(toNumber(raw.segments ?? SCHEDULE_DEFAULTS.segments, SCHEDULE_DEFAULTS.segments)),
    SCHEDULE_SEGMENT_MIN,
    SCHEDULE_SEGMENT_MAX,
  )
  const generateAfterMinutes = normalizeGenerateAfter(raw.generateAfter ?? SCHEDULE_DEFAULTS.generateAfter)

  return {
    enabled: lifeEnabled(config),
    segments,
    generateAfter: formatClock(generateAfterMinutes),
    generateAfterMinutes,
    regenerateAllowed: toBoolean(raw.regenerateAllowed, SCHEDULE_DEFAULTS.regenerateAllowed),
  }
}

/**
 * generateAfter 的三种写法：
 *   · "HH:MM"          → 过了这个点才生成（默认 07:30）
 *   · "" / null / false / "off" / "always" → 0（不挡，随时可生成）
 *   · 乱写 → 退回默认 07:30（别因为一个字段写错就变成「凌晨就开始编日程」）
 */
function normalizeGenerateAfter(value) {
  if (value === null || value === false) return 0
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '' || text === 'off' || text === 'none' || text === 'always') return 0
  const parsed = parseClock(text)
  if (parsed !== null) return parsed
  return parseClock(SCHEDULE_DEFAULTS.generateAfter) ?? 0
}

// --------------------------------------------------------------------------
// ③ 原子写盘（state.js 也用这一份，别写两套行为）
// --------------------------------------------------------------------------

/**
 * 原子写：先写 `.tmp` 再 rename。半截文件会让「今天有没有日程」直接读崩。
 * 失败（杀毒软件占着文件之类）再退化成直接覆盖写 —— 少一层原子性，比丢数据好。
 *
 * @param {string} file 目标路径
 * @param {object|string} payload 对象会 stringify（2 空格缩进，方便主人手改）
 * @param {object} [log] 日志器（有 warn 就记）
 * @returns {boolean}
 */
export function writeJsonAtomic(file, payload, log = null) {
  if (!file) return false
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (error) {
    log?.warn?.(`日程/状态落盘失败（${file}）：${error?.message ?? error}`)
    try {
      fs.writeFileSync(file, text, 'utf8')
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // 清不掉 tmp 不影响主流程
      }
      return true
    } catch {
      return false
    }
  }
}

// --------------------------------------------------------------------------
// ④ 日程簿：全局一份，按天缓存
// --------------------------------------------------------------------------

/**
 * 她今天的日程。全局一份（不是每个对话各一份），落盘在 `<dataDir>/life/schedule.json`。
 *
 * @example
 *   const book = new ScheduleBook({
 *     dataDir,
 *     config: () => store.get(),              // ⚠️ 传整份 config（要读 modes）；life 段也认
 *     generate: async ({ count, date }) => {  // 上层用 Mind 跑一次
 *       const reply = await mind.ask({ ... text: buildSchedulePrompt({ count, date }) })
 *       return parseScheduleOutput(reply.text)
 *     },
 *   })
 *   await book.ensureToday({ peerKey: 'private-1111111111' })
 *   book.renderHint()   // "现在在咖啡厅写东西，等下在写代码"
 */
export class ScheduleBook {
  /**
   * @param {object} options
   * @param {string} [options.dataDir] 数据目录（存储 `<dataDir>/life/schedule.json`）；不给 = 纯内存
   * @param {object|Function} [options.config] 整份 config 或 life 段，或返回它们的 getter
   * @param {object|Function} [options.modes] 可选：单独给 modes 段（config 只传 life 段时用）
   * @param {object} [options.log] 日志器
   * @param {() => number} [options.now] 时间注入（毫秒）
   * @param {(input: {count:number, date:string, now:number}) => Promise<Array<object>>} [options.generate]
   *   生成函数：**本模块不调模型**，由上层注入。返回 Segment[] 或任何东西（会被校验）。
   */
  constructor({ dataDir = '', config = {}, modes = null, log = null, now = () => Date.now(), generate = null } = {}) {
    this.dataDir = String(dataDir || '')
    this.config = config
    this.modes = modes
    this.log = log
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.generate = typeof generate === 'function' ? generate : null
    this.file = this.dataDir ? path.join(this.dataDir, 'life', 'schedule.json') : ''
    this.state = { date: '', segments: [], generatedAt: 0 }
    this.disposed = false
    this.#load()
  }

  /** 持久化文件路径（没给 dataDir 就是空串）。 */
  get path() {
    return this.file
  }

  /** 当前缓存的是哪一天的日程（'' = 还没生成过）。 */
  get date() {
    return this.state.date
  }

  #inflight = null

  /** 生成中（并发合并用，面板/测试可看）。 */
  get generating() {
    return Boolean(this.#inflight)
  }

  /**
   * 今天的日程（**只读缓存，不触发生成**）。
   * 缓存不是今天的就返回 [] —— 昨天的日程不能拿来当今天用。
   *
   * @param {number} [at] 现在
   * @returns {Array<object>}
   */
  plan(at = this.now()) {
    const today = dayStamp(at)
    if (!today || this.state.date !== today) return []
    return this.state.segments.map((segment) => ({ ...segment }))
  }

  /**
   * 跨天结算 + 按需生成。**这是唯一会调用生成函数的地方。**
   *
   * 顺序（一步都不能换）：
   *   ① life 整体关掉 → []
   *   ② work 模式 → []（连缓存都不碰，更不会调模型 —— 主人最在意的一条）
   *   ③ 今天已经有日程 → 直接返回（当天不改）
   *   ④ 还没到 generateAfter → []（凌晨不为晚上编日程）
   *   ⑤ 并发合并后调用 generate()，校验不过退安全日程
   *
   * @param {object} [options]
   * @param {string} [options.peerKey] 当前对话（'private-123' / 'group-456'）；不给 = 后台预生成
   * @param {boolean} [options.force] 强制重生成（还要 regenerateAllowed 为 true 才真的动）
   * @returns {Promise<Array<object>>}
   */
  async ensureToday({ peerKey = '', force = false } = {}) {
    if (this.disposed) return []

    const cfg = this.#cfg()
    if (!cfg.enabled) return []

    const peer = String(peerKey ?? '').trim()
    const modes = this.#modesConfig()

    // ① 按对话判：work → 一次模型调用都不许发生。
    if (peer) {
      if (!isOn('schedule', peer, { modes })) return []
    } else if (!hasCompanionSession({ modes })) {
      // ② 不知道是哪个对话（后台 tick）：所有对话都是 work 时，全局日程也一次都不生成。
      return []
    }

    const at = this.now()
    const today = dayStamp(at)
    if (!today) return []

    // ③ 当天已经生成过：默认不再改（主人的原话：当天只能改一次，防止精神分裂）。
    if (this.state.date === today && this.state.segments.length > 0) {
      if (!(force && cfg.regenerateAllowed)) return this.plan(at)
    } else if (!force && minutesOfDay(at) < cfg.generateAfterMinutes) {
      // ④ 还没到生成点（过了这个点、当天第一次用到才生成）。
      return []
    }

    // ⑤ 并发合并：同一时刻两个对话都要日程，也只跑一次模型。
    if (this.#inflight) return this.#inflight
    this.#inflight = this.#generate(today, at).finally(() => {
      this.#inflight = null
    })
    return this.#inflight
  }

  /**
   * 现在这一段（[time, end) 覆盖当前分钟才算）。
   * @param {number} [at]
   * @returns {object|null}
   */
  currentSegment(at = this.now()) {
    const list = this.state.date === dayStamp(at) ? this.state.segments : []
    const minute = minutesOfDay(at)
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const segment = list[index]
      const start = parseClock(segment.time)
      if (start === null) continue
      const end = parseClock(segment.end)
      const stop = end !== null && end > start ? end : start + 1
      if (minute >= start && minute < stop) return { ...segment }
    }
    return null
  }

  /** 现在之后的下一段（当前段还没结束就是它后面那段）。 */
  nextSegment(at = this.now()) {
    const list = this.state.date === dayStamp(at) ? this.state.segments : []
    const minute = minutesOfDay(at)
    for (const segment of list) {
      const start = parseClock(segment.time)
      if (start !== null && start > minute) return { ...segment }
    }
    return null
  }

  /**
   * 注入给 Mind 的一句「她此刻在干什么」。
   *
   * PLAN §3.2：只注入当前这一段 + 下一段的开头，不整份注入（省 token）。
   * 今天的事都过完了就返回空串 —— 别让「今天没安排」变成每轮都出现的一句废话。
   *
   * @param {number} [at]
   * @returns {string}
   */
  renderHint(at = this.now()) {
    if (this.state.date !== dayStamp(at)) return ''
    const current = this.currentSegment(at)
    const next = this.nextSegment(at)
    if (current) {
      const activity = String(current.activity ?? '').trim()
      if (!activity) return ''
      const tail = next && next.activity ? `，等下${next.activity}` : ''
      return `现在${activity}${tail}`
    }
    if (next && next.activity) return `待会儿（${next.time} 起）${next.activity}`
    return ''
  }

  /** 状态快照（面板用）。 */
  status() {
    return {
      date: this.state.date,
      generatedAt: this.state.generatedAt,
      segments: this.plan(),
      generating: this.generating,
      path: this.file,
    }
  }

  /** 落盘（原子写）。 */
  save() {
    if (!this.file) return false
    return writeJsonAtomic(this.file, {
      date: this.state.date,
      segments: this.state.segments,
      generatedAt: this.state.generatedAt,
    }, this.log)
  }

  /** 没别的资源要放，但要让上层能按契约收尾（concurrency 里的 in-flight 结果会被丢掉）。 */
  dispose() {
    this.disposed = true
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  #cfg() {
    return resolveScheduleConfig(this.config)
  }

  #modesConfig() {
    if (this.modes) {
      try {
        const value = typeof this.modes === 'function' ? this.modes() : this.modes
        if (value && typeof value === 'object') return value
      } catch {
        // modes getter 抛错就当没配
      }
    }
    return readModes(this.config)
  }

  /** 真的去生成：调注入的 generate → 校验 → 不够就安全日程 → 落盘。**绝不抛错**。 */
  async #generate(date, at) {
    const cfg = this.#cfg()
    let segments = []

    if (this.generate) {
      try {
        const raw = await this.generate({ count: cfg.segments, date, now: at })
        segments = normalizeSegments(raw)
        if (segments.length < MIN_VALID_SEGMENTS) {
          this.log?.warn?.(`日程生成结果不合格（合格 ${segments.length} 段），退回安全日程`)
        }
      } catch (error) {
        this.log?.warn?.(`日程生成失败，退回安全日程：${error?.message ?? error}`)
        segments = []
      }
    } else {
      this.log?.warn?.('没有注入日程生成函数，用安全日程兜底')
    }

    // 校验不过 / 模型挂了 / 根本没接上 → 安全日程。她可以日程不准，不能没有日程。
    if (segments.length < MIN_VALID_SEGMENTS) segments = safeSchedule()

    if (this.disposed) return []
    this.state = { date, segments, generatedAt: at }
    this.save()
    this.log?.debug?.(`日程已生成：${date}，${segments.length} 段`)
    return this.plan(at)
  }

  /** 读盘。文件不存在 / 坏了都退回空白 —— 日程丢一次不值得让整个插件起不来。 */
  #load() {
    if (!this.file) return
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const date = String(raw.date ?? '').trim()
    const segments = normalizeSegments(raw.segments)
    this.state = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      segments,
      generatedAt: toNumber(raw.generatedAt, 0),
    }
  }
}
