/**
 * 路由判定：**全纯函数，零 IO，零依赖**。
 *
 * 为什么必须纯：这里的每条规则都要用真群真号验证，混进 IO 就只能「上线试试」。
 * v2 的血泪：路由里掺了网络调用，一个身份判断 bug 要等十分钟才复现一次。
 * 纯函数能一次跑几百条用例，这就是 DESIGN §9「安全相关必须有反向测试」的前提。
 *
 * 判定顺序（早停，与 DESIGN §4 / 任务书一致）：
 *   1. 自己发的        → ignore  防自问自答死循环
 *   2. 空消息          → ignore  纯空白、无媒体、也没 @
 *   3. 黑名单三档      → 优先级**高于**主人判定（主人也能把自己关起来）
 *   4. 主人            → handle(owner)  含 owner.aliases 里的其它号
 *   5. 群白名单        → access.groups 非空时只认名单
 *   6. 单群黑名单      → group.profiles[gid].blockedUsers
 *                        （v2 踩过：这层以前只在「群观察」阶段查，被 @ 时照样回；
 *                          必须在路由层也拦，否则「在这个群拉黑他」形同虚设）
 *   7. 群内：@ → handle(guest)，没 @ → observe（攒上下文，不立刻回）
 *   8. 私聊            → handle(guest)，仍受 strangersCanChat 约束
 *
 * 返回 Decision（DESIGN §3）：{ action, role, mode, reason, priority }。
 * 额外带一个 chime（要不要主动搭话），chat-only 档为 false。
 */

/** 判定结果 */
export const ACTION = {
  /** 进对话管线 */
  HANDLE: 'handle',
  /** 只记下来当上下文，不回复 */
  OBSERVE: 'observe',
  /** 完全丢弃 */
  IGNORE: 'ignore',
}

/** 角色 */
export const ROLE = {
  OWNER: 'owner',
  GUEST: 'guest',
}

/** 黑名单档位（access.blocklist[].level） */
export const BLOCK_LEVEL = {
  /** 被 @ 也不理 */
  NO_AT: 'no-at',
  /** 可以闲聊，但不主动搭话、不给任何工具 */
  CHAT_ONLY: 'chat-only',
  /** 群聊私聊全拒 */
  BLOCK: 'block',
}

/**
 * 决定观望时长的那一档（DESIGN §3 Decision.priority）。
 * route 只负责「定档」，具体毫秒数由 observe.js 查表 ——
 * 这样主人改 observe.* 配置时不用动路由。
 */
export const PRIORITY = {
  /** 秒回：主人 */
  INSTANT: 'instant',
  /** 群聊被 @：固定 10 秒 */
  AT: 'at',
  /** 非主人私聊：首次 20~60 秒，同一坨 5 秒 */
  PRIVATE: 'private',
  /** 群聊没 @：20~60 秒观望，窗口结束一次性投喂 */
  OBSERVE: 'observe',
}

/** 会话权限档（传给 Mind） */
export const MODE = {
  READ_ONLY: 'read-only',
  WORKSPACE_WRITE: 'workspace-write',
  DANGER_FULL_ACCESS: 'danger-full-access',
}

/** 陌生人/非主人**永远**只读：权限这种东西不给默认值，要显式给。 */
const GUEST_MODE = MODE.READ_ONLY
const MODE_SET = new Set([MODE.READ_ONLY, MODE.WORKSPACE_WRITE, MODE.DANGER_FULL_ACCESS])

/** 拼一条 Decision，保证字段齐全（漏字段会让下游 switch 落空，很难查）。 */
function decision(action, reason, { role = ROLE.GUEST, mode = GUEST_MODE, priority = PRIORITY.OBSERVE, chime = false } = {}) {
  return { action, role, mode, reason, priority, chime }
}

function modeOr(value, fallback) {
  return MODE_SET.has(value) ? value : fallback
}

/** 黑名单档位归一：拼错的档位按最严格处理（安全优先，宁可误关不可漏放）。 */
function normalizeBlockLevel(level) {
  const value = String(level ?? '').trim().toLowerCase()
  if (!value) return BLOCK_LEVEL.BLOCK
  if (value === BLOCK_LEVEL.NO_AT || value === BLOCK_LEVEL.CHAT_ONLY || value === BLOCK_LEVEL.BLOCK) return value
  return BLOCK_LEVEL.BLOCK
}

/**
 * 在配置里找这个人的黑名单记录。
 * 兼容两种写法：数组 `[{ qq, level }]`（配置 schema）和对象 `{ qq: level }`（手改配置时省事）。
 * 无论哪种，都归一成 `{ qq, level }`。
 */
export function findBlock(blocklist, userId) {
  const id = String(userId ?? '')
  if (!id) return null
  if (Array.isArray(blocklist)) {
    for (const entry of blocklist) {
      if (entry === null || entry === undefined) continue
      if (typeof entry === 'string' || typeof entry === 'number') {
        if (String(entry) === id) return { qq: id, level: BLOCK_LEVEL.BLOCK }
        continue
      }
      if (String(entry.qq ?? entry.id ?? '') === id) {
        return { ...entry, qq: id, level: normalizeBlockLevel(entry.level) }
      }
    }
    return null
  }
  if (blocklist && typeof blocklist === 'object') {
    if (Object.prototype.hasOwnProperty.call(blocklist, id)) {
      return { qq: id, level: normalizeBlockLevel(blocklist[id]) }
    }
  }
  return null
}

/**
 * 这个 QQ 号是不是主人（owner.qq 或 owner.aliases）。
 * aliases 兼容 `['123', ...]` 和 `[{ qq: '123' }, ...]` 两种写法。
 */
export function isOwnerId(userId, config) {
  const id = String(userId ?? '').trim()
  if (!id) return false
  const owner = config?.owner ?? {}
  const ownerQq = String(owner.qq ?? '').trim()
  if (ownerQq && id === ownerQq) return true
  const aliases = Array.isArray(owner.aliases) ? owner.aliases : []
  for (const alias of aliases) {
    if (alias === null || alias === undefined) continue
    const value = typeof alias === 'string' || typeof alias === 'number'
      ? String(alias)
      : String(alias.qq ?? alias.id ?? '')
    if (value.trim() && value.trim() === id) return true
  }
  return false
}

/**
 * 主入口：一条 QqMessage → Decision。
 * @param {object} message 归一化后的消息（DESIGN §3 QqMessage）
 * @param {object} config 完整配置（缺字段全部有兜底，不会 TypeError）
 * @returns {{action:string, role:string, mode:string, reason:string, priority:string, chime:boolean}}
 */
export function decideRoute(message, config = {}) {
  if (!message || typeof message !== 'object') return decision(ACTION.IGNORE, 'invalid-message')

  const access = config?.access ?? {}
  const userId = String(message.userId ?? '')
  const scene = message.scene === 'group' ? 'group' : 'private'
  const groupId = String(message.groupId ?? '')
  const media = Array.isArray(message.media) ? message.media : []
  const text = typeof message.text === 'string' ? message.text : ''
  const mentionsMe = message.mentionsMe === true
  const selfId = String(message.selfId || config?.qq?.selfId || '')

  // 1. 自己发的：NapCat 某些配置会把机器人自己的消息也上报，不拦就是自问自答死循环
  if (selfId && userId === selfId) {
    return decision(ACTION.IGNORE, 'self')
  }

  // 2. 空消息：纯空白、没有媒体、也没 @ —— 处理它没有任何意义
  if (!text.trim() && media.length === 0 && !mentionsMe) {
    return decision(ACTION.IGNORE, 'empty')
  }

  // 3. 黑名单（优先于主人判定）
  const block = findBlock(access.blocklist, userId)
  if (block) {
    if (block.level === BLOCK_LEVEL.BLOCK) {
      return decision(ACTION.IGNORE, 'blocked')
    }
    if (block.level === BLOCK_LEVEL.NO_AT && mentionsMe) {
      // no-at：被 @ 也不理，但没 @ 时仍可当上下文观察
      return decision(ACTION.IGNORE, 'blocked-at')
    }
    // chat-only / no-at（没被 @）：当普通人处理，但 chat-only 不许主动搭话
    return decideAsGuest(message, config, access, {
      reasonPrefix: block.level === BLOCK_LEVEL.CHAT_ONLY ? 'chat-only' : 'guest',
      chatOnly: block.level === BLOCK_LEVEL.CHAT_ONLY,
    })
  }

  // 4. 主人：私聊 / 被 @ 秒回；**群里没 @ 也进观望**（ownerGroupMs，默认 5 秒）。
  //    主人的原话只给了「主人私聊秒回」，群聊没开这个口子 —— 主人在群里跟别人聊天时
  //    句句秒回会很吵，而且每句都是一次模型调用（烧钱）。真想叫她，用 @。
  if (isOwnerId(userId, config)) {
    const mode = scene === 'group'
      ? modeOr(access.defaultGroupMode, MODE.READ_ONLY)
      : modeOr(access.defaultPrivateMode, MODE.DANGER_FULL_ACCESS)
    const quietInGroup = scene === 'group' && !mentionsMe
    const reason = scene === 'group'
      ? (mentionsMe ? 'owner:group-at' : 'owner:group-observe')
      : 'owner'
    return decision(ACTION.HANDLE, reason, {
      role: ROLE.OWNER,
      mode,
      priority: quietInGroup ? PRIORITY.OBSERVE : PRIORITY.INSTANT,
      chime: true,
    })
  }

  // 5-8. 其他人
  return decideAsGuest(message, config, access, { reasonPrefix: 'guest', chatOnly: false })
}

/**
 * 非主人分支。
 * @param {object} message
 * @param {object} config
 * @param {object} access config.access
 * @param {{reasonPrefix:string, chatOnly:boolean}} options
 */
function decideAsGuest(message, config, access, { reasonPrefix, chatOnly }) {
  const userId = String(message.userId ?? '')
  const mentionsMe = message.mentionsMe === true
  const chime = chatOnly !== true

  if (message.scene === 'group') {
    const groupId = String(message.groupId ?? '')

    // 5. 群白名单：空 = 全管；非空 = 只认名单里的群
    const groups = Array.isArray(access.groups) ? access.groups.map((item) => String(item)) : []
    if (groups.length > 0 && !groups.includes(groupId)) {
      return decision(ACTION.IGNORE, 'group-not-allowed')
    }

    // 6. 单群黑名单（由群管工具/面板写进 group.profiles[群号].blockedUsers）
    const profile = config?.group?.profiles?.[groupId]
    const blockedUsers = Array.isArray(profile?.blockedUsers) ? profile.blockedUsers.map((item) => String(item)) : []
    if (blockedUsers.includes(userId)) {
      return decision(ACTION.IGNORE, 'group-blocked')
    }

    // 7. 群内 @：回；没 @：只观望（攒上下文，绝不主动插嘴）
    if (mentionsMe) {
      if (access.strangersCanChat === false) {
        return decision(ACTION.IGNORE, 'strangers-off')
      }
      return decision(ACTION.HANDLE, `${reasonPrefix}:group-at`, { priority: PRIORITY.AT, chime })
    }
    return decision(ACTION.OBSERVE, `${reasonPrefix}:group-observe`, { priority: PRIORITY.OBSERVE, chime: false })
  }

  // 8. 私聊：陌生人聊天开关只影响「回不回」，不影响权限（永远只读）
  if (access.strangersCanChat === false) {
    return decision(ACTION.IGNORE, 'strangers-off')
  }
  return decision(ACTION.HANDLE, reasonPrefix, { priority: PRIORITY.PRIVATE, chime })
}

/**
 * 去重器：按 message_id 挡掉重连抖动和 NapCat 重推（v1 坑 6）。
 * 固定容量，Map 的插入顺序天然就是淘汰顺序。
 * @param {number} capacity 最多记多少个 id
 */
export function createDeduper(capacity = 512) {
  const limit = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 512
  const seen = new Map()
  return {
    /** true = 第一次见（该处理）；false = 重复 */
    fresh(id) {
      const key = id === null || id === undefined ? '' : String(id)
      if (!key) return true // 没有 id 就没法去重，放行（丢消息比重复处理更糟）
      if (seen.has(key)) return false
      seen.set(key, Date.now())
      if (seen.size > limit) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
      return true
    },
    size() {
      return seen.size
    },
    clear() {
      seen.clear()
    },
  }
}

/**
 * 令牌桶限流：每个会话一个桶，窗口内最多 capacity 次。
 * 用途：同一会话一分钟最多回 N 条，防刷屏也防被 QQ 风控。
 * 语义沿用 v2：窗口到点**整桶回满**（不做平滑补充 —— 平滑会让「刚好卡点」的行为不可测）。
 * now 可注入，测试不用真等一分钟。
 *
 * @param {{capacity?:number, refillMs?:number}} options
 */
export function createRateLimiter({ capacity = 5, refillMs = 60000 } = {}) {
  const cap = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 5
  const refill = Number.isFinite(refillMs) && refillMs > 0 ? refillMs : 60000
  const buckets = new Map()
  return {
    /** true = 允许通过 */
    take(key, now = Date.now()) {
      const bucketKey = String(key ?? '')
      const at = Number.isFinite(now) ? now : Date.now()
      let bucket = buckets.get(bucketKey)
      if (!bucket) {
        bucket = { tokens: cap, at }
        buckets.set(bucketKey, bucket)
      }
      if (at - bucket.at >= refill) {
        bucket.tokens = cap
        bucket.at = at
      }
      if (bucket.tokens <= 0) return false
      bucket.tokens -= 1
      return true
    },
    reset(key) {
      if (key === undefined) buckets.clear()
      else buckets.delete(String(key))
    },
  }
}
