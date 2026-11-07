/**
 * moderation.js · L2 Controller 群管（自动审查）
 *
 * 职责：扫一批群消息，命中 `moderation.hotKeywords`（广告 / 涉黄 / 涉诈）就给出
 * 「建议禁言」的动作对象，交给 pipeline 去决定要不要真调 QQ API。
 *
 * 三条硬规矩：
 *  ① **纯函数优先**：这里不 import 任何网络/QQ 模块，inspectBatch 只吃数据吐数据。
 *  ② **群主 / 管理员 / 主人永不禁言**：发言人 role 必须是 member 才可能被建议禁言；
 *     role 缺失或未知一律保守跳过（宁可漏，不可错杀）。
 *  ③ 禁言时长钳制在 `[1, moderation.maxBanMinutes]`；没给就用 `defaultBanMinutes`。
 *     0 或负数按 1 处理（钳制是硬边界），超过上限按上限。
 *
 * 为什么默认热词表不直接生效：
 *   DESIGN §5 里 `hotKeywords: []` 是空数组，语义应该是「主人没配 = 不启用热词」。
 *   所以这里只在**完全没给 hotKeywords（undefined）**时才回落到 DEFAULT_HOT_KEYWORDS；
 *   显式传 [] 就当没开。组装层想把默认词表写进 config 可以自己 spread。
 */

/** 热词分类。 */
export const MODERATION_CATEGORY = {
  AD: 'ad',
  PORN: 'porn',
  FRAUD: 'fraud',
  HOT: 'hot',
}

export const CATEGORY_LABELS = {
  ad: '广告',
  porn: '涉黄',
  fraud: '涉诈',
  hot: '违规',
}

/**
 * 内置热词表（给组装层当默认值用；inspectBatch 只在 hotKeywords 为 undefined 时用它）。
 * 每条可以写 `words: []` 一次配多个，也可以一条一个词。
 */
export const DEFAULT_HOT_KEYWORDS = [
  { category: MODERATION_CATEGORY.AD, words: ['加微信', '微信号', '私聊加我', '兼职日结', '刷单', '扫码进群', '点击链接', '推广优惠'] },
  { category: MODERATION_CATEGORY.PORN, words: ['裸聊', '福利姬', '约炮', '色情', '成人视频', '看片'] },
  { category: MODERATION_CATEGORY.FRAUD, words: ['投资返利', '杀猪盘', '博彩', '网赌', '验证码给我', '帮我转账'] },
]

function numberOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 分类归一化：支持英文 id 和常见中文写法。 */
function normalizeCategory(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return MODERATION_CATEGORY.HOT
  if (value === 'ad' || value === '广告' || value === 'advertise' || value === 'advertisement') return MODERATION_CATEGORY.AD
  if (value === 'porn' || value === '色情' || value === '涉黄' || value === 'yellow') return MODERATION_CATEGORY.PORN
  if (value === 'fraud' || value === '诈骗' || value === '涉诈' || value === 'scam') return MODERATION_CATEGORY.FRAUD
  return MODERATION_CATEGORY.HOT
}

/** QQ 群成员角色归一化。未知返回 ''（调用方要保守跳过）。 */
export function normalizeRole(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'owner' || value === '群主' || value === '群 owner') return 'owner'
  if (value === 'admin' || value === 'administrator' || value === '管理员') return 'admin'
  if (value === 'member' || value === '成员' || value === '普通成员') return 'member'
  return ''
}

/**
 * 把配置里的 hotKeywords 归一化成规则列表：
 *   - 字符串                          → { keyword: 'x', category: 'hot', minutes: null }
 *   - { keyword|word|text, category, minutes } → 单条
 *   - { words: [...], category, minutes }      → 多条
 * 时间单位语义：minutes 只给「这一条规则」覆盖默认时长，最终仍会被钳制。
 *
 * @param {unknown} hotKeywords
 * @returns {Array<{keyword: string, category: string, minutes: number|null}>}
 */
export function normalizeHotKeywords(hotKeywords) {
  const list = Array.isArray(hotKeywords) ? hotKeywords : []
  const rules = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      const keyword = entry.trim()
      if (keyword) rules.push({ keyword, category: MODERATION_CATEGORY.HOT, minutes: null })
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const category = normalizeCategory(entry.category)
    const minutesRaw = entry.minutes === undefined || entry.minutes === null ? null : Number(entry.minutes)
    const minutes = Number.isFinite(minutesRaw) ? minutesRaw : null
    const words = Array.isArray(entry.words)
      ? entry.words
      : [entry.keyword ?? entry.word ?? entry.text]
    for (const word of words) {
      if (typeof word !== 'string') continue
      const keyword = word.trim()
      if (keyword) rules.push({ keyword, category, minutes })
    }
  }
  return rules
}

/** 取出会话主人 QQ：兼容 config.owner.qq / config.owner / config.ownerQq / moderation.ownerQq。 */
function resolveOwnerQq(root, section) {
  const candidates = [
    root?.owner?.qq,
    typeof root?.owner === 'string' ? root.owner : '',
    root?.ownerQq,
    section?.ownerQq,
    section?.owner?.qq,
  ]
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value) return value
  }
  return ''
}

/**
 * 解析配置：既接受「整份 config」（有 moderation 段 + owner），也接受「只有 moderation 段」。
 *
 * @param {object} config
 * @returns {object}
 */
function resolveConfig(config) {
  const root = config && typeof config === 'object' ? config : {}
  const section = root.moderation && typeof root.moderation === 'object' ? root.moderation : root
  const rawHotKeywords = section.hotKeywords === undefined ? DEFAULT_HOT_KEYWORDS : section.hotKeywords
  return {
    root,
    section,
    rules: normalizeHotKeywords(rawHotKeywords),
    banEnabled: section.banEnabled !== false,
    watchAll: section.watchAll !== false,
    defaultBanMinutes: numberOr(section.defaultBanMinutes, 10),
    maxBanMinutes: Math.max(1, Math.floor(numberOr(section.maxBanMinutes, 60))),
    ownerQq: resolveOwnerQq(root, section),
  }
}

/** 时长钳制（内部版，已解析配置）。 */
function clampMinutes(minutes, resolved) {
  const fallback = Math.max(1, Math.floor(numberOr(resolved.defaultBanMinutes, 10)))
  const max = Math.max(1, Math.floor(numberOr(resolved.maxBanMinutes, 60)))
  const provided = minutes !== undefined && minutes !== null && Number.isFinite(Number(minutes))
  const raw = provided ? Math.floor(Number(minutes)) : fallback
  return Math.min(max, Math.max(1, raw))
}

/**
 * 禁言时长钳制在 `[1, maxBanMinutes]`；没给就用 defaultBanMinutes。
 * 0 / 负数 → 1（硬下界），超过上限 → 上限。
 *
 * @param {number|undefined|null} minutes
 * @param {object} [config] 整份 config 或 moderation 段
 * @returns {number} 整数分钟
 */
export function clampBanMinutes(minutes, config = {}) {
  return clampMinutes(minutes, resolveConfig(config))
}

/** 内部：在一段文本里找命中的规则（大小写不敏感，中文不受影响）。 */
function findHits(text, resolved) {
  const source = String(text ?? '')
  if (!source) return []
  const lower = source.toLowerCase()
  const seen = new Set()
  const hits = []
  for (const rule of resolved.rules) {
    const needle = rule.keyword.toLowerCase()
    if (!needle || seen.has(needle)) continue
    if (!lower.includes(needle)) continue
    seen.add(needle)
    hits.push({
      keyword: rule.keyword,
      category: rule.category,
      minutes: rule.minutes,
      label: CATEGORY_LABELS[rule.category] ?? '违规',
    })
  }
  return hits
}

/**
 * 纯函数：一段文本命中了哪些热词。
 *
 * @param {string} text
 * @param {object} [config] 整份 config 或 moderation 段
 * @returns {Array<{keyword: string, category: string, minutes: number|null, label: string}>}
 */
export function matchHotKeywords(text, config = {}) {
  return findHits(text, resolveConfig(config))
}

/**
 * 判断这条消息的发言人能不能被建议禁言；返回跳过理由（空字符串 = 可以处理）。
 * 这里是权限反向测试的核心：群主 / 管理员 / 主人 / 角色未知 全部返回非空。
 */
function skipReasonFor({ role, userId, ownerQq, selfId }) {
  if (role === 'owner') return '群主，永不禁言'
  if (role === 'admin') return '管理员，永不禁言'
  if (ownerQq && userId === ownerQq) return '主人，永不禁言'
  if (selfId && userId === selfId) return '机器人自己，跳过'
  if (role !== 'member') return `角色未知（${role || '空'}），保守跳过`
  return ''
}

/** 汇总一条建议里命中的分类 / 关键词，做成给人看的 reason。 */
function describeHits(suggest) {
  const labels = [...new Set(suggest.hits.map((hit) => hit.label))]
  const keywords = [...new Set(suggest.hits.map((hit) => hit.keyword))]
  const shown = keywords.slice(0, 3).join('、')
  const more = keywords.length > 3 ? '等' : ''
  return `命中${labels.join('/')}关键词「${shown}」${more}`
}

/**
 * 审查一批群消息。
 *
 * @param {Array<{userId?: string, role?: string, text?: string, mentionsMe?: boolean, selfId?: string, sender?: {id?: string, role?: string}}>} messages
 * @param {object} [config] 整份 config（用 moderation 段 + owner.qq）或单独的 moderation 段
 * @returns {{suggest: Array<{userId: string, minutes: number, reason: string}>, reason: string}}
 *   suggest：建议禁言的动作对象（不含真正的 QQ API 调用，交给 pipeline）；
 *   reason：整批的判定摘要（含跳过的人/原因，方便主人查为什么没处理）。
 */
export function inspectBatch(messages, config = {}) {
  const resolved = resolveConfig(config)
  const list = Array.isArray(messages) ? messages : []
  const suggestByUser = new Map()
  const skipped = []
  let inspected = 0
  let hitMessages = 0

  for (const message of list) {
    if (!message || typeof message !== 'object') continue
    const userId = String(message.userId ?? message.sender?.id ?? '').trim()
    if (!userId) continue
    const text = String(message.text ?? '')
    if (!text) continue
    // watchAll=false：不盯全部消息，只审查被 @ 的（降低打扰）
    if (!resolved.watchAll && !message.mentionsMe) continue
    inspected += 1

    const hits = findHits(text, resolved)
    if (hits.length === 0) continue
    hitMessages += 1

    const role = normalizeRole(message.role ?? message.sender?.role)
    const skippedReason = skipReasonFor({
      role,
      userId,
      ownerQq: resolved.ownerQq,
      selfId: String(message.selfId ?? '').trim(),
    })
    if (skippedReason) {
      skipped.push(`${userId}（${skippedReason}）`)
      continue
    }
    if (!resolved.banEnabled) {
      skipped.push(`${userId}（禁言开关关闭）`)
      continue
    }

    // 规则自带的时长取最严（最大），没带就用 defaultBanMinutes，再统一钳制
    const explicitMinutes = hits.filter((hit) => hit.minutes !== null).map((hit) => hit.minutes)
    const minutes = clampMinutes(
      explicitMinutes.length > 0 ? Math.max(...explicitMinutes) : undefined,
      resolved,
    )

    const existing = suggestByUser.get(userId)
    if (existing) {
      existing.minutes = Math.max(existing.minutes, minutes)
      existing.hits.push(...hits)
    } else {
      suggestByUser.set(userId, {
        userId,
        minutes,
        firstSeen: suggestByUser.size,
        hits: hits.slice(),
      })
    }
  }

  // 按第一次命中的顺序出建议（稳定、可预期，不按 Map 插入之外的顺序瞎排）
  const suggest = [...suggestByUser.values()]
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .map((item) => ({
      userId: item.userId,
      minutes: item.minutes,
      reason: describeHits(item),
    }))

  const parts = []
  if (inspected === 0) {
    parts.push('没有可审查的文本消息')
  } else {
    parts.push(`审查 ${inspected} 条消息，命中热词 ${hitMessages} 条`)
  }
  if (!resolved.watchAll) parts.push('（watchAll=false，只审查被 @ 的消息）')
  if (!resolved.banEnabled && hitMessages > 0) parts.push('禁言开关已关闭，未生成建议')
  else if (suggest.length > 0) parts.push(`建议禁言 ${suggest.length} 人`)
  if (skipped.length > 0) {
    parts.push(`跳过 ${skipped.length} 人：${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? ' 等' : ''}`)
  }

  return { suggest, reason: parts.join('；') }
}
