/**
 * Interesting：兴趣值（主人的硬要求，DESIGN §7）。
 *
 * 需求原文：
 *   > 可以对指定的人/群调节兴趣。0.00~1，越大，DSH 收到消息的概率越大。
 *   > 被 @ 时，只要 p（兴趣）大于 0.1，就一定回。反之按「p(5*兴趣)」概率回复。
 *
 * 为什么要它：群里别当话痨。茶茶酱不是客服，没必要每条消息都接；
 * 但被点名（@）时至少要「很大概率」回，因为那是有事找她。
 *
 * 严格保持纯函数：随机数一律 rng 注入，测试里不许出现真随机（不然挂 CI 的是运气）。
 */

/** 默认值，字段名与 config.js / DESIGN §5 一致。 */
export const DEFAULT_INTEREST = {
  default: 0.5,
  users: {},
  groups: {},
  atSureThreshold: 0.1,
  atMultiplier: 5,
  unmentionedFactor: 0.35,
}

function clamp01(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(1, Math.max(0, num))
}

function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 把 config.interest 归一（容忍面板写进来字符串/空值）。 */
export function resolveInterestConfig(config) {
  const source = config?.interest && typeof config.interest === 'object' ? config.interest : {}
  return {
    default: clamp01(source.default, DEFAULT_INTEREST.default),
    users: source.users && typeof source.users === 'object' ? source.users : {},
    groups: source.groups && typeof source.groups === 'object' ? source.groups : {},
    atSureThreshold: numOr(source.atSureThreshold, DEFAULT_INTEREST.atSureThreshold),
    atMultiplier: numOr(source.atMultiplier, DEFAULT_INTEREST.atMultiplier),
    unmentionedFactor: numOr(source.unmentionedFactor, DEFAULT_INTEREST.unmentionedFactor),
  }
}

/**
 * 这个用户/这个群当前的兴趣值，0~1。
 *
 * 优先级：interest.users[uid] > interest.groups[gid] > interest.default
 * （个人配置优先于群配置：主人特意给某个人调过，就以个人为准。）
 *
 * @param {string} userId
 * @param {string} groupId 私聊传 '' / undefined
 * @param {object} config
 * @returns {number} 0~1
 */
export function interestOf(userId, groupId, config = {}) {
  const interest = resolveInterestConfig(config)
  const uid = String(userId ?? '')
  const gid = String(groupId ?? '')

  // 注意用 hasOwnProperty：`??` 会把合法值 0 当成「没有」是错的，
  // 但 users[uid] = null 这种脏数据要被跳过，所以先判 key 再取值。
  if (uid && Object.prototype.hasOwnProperty.call(interest.users, uid)) {
    return clamp01(interest.users[uid], interest.default)
  }
  if (gid && Object.prototype.hasOwnProperty.call(interest.groups, gid)) {
    return clamp01(interest.groups[gid], interest.default)
  }
  return interest.default
}

/**
 * 掷骰子决定这条消息回不回（被 @ 时反而大概率回）。
 *
 * @param {object} message QqMessage
 * @param {number} interest 0~1（一般来自 interestOf）
 * @param {object} [options]
 *   - rng: () => number   随机源，默认 Math.random（测试必须注入）
 *   - atSureThreshold / atMultiplier / unmentionedFactor：可从 config.interest 透传
 * @returns {{reply:boolean, p:number, reason:'at-sure'|'at-roll'|'chime-roll'}}
 */
export function shouldReply(message, interest, options = {}) {
  const rng = typeof options?.rng === 'function' ? options.rng : Math.random
  const atSureThreshold = numOr(options?.atSureThreshold, DEFAULT_INTEREST.atSureThreshold)
  const atMultiplier = numOr(options?.atMultiplier, DEFAULT_INTEREST.atMultiplier)
  const unmentionedFactor = numOr(options?.unmentionedFactor, DEFAULT_INTEREST.unmentionedFactor)
  const p0 = clamp01(interest, 0)

  if (message?.mentionsMe === true) {
    // 被点名：兴趣过了门槛就必回，别让主人觉得「叫了不动」
    if (p0 > atSureThreshold) {
      return { reply: true, p: 1, reason: 'at-sure' }
    }
    // 没过门槛：按 5 倍兴趣掷骰（0.1 兴趣也有 50% 机会）
    const p = Math.min(1, atMultiplier * p0)
    return { reply: rng() < p, p, reason: 'at-roll' }
  }

  // 没 @：兴趣打个折再掷骰，避免群里话痨
  const p = Math.min(1, p0 * unmentionedFactor)
  return { reply: rng() < p, p, reason: 'chime-roll' }
}
