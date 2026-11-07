/**
 * 模式（Mode）—— 所有"好玩但费钱"的功能的总开关。
 *
 * 主人原话：
 *   「我可能有时候要她纯干活，加日程影响工作加大消耗，但是日程真非常好玩」
 *
 * 所以这不是"每个功能一个开关"，而是一个**顶层概念**：
 *
 *   companion（陪伴）  日程生成+注入、情绪注入、主动消息、表情包、盗图、关系账本 —— 全开
 *   work（纯干活）     日程**根本不生成**（省一次模型调用）、**不注入**（省上下文 token），
 *                      情绪/关系只记账不外露，不主动搭话，表情包只发不收
 *
 * ⚠️ 关键区别：work 模式下日程是**不生成**，不是"生成了但不展示"——
 *    后者照样白花钱，而主人的抱怨正是"加大消耗"。
 *
 * 开关有三层，优先级从高到低：
 *   peers[peerKey]（某个群/某个人单独设） > default（全局默认） > 'companion'
 *
 * peerKey 的形状和 pipeline 的会话 key 同构：
 *   私聊 → `private-<QQ号>`
 *   群聊 → `group-<群号>`   ← 注意群按群设，不按"群里是谁在说"设
 */

export const MODE = {
  COMPANION: 'companion',
  WORK: 'work',
}

export const MODES = [MODE.COMPANION, MODE.WORK]

/** 每个功能在哪种模式下活着。`true` = 跑，`false` = 完全跳过，`'record'` = 只记账不外露。 */
const MATRIX = {
  /** 日程：生成 + 注入（最费钱的一项） */
  schedule: { companion: true, work: false },
  /** 当日状态（energy/mood/note）：注入 */
  life: { companion: true, work: 'record' },
  /** 情绪：注入到上下文 */
  emotion: { companion: true, work: 'record' },
  /** 主动消息（她主动来找你） */
  proactive: { companion: true, work: false },
  /** 表情包：发（句内标记） */
  memeSend: { companion: true, work: 'record' },
  /** 盗图：收别人的图 */
  memeSteal: { companion: true, work: false },
  /** 关系账本 */
  relation: { companion: true, work: 'record' },
}

/** 把 peerKey 归一化：群聊只保留群号（一个群一个模式，不按发言人拆）。 */
export function normalizePeerKey(peerKey) {
  const text = String(peerKey ?? '').trim()
  if (!text) return ''
  const group = /^group-(.+)$/.exec(text)
  if (group) return `group-${group[1].split('-').slice(0, 1).join('')}`
  return text
}

/**
 * 这个对话该用哪个模式。
 * @param {string} peerKey  'private-123' / 'group-456' / 'group-456-owner'
 * @param {object} config   整份配置
 * @returns {'companion'|'work'}
 */
export function resolveMode(peerKey, config = {}) {
  const modes = config?.modes ?? {}
  const peers = modes?.peers ?? {}
  const rawKey = String(peerKey ?? '')
  const key = normalizePeerKey(rawKey)

  // ① 原始键精确命中（用户就是照这个形状写的）
  if (MODES.includes(peers[rawKey])) return peers[rawKey]

  // ② 归一化后的键命中（群聊 → group-<群号>）
  if (key && MODES.includes(peers[key])) return peers[key]

  // ③ 把 peers 里的键也归一化后比对 —— 这样
  //    「给 group-333-owner 设成 work」对 group-333-guest 同样生效（模式是按群的，不按发言人）。
  if (key) {
    for (const [peerId, mode] of Object.entries(peers)) {
      if (!MODES.includes(mode)) continue
      if (normalizePeerKey(peerId) === key) return mode
    }
  }

  const fallback = modes?.default
  return MODES.includes(fallback) ? fallback : MODE.COMPANION
}

/**
 * 这个功能在这个对话里该怎么跑。
 *
 * 三层判定（高 → 低），和 config.features / config.modes 的分工一致：
 *   ① features.peers[peerKey][功能]  —— 某个群/某个人单独开关（最具体）
 *   ② features[功能]                 —— 全局总开关（一票否决）
 *   ③ modes 矩阵                     —— 模式下「正常跑 / 只记账 / 不跑」
 *
 * @returns {boolean|'record'} true = 正常跑；'record' = 只记不外露；false = 完全跳过
 */
export function featureMode(feature, peerKey, config = {}) {
  // ① 按对话覆盖
  const peers = config?.features?.peers
  if (peers && typeof peers === 'object') {
    const key = normalizePeerKey(peerKey)
    const own = (key ? peers[key] : undefined) ?? peers[String(peerKey ?? '')]
    if (own && typeof own === 'object' && typeof own[feature] === 'boolean') {
      // 显式打开 = 正常跑（绕过模式的 'record'，主人说开就是要它真的动）
      return own[feature] ? true : false
    }
  }

  // ② 全局总开关：false 就是彻底停
  if (config?.features?.[feature] === false) return false

  // ③ 模式矩阵
  const mode = resolveMode(peerKey, config)
  const row = MATRIX[feature]
  if (!row) return true
  return row[mode] ?? false
}

/** 方便调用的三个谓词。 */
export function isOn(feature, peerKey, config) {
  return featureMode(feature, peerKey, config) === true
}

export function isRecordOnly(feature, peerKey, config) {
  return featureMode(feature, peerKey, config) === 'record'
}

export function isOff(feature, peerKey, config) {
  return featureMode(feature, peerKey, config) === false
}

/** 面板用：把所有功能和它们在各模式下的状态摊开。 */
export function modeMatrix() {
  return Object.entries(MATRIX).map(([feature, row]) => ({ feature, ...row }))
}
