/**
 * 关系账本（v3）—— 「我们之间走到哪一步了」。
 *
 * ⚠️ 和 emotion.js 的分工（两边都要存在，但**绝不重复记账**）：
 *   · 情绪 = 这一轮心情怎么动（分钟~小时级）：开心/难过/吃醋，指数衰减回基线；
 *   · 关系 = 我们之间长期走到哪了（周~月级）：分数 → 六个阶段，只被「事件」推动、
 *     靠自然回落慢慢淡。
 *   所以：关系不写心情，情绪不碰分数。两层各自只做自己那个时间尺度的事。
 *
 * 从 PLAN v3.1 §4（`private_companion` 的 relationship_ledger.py）搬过来的：
 *   · 分数域 −1200 ~ +1200，六阶段（疏离 → 深联结）；
 *   · 迟滞：降段要跌破「当前段下限 − 20」才认，防止分数在阈值附近抖来抖去；
 *   · 单次正向 +4 / 负向 −12，每日正向累计 +12；≥600 正向打七五折、≥900 打五折；
 *   · 自然回落只向 0：3 天没互动不扣，第 4~7 天 −2/天，8~14 天 −5/天，15 天起 −8/天；
 *   · 同一消息同一原因 30 分钟去重（一条消息连夸十句只记一次）。
 *
 * 我们砍掉的（PLAN §4.2）：多人格、群聊贡献、六重上限、边界档位链、以及
 * 「专属联结冻结」—— 那个太死，换成本模块下面这条**主人地板**。
 *
 * 两条必须写在这里、不能交给调用方自觉的设计：
 *   ① **主人地板**：主人的分数永远 ≥ close(600)。
 *      理由（PLAN §4.3，茶茶酱原话）：一次吵架她就不理人，体验很糟。
 *      所以主人最差也只是「有点不高兴」，永远掉不到「疏离」。
 *   ② **归因分离**（从 content_safety_guard 学的）：**只有用户干的事能扣分**。
 *      她自己心情不好、模型判断跑偏、程序出 bug —— 都不许记到用户头上。
 *      调用方传 attribution: 'user' | 'bot' | 'system'；非 user 的负向一律不扣（正向照涨）。
 *
 * 纯函数优先：phaseOf / settleDecay / applyEvent 零 IO、零副作用、时间全注入，
 * 回落/去重/迟滞这些最容易出错的地方全靠它们钉住。文件 UTF-8 无 BOM，零外部依赖。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { featureMode } from '../modes.js'

// --------------------------------------------------------------------------
// 常量
// --------------------------------------------------------------------------

/** 六个阶段。顺序就是「由远到近」，落盘的 phase 字段认的就是这些 key，别改名。 */
export const PHASES = ['distant', 'acquaintance', 'familiar', 'close', 'intimate', 'deeply_bonded']

/** 阶段 → 中文。给面板和注入文案用；**不要**拿它当条件判断（判断一律用 key）。 */
export const PHASE_LABELS = {
  distant: '疏离',
  acquaintance: '认识',
  familiar: '熟悉',
  close: '亲近',
  intimate: '亲密',
  deeply_bonded: '深联结',
}

/**
 * 每个阶段的下限分数（与 PHASES 同下标）。
 *
 * 为什么是这几个数：
 *   · 200 是契约点名的 familiar 下限（测试用例里 familiar(300) / acquaintance(190) 也印证了它）；
 *   · 600 = close，正好等于 `diminish.from`（一进「亲近」，涨分开始变慢）和主人地板；
 *   · 900 = intimate，正好等于 `diminish.hardFrom`（一进「亲密」，涨分砍半）；
 *   · 1100 是「深联结」的门槛，留 100 分余量到顶（1200），不然永远够不着。
 *   · 0 以下全算 distant（负数只可能来自用户反复作恶或手动重置）。
 */
export const PHASE_FLOORS = [-1200, 0, 200, 600, 900, 1100]

export const SCORE_MIN = PHASE_FLOORS[0]
export const SCORE_MAX = 1200

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 默认配置。字段与契约（任务书「配置」段）一一对应，只多不少。
 *
 * ⚠️ `initial` 契约里写的是 200，但同一行的注释是「新认识的人从 familiar 起步？不，
 *    从 acquaintance(0) 起」—— 200 正好等于 familiar 的下限，写 200 等于让所有陌生人
 *    一上来就是「熟悉」，和注释、和整个阶段设计都打架。所以默认取 0（= acquaintance）。
 *    主人真想改回 200 就配 `relation.initial`，代码不拦。
 */
export const DEFAULT_RELATION = {
  enabled: true,
  /** 新人的起始分数：0 = acquaintance（见上面那段为什么不是 200） */
  initial: 0,
  /** 单次正向上限 */
  singleGainCap: 4,
  /** 单次负向上限 */
  singleLossCap: 12,
  /** 每日正向累计上限（超出部分丢弃） */
  dailyGainCap: 12,
  /** 迟滞带宽：降段要比下限再多跌这么多分 */
  hysteresis: 20,
  /**
   * 自然回落的阶梯。
   * graceDays = 前 3 天完全不动；tiers 按「距最后一次互动第几天」查表：
   *   第 4~7 天 → −2/天，第 8~14 天 → −5/天，第 15 天起 → −8/天。
   */
  decay: {
    graceDays: 3,
    tiers: [
      { untilDay: 7, perDay: 2 },
      { untilDay: 14, perDay: 5 },
      { perDay: 8 },
    ],
  },
  /** 边际递减：分数越高，正向加得越慢（防止早早就刷满顶） */
  diminish: { from: 600, factor: 0.75, hardFrom: 900, hardFactor: 0.5 },
  /** 同一消息同一原因去重窗口 */
  dedupeMs: 30 * 60 * 1000,
  /** 主人分数的地板阶段（主人永远不低于这个阶段） */
  ownerFloorPhase: 'close',
  /** 账本最多留多少条（只留最近的，防止文件无限长） */
  ledgerMax: 200,
}

// --------------------------------------------------------------------------
// 小工具（纯函数）
// --------------------------------------------------------------------------

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/** 保留两位小数：落盘和断言都别出现 302.25000000000006。 */
function round2(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.round(num * 100) / 100
}

/** 宽松取数：配置/旧数据/模型输出什么形状都可能，取不到就给 fallback（不抛错）。 */
function toNumber(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value !== 'string') return fallback
  const found = value.match(/-?\d+(?:\.\d+)?/)
  return found ? Number(found[0]) : fallback
}

/** 阶段名归一：非法值返回 ''（绝不抛错，旧数据里可能有各种垃圾）。 */
function normalizePhase(phase) {
  const key = String(phase ?? '').trim().toLowerCase()
  return PHASES.includes(key) ? key : ''
}

/** 阶段下限分数；非法阶段返回 null。 */
export function phaseFloor(phase) {
  const key = normalizePhase(phase)
  const index = key ? PHASES.indexOf(key) : -1
  return index >= 0 ? PHASE_FLOORS[index] : null
}

/** 本地日期键：按宿主时区分天，和主人「今天」的直觉一致。 */
function dayKeyOf(at) {
  const date = new Date(Number(at))
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (num) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 日期键 → 天序号（自 1970-01-01 的本地日历天数）。
 *
 * 用 `Date.UTC(本地年月日)` 折算，而不是 `Math.floor(时间戳/86400000)`：
 * 后者按 UTC 切天，东八区会差 8 小时（晚上 8 点以后的互动会算到「第二天」）。
 */
function dayIndexFromKey(key) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
  if (!matched) return null
  const index = Math.floor(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])) / DAY_MS)
  return Number.isFinite(index) ? index : null
}

/** 时间戳 → 天序号；非法返回 null。 */
function dayIndexOf(at) {
  const num = Number(at)
  if (!Number.isFinite(num) || num <= 0) return null
  return dayIndexFromKey(dayKeyOf(num))
}

/** lastSettledDay 可能是日期键，也可能是旧数据里的时间戳，两种都认。 */
function settledIndexOf(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return dayIndexOf(value)
  return dayIndexFromKey(value)
}

/** 距最后一次互动的第 dayNo 天，每天该扣多少。 */
function decayPerDay(dayNo, decay) {
  const cfg = decay && typeof decay === 'object' ? decay : DEFAULT_RELATION.decay
  const graceDays = Math.max(0, Math.round(toNumber(cfg.graceDays, DEFAULT_RELATION.decay.graceDays)))
  if (dayNo <= graceDays) return 0
  const tiers = Array.isArray(cfg.tiers) && cfg.tiers.length > 0 ? cfg.tiers : DEFAULT_RELATION.decay.tiers
  let last = 0
  for (const tier of tiers) {
    if (!tier || typeof tier !== 'object') continue
    last = Math.max(0, toNumber(tier.perDay, 0))
    const until = tier.untilDay === undefined || tier.untilDay === null || tier.untilDay === ''
      ? Infinity
      : Math.max(0, Math.round(toNumber(tier.untilDay, Infinity)))
    if (dayNo <= until) return last
  }
  return last
}

function trimLedger(ledger, max) {
  const limit = Math.max(0, Math.round(toNumber(max, 0)))
  if (limit === 0) return []
  return ledger.length > limit ? ledger.slice(-limit) : ledger
}

// --------------------------------------------------------------------------
// 配置解析
// --------------------------------------------------------------------------

function normalizeDecayTiers(tiers) {
  const source = Array.isArray(tiers) && tiers.length > 0 ? tiers : DEFAULT_RELATION.decay.tiers
  const out = []
  for (const tier of source) {
    if (!tier || typeof tier !== 'object') continue
    const perDay = Math.max(0, toNumber(tier.perDay, 0))
    const untilDay = tier.untilDay === undefined || tier.untilDay === null || tier.untilDay === ''
      ? Infinity
      : Math.max(0, Math.round(toNumber(tier.untilDay, Infinity)))
    out.push({ untilDay, perDay })
  }
  if (out.length === 0) return DEFAULT_RELATION.decay.tiers.map((tier) => ({ ...tier }))
  // 按天数升序排：查表是「第一个够得着的档」，顺序错了回落就会乱
  return out.sort((a, b) => a.untilDay - b.untilDay)
}

/**
 * 把 `config.relation` 归一（容忍面板写进来字符串/空值/整份 config）。
 *
 * 兼容三种传法（装配层写法不统一，别让字段名把功能悄悄关掉）：
 *   1. 关系段本身：`{ singleGainCap: 4 }`
 *   2. 整份 config：`{ relation: {...}, owner: {...}, modes: {...} }`
 *   3. getter：`() => store.get().relation`
 */
export function resolveRelationConfig(config = {}) {
  let raw = config
  if (typeof raw === 'function') {
    try {
      raw = raw()
    } catch {
      raw = null
    }
  }
  const root = raw && typeof raw === 'object' ? raw : {}
  const section = root.relation && typeof root.relation === 'object' ? root.relation : root
  const decaySource = section.decay && typeof section.decay === 'object' ? section.decay : {}
  const diminishSource = section.diminish && typeof section.diminish === 'object' ? section.diminish : {}

  const from = clamp(toNumber(diminishSource.from, DEFAULT_RELATION.diminish.from), SCORE_MIN, SCORE_MAX)
  const hardFrom = Math.max(
    from,
    clamp(toNumber(diminishSource.hardFrom, DEFAULT_RELATION.diminish.hardFrom), SCORE_MIN, SCORE_MAX),
  )

  return {
    enabled: section.enabled !== false,
    initial: clamp(toNumber(section.initial, DEFAULT_RELATION.initial), SCORE_MIN, SCORE_MAX),
    singleGainCap: Math.max(0, toNumber(section.singleGainCap, DEFAULT_RELATION.singleGainCap)),
    singleLossCap: Math.max(0, toNumber(section.singleLossCap, DEFAULT_RELATION.singleLossCap)),
    dailyGainCap: Math.max(0, toNumber(section.dailyGainCap, DEFAULT_RELATION.dailyGainCap)),
    hysteresis: clamp(toNumber(section.hysteresis, DEFAULT_RELATION.hysteresis), 0, 200),
    decay: {
      graceDays: Math.max(0, Math.round(toNumber(decaySource.graceDays, DEFAULT_RELATION.decay.graceDays))),
      tiers: normalizeDecayTiers(decaySource.tiers),
    },
    diminish: {
      from,
      factor: clamp(toNumber(diminishSource.factor, DEFAULT_RELATION.diminish.factor), 0, 1),
      hardFrom,
      hardFactor: clamp(toNumber(diminishSource.hardFactor, DEFAULT_RELATION.diminish.hardFactor), 0, 1),
    },
    dedupeMs: Math.max(0, toNumber(section.dedupeMs, DEFAULT_RELATION.dedupeMs)),
    ownerFloorPhase: normalizePhase(section.ownerFloorPhase) || DEFAULT_RELATION.ownerFloorPhase,
    ledgerMax: clamp(Math.round(toNumber(section.ledgerMax, DEFAULT_RELATION.ledgerMax)), 0, 2000),
  }
}

// --------------------------------------------------------------------------
// 纯函数 ①：分数 → 阶段（迟滞）
// --------------------------------------------------------------------------

/** 裸分数落在哪个阶段（不带迟滞）。 */
function rawPhaseIndex(value) {
  let index = 0
  for (let i = 0; i < PHASES.length; i += 1) {
    if (value >= PHASE_FLOORS[i]) index = i
  }
  return index
}

/**
 * 分数 → 阶段，带迟滞。
 *
 * 迟滞怎么落：
 *   · **降段**：必须跌破「当前阶段下限 − hysteresis」才认。
 *     familiar 的人掉到 190 不掉（190 ≥ 200−20），掉到 179 才回 acquaintance。
 *   · **升段**：必须真的越过目标阶段的下限（严格大于）。
 *     199 不升、201 升；正好 200 也留在原阶段（「越过」不算「等于」）。
 *   于是 [下限−20, 下限] 这条带子是「粘」的：从上面掉下来不降，从下面顶上来不升，
 *   分数在阈值附近抖来抖去也不会来回换脸。
 *
 * ⚠️ 契约正文写「升段要越过阈值 +20」，但验收用例写的是「acquaintance(190) 升到 199
 *    不升、201 才升」——两者不可能同时成立。这里按**验收用例**实现（201 升），理由：
 *    1) 验收用例是明确的数字，正文那句是描述；2) 按 +20 的话 200 分起的新人要 220 才
 *       familiar，且 [200,220) 变成谁都不敢进的死区，反而更容易让人觉得「关系不动了」。
 *    真想要对称 ±20 就把 `hysteresis` 配小，行为会跟着变（不会写死）。
 *
 * @param {number} score 当前分数（会先夹到 −1200~1200）
 * @param {string} [previousPhase] 上一轮阶段；不认识/没传时按裸分数判
 * @param {{hysteresis?: number}} [options]
 * @returns {{phase: string, label: string, changed: boolean}}
 */
export function phaseOf(score, previousPhase, { hysteresis = DEFAULT_RELATION.hysteresis } = {}) {
  const value = clamp(toNumber(score, 0), SCORE_MIN, SCORE_MAX)
  const band = Math.max(0, toNumber(hysteresis, DEFAULT_RELATION.hysteresis))
  const rawIndex = rawPhaseIndex(value)
  const prev = normalizePhase(previousPhase)
  const prevIndex = prev ? PHASES.indexOf(prev) : -1

  let index = rawIndex
  if (prevIndex >= 0 && rawIndex !== prevIndex) {
    if (rawIndex > prevIndex) {
      // 升段：必须**严格越过**目标下限（199 不升、201 升）
      if (value <= PHASE_FLOORS[rawIndex]) index = prevIndex
    } else if (value >= PHASE_FLOORS[prevIndex] - band) {
      // 降段：没跌破「当前下限 − 带宽」就还是原阶段
      index = prevIndex
    }
  }

  const phase = PHASES[index]
  return {
    phase,
    label: PHASE_LABELS[phase],
    changed: prevIndex >= 0 && phase !== PHASES[prevIndex],
  }
}

// --------------------------------------------------------------------------
// 纯函数 ②：自然回落
// --------------------------------------------------------------------------

/**
 * 自然回落：从「最后一次互动」算起，按天扣分；**只向 0 回落，不转负**。
 *
 * 幂等的关键在 `lastSettledDay`：它记着「已经结算到哪一天了」，
 * 同一天调用两次 → 循环从今天+1 开始 → 一天只会扣一次。
 *
 * 为什么负数不回落：分数掉到负数意味着用户做了很糟的事，
 * 让它随时间自己回 0 等于「吵架过几天就自动和好」，那不是关系，是金鱼。
 * 要恢复只能靠之后的正向互动。
 *
 * 为什么不从「上次结算日」而是从「max(上次结算日, 最后互动日)」开始算：
 * 互动一次就该把回落的钟拨回去 —— 哪怕上次结算是三天前，只要今天互动过，
 * 就不能把这三天按「没互动」扣掉。
 *
 * @param {object} params
 * @param {number} params.score 当前分数
 * @param {number} [params.lastActiveAt] 最后一次互动时间（毫秒）；0/空 = 没有互动记录
 * @param {string|number} [params.lastSettledDay] 上次结算到哪一天（日期键 'YYYY-MM-DD' 或时间戳）
 * @param {number} params.now 现在（毫秒，必须注入）
 * @param {object} [params.decay] 回落配置（graceDays/tiers）
 * @returns {{score:number, settledDay:string, delta:number}} delta 是这次实际扣掉的分数（正数）
 */
export function settleDecay({
  score,
  lastActiveAt = 0,
  lastSettledDay = '',
  now = Date.now(),
  decay = DEFAULT_RELATION.decay,
} = {}) {
  const nowNum = toNumber(now, Date.now())
  const todayKey = dayKeyOf(nowNum)
  const todayIdx = dayIndexOf(nowNum)
  const before = clamp(toNumber(score, 0), SCORE_MIN, SCORE_MAX)

  // 时钟都坏了就原样返回（宁可少扣，不能乱扣）
  if (todayIdx === null) return { score: before, settledDay: String(lastSettledDay ?? ''), delta: 0 }

  // 没有合法结算日 → 从今天起算。旧数据第一次启用回落时不能把「陈年旧账」一次扣光。
  const settledIdx = settledIndexOf(lastSettledDay)
  const startIdx = settledIdx === null ? todayIdx : settledIdx
  const activeIdx = dayIndexOf(toNumber(lastActiveAt, 0))

  // 只处理正分；没有互动记录也不回落
  if (before <= 0 || activeIdx === null) {
    return { score: before, settledDay: todayKey, delta: 0 }
  }

  // 永远不结算「最后互动之前」的天数：互动一次，回落的钟就拨回去
  const fromIdx = Math.max(startIdx, activeIdx)
  let total = 0
  for (let day = fromIdx + 1; day <= todayIdx; day += 1) {
    total += decayPerDay(day - activeIdx, decay)
  }
  if (total <= 0) return { score: before, settledDay: todayKey, delta: 0 }

  const after = Math.max(0, before - total) // 「不转负」在这里兜底
  return { score: round2(after), settledDay: todayKey, delta: round2(before - after) }
}

// --------------------------------------------------------------------------
// 纯函数 ③：应用一次事件
// --------------------------------------------------------------------------

/** 去重判定：同一 eventKey（优先）或同一 reason 在去重窗口内出现过就不再记。 */
function isDuplicate(recentLedger, eventKey, reason, at, dedupeMs) {
  const window = Math.max(0, toNumber(dedupeMs, 0))
  if (window <= 0) return false
  const list = Array.isArray(recentLedger) ? recentLedger : []
  const hasKey = Boolean(eventKey)
  const hasReason = Boolean(reason)
  if (!hasKey && !hasReason) return false // 什么都没给就别去重，否则所有匿名事件会被合成一条

  return list.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const entryAt = toNumber(entry.at, 0)
    if (!(entryAt > 0)) return false
    const gap = at - entryAt
    // gap < 0：账本里比现在还晚的条目（时钟被调过），不参与去重
    if (gap < 0 || gap >= window) return false
    if (hasKey) {
      const entryKey = String(entry.eventKey ?? '').trim()
      if (entryKey) return entryKey === eventKey
      // 老账本没有 eventKey：退回比 reason
      return hasReason && String(entry.reason ?? '').trim() === reason
    }
    return String(entry.reason ?? '').trim() === reason
  })
}

/**
 * 应用一次分数变化。**纯函数**：不读盘、不取时间、不改入参。
 *
 * 处理顺序（顺序有讲究，别换）：
 *   ① 归因分离：非 'user' 的负向直接丢弃（正向他可以涨，见文件头）
 *   ② 去重：同一 eventKey/reason 在 30 分钟内只记一次
 *   ③ 单次上限：+4 / −12
 *   ④ 边际递减：≥600 ×3/4，≥900 ×1/2（用**变化前**的分数判，别用变化后的）
 *   ⑤ 每日正向累计上限：一天最多涨 12，超出部分丢弃
 *   ⑥ 分数域夹到 −1200~1200
 *
 * @param {object} params
 * @param {number} params.score 变化前分数
 * @param {number} params.delta 想加多少（模型/规则给的分）
 * @param {string} [params.reason] 人话原因（进账本给面板看，也参与去重）
 * @param {number} [params.at] 事件时间（毫秒）
 * @param {Array} [params.recentLedger] 现有账本（只读，用于去重）
 * @param {number} [params.todayPositive] 今天已经累计涨了多少
 * @param {string} [params.todayPositiveDay] todayPositive 属于哪一天（日期键）；和 at 不是同一天就按 0 算
 * @param {'user'|'bot'|'system'} [params.attribution] 归因；只有 user 的负向会真的扣分
 * @param {string} [params.eventKey] 同一消息的稳定 key（建议 `<消息id>:<原因>`）
 * @param {object} [params.config] 关系配置（整份 config / 关系段 / 已归一对象都认）
 * @returns {{score:number, applied:number, capped:boolean, reason:string, deduped:boolean, dropped:boolean}}
 */
export function applyEvent({
  score,
  delta = 0,
  reason = '',
  at = Date.now(),
  recentLedger = [],
  todayPositive = 0,
  todayPositiveDay = '',
  attribution = 'user',
  eventKey = '',
  config = {},
} = {}) {
  const cfg = resolveRelationConfig(config)
  const current = clamp(toNumber(score, 0), SCORE_MIN, SCORE_MAX)
  const atNum = toNumber(at, Date.now())
  const reasonText = String(reason ?? '').trim().slice(0, 120)
  const wanted = round2(toNumber(delta, 0))
  const base = {
    score: current,
    applied: 0,
    capped: false,
    reason: reasonText,
    deduped: false,
    dropped: false,
  }

  if (wanted === 0) return base

  // ① 归因分离：她自己的情绪/模型跑偏/系统抖动 —— 不许扣用户的分
  if (wanted < 0 && attribution !== 'user') return { ...base, dropped: true }

  // ② 同一消息同一原因 30 分钟内只记一次
  if (isDuplicate(recentLedger, String(eventKey ?? '').trim(), reasonText, atNum, cfg.dedupeMs)) {
    return { ...base, deduped: true }
  }

  let capped = false
  let amount = wanted

  if (wanted > 0) {
    // ③ 单次上限
    if (amount > cfg.singleGainCap) {
      amount = cfg.singleGainCap
      capped = true
    }
    // ④ 边际递减（用变化前的分数判）
    const factor = current >= cfg.diminish.hardFrom
      ? cfg.diminish.hardFactor
      : (current >= cfg.diminish.from ? cfg.diminish.factor : 1)
    if (factor !== 1) amount = Math.round(amount * factor) // 分数保持整数，别留 302.25 的毛刺
    // ⑤ 每日正向累计上限
    const day = dayKeyOf(atNum)
    const sameDay = Boolean(todayPositiveDay) && String(todayPositiveDay) === day
    const used = sameDay ? Math.max(0, toNumber(todayPositive, 0)) : 0
    const room = Math.max(0, round2(cfg.dailyGainCap - used))
    if (amount > room) {
      amount = room
      capped = true
    }
  } else if (amount < -cfg.singleLossCap) {
    // ③ 负向单次上限
    amount = -cfg.singleLossCap
    capped = true
  }

  if (amount === 0) return { ...base, capped }
  const next = clamp(round2(current + amount), SCORE_MIN, SCORE_MAX)
  const applied = round2(next - current)
  if (applied === 0) return { ...base, capped: true } // 已经在顶/底，加不动了

  return {
    score: next,
    applied,
    capped: capped || Math.abs(applied - amount) > 1e-9,
    reason: reasonText,
    deduped: false,
    dropped: false,
  }
}

// --------------------------------------------------------------------------
// 阶段 → 语气标签（喂给 tags.js / preset 用）
// --------------------------------------------------------------------------

/**
 * 阶段 → 一个能直接当标签念的短词。
 *
 * 上层可以把它拼进 `tags` 数组，`preset.renderTagLine` 会渲染成「- 熟人」这样一行；
 * 但它只是个词，真正解释「该怎么说话」的是 RelationStore.renderForMind()。
 */
export const PHASE_TAGS = {
  distant: '关系生分',
  acquaintance: '刚认识',
  familiar: '熟人',
  close: '亲近的人',
  intimate: '亲密的人',
  deeply_bonded: '深交',
}

export function phaseTagOf(phase) {
  const key = normalizePhase(phase)
  return key ? PHASE_TAGS[key] ?? '' : ''
}

// --------------------------------------------------------------------------
// 注入文案（纯函数：只依赖传入的阶段/身份）
// --------------------------------------------------------------------------

const PHASE_TONE = {
  distant: '跟你之间还隔着一层，印象不太好',
  acquaintance: '和你只是认识，还没到熟的程度',
  familiar: '和你已经算熟了',
  close: '和你关系很近',
  intimate: '和你关系很亲',
  deeply_bonded: '和你交情很深，彼此都信得过',
}

const PHASE_TIPS = {
  distant: '别热络，话少一点、客气一点。',
  acquaintance: '礼貌就行，别自来熟。',
  familiar: '说话可以放松一点，不用太端着。',
  close: '可以开玩笑、可以撒娇，不用每句都客气。',
  intimate: '说话可以直接、放松一点，像对亲近的人。',
  deeply_bonded: '可以像对最亲近的人那样说话。',
}

// --------------------------------------------------------------------------
// 状态存储
// --------------------------------------------------------------------------

/**
 * 关系状态存储：`<dataDir>/relation/<userId>.json`，原子写。
 *
 * 每份状态：
 *   {
 *     version, userId, score, phase,
 *     lastActiveAt, lastSettledDay,           // 回落用（见 settleDecay）
 *     positive: { day, total },               // 每日正向累计（当天正能量）
 *     ledger: [{ eventKey, reason, delta, scoreBefore, scoreAfter, at }], // 最多 ledgerMax 条
 *     updatedAt,
 *   }
 *
 * @example
 *   const relation = new RelationStore({
 *     dataDir,
 *     // ⚠️ 建议传**整份 config** 的 getter：owner（主人地板）和 modes（work 只记）
 *     //    都挂在整份 config 上，只传 relation 段的话那两件事会失效（会退化成没有主人、全 companion）。
 *     config: () => store.get(),
 *     log: log.child('relation'),
 *   })
 *   relation.touch(userId)                                    // 每收到一条消息（拨回回落钟）
 *   await relation.apply({ userId, delta: +3, reason: '主动关心' })   // 有行为时
 *   const line = relation.renderForMind({ userId, peerKey })  // 每轮注入
 */
export class RelationStore {
  /** 同一用户的写队列：两个 apply 并发会互相覆盖，串起来最省心。 */
  #queues = new Map()
  /** 已加载的状态（读多写少，缓存住；文件很小，内存不心疼）。 */
  #cache = new Map()
  /** 原子写临时文件名序号（同一进程内别重名）。 */
  #tmpSeq = 0

  /**
   * @param {object} options
   * @param {string} options.dataDir 数据目录（关系在 `<dataDir>/relation/`）
   * @param {object|Function} [options.config] 整份配置 / relation 段 / 返回它们的 getter
   * @param {object} [options.log] 日志器
   * @param {Function} [options.now] 时间注入（毫秒）—— 回落/去重全靠它测
   * @param {object|string|string[]} [options.owner] 主人配置（config 只传了 relation 段时用它兜底）
   * @param {Function} [options.modeOf] `(peerKey, rootConfig) => mode`，config 里没有 modes 时兜底
   */
  constructor({ dataDir = '', config = {}, log = null, now = () => Date.now(), owner = null, modeOf = null } = {}) {
    this.dataDir = String(dataDir || '.')
    this.root = path.join(this.dataDir, 'relation')
    this.config = config
    this.log = log
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.owner = owner
    this.modeOf = typeof modeOf === 'function' ? modeOf : null
  }

  // ── 对外：读 ────────────────────────────────────────────────

  /**
   * 读某个人的关系快照。
   * 读的时候会顺手做一遍归一（分数夹紧、主人地板、阶段重算），
   * 所以「主人地板」这条不变量连历史脏数据也兜得住。
   *
   * @param {string} userId
   * @returns {{score:number, phase:string, label:string, ledger:Array}}
   */
  get(userId) {
    const cfg = this.#cfg()
    const uid = this.#safeId(userId)
    if (!uid) return this.#snapshot(this.#blank('', cfg))
    const state = this.#load(uid, cfg)
    this.#normalize(state, cfg)
    return this.#snapshot(state)
  }

  // ── 对外：写 ────────────────────────────────────────────────

  /**
   * 记一次关系事件。
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {number} params.delta 想加多少（正=亲近，负=疏远）
   * @param {string} [params.reason] 人话原因（进账本，也参与去重）
   * @param {'user'|'bot'|'system'} [params.attribution] 归因：只有 user 的负向会真的扣分
   * @param {string} [params.eventKey] 同一消息稳定 key，建议 `<消息id>:<原因>`
   * @param {number} [params.at] 事件时间（毫秒；默认注入的 now）
   * @returns {Promise<{score:number, phase:string, applied:number, capped:boolean, deduped:boolean, dropped:boolean, changed:boolean}>}
   */
  async apply({ userId, delta = 0, reason = '', attribution = 'user', eventKey = '', at = null } = {}) {
    const cfg = this.#cfg()
    const uid = this.#safeId(userId)
    if (!cfg.enabled || !uid) {
      const snapshot = uid ? this.get(uid) : this.#snapshot(this.#blank('', cfg))
      return {
        score: snapshot.score,
        phase: snapshot.phase,
        applied: 0,
        capped: false,
        deduped: false,
        dropped: !cfg.enabled,
        changed: false,
      }
    }

    return this.#enqueue(uid, async () => {
      const time = at === null || at === undefined ? this.now() : toNumber(at, this.now())
      const state = this.#load(uid, cfg)

      // ① 先结算这些天的自然回落（幂等：同一天调几次也只会扣一次）
      this.#decay(state, time, cfg)
      this.#normalize(state, cfg)

      const before = round2(state.score)
      const phaseBefore = state.phase

      // ② 再记这次事件
      const result = applyEvent({
        score: before,
        delta,
        reason,
        at: time,
        recentLedger: state.ledger,
        todayPositive: state.positive.total,
        todayPositiveDay: state.positive.day,
        attribution,
        eventKey,
        config: cfg,
      })
      if (result.applied !== 0) state.score = result.score

      // ③ 归一（主人地板/上下限/阶段迟滞都可能把这条事件的效果吃掉）
      this.#normalize(state, cfg)
      const applied = round2(state.score - before)

      // 账本只记「真的动了分」的：被上限/地板/去重挡掉的不占账本位置
      if (applied !== 0) {
        state.ledger.push({
          eventKey: String(eventKey ?? '').trim().slice(0, 120),
          reason: result.reason,
          delta: applied,
          scoreBefore: before,
          scoreAfter: round2(state.score),
          at: time,
        })
        state.ledger = trimLedger(state.ledger, cfg.ledgerMax)
        if (applied > 0) {
          const day = dayKeyOf(time)
          const used = state.positive.day === day ? state.positive.total : 0
          state.positive = { day, total: round2(used + applied) }
        }
      }

      // 用户真的说话了 → 把「自然回落」的钟拨回来。
      // （bot/system 的事件不算互动：她自己的活动不能替用户续命。）
      if (attribution === 'user') state.lastActiveAt = Math.max(state.lastActiveAt, time)

      const changed = state.phase !== phaseBefore
      state.updatedAt = time
      await this.#save(uid, state)

      return {
        score: round2(state.score),
        phase: state.phase,
        applied,
        capped: result.capped,
        deduped: result.deduped,
        dropped: result.dropped,
        changed,
      }
    })
  }

  /**
   * 跨天回落（幂等：同一天调几次只扣一次）。
   *
   * 上层不用掐着表调 —— apply() 内部也会先结算一遍；
   * 但没人说话的那几天不会有 apply，所以建议每轮进来顺手 settle 一下（或者定时跑）。
   *
   * @param {string} userId
   * @returns {Promise<{score:number, phase:string, delta:number}|undefined>}
   */
  async settle(userId, { at = null } = {}) {
    const cfg = this.#cfg()
    const uid = this.#safeId(userId)
    if (!cfg.enabled || !uid) return undefined

    return this.#enqueue(uid, async () => {
      const time = at === null || at === undefined ? this.now() : toNumber(at, this.now())
      const state = this.#load(uid, cfg)
      const settledBefore = state.lastSettledDay
      const scoreBefore = round2(state.score)
      const decayed = this.#decay(state, time, cfg)
      this.#normalize(state, cfg)
      const changed = decayed.delta !== 0 || state.lastSettledDay !== settledBefore || round2(state.score) !== scoreBefore
      if (changed) {
        state.updatedAt = Math.max(state.updatedAt, time)
        await this.#save(uid, state)
      }
      return { score: round2(state.score), phase: state.phase, delta: decayed.delta }
    })
  }

  /**
   * 记一次「这个人还在说话」—— 只拨回落钟，不动分数。
   *
   * 为什么要单独一个方法：大多数消息不会产生关系事件，
   * 但「今天聊过天」和「三天没理她」对回落的含义完全不同。
   * 不阻塞调用方：关系文件很小，异步落盘就行（写失败也不影响聊天）。
   */
  touch(userId, at = null) {
    const cfg = this.#cfg()
    const uid = this.#safeId(userId)
    if (!cfg.enabled || !uid) return
    try {
      const time = at === null || at === undefined ? this.now() : toNumber(at, this.now())
      const state = this.#load(uid, cfg)
      if (time <= state.lastActiveAt) return
      state.lastActiveAt = time

      // 两个保护，都是为了别把数据目录写爆：
      // ① 只是「群里冒过一句」的陌生人（没账本、分数还是初始值）不建文件 ——
      //    不然每个在群里说过话的路人都会留一个 json，审计的时候全是噪音；
      //    （内存里照样记 lastActiveAt，同一进程里他真触发了事件，apply 会一起写出去）
      // ② 已经存在的人，最多 10 分钟落一次盘 —— 回落按天算，差几分钟完全不影响，
      //    但每来一条消息写一次文件就太亏了。
      const stranger = !state._stored && state.ledger.length === 0 && round2(state.score) === round2(cfg.initial)
      if (stranger) return
      if (state._stored && time - state._persistedActiveAt < 10 * 60 * 1000) return

      this.#enqueue(uid, async () => {
        await this.#save(uid, state)
      }).catch(() => {})
    } catch (error) {
      this.log?.warn?.(`关系活跃时间更新失败：${error?.message ?? error}`)
    }
  }

  // ── 对外：注入 ──────────────────────────────────────────────

  /**
   * 渲染一句「关系提示」塞给 Mind。
   *
   * work 模式（`isRecordOnly('relation', peerKey, config)`）返回 ''：
   * 纯干活时不外露，但账照记（PLAN §1 的 ⚪ 只记）。
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} [params.peerKey] 会话 key（'private-123' / 'group-456'），判断模式用
   * @param {'companion'|'work'} [params.mode] 直接给模式（不给就按 config.modes 判）
   * @returns {string} 空串 = 这次不注入
   */
  renderForMind({ userId, peerKey = '', mode = '' } = {}) {
    const cfg = this.#cfg()
    if (!cfg.enabled) return ''

    // 模式闸门：work 只记不外露
    let visible = false
    if (this.modeOf) {
      visible = featureMode('relation', peerKey, { modes: { default: this.modeOf(peerKey, this.#rawRoot()) } }) === true
    } else if (mode) {
      visible = featureMode('relation', peerKey, { modes: { default: mode } }) === true
    } else {
      visible = featureMode('relation', peerKey, this.#rawRoot()) === true
    }
    if (!visible) return ''

    const snapshot = this.get(userId)
    const phase = snapshot.phase
    const who = this.#isOwner(userId) ? '主人' : '这个人'
    const tone = PHASE_TONE[phase] ?? PHASE_TONE.acquaintance
    const tip = PHASE_TIPS[phase] ?? PHASE_TIPS.acquaintance
    // 和 emotion.js 同一个口径：只说状态、不下命令，结尾提醒别把提示念出来
    return `（关系：${PHASE_LABELS[phase] ?? phase}）${who}${tone}。${tip}\n这是背景，按你自己的判断说话，别把这段念出来。`
  }

  // ── 对外：面板 ──────────────────────────────────────────────

  /** 全局统计（面板用）。读目录是同步的：文件很小，面板不是热路径。 */
  stats() {
    const cfg = this.#cfg()
    const out = { enabled: cfg.enabled, users: 0, byPhase: {}, avgScore: 0, minScore: 0, maxScore: 0, ledgerEntries: 0 }
    let names = []
    try {
      names = fs.readdirSync(this.root).filter((name) => name.endsWith('.json'))
    } catch {
      names = [] // 目录还没建 = 一个关系都没有
    }
    let total = 0
    let min = null
    let max = null
    for (const name of names) {
      let uid = ''
      try {
        uid = decodeURIComponent(name.slice(0, -'.json'.length))
      } catch {
        continue // 文件名坏了就当没有
      }
      if (!uid) continue
      const state = this.#load(uid, cfg)
      this.#normalize(state, cfg)
      out.users += 1
      out.byPhase[state.phase] = (out.byPhase[state.phase] ?? 0) + 1
      out.ledgerEntries += state.ledger.length
      total += state.score
      min = min === null ? state.score : Math.min(min, state.score)
      max = max === null ? state.score : Math.max(max, state.score)
    }
    out.avgScore = out.users > 0 ? round2(total / out.users) : 0
    out.minScore = min ?? 0
    out.maxScore = max ?? 0
    return out
  }

  /** 有状态的类要能 dispose：丢掉缓存，没别的资源（落盘已经在每次写时 await 掉了）。 */
  dispose() {
    this.#cache.clear()
  }

  // ------------------------------------------------------------------
  // 内部：配置 / 主人
  // ------------------------------------------------------------------

  #rawRoot() {
    try {
      const raw = typeof this.config === 'function' ? this.config() : this.config
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  #cfg() {
    return resolveRelationConfig(this.#rawRoot())
  }

  /** 主人 id 集合：构造参数 owner + 整份 config 的 owner.qq / owner.aliases 都算。 */
  #ownerIds() {
    const root = this.#rawRoot()
    const ids = new Set()
    const add = (value) => {
      const id = String(value ?? '').trim()
      if (id) ids.add(id)
    }
    const absorb = (source) => {
      if (!source) return
      if (typeof source === 'string' || typeof source === 'number') {
        add(source)
        return
      }
      if (Array.isArray(source)) {
        for (const item of source) add(item)
        return
      }
      if (typeof source === 'object') {
        add(source.qq ?? source.id ?? '')
        const aliases = Array.isArray(source.aliases) ? source.aliases : []
        for (const item of aliases) add(item)
      }
    }
    absorb(this.owner)
    absorb(root.owner)
    return ids
  }

  #isOwner(userId) {
    const id = String(userId ?? '').trim()
    return id ? this.#ownerIds().has(id) : false
  }

  #safeId(userId) {
    return String(userId ?? '').trim()
  }

  #fileOf(uid) {
    // encodeURIComponent 保证 userId 里的 / \ .. 之类不会跑出 relation 目录
    return path.join(this.root, `${encodeURIComponent(uid)}.json`)
  }

  // ------------------------------------------------------------------
  // 内部：状态
  // ------------------------------------------------------------------

  #blank(uid, cfg) {
    const time = this.now()
    const state = {
      version: 1,
      userId: uid,
      score: clamp(toNumber(cfg.initial, 0), SCORE_MIN, SCORE_MAX),
      phase: phaseOf(cfg.initial, null).phase,
      lastActiveAt: 0,
      lastSettledDay: dayKeyOf(time),
      positive: { day: dayKeyOf(time), total: 0 },
      ledger: [],
      updatedAt: 0,
      // 下面两个只在内存里用，不落盘（#serialize 是显式列字段的，不会带出去）
      _stored: false, // 磁盘上有没有这个人的文件
      _persistedActiveAt: 0, // 上次把 lastActiveAt 写进文件的时刻（touch 节流用）
    }
    this.#normalize(state, cfg)
    return state
  }

  /**
   * 状态归一：分数夹紧 → 主人地板 → 阶段（带迟滞）。
   * 所有写路径和读路径都走这里，保证「主人永远不低于 close」是**不变量**而不是约定。
   */
  #normalize(state, cfg) {
    state.score = round2(clamp(toNumber(state.score, cfg.initial), SCORE_MIN, SCORE_MAX))

    const owner = this.#isOwner(state.userId)
    const floorPhase = cfg.ownerFloorPhase
    const floor = owner ? phaseFloor(floorPhase) : null
    if (owner && floor !== null && state.score < floor) state.score = round2(floor)

    state.phase = phaseOf(state.score, state.phase, { hysteresis: cfg.hysteresis }).phase

    // 主人地板兜底：分数在 600 整点时，迟滞会让「低于 close 的旧阶段」升不上来，
    // 既然 floor 是硬不变量，阶段也得跟着提上去。
    if (owner && floor !== null) {
      const index = PHASES.indexOf(state.phase)
      const floorIndex = PHASES.indexOf(floorPhase)
      if (index >= 0 && floorIndex > index) state.phase = floorPhase
    }
    return state.phase
  }

  #read(uid, cfg) {
    const file = this.#fileOf(uid)
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      // 没有文件是正常的（新人）；文件坏了也只警告 —— 关系丢一次不值得让整个插件起不来
      if (error?.code !== 'ENOENT') {
        this.log?.warn?.(`关系状态读取失败（${uid}）：${error?.message ?? error}`)
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return this.#blank(uid, cfg)

    const state = this.#blank(uid, cfg)
    state.score = clamp(toNumber(raw.score, cfg.initial), SCORE_MIN, SCORE_MAX)
    state.phase = normalizePhase(raw.phase) || phaseOf(state.score, null).phase
    state.lastActiveAt = Math.max(0, toNumber(raw.lastActiveAt, 0))
    state.lastSettledDay = dayIndexFromKey(raw.lastSettledDay) !== null
      ? String(raw.lastSettledDay)
      : dayKeyOf(this.now())
    const positive = raw.positive && typeof raw.positive === 'object' ? raw.positive : {}
    state.positive = {
      day: dayIndexFromKey(positive.day) !== null ? String(positive.day) : dayKeyOf(this.now()),
      total: Math.max(0, toNumber(positive.total, 0)),
    }
    state.updatedAt = toNumber(raw.updatedAt, 0)

    const ledger = []
    if (Array.isArray(raw.ledger)) {
      for (const entry of raw.ledger) {
        if (!entry || typeof entry !== 'object') continue
        const delta = round2(toNumber(entry.delta, 0))
        if (!Number.isFinite(delta) || delta === 0) continue // 0 分的事件进账本没有意义
        ledger.push({
          eventKey: String(entry.eventKey ?? '').slice(0, 120),
          reason: String(entry.reason ?? '').slice(0, 120),
          delta,
          scoreBefore: round2(toNumber(entry.scoreBefore, 0)),
          scoreAfter: round2(toNumber(entry.scoreAfter, 0)),
          at: toNumber(entry.at, 0),
        })
      }
    }
    state.ledger = trimLedger(ledger, cfg.ledgerMax)
    this.#normalize(state, cfg)
    state._stored = true
    state._persistedActiveAt = state.lastActiveAt
    return state
  }

  #load(uid, cfg) {
    const cached = this.#cache.get(uid)
    if (cached) return cached
    const state = this.#read(uid, cfg)
    this.#cache.set(uid, state)
    return state
  }

  #decay(state, time, cfg) {
    const result = settleDecay({
      score: state.score,
      lastActiveAt: state.lastActiveAt,
      lastSettledDay: state.lastSettledDay,
      now: time,
      decay: cfg.decay,
    })
    if (result.delta !== 0) state.score = result.score
    state.lastSettledDay = result.settledDay || dayKeyOf(time)
    return result
  }

  #snapshot(state) {
    return {
      score: round2(state.score),
      phase: state.phase,
      label: PHASE_LABELS[state.phase] ?? '',
      ledger: state.ledger.map((entry) => ({ ...entry })),
    }
  }

  #serialize(state) {
    return {
      version: 1,
      userId: state.userId,
      score: round2(state.score),
      phase: state.phase,
      lastActiveAt: state.lastActiveAt,
      lastSettledDay: state.lastSettledDay,
      positive: { day: state.positive.day, total: round2(state.positive.total) },
      ledger: state.ledger.map((entry) => ({ ...entry })),
      updatedAt: state.updatedAt,
    }
  }

  // ------------------------------------------------------------------
  // 内部：IO
  // ------------------------------------------------------------------

  /** 原子写：先写 `.tmp` 再 rename（半截文件会让整份关系读崩，v2 踩过这个坑）。 */
  async #save(uid, state) {
    const file = this.#fileOf(uid)
    const payload = JSON.stringify(this.#serialize(state), null, 2)
    this.#tmpSeq += 1
    const tmp = `${file}.${process.pid}.${this.#tmpSeq}.tmp`
    try {
      await fsp.mkdir(this.root, { recursive: true })
      await fsp.writeFile(tmp, payload, 'utf8')
      try {
        await fsp.rename(tmp, file)
      } catch {
        // Windows 上目标文件偶尔被占着（杀毒/编辑器），rename 会失败；
        // 退化成直接覆盖写 —— 少一层原子性，总比丢关系好
        await fsp.writeFile(file, payload, 'utf8')
        await fsp.rm(tmp, { force: true })
      }
      state._stored = true
      state._persistedActiveAt = state.lastActiveAt
      return true
    } catch (error) {
      this.log?.warn?.(`关系状态落盘失败（${uid}）：${error?.message ?? error}`)
      try {
        await fsp.rm(tmp, { force: true })
      } catch {
        // 清不掉 tmp 不影响主流程
      }
      return false
    }
  }

  /** 同一用户串行执行，避免两个 apply 并发读改写互相覆盖。 */
  #enqueue(uid, task) {
    const previous = this.#queues.get(uid) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(() => {}, () => {})
    this.#queues.set(uid, tail)
    tail.then(() => {
      if (this.#queues.get(uid) === tail) this.#queues.delete(uid)
    })
    return run
  }
}
