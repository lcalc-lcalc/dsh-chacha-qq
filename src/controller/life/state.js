/**
 * life/state.js —— 她的当日状态（v3.1 PLAN §3.3）。
 *
 * 从参考实现（private_companion 的 daily_state.py）只搬**一件**最值钱的事：
 *
 *   ⭐「状态是合成视图，不是被改写的存储」
 *     内部只维护一串 conditions；`energy / moodBias / note` 每一刻都**现算**。
 *
 * 为什么这条最重要：
 *   如果「今天有点累」被写成一个会被反复加减的 energy 数字，那么每轮注入一次、面板刷一次、
 *   重启读一次，都可能偷偷把数字改歪 —— 一天下来心情跟实际发生的事完全对不上。
 *   改成 condition 列表以后，状态是**发生过的那些事算出来的**：加一条减一条都可追溯，
 *   跨天结算也只是「丢掉日抛的、留下还没过期的」，不需要记住任何中间态。
 *
 * 跨天（这是唯一有状态的地方，也是最容易写成精神分裂的地方）：
 *   · 日抛项（sleep / hunger / mood）**重抽** —— 昨天没睡好不该永远没睡好；
 *   · 带 endTs 的（health 之类）**继承到过期为止** —— 感冒不会因为过了 0 点就好了；
 *   · `generatedDay` 幂等：同一天无论 ensureToday()/get() 被调多少次，只生成一次。
 *
 * 模式集成（跟 modes.js 的三层开关对齐）：
 *   · work → renderForMind() 返回 ''（不注入，省 token）；condition 照常维护（成本约等于零，
 *     契约里 life 在 work 下是 'record' —— 只记账不外露）；
 *   · 显式传 mode='work' 也直接闭嘴（调用方不用先查配置）。
 *
 * 和 emotion.js 的分工（别重复它的事）：
 *   · emotion.js 管「这一轮聊天让心情往哪走」——即时、有半衰期、一次只说一次；
 *   · 本模块管「她今天过日子的底色」——每天重抽、跨天继承，注入一句状态+日程。
 *   两边都往 Mind 注入，但说的不是同一件事：一个说「刚才被夸了有点甜」，一个说「今天有点累」。
 *
 * 时间一律走注入的 `now()`；随机走注入的 `rng()`（跨天逻辑全靠它们测）。
 * 所有文件 UTF-8 无 BOM；零外部依赖。
 */
import fs from 'node:fs'
import path from 'node:path'

import { isOn, resolveMode } from '../../modes.js'
import {
  SCHEDULE_DEFAULTS,
  ScheduleBook,
  dayStamp,
  lifeEnabled,
  readLifeSegment,
  resolveScheduleConfig,
  writeJsonAtomic,
} from './schedule.js'

// --------------------------------------------------------------------------
// 常量
// --------------------------------------------------------------------------

/** 四种 condition（契约写死的四种；不做天气、不做生理期、不做细节强化）。 */
export const CONDITION_KINDS = ['sleep', 'hunger', 'health', 'mood']

/** energy 的硬边界（契约：10~100）。低于 10 她会「累死」，高于 100 是假的。 */
export const ENERGY_MIN = 10
export const ENERGY_MAX = 100

/** 默认配置。外面传进来的 `config.life.state` 会盖在上面。 */
export const STATE_DEFAULTS = Object.freeze({
  /** energy 基线：什么事都没发生就是 75 */
  energyBaseline: 75,
  /** 注入口径：companion-only（默认，work 不注入）| always（life 开着就注入）| off（永不注入） */
  injectMode: 'companion-only',
})

/** life 段的完整默认值（配置层可以直接拿这份当模板写进 config.json）。 */
export const LIFE_DEFAULTS = Object.freeze({
  enabled: true,
  schedule: SCHEDULE_DEFAULTS,
  state: STATE_DEFAULTS,
})

const DAY = 24 * 60 * 60 * 1000

/** 最多留多少条 condition（正常一天 3~4 条，继承几条感冒就到顶了）。 */
const MAX_CONDITIONS = 24

/** 每天新抽一条「小毛病」的概率。低一点：她多数日子是好好的，不然天天喊不舒服就不像人了。 */
const HEALTH_CHANCE = 0.12

/**
 * 日抛项的模板。mood 的写法都保证能接在「心里」后面读通（`心里有点闷` 通顺，`心里有点哑` 不通）。
 * energyDelta 是这一条对当天能量的一次性影响，不做衰减 —— 因为它是「状态」，不是「情绪」。
 */
const SLEEP_TEMPLATES = Object.freeze([
  { title: '昨晚睡得挺沉', mood: '亮堂', energyDelta: 8, cause: '一夜没醒，起床时脑子是清楚的' },
  { title: '昨晚睡得一般', mood: '平稳', energyDelta: 0, cause: '中间醒过一次，翻了个身又睡了' },
  { title: '昨晚没睡好', mood: '有点倦', energyDelta: -10, cause: '想事情想到很晚才睡着' },
  { title: '太早被闹钟拽起来', mood: '毛毛躁躁', energyDelta: -6, cause: '闹钟响了三遍才把人叫起来' },
])

const HUNGER_TEMPLATES = Object.freeze([
  { title: '刚吃过，肚子是饱的', mood: '踏实', energyDelta: 3, cause: '早饭吃得很从容' },
  { title: '有点饿，还没顾上吃', mood: '有点急', energyDelta: -4, cause: '手头这件事还差一点收尾' },
  { title: '喝了杯温的，暖过来了', mood: '安静', energyDelta: 2, cause: '杯子一直捧在手里' },
])

const MOOD_TEMPLATES = Object.freeze([
  { title: '心里挺静的', mood: '安静', energyDelta: 0, cause: '没什么事，就是平平静静的一天' },
  { title: '今天有点想说话', mood: '轻快', energyDelta: 2, cause: '一睁眼就觉得今天会有点意思' },
  { title: '有点提不起劲', mood: '有点闷', energyDelta: -3, cause: '也说不上为什么，就是懒懒的' },
  { title: '心情不坏，有点想闹', mood: '软软的', energyDelta: 4, cause: '早上看到一句好玩的话，念念不忘' },
])

const HEALTH_TEMPLATES = Object.freeze([
  { title: '好像有点着凉', mood: '蔫蔫的', energyDelta: -8, cause: '昨晚窗户开着睡的', days: 2 },
  { title: '嗓子有点哑', mood: '不太舒服', energyDelta: -5, cause: '今天话比平时少', days: 1 },
  { title: '肚子不太舒服', mood: '有点难受', energyDelta: -6, cause: '早上那口凉的吃急了', days: 1 },
])

/** 上层没给 title 时的兜底（面板手加 condition 可能只给 kind + energyDelta）。 */
const DEFAULT_TITLES = Object.freeze({
  sleep: '睡了一觉',
  hunger: '肚子的事',
  health: '身体不太舒服',
  mood: '心里的事',
})

// --------------------------------------------------------------------------
// 小工具（纯函数）
// --------------------------------------------------------------------------

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function toNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return fallback
  const found = value.match(/-?\d+(?:\.\d+)?/)
  return found ? Number(found[0]) : fallback
}

/**
 * 时间参数归一化。
 * ⚠️ 不能写 `Number.isFinite(Number(at))`：`Number(null) === 0` 是可数的，
 *    于是 `at = null` 会变成 1970-01-01 ——「跨天」直接算成另一个世纪。
 *    （这条踩过，测试里专门钉了「不传 at 时必须用 now()」。）
 */
function resolveTime(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function clipText(value, max) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? text.slice(0, max) : text
}

/** 认不出的 kind 按 mood 处理 —— condition 是内部数据，宁可归错类也别整条丢掉。 */
function normalizeKind(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return CONDITION_KINDS.includes(text) ? text : 'mood'
}

/** 注入口径归一化：认不出的一律回默认（默认 = 只在陪伴模式注入，保护 work 的钱包）。 */
export function normalizeInjectMode(value) {
  if (value === false) return 'off'
  if (value === undefined || value === null || value === '') return STATE_DEFAULTS.injectMode
  const text = String(value).trim().toLowerCase()
  if (['off', 'none', 'never', 'silent', '不注入'].includes(text)) return 'off'
  if (['always', 'all', 'on', 'true', '1', '总是'].includes(text)) return 'always'
  return STATE_DEFAULTS.injectMode
}

/** 调用方的 mode 参数归一化（只认两个真值，其余当「没说」）。 */
function normalizeMode(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'work' || text === '纯干活') return 'work'
  if (text === 'companion' || text === '陪伴') return 'companion'
  return ''
}

/**
 * 归一化 life.state 段。
 * @returns {{energyBaseline:number, injectMode:'companion-only'|'always'|'off'}}
 */
export function resolveStateConfig(config) {
  const life = readLifeSegment(config)
  const raw = life.state && typeof life.state === 'object' && !Array.isArray(life.state) ? life.state : {}
  return {
    energyBaseline: clamp(
      Math.round(toNumber(raw.energyBaseline ?? STATE_DEFAULTS.energyBaseline, STATE_DEFAULTS.energyBaseline)),
      ENERGY_MIN,
      ENERGY_MAX,
    ),
    injectMode: normalizeInjectMode(raw.injectMode ?? STATE_DEFAULTS.injectMode),
  }
}

/** 归一化整段 life 配置（面板/装配层都可以拿它做「缺什么补什么」）。 */
export function resolveLifeConfig(config) {
  return {
    enabled: lifeEnabled(config),
    schedule: resolveScheduleConfig(config),
    state: resolveStateConfig(config),
  }
}

/**
 * 一句话自我说明（契约：`note`，「今天有点累，说话可以短一点」这种）。
 * 纯函数、只吃 energy + moodBias —— 面板改基线/加 condition 都能立刻反映出来。
 */
export function buildNote({ energy = STATE_DEFAULTS.energyBaseline, moodBias = '平稳' } = {}) {
  const value = clamp(toNumber(energy, STATE_DEFAULTS.energyBaseline), 0, 100)
  let head
  if (value <= 25) head = '今天很累，说话可以短一点'
  else if (value <= 45) head = '有点累，说话可以短一点'
  else if (value <= 60) head = '状态一般'
  else if (value < 82) head = '状态还行'
  else head = '精神不错，可以多说两句'

  const mood = clipText(moodBias, 12)
  if (!mood || mood === '平稳') return head
  return `${head}，心里${mood}`
}

/** 从模板里抽一条（rng 必须是注入的；返回 1 也不能越界）。 */
function pickOne(list, rng) {
  const roll = Number(typeof rng === 'function' ? rng() : 0.5)
  const ratio = Number.isFinite(roll) ? clamp(roll, 0, 1) : 0.5
  const index = Math.min(list.length - 1, Math.floor(ratio * list.length))
  return list[index]
}

// --------------------------------------------------------------------------
// 当日状态
// --------------------------------------------------------------------------

/**
 * 她的当日状态 + 当天日程。
 *
 * 有状态，但只有「读盘 / 跨天结算 / 落盘」这几件事；所有判断都是现算的。
 *
 * @example
 *   const life = new LifeState({
 *     dataDir,
 *     config: () => store.get(),   // ⚠️ 传整份 config（要读 modes）；life 段也认
 *     generate: async ({ count, date }) => mindRun(buildSchedulePrompt({ count, date })),
 *   })
 *   await life.ensureToday({ peerKey })          // 跨天结算 + 需要时才生成日程
 *   const text = life.renderForMind({ mode, peerKey })  // 一句注入话；work → ''
 */
export class LifeState {
  /**
   * @param {object} options
   * @param {string} [options.dataDir] 数据目录（状态在 `<dataDir>/life/state.json`）；不给 = 纯内存
   * @param {object|Function} [options.config] 整份 config、life 段，或返回它们的 getter
   * @param {object|Function} [options.modes] 可选：单独给 modes 段（config 只传 life 段时用）
   * @param {object} [options.log] 日志器
   * @param {() => number} [options.now] 时间注入
   * @param {() => number} [options.rng] 随机注入（日抛项重抽用）
   * @param {Function} [options.generate] 日程生成函数（透传给 ScheduleBook，本模块不调模型）
   * @param {ScheduleBook} [options.schedule] 可选：注入一个日程簿（测试用）
   */
  constructor({
    dataDir = '',
    config = {},
    modes = null,
    log = null,
    now = () => Date.now(),
    rng = Math.random,
    generate = null,
    schedule = null,
  } = {}) {
    this.dataDir = String(dataDir || '')
    this.config = config
    this.modes = modes
    this.log = log
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.rng = typeof rng === 'function' ? rng : Math.random
    this.file = this.dataDir ? path.join(this.dataDir, 'life', 'state.json') : ''
    this.disposed = false
    this.schedule =
      schedule ||
      new ScheduleBook({
        dataDir: this.dataDir,
        config,
        modes,
        log: typeof log?.child === 'function' ? log.child('schedule') : log,
        now: this.now,
        generate,
      })
    this.state = { version: 1, generatedDay: '', rolledAt: 0, conditions: [] }
    this.#load()
  }

  /** 持久化文件路径（没给 dataDir 就是空串）。 */
  get path() {
    return this.file
  }

  /**
   * 现算的当日状态。
   *
   * ⚠️ 每次调用都重新算：energy = 基线 + 所有生效 condition 的 energyDelta 再夹到 10~100；
   *    moodBias = 强度（|energyDelta|）最高那条的 mood；note = 由这两个现写的一句话。
   *
   * @param {number} [at] 现在（默认注入的 now）
   * @returns {{energy:number, moodBias:string, note:string, conditions:Array<object>, baseline:number, at:number}}
   */
  get(at = this.now()) {
    const time = resolveTime(at, this.now())
    const cfg = this.#cfg()
    const baseline = cfg.state.energyBaseline

    // 懒跨天：任何读路径都能拿到「今天的」条件，不依赖上层一定调过 ensureToday。
    this.#rollTo(time)

    if (!cfg.enabled) {
      return {
        energy: baseline,
        moodBias: '平稳',
        note: buildNote({ energy: baseline, moodBias: '平稳' }),
        conditions: [],
        baseline,
        at: time,
      }
    }

    const active = this.#active(time)
    let total = baseline
    let strongest = null
    let strongestStrength = -1

    for (const condition of active) {
      const delta = toNumber(condition.energyDelta, 0)
      total += delta
      const strength = Math.abs(delta)
      // 取强度最高的那条；并列时留先出现的那条（同强度下先抽到的更具体）
      if (!strongest || strength > strongestStrength) {
        strongest = condition
        strongestStrength = strength
      }
    }

    const energy = clamp(Math.round(total), ENERGY_MIN, ENERGY_MAX)
    const strongestMood = strongest && strongestStrength > 0 ? String(strongest.mood ?? '').trim() : ''
    const firstWithMood = active.find((condition) => String(condition.mood ?? '').trim())
    const moodBias = strongestMood || String(firstWithMood?.mood ?? '').trim() || '平稳'
    const note = buildNote({ energy, moodBias })

    return {
      energy,
      moodBias,
      note,
      conditions: active.map((condition) => ({ ...condition })),
      baseline,
      at: time,
    }
  }

  /**
   * 跨天结算 + 按需生成今天的日程。
   *
   * @param {object} [options]
   * @param {string} [options.peerKey] 当前对话（决定「这个对话要不要生成」，见 ScheduleBook）
   * @param {number} [options.at] 现在（默认注入的 now）
   * @returns {Promise<Array<object>>} 今天的日程（work / 还没到生成点 → []）
   */
  async ensureToday({ peerKey = '', at = null } = {}) {
    if (this.disposed) return []
    const time = resolveTime(at, this.now())
    this.#rollTo(time)
    return this.schedule.ensureToday({ peerKey })
  }

  /**
   * 今天的日程（**只读缓存**；契约里的 Promise 签名，但不会触发生成）。
   * @returns {Promise<Array<object>>}
   */
  async plan() {
    return this.schedule.plan()
  }

  /** 现在在干哪件事（没有正在进行的段就是 null）。 */
  currentSegment(at = this.now()) {
    return this.schedule.currentSegment(at)
  }

  /**
   * 渲染要注入给 Mind 的那一句话。
   *
   *   companion → 「（你今天的状态：有点累，说话可以短一点，能量 45。今天日程：现在在咖啡厅写东西。这是底色，不用念出来）」
   *   work      → ''（**不注入**，省 token —— 契约矩阵里 life 在 work 下是 'record'）
   *   关机/关掉  → ''
   *
   * @param {object} [options]
   * @param {'companion'|'work'|''} [options.mode] 当前对话的模式（给了就以它为准，否则按 peerKey 查）
   * @param {string} [options.peerKey] 当前对话
   * @param {number} [options.at] 现在
   * @returns {string}
   */
  renderForMind({ mode = '', peerKey = '', at = null } = {}) {
    const time = resolveTime(at, this.now())
    const cfg = this.#cfg()
    if (!cfg.enabled) return ''

    const want = normalizeMode(mode)
    // ⓪ 显式 work：直接闭嘴。这是最省钱的一条路，放在最前面。
    if (want === 'work') return ''

    const peer = String(peerKey ?? '').trim()
    const modes = this.#modesConfig()
    // ① 模式矩阵：work 下 life 是 'record' —— 状态照常维护，但不许进她的上下文。
    if (!isOn('life', peer, { modes })) return ''
    if (cfg.state.injectMode === 'off') return ''

    const effective = want || resolveMode(peer, { modes })
    if (cfg.state.injectMode === 'companion-only' && effective !== 'companion') return ''

    const state = this.get(time)
    const bits = [`你今天的状态：${state.note}，能量 ${state.energy}`]
    // PLAN §3.2：只注入「当前这一段」+ 下一段的开头，不整份注入（省 token）。
    const scheduleLine = this.schedule.renderHint(time)
    if (scheduleLine) bits.push(`今天日程：${scheduleLine}`)

    return `（${bits.join('。')}。这是底色，不用念出来）`
  }

  /**
   * 手动加一条 condition（上层知道的具体事件走这里，比如主人说她感冒了）。
   *
   * 为什么不自动做：这个模块不该猜「聊天内容代表身体发生了什么」——
   * 那是 Mind 的判断；它判断出来了就调这里落一条，带 endTs 的会自己继承到过期。
   *
   * @param {object} input
   * @param {'sleep'|'hunger'|'health'|'mood'} [input.kind]
   * @param {string} [input.title]
   * @param {string} [input.mood]
   * @param {number} [input.energyDelta] 对能量的影响（-40~40，超过会被夹）
   * @param {number|null} [input.endTs] 过期时刻；给了就在跨天时继承到过期为止
   * @param {number} [input.startTs] 开始时刻（默认现在）
   * @param {string} [input.cause]
   * @param {number} [at] 现在
   * @returns {object} 落下的那条 condition
   */
  addCondition(input = {}, at = this.now()) {
    const time = resolveTime(at, this.now())
    // 先结算今天，否则「开盘前手动加的这条」会在第一次读状态时被跨天结算当成旧日条件清掉
    this.#rollTo(time)
    const kind = normalizeKind(input.kind)
    const startRaw = Number(input.startTs)
    const endRaw = Number(input.endTs)
    const condition = {
      id: this.#nextId(kind, time),
      kind,
      title: clipText(input.title, 30) || DEFAULT_TITLES[kind],
      mood: clipText(input.mood, 12) || '平稳',
      energyDelta: clamp(Math.round(toNumber(input.energyDelta, 0)), -40, 40),
      startTs: Number.isFinite(startRaw) && startRaw > 0 ? startRaw : time,
      endTs: Number.isFinite(endRaw) && endRaw > 0 ? endRaw : null,
      cause: clipText(input.cause, 60),
    }
    this.state.conditions.push(condition)
    if (this.state.conditions.length > MAX_CONDITIONS) {
      this.state.conditions = this.state.conditions.slice(-MAX_CONDITIONS)
    }
    this.save()
    return { ...condition }
  }

  /** 状态快照（面板用）。 */
  status() {
    // 先 get()：它会补上今天的跨天结算，快照才不会出现「day 还是旧的、conditions 已经是新的」
    const live = this.get()
    return {
      day: this.state.generatedDay,
      rolledAt: this.state.rolledAt,
      conditions: this.state.conditions.map((condition) => ({ ...condition })),
      live,
      schedule: this.schedule.status(),
      path: this.file,
    }
  }

  /** 落盘（原子写）。 */
  save() {
    if (!this.file) return false
    return writeJsonAtomic(this.file, this.#serialize(), this.log)
  }

  /** 没别的资源要放，但按 PLAN 的全局约束，有状态的要能 dispose()。 */
  dispose() {
    if (this.disposed) return
    this.save()
    this.schedule.dispose()
    this.disposed = true
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  #cfg() {
    return resolveLifeConfig(this.config)
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
    const root = typeof this.config === 'function' ? safeCall(this.config) : this.config
    const modes = root && typeof root === 'object' ? root.modes : null
    return modes && typeof modes === 'object' ? modes : {}
  }

  /**
   * 跨天结算（幂等：同一天只跑一次）。
   * @returns {boolean} 这次是不是真的跨天了（面板/测试能看出来）
   */
  #rollTo(time) {
    const cfg = this.#cfg()
    if (!cfg.enabled) return false
    const today = dayStamp(time)
    if (!today || this.state.generatedDay === today) return false

    // 日抛项重抽；带 endTs 的继承到过期为止（感冒不会因为过了 0 点就好了）
    const inherited = this.state.conditions.filter((condition) => {
      const end = Number(condition.endTs)
      return Number.isFinite(end) && end > time
    })
    this.state.conditions = inherited
    this.state.generatedDay = today
    this.state.rolledAt = time
    this.#rollDaily(time)
    this.save()
    return true
  }

  /** 新的一天：睡 / 饿 / 底子心情各抽一条（偶尔再多一条小毛病，带 endTs 跨天继承）。 */
  #rollDaily(time) {
    this.#appendTemplate('sleep', pickOne(SLEEP_TEMPLATES, this.rng), time)
    this.#appendTemplate('hunger', pickOne(HUNGER_TEMPLATES, this.rng), time)
    this.#appendTemplate('mood', pickOne(MOOD_TEMPLATES, this.rng), time)

    const roll = Number(this.rng())
    if (Number.isFinite(roll) && roll < HEALTH_CHANCE) {
      const health = pickOne(HEALTH_TEMPLATES, this.rng)
      const days = Math.max(1, Math.round(toNumber(health.days, 1)))
      this.#appendTemplate('health', health, time, time + days * DAY)
    }
  }

  #appendTemplate(kind, template, time, endTs = null) {
    this.state.conditions.push({
      id: this.#nextId(kind, time),
      kind,
      title: String(template.title ?? ''),
      mood: String(template.mood ?? '平稳'),
      energyDelta: toNumber(template.energyDelta, 0),
      startTs: time,
      endTs,
      cause: String(template.cause ?? ''),
    })
  }

  #nextId(kind, time) {
    const base = `${kind}-${time}`
    let id = base
    let index = 1
    while (this.state.conditions.some((condition) => condition.id === id)) {
      index += 1
      id = `${base}-${index}`
    }
    return id
  }

  /** 这一刻真正生效的 condition：还没开始的不算，过了 endTs 的也不算。 */
  #active(time) {
    return this.state.conditions.filter((condition) => {
      const start = Number(condition.startTs)
      if (Number.isFinite(start) && start > time) return false
      const end = Number(condition.endTs)
      if (Number.isFinite(end) && end > 0 && end <= time) return false
      return true
    })
  }

  #serialize() {
    return {
      version: 1,
      // 任务书里叫 state_generated_day；落盘统一 camelCase（跟 emotion 的 state.json 一个风格）
      generatedDay: this.state.generatedDay,
      rolledAt: this.state.rolledAt,
      conditions: this.state.conditions.map((condition) => ({ ...condition })),
    }
  }

  /** 读盘。文件不存在 / 坏了都退回空白 —— 状态丢一次不值得让整个插件起不来。 */
  #load() {
    if (!this.file) return
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return

    // 兼容任务书里那个键名（state_generated_day），也认 camelCase
    const day = String(raw.generatedDay ?? raw.state_generated_day ?? '').trim()
    const conditions = Array.isArray(raw.conditions)
      ? raw.conditions.map(normalizeCondition).filter(Boolean).slice(-MAX_CONDITIONS)
      : []

    this.state = {
      version: 1,
      generatedDay: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '',
      rolledAt: toNumber(raw.rolledAt, 0),
      conditions,
    }
  }
}

/** 从盘上读回来的 condition 也要容错（旧版本/手改都可能缺字段）。 */
function normalizeCondition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const title = clipText(raw.title, 30)
  if (!title) return null
  const kind = normalizeKind(raw.kind)
  const start = Number(raw.startTs)
  const end = Number(raw.endTs)
  return {
    id: String(raw.id ?? '').trim() || `${kind}-${Number.isFinite(start) ? start : 0}`,
    kind,
    title,
    mood: clipText(raw.mood, 12) || '平稳',
    energyDelta: clamp(Math.round(toNumber(raw.energyDelta, 0)), -40, 40),
    startTs: Number.isFinite(start) && start > 0 ? start : 0,
    endTs: Number.isFinite(end) && end > 0 ? end : null,
    cause: clipText(raw.cause, 60),
  }
}

function safeCall(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}
