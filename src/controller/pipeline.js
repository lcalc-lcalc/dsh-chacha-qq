/**
 * Controller 总调度 —— 三层之间的中枢。
 *
 *   NapCat 帧 ──normalize──▶ QqMessage
 *                                │
 *                        去重 → 路由 → 安全体检
 *                                │
 *                    ┌───────────┴───────────┐
 *                    │                       │
 *              主人 / 被 @               其他人
 *                    │                       │
 *                立刻投喂              观望窗口攒批
 *                    │                       │
 *                    └───────────┬───────────┘
 *                                ▼
 *                        Interesting 掷骰
 *                                ▼
 *                          The Mind 跑一轮
 *                                ▼
 *                     节奏分片（<20 token / 2~5 秒）
 *                                ▼
 *                             QQ 发出
 *
 * 设计原则：
 *  - **每个下游模块都可以缺席**。分身们分头写的模块，谁没交付就降级跳过并记日志，
 *    绝不让一个模块缺失拖垮整条管线（旧版踩过：整个插件静默不加载，日志一片空白）。
 *  - **判断和动作分开**：route/interest/security/moderation 都是纯函数，返回"建议"；
 *    真正动手的只有这里。这样每一条规则都能单测。
 */
import fs from 'node:fs'
import path from 'node:path'

import { normalizeMessage, umoOf } from '../napcat/normalize.js'
import { ACTION, createDeduper, createRateLimiter, decideRoute } from './route.js'
import { isOn, resolveMode } from '../modes.js'
import { Outbox } from './outbox.js'
import { Inbound } from './inbound.js'
// 「问心情」和「算心情」是两个纯函数，实例只负责状态机 —— 这里直接拿纯函数用。
import { buildJudgePrompt, parseJudgeOutput } from './emotion.js'

/** 截断长文本给日志用。 */
function clip(text, max = 80) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 安全取一个可选模块的方法，不存在就返回 undefined 而不是抛错。 */
function call(object, method, ...args) {
  try {
    if (object && typeof object[method] === 'function') return object[method](...args)
  } catch {
    // 下游模块出错不许传染
  }
  return undefined
}

export class Controller {
  /**
   * @param {object} options
   * @param {object} options.ctx
   * @param {{get:()=>object, patch:(p:object)=>any}} options.store
   * @param {object} options.log
   * @param {object} options.gateway
   * @param {object} options.mind
   * @param {object} [options.route]      纯函数模块（默认用 ./route.js）
   * @param {object} [options.observe]    { ObservationWindow }
   * @param {object} [options.interest]
   * @param {object} [options.tags]
   * @param {object} [options.security]
   * @param {object} [options.emotion]
   * @param {object} [options.memory]
   * @param {object} [options.moderation]
   * @param {object} [options.rhythm]
   * @param {string} [options.dataDir]
   */
  constructor({
    ctx,
    store,
    log,
    gateway,
    mind,
    observe = null,
    interest = null,
    tags = null,
    security = null,
    emotion = null,
    memory = null,
    summarizer = null,
    life = null,
    relation = null,
    meme = null,
    moderation = null,
    rhythm = null,
    dataDir = '',
  }) {
    this.ctx = ctx
    this.store = store
    this.log = log
    this.gateway = gateway
    this.mind = mind
    this.observe = observe
    this.interest = interest
    this.tags = tags
    this.security = security
    this.emotion = emotion
    this.memory = memory
    /**
     * 自动总结：旧实现最大的洞是「她只在被叫时才记」——
     * 主人说「我喜欢吃辣」，如果她没主动想到调 qq_remember，聊完就没了。
     * 有了这个，对话攒够就跟一次总结，自动抽出事实/偏好/承诺。
     */
    this.summarizer = summarizer
    /** 日程 + 当日状态（她说"现在在咖啡厅"要有来处） */
    this.life = life
    /** 关系账本（我们走到哪一步了） */
    this.relation = relation
    /** 表情包系统（含盗图 + 发送编排） */
    this.meme = meme
    this.moderation = moderation
    this.rhythm = rhythm
    this.dataDir = dataDir

    this.dedupe = createDeduper(512)
    this.limiter = createRateLimiter({ capacity: 6, refillMs: 60000 })

    // 发言统计器：自动标签（新人 / 话痨）靠它。纯内存、不落盘 ——
    // 重启后新人重新变新人，可以接受（统计不是记忆）。
    this.tagLedger = call(tags, 'createTagLedger', {}) ?? null

    // ⚠️ 不要把 rhythm *模块* 传进去：Outbox 要的是「节奏发送器实例」。
    //    不传时 Outbox 会自己 createRhythmSender()，那才是正确路径。
    this.outbox = new Outbox({ gateway, store, log: log.child('outbox') })
    this.inbound = new Inbound({ gateway, store, log: log.child('inbound'), dataDir })

    /** 群上下文：groupId → 最近若干行文本（免费，只为让 Mind 知道刚才在聊什么） */
    this.groupHistory = new Map()
    /** 群消息对象滚动缓存：groupId → 最近若干条 QqMessage（给群管批量审查用） */
    this.groupMessages = new Map()
    /** 群管处罚冷却：`${gid}:${uid}` → 上次动手时间，防同一个人被反复禁言 */
    this.moderationCooldown = new Map()
    /** 待处理的加好友/加群请求：flag → entry */
    this.pendingRequests = new Map()
    /** 面板对话流（内存，最近 200 条） */
    this.recent = []
    /** 拉黑/注入/输出拦截统计（面板要看得见「真的拦住了」） */
    this.stats = { blocked: 0, injected: 0, replyBlocked: 0, lastBlockAt: 0, byReason: {} }

    /** peer 会话内的轮次队列，保证同一会话串行 */
    this.turnQueues = new Map()
    this.disposed = false
    this.startedAt = Date.now()
  }

  // ── 生命周期 ────────────────────────────────────────────────

  start() {
    const cfg = this.store.get()
    if (cfg.qq?.enabled === false) {
      this.log.info('QQ 网关在配置里是关闭的，不连接')
      return
    }
    this.gateway.on?.('packet', (packet) => {
      try {
        this.onPacket(packet)
      } catch (error) {
        // 任何一帧处理失败都不许拖垮网关
        this.log.error('处理事件出错：', error)
      }
    })
    this.gateway.connect?.()

    // 日程预热：后台跑一次，别让当天第一句对话为生成日程多等一次模型调用。
    // 不给 peerKey → 模块内部判「有没有任何 companion 会话」，全是 work 就一次都不生成。
    try {
      const warming = this.life?.ensureToday?.()
      if (warming && typeof warming.catch === 'function') {
        warming.catch((error) => this.log.debug('日程预热失败（不影响聊天）：', error?.message ?? error))
      }
    } catch (error) {
      this.log.debug('日程预热失败（不影响聊天）：', error?.message ?? error)
    }

    this.log.info('Controller 已启动')
  }

  stop() {
    if (this.disposed) return
    this.disposed = true
    call(this.observe, 'dispose')
    // ⚠️ 节奏发送器内部有 2~5 秒的 sleep 定时器；Inbound 也有下载超时。
    //    不 dispose 的话，插件卸载/热重载之后它们还会醒过来对着旧网关发消息。
    try {
      this.outbox?.dispose?.()
    } catch {
      // ignore
    }
    try {
      this.inbound?.dispose?.()
    } catch {
      // ignore
    }
    this.groupHistory.clear()
    this.groupMessages.clear()
    this.moderationCooldown.clear()
  }

  // ── 收包 ────────────────────────────────────────────────────

  onPacket(packet) {
    if (this.disposed) return

    // 自己发出去的消息也会被上报，用来核对「到底是谁发的」
    if (packet?.post_type === 'message_sent') {
      const segs = Array.isArray(packet.message) ? packet.message : []
      this.log.debug(`[发出] ${packet.message_type} → ${packet.target_id ?? packet.group_id ?? '?'}`)
      return
    }

    if (packet?.post_type === 'request') {
      this.onRequest(packet)
      return
    }

    if (packet?.post_type !== 'message') {
      this.log.debug(`事件 ${packet?.post_type ?? '?'}/${packet?.notice_type ?? packet?.request_type ?? ''}`)
      return
    }

    const message = normalizeMessage(packet, this.gateway.selfId)
    if (!message) return

    // 幂等：重连抖动 / NapCat 重推会把同一条送两遍
    if (!this.dedupe.fresh(message.id)) {
      this.log.debug(`重复消息已丢弃 ${message.id}`)
      return
    }

    const cfg = this.store.get()
    if (cfg.qq?.enabled === false) return

    const decision = decideRoute(message, cfg)

    if (decision.action === ACTION.IGNORE) {
      if (String(decision.reason).includes('block')) {
        this.stats.blocked += 1
        this.stats.lastBlockAt = Date.now()
        this.stats.byReason[decision.reason] = (this.stats.byReason[decision.reason] ?? 0) + 1
        this.log.debug(`已拦截（${decision.reason}）：${message.userId}`)
      }
      return
    }

    // 群聊：先把这条记进上下文缓存（免费），再决定要不要叫醒 Mind（花钱）
    if (message.scene === 'group') {
      this.rememberGroupLine(message)
      this.rememberGroupMessage(message)
      this.moderate(message, cfg)
    }

    // 盗图：看一眼这张图她喜不喜欢。
    // 概率闸在模块内部 —— 没通过就零成本返回，不会每张图都去调视觉模型。
    try {
      const stealing = isOn('memeSteal', this.peerKeyOfMessage(message), cfg)
        ? this.meme?.maybeSteal?.(message)
        : null
      if (stealing && typeof stealing.catch === 'function') {
        stealing.catch((error) => this.log.debug('盗图失败（不影响回话）：', error?.message ?? error))
      }
    } catch (error) {
      this.log.debug('盗图失败（不影响回话）：', error?.message ?? error)
    }

    // 安全体检：在消息进 Mind 之前
    const verdict = this.inspectSecurity(message, decision, cfg)
    if (verdict) {
      if (verdict.handled) return
    }

    // 本条要不要回：主人/@ 直通；其他人过 Interesting 掷骰
    const { message: msg, decision: dec } = verdict ?? { message, decision }
    const interestVerdict = this.rollInterest(msg, dec, cfg)
    if (!interestVerdict.reply) {
      this.log.debug(
        `不接话（${interestVerdict.reason}，p=${interestVerdict.p.toFixed(2)}）：` +
        `${umoOf(msg)} ${clip(msg.text, 40)}`,
      )
      return
    }

    // 观望还是立刻
    const priority = dec.priority ?? 'observe'
    if (priority === 'instant' || priority === 'at') {
      this.enqueueTurn([msg], dec)
      return
    }

    // 其他人走观望窗口
    if (this.observe && typeof this.observe.push === 'function') {
      const outcome = this.observe.push(msg, dec, cfg)
      this.log.debug(`观望中（${outcome?.settleAfterMs ?? '?'}ms）：${umoOf(msg)}`)
      return
    }

    // 观望模块没交付时降级：直接处理（宁可真回，不要静默丢消息）
    this.log.warn('观望模块不可用，本条直接处理')
    this.enqueueTurn([msg], dec)
  }

  /** 群上下文缓存：让 Mind 知道「刚才群里在聊什么」。 */
  rememberGroupLine(message) {
    const cfg = this.store.get()
    const limit = Math.max(1, Number(cfg.group?.historyLines) || 30)
    const gid = String(message.peerId)
    const name = message.sender?.card || message.sender?.nickname || '某人'
    const idPart = message.id ? ` [#${message.id}]` : ''
    const body = message.text ||
      (message.media?.length ? `[${message.media.map((m) => m.kind).join('/')}]` : '')
    if (!body) return

    let lines = this.groupHistory.get(gid)
    if (!lines) {
      lines = []
      this.groupHistory.set(gid, lines)
    }
    lines.push({ id: message.id, text: `${name}(${message.userId})${idPart}: ${body}` })
    if (lines.length > limit) lines.shift()
  }

  /**
   * 群消息对象缓存（和上面那份「给人看的文本」分开存）。
   * 群管要的是**结构化**消息：userId / sender.role / selfId 都得在，
   * 压成一行文本之后就判不了「这个人是不是管理员」了。
   */
  rememberGroupMessage(message) {
    const limit = Math.max(1, Number(this.store.get()?.group?.historyLines) || 30)
    const gid = String(message.peerId)
    let list = this.groupMessages.get(gid)
    if (!list) {
      list = []
      this.groupMessages.set(gid, list)
    }
    list.push(message)
    if (list.length > limit) list.shift()
  }

  /**
   * 群管巡检：看一眼最近这几条群消息有没有要动手的（广告 / 刷屏 / 涉诈）。
   *
   * 分工和注入惩罚一样：`moderation.inspectBatch` 是纯函数只给建议，
   * 这里只负责执行。moderation 自己会跳过群主 / 管理员 / 主人，
   * pipeline 不重复判一遍（判两处最容易出「一边罚一边不知道罚了」）。
   */
  moderate(message, cfg) {
    if (!this.moderation) return
    if (message.scene !== 'group') return
    if (!isOn('moderation', this.peerKeyOfMessage(message), cfg)) return

    const gid = String(message.peerId)
    const batch = this.groupMessages.get(gid) ?? [message]
    const verdict = call(this.moderation, 'inspectBatch', batch, cfg)
    const suggest = Array.isArray(verdict?.suggest) ? verdict.suggest : []
    if (suggest.length === 0) return

    const cooldownMs = Math.max(0, Number(cfg.security?.penaltyCooldownMs) || 0)
    const now = Date.now()

    for (const item of suggest) {
      const userId = String(item?.userId ?? '')
      if (!userId) continue

      // 冷却：同一个人在冷却期内不重复禁言（不然每来一条消息就调一次 API）
      const key = `${gid}:${userId}`
      const last = this.moderationCooldown.get(key) ?? 0
      if (cooldownMs > 0 && now - last < cooldownMs) {
        this.log.debug(`群管冷却中，跳过 ${userId}`)
        continue
      }
      this.moderationCooldown.set(key, now)

      this.log.info(`群管：禁言 ${userId} ${item.minutes} 分钟（${item.reason ?? ''}）`)
      this.executePenalty({
        action: 'mute',
        userId,
        groupId: gid,
        minutes: item.minutes,
        reason: item.reason,
        blocklist: null, // 群管只禁言，不拉黑（拉黑是主人的决定）
      })
    }

    if (verdict?.reason) this.log.debug(`群管巡检：${verdict.reason}`)
  }

  /**
   * 群上下文文本（不含刚说的那条，避免自我复读）。
   * @param {string} groupId
   * @param {string} [excludeId] 排除这条（就是当前这句）
   * @param {number} [limit] >0 时只取最近这么多行（省钱模式）
   */
  groupContextOf(groupId, excludeId = '', limit = 0) {
    const lines = this.groupHistory.get(String(groupId)) ?? []
    let list = lines.filter((line) => line.id !== excludeId)
    if (limit > 0 && list.length > limit) list = list.slice(-limit)
    return list.map((line) => line.text).join('\n')
  }

  /**
   * 安全体检。
   *
   * 「扫什么、命中算几级、该罚什么」全在 security.js 里（纯函数）：
   * 组合特征防误报、转述降权、主人永不惩罚、私聊把禁言退化成拉黑 —— 都做好了。
   * 这里只负责「照着它给的动作对象真的动手」，不重复判一次。
   *
   * @returns {{message,decision,handled?:boolean}|null} null = 放行
   */
  inspectSecurity(message, decision, cfg) {
    if (!this.security || cfg.security?.injectionEnabled === false) return null

    const verdict = call(this.security, 'inspect', message.text, {
      role: decision.role,
      message,
      userId: message.userId,
      groupId: message.groupId,
      config: cfg,
    })
    if (!verdict || !verdict.risk || verdict.risk === 'clean') return null

    this.stats.injected += 1
    this.stats.byReason[verdict.risk] = (this.stats.byReason[verdict.risk] ?? 0) + 1
    this.log.warn(
      `疑似提示词注入（${verdict.risk}）：${message.userId} ${clip(message.text, 60)}` +
      `${verdict.hits?.length ? ` 命中=${verdict.hits.join('、')}` : ''}`,
    )

    // suspicious 默认不罚（宁可漏判）：照常聊，只留一条日志
    if (verdict.risk !== 'malicious') return null

    const penalty = call(this.security, 'penaltyFor', message, verdict, cfg)
    if (!penalty) return null

    this.executePenalty(penalty)
    return { message, decision, handled: true }
  }

  /**
   * 照着 security 给的动作对象动手。
   * **这里只执行、不判断** —— 判断散两处最容易出「一边罚一边不知道罚了」。
   */
  executePenalty(penalty) {
    const { action, userId, groupId, minutes, reason, blocklist } = penalty ?? {}
    this.log.warn(
      `执行惩罚：${action} → ${userId}` +
      `${groupId ? ` @群 ${groupId}` : ''}（${reason ?? '注入'}）`,
    )

    if (action === 'mute' && groupId) {
      const seconds = Math.max(60, (Number(minutes) || 10) * 60)
      Promise.resolve(
        this.gateway.call?.('set_group_ban', { group_id: groupId, user_id: userId, duration: seconds }),
      ).catch((error) => this.log.debug('禁言失败：', error?.message ?? error))
    } else if (action === 'kick' && groupId) {
      Promise.resolve(
        this.gateway.call?.('set_group_kick', { group_id: groupId, user_id: userId, reject_add_request: false }),
      ).catch((error) => this.log.debug('踢人失败：', error?.message ?? error))
    }

    if (blocklist) this.writeBlocklist(blocklist)
  }

  /** 写进全局黑名单（幂等，重复注入不会堆一堆重复条目）。 */
  writeBlocklist(entry) {
    try {
      const access = this.store.get().access ?? {}
      const list = Array.isArray(access.blocklist) ? [...access.blocklist] : []
      if (list.some((item) => String(item?.qq) === String(entry.qq))) return
      list.push(entry)
      this.store.patch({ access: { blocklist: list } })
      this.log.info(`已自动拉黑 ${entry.qq}（${entry.note ?? ''}）`)
    } catch (error) {
      this.log.warn('写黑名单失败：', error)
    }
  }

  // ── Interesting 掷骰 ────────────────────────────────────────

  rollInterest(message, decision, cfg) {
    // 主人永远回，不掷骰
    if (decision.role === 'owner') return { reply: true, p: 1, reason: 'owner' }

    const groupId = message.scene === 'group' ? message.groupId : ''
    const value = call(this.interest, 'interestOf', message.userId, groupId, cfg)
    const interest = typeof value === 'number' ? value : Number(cfg.interest?.default ?? 0.5)

    const verdict = call(this.interest, 'shouldReply', message, interest, {})
    if (!verdict) {
      // 兴趣模块没交付：被 @ 就回，没 @ 不回（保守）
      return message.mentionsMe
        ? { reply: true, p: 1, reason: 'fallback-at' }
        : { reply: false, p: 0, reason: 'fallback-quiet' }
    }
    return verdict
  }

  // ── 观望窗口到期 ────────────────────────────────────────────

  /**
   * 观望窗口结算：一批消息一起交给 Mind。
   * @param {string} batchKey
   * @param {Array} messages
   */
  onSettle(batchKey, messages) {
    if (this.disposed) return
    const list = Array.isArray(messages) ? messages.filter(Boolean) : []
    if (list.length === 0) return

    const cfg = this.store.get()
    const first = list[0]
    const decision = decideRoute(first, cfg)
    this.log.info(`观望结算：${batchKey}，${list.length} 条`)
    this.enqueueTurn(list, decision)
  }

  // ── 真正跑一轮 ──────────────────────────────────────────────

  /** 同一 peer 串行，不同 peer 并行。 */
  enqueueTurn(messages, decision) {
    const first = messages[0]
    const umo = umoOf(first)
    const previous = this.turnQueues.get(umo) ?? Promise.resolve()
    const next = previous
      .then(() => this.runTurn(messages, decision))
      .catch((error) => this.log.error(`跑一轮失败（${umo}）：`, error))
      .finally(() => {
        if (this.turnQueues.get(umo) === next) this.turnQueues.delete(umo)
      })
    this.turnQueues.set(umo, next)
    return next
  }

  async runTurn(messages, decision) {
    if (this.disposed) return
    const cfg = this.store.get()
    const first = messages[messages.length - 1]
    const umo = umoOf(first)

    // 限流：同一会话一分钟内太频繁就跳过
    if (!this.limiter.take(umo)) {
      this.log.warn(`限流：${umo} 太频繁，本批跳过`)
      return
    }

    // 陌生人聊天关闭：给一句固定回复，不花一分额度
    if (decision.role === 'guest' && cfg.access?.strangersCanChat === false) {
      const canned = String(cfg.access?.strangerReply ?? '')
      if (canned) await this.outbox.send(first, canned)
      return
    }

    if (this.mind && this.mind.available === false) {
      this.log.warn('Mind 不可用（ctx.agents 没挂载？），本条只记录不回复')
      return
    }

    // 标签：先记账（自动标签要统计），再算标签
    let tags = []
    try {
      const stats = this.tagLedger?.record?.(String(first.userId))
      tags = call(this.tags, 'tagsOf', first, cfg, stats ? { stats } : {}) ?? []
    } catch (error) {
      this.log.debug('算标签失败（跳过）：', error?.message ?? error)
    }
    const sessionKey = this.sessionKeyOf(first, decision.role)

    // 关系：拨一下回落钟（异步落盘，不阻塞）。
    // 注意这里**不记分** —— "他还活着在说话"本身不代表正负向事件，记分会把账本刷成噪音。
    try {
      if (isOn('relation', sessionKey, cfg)) this.relation?.touch?.(String(first.userId))
    } catch (error) {
      this.log.debug('关系拨钟失败（跳过）：', error?.message ?? error)
    }

    // 日程：当天已生成过就是读缓存（零成本）；work 模式一次都不调。
    // 用 void 不阻塞 —— 当天第一句对话不该为了生成日程多等一次模型调用
    // （预热在 Controller.start() 里做，正常情况下这里早就备好了）。
    try {
      const warming = isOn('schedule', sessionKey, cfg)
        ? this.life?.ensureToday?.({ peerKey: sessionKey })
        : null
      if (warming && typeof warming.catch === 'function') {
        warming.catch((error) => this.log.debug('日程结算失败（跳过）：', error?.message ?? error))
      }
    } catch (error) {
      this.log.debug('日程结算失败（跳过）：', error?.message ?? error)
    }

    const generation = Number(cfg.sessions?.generations?.[sessionKey] ?? 0) || 0
    const sessionId = generation > 0 ? `${cfg.mind?.sessionPrefix ?? 'qq'}-${sessionKey}-g${generation}` : `${cfg.mind?.sessionPrefix ?? 'qq'}-${sessionKey}`

    this.log.info(
      `[${decision.role}] ${umo} ${first.sender?.name || first.userId}` +
      `${first.mentionsMe ? ' @我' : ''}：${clip(first.text, 120)}` +
      `${messages.length > 1 ? `（一批 ${messages.length} 条）` : ''}`,
    )

    // 媒体先落地：模型只认本机路径
    let mediaItems = []
    const withMedia = messages.filter((m) => (m.media?.length ?? 0) > 0)
    for (const item of withMedia) {
      const collected = await this.inbound.collect(item).catch((error) => {
        this.log.warn('下载媒体失败：', error)
        return []
      })
      mediaItems.push(...(collected ?? []))
    }

    // 关系：一句语气提示（work 模式它自己返回空串，这里不用判）
    const relationLine = (() => {
      try {
        if (!isOn('relation', sessionKey, cfg)) return ''
        return this.relation?.renderForMind?.({ userId: String(first.userId), peerKey: sessionKey }) ?? ''
      } catch (error) {
        this.log.debug('取关系失败（跳过）：', error?.message ?? error)
        return ''
      }
    })()

    const prompt = this.composePrompt({ messages, decision, mediaItems, relationLine })

    // 面板对话流：记下收到的那条
    for (const item of messages) {
      this.record({
        direction: 'in',
        scene: item.scene,
        peerId: item.peerId,
        groupId: item.groupId,
        userId: item.userId,
        name: item.sender?.card || item.sender?.nickname || item.userId,
        text: item.text,
        media: item.media?.length ?? 0,
        role: decision.role,
        tags,
      })
    }

    // 流式：边生成边攒，交给节奏模块分片发
    let streamed = ''
    const onDelta = (delta) => {
      if (typeof delta === 'string' && delta) streamed += delta
    }

    let reply = ''
    let trace = []
    try {
      const result = await this.mind.ask({
        sessionId,
        role: decision.role,
        mode: decision.mode,
        tags,
        peerId: first.peerId,
        peerKey: sessionKey,
        text: prompt,
        onDelta,
        timeoutMs: Number(cfg.mind?.turnTimeoutMs) || 180000,
      })
      reply = String(result?.text ?? '').trim()
      trace = Array.isArray(result?.trace) ? result.trace : []
    } catch (error) {
      this.log.error(`Mind 调用失败（${sessionId}）：`, error)
      reply = '呜…茶茶酱这边卡住了，主人稍等一下再试好不好 (´･ω･`)'
    }

    if (!reply) {
      this.log.debug('她选择不说话，本轮静默')
      this.archive({ sessionId, message: first, trace, reply: '', tags })
      return
    }

    // 输出侧审核：她要说出去的话，出门之前再看一遍。
    // 输入侧只挡「用户想注入」，挡不住「她自己被带歪了」—— 这一层补那个时刻。
    const guarded = this.guardReply(reply, decision.role, cfg, sessionKey)
    if (!guarded.replacement) {
      this.log.warn('回复被拦且配置成不兜底，本轮静默')
      this.archive({ sessionId, message: first, trace, reply: '', tags })
      return
    }
    reply = guarded.replacement

    // 分片发出去：有表情包系统就交给它 —— 它会处理 `&&类别&&` 标记、图文混排、
    // 以及「文字发完再单独发图」。没有就退回纯 outbox。
    let outcome = null
    try {
      outcome = this.meme
        ? await this.meme.sendReply({
          outbox: this.outbox,
          message: first,
          text: reply,
          quote: first.scene === 'group',
        })
        : await this.outbox.send(first, reply, { quote: first.scene === 'group' })
    } catch (error) {
      this.log.error('发送失败（本轮回复丢失）：', error)
    }
    this.log.info(`已回 ${umo}：${outcome?.sent ?? 0} 条`)

    this.record({
      direction: 'out',
      scene: first.scene,
      peerId: first.peerId,
      groupId: first.groupId,
      userId: first.userId,
      name: '茶茶酱',
      text: reply,
      chunks: outcome?.sent ?? 0,
      role: decision.role,
      tags,
    })

    // 轨迹进面板：主人要「像 DSH 那样」看到思考 / 工具 / 计划 / token，
    // 所以这里把每一项该带的字段都带齐（面板不猜、不二次请求）。
    for (const item of trace) {
      const kind = String(item?.kind ?? '')
      if (kind === 'user' || kind === 'reply') continue

      const nameOf = {
        tool: `调用 ${item.name ?? '工具'}`,
        reasoning: '思考',
        'tool-result': '工具结果',
        plan: '计划',
        usage: 'token',
      }[kind] ?? kind

      this.record({
        direction: 'internal',
        kind,
        scene: first.scene,
        peerId: first.peerId,
        groupId: first.groupId,
        userId: first.userId,
        name: nameOf,
        text: kind === 'tool' ? '' : String(item.text ?? ''),
        toolName: kind === 'tool' ? String(item.name ?? '') : '',
        toolArgs: kind === 'tool' ? (item.args ?? null) : null,
        toolResult: kind === 'tool' ? String(item.result ?? '') : '',
        toolError: Boolean(item.error),
        tokens: item.tokens ?? null,
        plan: Array.isArray(item.plan) ? item.plan : null,
        role: decision.role,
      })
    }

    this.archive({ sessionId, message: first, trace, reply, tags })

    // 自动总结：把这一轮（说了什么 + 回了什么）攒进待总结队列。
    // 攒够 N 条（默认 12）就跟一次模型总结，自动抽出「值得长期记住的」写进 facts.jsonl。
    // 这是让记忆「真的记住」的关键 —— 不然她只在被主动叫时才记，聊完就没了。
    this.markForSummary(sessionKey, { message: first, reply, role: decision.role })

    // 情绪：这一轮发生了什么，单独问一次模型判断心情往哪走。
    // **不阻塞回复** —— 话已经发出去了，心情慢慢算。
    void this.judgeEmotion({ role: decision.role, text: first.text, reply, peerKey: sessionKey })

    // 上下文预算：能压就压；压不动且到硬上限才换代次（换代次前先存档）
    void this.handleContextBudget({ sessionId, sessionKey })
  }

  /**
   * 上下文预算：压缩优先，换代次兜底。
   *
   * 为什么要兜底：`compaction` 是尽力而为的服务 ——
   * 内核可能因为「没有安全的可压段落」「单个 tool 结果本身就超预算」直接拒绝压缩。
   * 没有兜底的话事件数会一路涨，最后 API 报 context overflow，
   * **而且是在最需要回话的时候失败**。
   *
   * 换代次不会丢数据：这一轮的完整轨迹一直写在 `archive/` 里，
   * 记忆也在 `memory/` 里。她只是「想不起来」，需要时用 `qq_recall_memory`
   * 派子 Agent 去翻 —— 这正是主人架构里说的那种回忆方式。
   *
   * @param {{sessionId:string, sessionKey:string}} options
   */
  async handleContextBudget({ sessionId, sessionKey }) {
    const entry = this.mind?.live?.get?.(sessionId)
    const agent = entry?.handle?.agent
    if (!agent || typeof this.mind?.maybeCompact !== 'function') return

    let verdict = null
    try {
      verdict = await this.mind.maybeCompact(agent, {
        provider: entry.provider ?? '',
        model: entry.model ?? '',
      })
    } catch (error) {
      this.log.warn('上下文检查失败（不影响聊天）：', error?.message ?? error)
      return
    }

    if (!verdict?.needReset) return

    // 换代次之前先留一句痕 —— 不然「聊着聊着她突然失忆」，主人会一头雾水
    await this.noteBeforeReset({ sessionId, used: verdict.used })

    try {
      const generations = { ...(this.store.get()?.sessions?.generations ?? {}) }
      const next = (Number(generations[sessionKey]) || 0) + 1
      generations[sessionKey] = next
      this.store.patch({ sessions: { generations } })
      await this.mind.dispose(sessionId)
      this.log.warn(
        `会话 ${sessionKey} 上下文到硬上限（${verdict.used} 条），已换成第 ${next} 代` +
        `（旧对话还在 archive/ 里，她可以用 qq_recall_memory 翻回来）`,
      )
    } catch (error) {
      this.log.error('换代次失败：', error)
    }
  }

  /** 换代次前在记忆里留一条痕。失败也不影响换代次。 */
  async noteBeforeReset({ sessionId, used }) {
    if (!this.memory || typeof this.memory.appendMemory !== 'function') return
    try {
      const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
      await this.memory.appendMemory(
        `（自动记录）${stamp} 上下文到了硬上限（${used} 条事件），之前那段对话被截断了；` +
        `需要的话用 qq_recall_memory 翻 archive/。`,
        { section: 'self' },
      )
    } catch (error) {
      this.log.debug('换代次前存档失败（不影响）：', error?.message ?? error)
    }
  }

  /**
   * 情绪判断：问一次「这一轮她的心情往哪走」。
   *
   * 为什么要单独一次模型调用（照「鱼的心」的实测结论）：
   *   关键词硬猜会把心情判成随机数。只有让模型看完「对方说的 + 她回的」才判得准。
   *   代价是一次很短的调用；嫌贵就把 emotion.enabled 关掉。
   *
   * ⚠️ 用 guest 角色跑：判断这一步不需要任何工具，
   *    也别让判断会话拿到主人的电脑权限。
   */
  async judgeEmotion({ role, text, reply, peerKey = '' }) {
    if (!this.emotion || !this.mind?.available) return
    const cfg = this.store.get()
    if (cfg.emotion?.enabled === false) return
    // 总开关：关掉情绪 = 连这次模型调用都不发（这是全项目最贵的一项）
    if (!isOn('emotion', peerKey, cfg)) return
    if (!text && !reply) return

    // 降频：每 N 轮判断一次。
    // 为什么能降：心情半衰期 3 小时、七根情绪 90 分钟，一两轮的延迟几乎看不出来；
    // 而每轮判断 = **一整次模型调用**，这是全项目最贵的一项隐性开销。
    const every = Math.max(1, Number(cfg.emotion?.judgeEveryTurns) || 2)
    this.emotionTurns = (Number(this.emotionTurns) || 0) + 1
    if (every > 1 && this.emotionTurns % every !== 0) {
      this.log.debug(`情绪判断跳过（每 ${every} 轮一次，当前第 ${this.emotionTurns} 轮）`)
      return
    }

    try {
      const prompt = buildJudgePrompt({
        recentTurns: [
          { text, speaker: role },
          { text: reply, speaker: 'self' },
        ],
        speaker: role,
        config: cfg,
      })
      const judged = await this.mind.ask({
        sessionId: `${cfg.mind?.sessionPrefix ?? 'qq'}-emotion`,
        role: 'guest',
        mode: 'read-only',
        tags: [],
        peerId: 'emotion',
        text: prompt,
        timeoutMs: 60000,
      })
      const delta = parseJudgeOutput(judged?.text ?? '')
      if (!delta) {
        this.log.debug('情绪判断没有返回可用结果（跳过）')
        return
      }
      const result = this.emotion.apply(delta)
      this.log.debug(`情绪判定：applied=${result?.applied} mood=${result?.mood} reason=${delta.reason || '(无)'}`)
    } catch (error) {
      this.log.debug('情绪判断失败（不影响聊天）：', error?.message ?? error)
    }
  }

  /**
   * 输出侧审核：她要说出去的话，出门之前再看一遍。
   *
   * 分工和前面一样：**判断在 security.js（纯函数），执行在这里**。
   *
   * 处置默认 `fallback`（换一句兜底话）：
   *   - 比 `discard`（干脆不发）体验好 —— 主人不会觉得她卡住了
   *   - 比 `regenerate`（带原因重生）便宜 —— 重生要再跑一轮，钱和延迟都翻倍
   */
  guardReply(reply, role, cfg, peerKey = '') {
    const text = String(reply ?? '')
    if (!text.trim()) return { blocked: false, replacement: text }
    // features.replyGuard 是总开关，security.outputGuard 是更细的开关 —— 两个都认
    if (!isOn('replyGuard', peerKey, cfg)) return { blocked: false, replacement: text }
    if (!this.security || cfg.security?.outputGuard === false) return { blocked: false, replacement: text }

    const verdict = call(this.security, 'inspectReply', text, {
      role,
      config: cfg,
      protect: this.protectTexts(),
    })
    if (!verdict || !verdict.risk || verdict.risk === 'clean') return { blocked: false, replacement: text }

    // 可疑（只是口气不对，比如聊到自己的设定）→ 记一笔但不拦
    if (verdict.risk !== 'malicious') {
      this.log.debug(`回复可疑（${(verdict.hits ?? []).join(',')}）：${clip(text, 50)}`)
      return { blocked: false, replacement: text }
    }

    this.stats.replyBlocked = (this.stats.replyBlocked ?? 0) + 1
    this.log.warn(`回复被拦（${(verdict.hits ?? []).join(',') || '?'}）：${clip(text, 60)}`)

    const policy = String(cfg.security?.replyPenalty ?? 'fallback')
    if (policy === 'discard') return { blocked: true, replacement: '' }
    return { blocked: true, replacement: '呜…这句话茶茶酱不能说哦 (´･ω･`)' }
  }

  /** 要保护的原文片段：核心记忆的开头（她本来也看不到系统提示全文，不用传）。 */
  protectTexts() {
    const out = []
    try {
      const core = this.memory?.readCore?.()
      if (core) out.push(String(core).slice(0, 300))
    } catch {
      // 记忆读不到就不保护（不能因为这个把正常的回复拦下来）
    }
    return out
  }

  // ── 组装给 Mind 的输入 ──────────────────────────────────────

  composePrompt({ messages, decision, mediaItems, relationLine = '' }) {
    const cfg = this.store.get()
    const first = messages[messages.length - 1]
    const parts = []

    if (first.scene === 'group') {
      // 群上下文按需（主人：「上下文不要太多，不然贵死」）：
      //   always     → 每次都带完整历史（贵，但信息最全）
      //   on-demand  → 被 @ 时带完整历史；没被 @ 只带最近几行（默认）
      // 群缓存本身一直在记（免费），这里只决定要不要塞进 prompt。
      const contextOn = String(cfg.group?.contextOn ?? 'on-demand')
      const atMe = first.mentionsMe === true
      const limit = contextOn === 'always' ? 0 : (atMe ? 0 : 5)
      const history = this.groupContextOf(first.groupId, first.id, limit)
      if (history) {
        parts.push(
          `（这是 QQ 群 ${first.groupId}，刚才群里在聊。` +
          `格式是「昵称(QQ号) [#消息id]: 内容」，要禁言/撤回可以用这些号：\n${history}\n）`,
        )
      }
      // 一批里的多条一起给，她才知道中间发生了什么
      for (const item of messages) {
        const name = item.sender?.card || item.sender?.nickname || '某人'
        const idPart = item.id ? ` [#${item.id}]` : ''
        parts.push(`${name}(${item.userId})${idPart} 说：${item.text || '（发了媒体）'}`)
      }
    } else {
      for (const item of messages) {
        if (item.text) parts.push(item.text)
      }
    }

    if (mediaItems.length > 0) {
      const lines = mediaItems.map((item) =>
        item.failed ? `- （没取到：${item.url ?? ''}）` : `- ${item.kind}：${item.path}`,
      )
      parts.push(`（对方还发了媒体，已经落到本机：\n${lines.join('\n')}\n）`)
    }

    // 群管提示：她是管理员才可以动手
    const profile = cfg.group?.profiles?.[String(first.groupId)] ?? {}
    if (first.scene === 'group' && profile.canModerate === false) {
      parts.push('（你在这个群没有管理权限，不要尝试禁言或踢人。）')
    }

    // 关系提示放最后：它是「怎么说话」的基调，不是「说了什么」
    if (relationLine) parts.push(relationLine)

    return parts.join('\n') || '（对方发来一条空消息）'
  }

  // ── 会话 key ────────────────────────────────────────────────

  /** 和 MindSessions.keyOf 必须同算法。 */
  sessionKeyOf(message, role) {
    if (message.scene === 'group') {
      return `group-${message.groupId}-${role === 'owner' ? 'owner' : 'guest'}`
    }
    return `private-${message.peerId}`
  }

  // ── 请求事件（加好友/加群） ─────────────────────────────────

  onRequest(packet) {
    const flag = String(packet?.flag ?? '')
    if (!flag) return
    const type = packet.request_type === 'group' ? 'group' : 'friend'
    const entry = {
      flag,
      type,
      userId: String(packet.user_id ?? ''),
      groupId: String(packet.group_id ?? ''),
      comment: String(packet.comment ?? ''),
      subType: String(packet.sub_type ?? ''),
      at: Date.now(),
    }
    this.pendingRequests.set(flag, entry)
    if (this.pendingRequests.size > 50) {
      const oldest = this.pendingRequests.keys().next().value
      this.pendingRequests.delete(oldest)
    }
    this.log.info(
      `收到${type === 'friend' ? '加好友' : '加群'}请求：${entry.userId}` +
      `${entry.comment ? `（${entry.comment.slice(0, 40)}）` : ''}`,
    )
    this.record({
      direction: 'in',
      scene: type === 'friend' ? 'private' : 'group',
      peerId: type === 'friend' ? entry.userId : entry.groupId,
      userId: entry.userId,
      name: `${type === 'friend' ? '加好友' : '加群'}请求`,
      text: `申请：${entry.userId}${entry.comment ? `（${entry.comment}）` : ''}`,
      role: 'guest',
    })
  }

  // ── 存档 / 面板 ─────────────────────────────────────────────

  record(entry) {
    this.recent.push({ at: Date.now(), ...entry })
    if (this.recent.length > 200) this.recent.shift()
  }

  /** 轨迹落盘：一天一个 JSONL，行内一个事件。 */
  archive({ sessionId, message, trace, reply, tags }) {
    try {
      const dir = path.join(this.dataDir, 'archive')
      fs.mkdirSync(dir, { recursive: true })
      const day = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const file = path.join(dir, `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.jsonl`)

      const base = {
        sessionId,
        scene: message?.scene,
        groupId: message?.groupId,
        userId: message?.userId,
        peerName: message?.sender?.card || message?.sender?.nickname || '',
        messageId: message?.id,
        tags: tags ?? [],
      }
      const lines = []
      for (const item of trace ?? []) {
        lines.push(JSON.stringify({ ...base, at: item.at ?? Date.now(), ...item }))
      }
      if (reply) lines.push(JSON.stringify({ ...base, at: Date.now(), kind: 'reply', text: reply }))
      if (lines.length > 0) fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    } catch (error) {
      this.log.warn('轨迹落盘失败（不影响回复）：', error?.message ?? error)
    }
  }

  /**
   * 面板用：会话列表。
   *
   * 数据散在五个地方（recent 是消息流、groupHistory 是群上下文、
   * sessions.generations 是代次、modes 是模式、relation 是关系阶段），
   * 这里按 peerKey 聚成一份 —— 面板不该自己拼这个。
   *
   * @returns {Array<object>}
   */
  listConversations() {
    const cfg = this.store.get()
    const byKey = new Map()

    /** recent 里一条记录长这样：{ scene, peerId, groupId, direction, ... } */
    const keyOf = (entry) => {
      if (entry?.scene === 'group') {
        const gid = String(entry.groupId || entry.peerId || '')
        return gid ? `group-${gid}` : ''
      }
      const uid = String(entry?.peerId || '')
      return uid ? `private-${uid}` : ''
    }

    for (const entry of this.recent) {
      const peerKey = keyOf(entry)
      if (!peerKey) continue

      let conv = byKey.get(peerKey)
      if (!conv) {
        conv = {
          peerKey,
          scene: entry.scene,
          peerId: entry.scene === 'group'
            ? String(entry.groupId || entry.peerId || '')
            : String(entry.peerId || ''),
          name: '',
          role: entry.role ?? 'guest',
          lastAt: 0,
          lastText: '',
          counts: { in: 0, out: 0 },
        }
        byKey.set(peerKey, conv)
      }

      if (entry.direction === 'in') conv.counts.in += 1
      if (entry.direction === 'out') conv.counts.out += 1

      const at = Number(entry.at) || 0
      if (at >= conv.lastAt) {
        conv.lastAt = at
        if (entry.text) conv.lastText = clip(entry.text, 60)
        if (entry.direction === 'in' && entry.name) conv.name = String(entry.name)
      }
      // 群名没存过就先用群号当名字
      if (!conv.name) conv.name = conv.peerId
    }

    const out = []
    for (const conv of byKey.values()) {
      // 模式
      let mode = 'companion'
      try {
        mode = resolveMode(conv.peerKey, cfg) || 'companion'
      } catch {
        // 模式模块坏了也不能让面板空掉
      }

      // 关系阶段
      let relation = null
      try {
        const got = this.relation?.get?.(conv.peerId)
        if (got) relation = { score: got.score, phase: got.phase, label: got.label ?? '' }
      } catch {
        relation = null
      }

      // 会话事件数 / 上下文压力
      let session = null
      try {
        const live = this.mind?.listSessions?.() ?? []
        const hit = live.find((item) => String(item?.sessionId ?? '').includes(conv.peerKey))
        if (hit) {
          session = {
            sessionId: hit.sessionId,
            events: hit.events ?? 0,
            pressure: hit.pressure ?? 0,
          }
        }
      } catch {
        session = null
      }

      // 群消息缓存条数（面板上显示「她手里有多少上下文」）
      const cached = conv.scene === 'group'
        ? (this.groupHistory.get(conv.peerId)?.length ?? 0)
        : 0

      out.push({ ...conv, mode, relation, session, tags: [], cached })
    }

    out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    return out
  }

  /**
   * 把一轮对话攒进「待总结」队列，攒够就跟一次总结。
   *
   * 为什么用 `void` 不 await：总结要跑一次模型（几秒），不能让它拖慢
   * 用户已经收到回复之后的后台动作。而且总结失败绝不该影响聊天。
   */
  markForSummary(peerKey, { message, reply, role }) {
    if (!this.summarizer) return
    // 记忆总开关关掉 → 连攒都不攒（主人的意思很明确：关了就别花钱）
    if (!isOn('memory', peerKey, this.store.get())) return
    try {
      const speaker = role === 'owner' ? 'owner' : 'guest'
      // 用户说的那句
      if (message?.text) {
        this.summarizer.markTurn(peerKey, { speaker, text: message.text, at: message.at })
      }
      // 她的回复也记 —— 有些事实只出现在她的回复里（比如"我叫茶茶酱"）
      if (reply) {
        this.summarizer.markTurn(peerKey, { speaker: 'self', text: reply, at: Date.now() })
      }

      const pending = this.summarizer.maybeSummarize({ peerKey })
      if (pending && typeof pending.catch === 'function') {
        pending
          .then((result) => {
            if (result?.summarized) {
              this.log.info(
                `记忆总结：${peerKey} 新增 ${result.added ?? '?'} 条事实` +
                `（${this.memory?.stats?.()?.facts ?? '?'} 条总计）`,
              )
            }
          })
          .catch((error) => this.log.debug('自动总结失败（不影响聊天）：', error?.message ?? error))
      }
    } catch (error) {
      this.log.debug('攒记忆失败（不影响聊天）：', error?.message ?? error)
    }
  }

  /**
   * 从一条消息算出会话 key（和 `listConversations` 里的 keyOf 同构）。
   * 总开关是按对话判的，所以每个调用点都要先把它算出来。
   */
  peerKeyOfMessage(message) {
    if (!message) return ''
    if (message.scene === 'group') {
      const gid = String(message.groupId || message.peerId || '')
      return gid ? `group-${gid}` : ''
    }
    const uid = String(message.peerId || '')
    return uid ? `private-${uid}` : ''
  }

  /** 面板快照。 */
  snapshot() {
    const cfg = this.store.get()
    return {
      connected: Boolean(this.gateway.connected),
      selfId: this.gateway.selfId ?? '',
      uptimeMs: Date.now() - this.startedAt,
      dataDir: this.dataDir,
      stats: this.stats,
      pendingRequests: this.pendingRequests.size,
      groups: [...this.groupHistory.entries()].map(([groupId, lines]) => ({ groupId, cached: lines.length })),
      mind: {
        available: Boolean(this.mind?.available),
        model: call(this.mind, 'modelInfo') ?? null,
        sessions: call(this.mind, 'listSessions') ?? [],
      },
      recent: this.recent.slice(-60),
      now: Date.now(),
    }
  }
}
