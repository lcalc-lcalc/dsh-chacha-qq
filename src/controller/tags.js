/**
 * 贴标签：给用户/群贴标签，标签最终影响给 Mind 的语气提示。
 *
 * 为什么要标签：Mind 只看到「一段文本 + 角色」，不知道对面是天天见的老熟人、
 * 还是第一次冒出来的路人。标签就是把这层社会关系翻译成一句人话塞进上下文，
 * 不然她对谁都是同一个腔调（对熟人太客气、对陌生人太随意，都很难受）。
 *
 * 设计要点：
 *   1. 标签**可配置**（config.tags.users / groups），代码里只留一张**默认表**，
 *      中文提示文案集中放在 DEFAULT_TAG_TABLE，绝不散落在各个分支里。
 *   2. 自动标签（newcomer / frequent）需要「这个人说过几句话」这种统计，
 *      但本模块保持纯函数：统计由调用方通过 ctx.stats 注入，
 *      真正记账的 createTagLedger() 只负责计数，不碰 IO、不碰定时器。
 *   3. 输出标签是**稳定有序**的：先人、再群、最后自动标签 —— 提示词前缀缓存才不会被随机顺序打穿。
 */

/** 默认标签表：标签 id → 中文标签 + 给 Mind 看的一句提示。 */
export const DEFAULT_TAG_TABLE = {
  newcomer: {
    label: '新面孔',
    hint: '这个人刚来没多久，还不熟，说话别太随意，留点分寸',
  },
  frequent: {
    label: '常客',
    hint: '这个人是老朋友，可以随便开点玩笑',
  },
}

/** 默认配置（字段名与 config.js 一致，table/maxTags/auto 是 v3 追加的可选项）。 */
export const DEFAULT_TAGS = {
  enabled: true,
  users: {},
  groups: {},
  maxTags: 8,
  auto: {
    frequentAfterMsgs: 30,
    newcomer: true,
  },
  table: {},
}

function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 把配置里的标签值归一成字符串数组。
 * 容忍三种写法：'老朋友' / ['老朋友', '技术宅'] / { name: '老朋友' }。
 * 全部 trim、去空、去重（保序）。
 */
function toTagList(value) {
  const out = []
  const push = (item) => {
    const text = typeof item === 'string' ? item.trim() : (item === null || item === undefined ? '' : String(item).trim())
    if (text && !out.includes(text)) out.push(text)
  }
  if (Array.isArray(value)) {
    for (const item of value) push(item)
  } else if (value && typeof value === 'object') {
    // 兼容 { name: 'xx' } / { id: 'xx' } 这种对象写法
    push(value.name ?? value.id ?? value.tag ?? '')
  } else {
    push(value)
  }
  return out
}

/**
 * 默认表 + 配置表深合并。
 * 配置表支持省略 label（只写 hint），反之亦然。
 */
export function resolveTagTable(config = {}) {
  const raw = config?.tags?.table
  const table = {}
  for (const [id, entry] of Object.entries(DEFAULT_TAG_TABLE)) table[id] = { ...entry }
  if (!raw || typeof raw !== 'object') return table
  for (const [id, entry] of Object.entries(raw)) {
    const key = String(id).trim()
    if (!key) continue
    const base = table[key] ?? { label: key, hint: '' }
    if (typeof entry === 'string') {
      table[key] = { ...base, hint: entry }
    } else if (entry && typeof entry === 'object') {
      table[key] = {
        label: typeof entry.label === 'string' && entry.label ? entry.label : base.label,
        hint: typeof entry.hint === 'string' && entry.hint ? entry.hint : base.hint,
      }
    }
  }
  return table
}

/**
 * 这条消息的标签（string[]，稳定有序、无重复）。
 *
 * @param {object} message QqMessage
 * @param {object} config 完整配置
 * @param {object} [ctx]
 *   - stats: { total:number, today:number } 该用户的发言统计（含当前这条）
 *   - statsOf: (userId) => { total, today } 懒取版本，优先于 stats
 * @returns {string[]}
 */
export function tagsOf(message, config = {}, ctx = {}) {
  if (config?.tags?.enabled === false) return []

  const uid = String(message?.userId ?? '')
  const gid = message?.scene === 'group'
    ? String(message?.groupId ?? '')
    : (message?.groupId ? String(message.groupId) : '')
  const tagsCfg = config?.tags ?? {}
  const users = tagsCfg.users && typeof tagsCfg.users === 'object' ? tagsCfg.users : {}
  const groups = tagsCfg.groups && typeof tagsCfg.groups === 'object' ? tagsCfg.groups : {}

  const out = []
  const add = (tag) => {
    const text = String(tag ?? '').trim()
    if (text && !out.includes(text)) out.push(text)
  }

  // ① 人身上的标签（主人手调的，最准）
  if (uid && Object.prototype.hasOwnProperty.call(users, uid)) {
    for (const tag of toTagList(users[uid])) add(tag)
  }
  // ② 群上的标签
  if (gid && Object.prototype.hasOwnProperty.call(groups, gid)) {
    for (const tag of toTagList(groups[gid])) add(tag)
  }

  // ③ 自动标签。统计是外部注入的；拿不到就只输出配置标签，绝不自己猜。
  const stats = resolveStats(ctx, uid)
  const auto = tagsCfg.auto && typeof tagsCfg.auto === 'object' ? tagsCfg.auto : {}
  if (stats) {
    const total = numOr(stats.total, 0)
    const today = numOr(stats.today, 0)
    if (auto.newcomer !== false && total <= 1) add('newcomer')
    const frequentAfter = Math.max(0, numOr(auto.frequentAfterMsgs, DEFAULT_TAGS.auto.frequentAfterMsgs))
    if (frequentAfter > 0 && today >= frequentAfter) add('frequent')
  }

  const maxTags = Math.max(0, numOr(tagsCfg.maxTags, DEFAULT_TAGS.maxTags))
  return maxTags > 0 ? out.slice(0, maxTags) : out
}

/** 统计来源：函数优先，其次直接给对象。 */
function resolveStats(ctx, uid) {
  try {
    if (typeof ctx?.statsOf === 'function') {
      const value = ctx.statsOf(uid)
      return value && typeof value === 'object' ? value : null
    }
    if (ctx?.stats && typeof ctx.stats === 'object') return ctx.stats
  } catch {
    // 统计拿不到不影响贴标签，静默降级
  }
  return null
}

/**
 * 标签 → 给提示词看的一行文字。
 * 有 hint 用 hint（「这个人是老朋友，可以随便开点玩笑」），
 * 没登记的标签原样输出（主人自己加的「技术群」之类，原词就是信息）。
 *
 * @param {string[]} tags
 * @param {object} [options]
 *   - table: 直接给一张表（resolveTagTable 的结果）
 *   - config: 给整份配置，内部自己合并表
 * @returns {string} 空标签时返回 ''
 */
export function renderTags(tags, options = {}) {
  if (!Array.isArray(tags) || tags.length === 0) return ''
  const table = options?.table ?? resolveTagTable(options?.config ?? {})
  const hints = []
  for (const tag of tags) {
    const key = String(tag ?? '').trim()
    if (!key) continue
    const entry = table[key]
    const hint = typeof entry?.hint === 'string' && entry.hint ? entry.hint : key
    if (!hints.includes(hint)) hints.push(hint)
  }
  return hints.join('；')
}

/** 本地日期键（按宿主时区分天，和「今天说了多少」的直觉一致）。 */
function dayKeyOf(at) {
  const date = new Date(at)
  const pad = (num) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 一个极简的发言统计器（给 pipeline 记账用，配合 ctx.statsOf 喂给 tagsOf）。
 * 只有内存计数，不落盘 —— 重启后新人重新变新人，可接受（统计不是记忆）。
 *
 * record() 返回**含当前这条**的统计；pipeline 顺序：
 *   const stats = ledger.record(message.userId)
 *   const tags = tagsOf(message, config, { stats })
 */
export function createTagLedger({ now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now()
  /** @type {Map<string, {total:number, day:string, today:number}>} */
  const users = new Map()

  const stateOf = (uid, at) => {
    let state = users.get(uid)
    if (!state) {
      state = { total: 0, day: dayKeyOf(at), today: 0 }
      users.set(uid, state)
    } else {
      const day = dayKeyOf(at)
      if (state.day !== day) {
        state.day = day
        state.today = 0
      }
    }
    return state
  }

  return {
    record(userId, at = clock()) {
      const uid = String(userId ?? '')
      if (!uid) return { total: 0, today: 0 }
      const state = stateOf(uid, numOr(at, clock()))
      state.total += 1
      state.today += 1
      return { total: state.total, today: state.today }
    },
    statsOf(userId, at = clock()) {
      const uid = String(userId ?? '')
      if (!uid) return { total: 0, today: 0 }
      const state = stateOf(uid, numOr(at, clock()))
      return { total: state.total, today: state.today }
    },
    reset(userId) {
      if (userId === undefined) users.clear()
      else users.delete(String(userId))
    },
  }
}
