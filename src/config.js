/**
 * 配置：唯一真相源是一份 JSON 文件（面板可热改），DSH 的 Config 只用来引导数据目录。
 *
 * 为什么不用 DSH 的 Config 当业务配置：
 *  - 面板要在不重启插件的前提下改任何一项（包括嵌套很深的结构）；
 *  - 一份 JSON 更容易备份、迁移、手改，出问题主人能自己救；
 *  - DSH Config 的 volatile 有「不能嵌套 volatile」的限制，撑不住这个体量。
 *
 * 读取铁律：**深合并 + 类型纠正**。
 * 旧版踩过：`patch({ brain: { dsh: { profile } } })` 只合一层，把整个 brain.dsh 顶掉，
 * 面板上同组字段瞬间全空。所以所有写入都走 mergeDeep，读盘后按默认结构校正类型。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认配置。任何字段缺失都从这里补。 */
export const DEFAULT_CONFIG = {
  qq: {
    enabled: true,
    wsUrl: 'ws://127.0.0.1:3001',
    token: '',
    selfId: '',
    reconnect: { minDelayMs: 1000, maxDelayMs: 30000, factor: 1.8 },
    /** 已连接但这么久没收到任何包（含心跳）就告警 */
    silenceWarnMs: 600000,
    /** 重连看门狗：没连上就强制重连的间隔 */
    reconnectGuardMs: 30000,
  },

  // ── 主人 ─────────────────────────────────────────────────────
  // ⚠️ **必须自己填**。留空的话她认不出谁是谁 —— 所有人都会被当成陌生人处理
  //    （群聊只读、私聊也只给只读权限）。第一次启动时日志会提醒。
  owner: {
    /** 主人的 QQ 号（数字字符串）。留空 = 还没配 */
    qq: '',
    /** 显示名，随便写，只用来给模型看她该怎么称呼 */
    name: '主人',
    /** 同一个人的其他号（比如小号） */
    aliases: [],
  },

  // ── 模式：所有「好玩但费钱」的功能的总开关 ──────────────────
  // companion = 陪伴（日程/情绪/主动/表情包/盗图/关系 全开）
  // work      = 纯干活（日程根本不生成，不注入，不主动搭话）
  // 优先级：peers[peerKey] > default
  modes: {
    default: 'companion',
    /** { "group-123456": "work", "private-1111111111": "companion" } */
    peers: {},
  },

  // ── 功能总开关 ───────────────────────────────────────────────
  // 和上面 modes 的区别（别混，这是两个维度）：
  //   modes     决定「这个对话处在什么状态」（陪伴 / 纯干活）→ 影响一整组行为
  //   features  决定「这个功能到底开不开」→ 一票否决，跟模式无关
  //
  // 三层优先级（高 → 低）：
  //   features.peers[peerKey][功能]   ← 某个群/某个人单独关掉
  //   features[功能]                  ← 全局总开关
  //   modes 矩阵                      ← 模式下"正常跑 / 只记账 / 不跑"
  //
  // 典型用法：
  //   「我不想用表情包了」      → features.meme = false
  //   「这个群别发表情包」       → features.peers['group-123456'].meme = false
  //   「这个群她纯干活」         → modes.peers['group-123456'] = 'work'
  features: {
    /** 日程：每天生成一份（关掉 = 一次模型调用都不发） */
    schedule: true,
    /** 当日状态（精力/心情底色）注入 */
    life: true,
    /** 情绪：判断 + 注入（关掉 = 连判断都不跑，省最多） */
    emotion: true,
    /** 主动消息（她主动找你）—— 功能还没实现，先留总开关 */
    proactive: true,
    /** 发表情包（句内 `&&类别&&` 标记） */
    meme: true,
    /** 盗图（看她喜不喜欢别人发的图） */
    memeSteal: true,
    /** 关系账本（记账 + 语气提示） */
    relation: true,
    /** 记忆读写（关掉 = 不注入、不总结、qq_remember 也不写） */
    memory: true,
    /** 群管（热词审查 + 自动禁言） */
    moderation: true,
    /** 输出侧审核（她要说出去的话出门前再看一遍） */
    replyGuard: true,
    /**
     * 按对话覆盖：{ "group-123456": { "meme": false, "memeSteal": false } }
     * 只写 false/true，缺省跟随上面的全局值。
     */
    peers: {},
  },

  // ── L3 The Mind ──────────────────────────────────────────────
  mind: {
    /**
     * 工具白名单。这就是「把完整 DSH 砍到只剩四种能力」的那一刀。
     *
     * 砍法有据可查（旧版 headless-guest profile 的血泪结论）：
     *   ✗ 直接禁用 tools 服务 → 整个 profile 起不来
     *   ✓ 保留 tools 服务，只把工具一个个摘掉 → 服务在，工具没了，
     *     模型连 schema 都看不到，比靠提示词约束硬得多。
     */
    toolAllow: [
      // ① 制定计划
      'todo_write',
      'exit_plan_mode',
      // ② 启动子 Agent（跨会话回忆要用）
      'subagent',
      'subagent_fork',
      'send_message',
      'list_agents',
      // ③ 上网
      'web_search',
      'web_fetch',
    ],
    /** 空 = 跟随 DSH 默认模型 */
    provider: '',
    model: '',
    reasoningEffort: '',
    maxTokens: 0,
    turnTimeoutMs: 180000,
    sessionPrefix: 'qq',
    /** 攒够多少事件就尝试压缩（软上限，0 = 不主动压） */
    compactAtEventCount: 800,
    /**
     * **硬上限**：压缩压不动（服务不可用 / 内核拒绝）时，到这个数就换代次。
     *
     * 为什么必须有这一条：压缩是「尽力而为」——内核可能因为
     * 「没有安全的可压段落」「单个 tool 结果太大」直接拒绝。
     * 没有硬上限的话事件数会一路涨，最后 API 直接报 context overflow，
     * 消息发不出去（而且是在最需要回话的时候失败）。
     * 旧版只有「换代次」这一条粗暴路径，v3 改成「先压缩、压不动才换代次」。
     * 0 = 不设硬上限（不推荐）。
     */
    hardResetEventCount: 2000,
    /** 人格覆盖：留空用内置人格 */
    personaOverride: '',
  },

  // ── 观望 ─────────────────────────────────────────────────────
  // 拟人取向：**别让人等**。真人不会盯着屏幕等半分钟才回一句。
  // 原来的 20~60 秒是「怕打扰」的思路，代价是延迟高到能感觉出来像机器人。
  observe: {
    enabled: true,
    /** 默认观望窗口（消息进来后等这么久再决定回不回） */
    defaultMinMs: 8000,
    defaultMaxMs: 25000,
    /** 被 @ 的固定延迟（被人叫名字要快） */
    atMs: 4000,
    /** 非主人私聊，同一坨里已经观望过一次的后续延迟 */
    guestPrivateMs: 3000,
    /** 主人私聊秒回 */
    ownerPrivateMs: 0,
    /**
     * 主人在群里说话、但**没 @ 我**：等这么久。
     *
     * 为什么不是 0：主人在群里跟别人聊天，每句都秒回会非常吵、也非常烧钱。
     * 为什么不是 20~60 秒：主人明明在跟自己说话，等那么久会以为她死了。
     */
    ownerGroupMs: 3000,
    /** 多久之内算「同一坨连续对话」—— 90 秒更像真人：刚聊完的话题还记得 */
    sameThreadMs: 90000,
    /** 一批最多攒多少条，超了就提前结算 */
    maxBatch: 40,
    /**
     * 按对话覆盖观望时长（面板里那个「这个对话单独调」）。
     *   { "group-123456": { "minMs": 5000, "maxMs": 15000 } }
     * 只有 minMs/maxMs 两项，其余档位仍走上面的全局值。
     */
    peers: {},
  },

  // ── Interesting ──────────────────────────────────────────────
  // 拟人取向：**比默认更愿意说话**。0.65 意味着群里没被 @ 时
  // 概率 = 0.65 × 0.45 ≈ 29%，大约每三四条群消息接一次 —— 活跃但不多话。
  interest: {
    default: 0.65,
    /** { "123456789": 0.9 } */
    users: {},
    /** { "999999": 0.7 } */
    groups: {},
    /** 被 @ 时高于这个兴趣就一定回 */
    atSureThreshold: 0.1,
    /** 「p(5*兴趣)」里的那个 5 */
    atMultiplier: 5,
    /** 没被 @ 时兴趣乘这个系数才当概率（避免群里话痨） */
    unmentionedFactor: 0.45,
  },

  // ── 出站节奏 ─────────────────────────────────────────────────
  // 拟人取向：**打字快、片数少**。
  // 每片仍守着主人定的「<20 token」，但片间间隔缩到 1.2~3 秒（真人手机打字的速度），
  // 一轮最多 12 片 —— 再多就不像人，像复读机。
  rhythm: {
    enabled: true,
    /** 两条消息之间的随机间隔 */
    minGapMs: 1200,
    maxGapMs: 3000,
    /** 一片最多多少 token（主人定的 20，别动） */
    maxTokensPerPiece: 20,
    /** 一轮最多发几片（防刷屏） */
    maxPiecesPerTurn: 12,
    /** 单条消息的硬上限（QQ 侧限制） */
    maxCharsPerMessage: 2000,
  },

  // ── 权限 ─────────────────────────────────────────────────────
  access: {
    defaultPrivateMode: 'danger-full-access',
    defaultGroupMode: 'read-only',
    strangersCanChat: true,
    strangerReply: '呜…茶茶酱只听主人的话哦，不跟陌生人聊 (´･ω･`)',
    requireAtInGroup: true,
    /** 三档黑名单：[{ qq, level: 'no-at'|'chat-only'|'block', note }] */
    blocklist: [],
    /** 群白名单，空 = 全管 */
    groups: [],
  },

  // ── 彩蛋 ─────────────────────────────────────────────────────
  // 全是「只加味道、不加逻辑」的东西：最坏情况是她说了一句有点奇怪的话，
  // 永远不会导致丢消息、发错人、多花钱。
  // 想全部关掉：`easterEggs: false`（那就跟没有这个文件一样）。
  fun: {
    /** 总开关。关掉 = 启动语不变、深夜不关怀 */
    easterEggs: true,
    /**
     * 凌晨 2~5 点，说一句「你怎么还不睡」的概率。
     *
     * 为什么默认只有 0.08：每晚聊十句顶多撞上一次。
     * 每次都提醒就变成教训人了，不是关心。
     */
    nightCareProbability: 0.08,
  },

  // ── 群 ───────────────────────────────────────────────────────
  group: {
    historyLines: 30,
    /**
     * 群上下文注入策略：
     *   'always'     每条群消息都把最近 N 条历史塞进 prompt（信息全，但贵）
     *   'on-demand'  只在「被 @」或「决定插嘴」时才带（省钱，默认）
     *
     * 主人说「上下文不要太多，不然贵死」→ 默认 on-demand。
     * 注意：群上下文缓存本身**始终**在记（免费），这里只决定要不要塞进 prompt。
     */
    contextOn: 'on-demand',
    /** 每个群的独立配置，键是群号 */
    profiles: {},
  },

  // ── 安全 ─────────────────────────────────────────────────────
  security: {
    /** 防提示词注入总开关 */
    injectionEnabled: true,
    /** 额外自定义的注入特征（正则字符串），面板可加 */
    injectionPatterns: [],
    /** 命中后的惩罚档：ignore | mute-and-block | ban */
    penalty: 'mute-and-block',
    penaltyMuteMinutes: 10,
    /** 惩罚后多久内不再重复处罚同一人 */
    penaltyCooldownMs: 3600000,

    // ── 分级阈值（controller-core 的 security.js 认这几个） ──
    /** 可疑级要不要罚（null = 不罚，宁可漏判）。设成 'ignore' 之类就轻罚 */
    suspiciousPenalty: null,
    /** 累计到多少分算可疑 */
    suspiciousScore: 2,
    /** 累计到多少分算恶意 */
    maliciousScore: 4,
    /** 自定义正则命中的权重 */
    customPatternWeight: 3,
    /** 单条最多扫多少字符（防超长灌水把 CPU 拖死） */
    maxScanChars: 20000,

    // ── 输出侧审核（她要说出去的话，出门之前再看一遍） ──
    /** 总开关。输入侧挡「用户想注入」，这一层挡「她自己被带歪了」 */
    outputGuard: true,
    /** 命中后的处置：fallback（换一句兜底话）| discard（这条不发） */
    replyPenalty: 'fallback',
  },

  // ── 贴标签 ───────────────────────────────────────────────────
  tags: {
    enabled: true,
    /** { "123456789": ["老朋友"] } */
    users: {},
    /** { "999999": ["技术群"] } */
    groups: {},
    /** 覆盖内置标签表：{ 标签名: "念给她听的解释" } */
    table: {},
    /** 一个人最多带几个标签（防刷屏） */
    maxTags: 5,
    /** 自动打标签的阈值 */
    auto: {
      /** 当天说超过这么多条算 frequent */
      frequentAfterMsgs: 30,
      /** 第一次说话打 newcomer */
      newcomer: true,
    },
  },

  // ── 情绪（鱼的心风格） ────────────────────────────────────────
  emotion: {
    enabled: true,
    /** 心情值基线（0-100） */
    baseline: 70,
    /** 心情没情绪时向基线回落的半衰期（小时） */
    moodHalfLifeHours: 3,
    /** 七根情绪向 0 衰减的半衰期（分钟） */
    feelingHalfLifeMinutes: 90,
    /** 注入方式：none（不告诉它）/ mood-only（只说心情）/ event（说它刚才那件事） */
    tellIt: 'event',
    /** 判断模型自己标的分低于它就只记后台、不进嘴 */
    confidenceThreshold: 60,
    /** 心情下限（0 = 不设底线） */
    floor: 0,
    /**
     * 每几轮判断一次心情。
     *
     * ⚠️ 这是全项目最贵的一项隐性开销：**每判断一次就是一整次模型调用**。
     * 心情半衰期 3 小时、情绪 90 分钟，一两轮的延迟几乎看不出来，
     * 所以默认 2（省一半）。设 1 = 每轮都判（最准最贵）。
     */
    judgeEveryTurns: 2,
  },

  // ── 记忆 ─────────────────────────────────────────────────────
  // ⚠️ 主人的原话：「记忆很短」「怎么能按时间算呢」「上下文不要太多，不然贵死」。
  // 所以 v2 的取向是：**预算砍一半以上 + 按相关检索而不是按时间切 + 自动总结**。
  memory: {
    enabled: true,
    /** 注入总量硬上限（原 6000 → 1600：主人在意成本） */
    injectMaxChars: 1600,
    /** 核心记忆（永久、每轮都注入）的预算 */
    injectCoreMaxChars: 600,
    /** 每次注入最多检索几条结构化事实 */
    factsMaxItems: 6,
    /** 最近几天的流水参与注入（1 = 只看今天，其余靠检索） */
    injectRecentDays: 1,
    injectSummaryMaxChars: 1200,
    /** 跨会话回忆：派子 Agent 复盘别的对话 */
    recallEnabled: true,
    recallMaxTokens: 1200,
    /** 回忆最多扫多少天的轨迹 */
    recallScanDays: 14,
    /**
     * 自动总结：攒够就抽「值得长期记住的」写进 facts.jsonl。
     * 没有这个的话，主人说「我喜欢吃辣」如果她没主动调 qq_remember 就丢了。
     */
    summarize: {
      enabled: true,
      /** 攒够多少条对话总结一次 */
      minTurns: 12,
      /** 或者攒够多少字 */
      maxChars: 4000,
    },
  },

  // ── 日程与当日状态（她有自己的生活） ────────────────────────
  // 只在 companion 模式跑；work 模式**连生成都不触发**（省一次模型调用）。
  life: {
    enabled: true,
    schedule: {
      /** 每天几段（会被夹在 6~8） */
      segments: 6,
      /** 过了这个点、当天第一次真正用到才生成；'off'/'always' = 不挡 */
      generateAfter: '07:30',
      /** 当天生成后是否允许重新生成（false = 防精神分裂） */
      regenerateAllowed: false,
    },
    state: {
      /** 精力基线（10~100） */
      energyBaseline: 75,
      /** 注入档：companion-only / off */
      injectMode: 'companion-only',
    },
  },

  // ── 关系账本（我们走到哪一步了） ────────────────────────────
  relation: {
    enabled: true,
    /**
     * 初始分。**0 而不是 200** —— 200 正好是 familiar 的下限，
     * 那样所有陌生人一上来就"熟悉"了。
     */
    initial: 0,
    /** 单次涨跌上限 */
    singleGainCap: 4,
    singleLossCap: 12,
    /** 每日正向累计上限（超出丢弃） */
    dailyGainCap: 12,
    /** 阶段迟滞：跨段要越过阈值 ±20 才生效，防阈值抖动 */
    hysteresis: 20,
    /** 自然回落：只向 0 减、不转负 */
    decay: {
      graceDays: 3,
      tiers: [
        { untilDay: 7, perDay: 2 },
        { untilDay: 14, perDay: 5 },
        { perDay: 8 },
      ],
    },
    /** 边际递减：越熟越难涨 */
    diminish: { from: 600, factor: 0.75, hardFrom: 900, hardFactor: 0.5 },
    /** 同一件事多久内不重复记 */
    dedupeMs: 1800000,
    /** 主人分数地板（掉不到这个阶段以下 —— 一次吵架她就不理人，体验很糟） */
    ownerFloorPhase: 'close',
    /** 账本最多留多少条 */
    ledgerMax: 200,
  },

  // ── 表情包 ───────────────────────────────────────────────────
  meme: {
    /** 整条消息发图的总闸（0 = 从不发） */
    probability: 0.35,
    /** 一条消息最多几张（一条一张就够，多了像刷屏） */
    maxPerMessage: 1,
    /** 图文混排的概率（其余情况发完文字再单独发）—— 60% 更像真人：话里夹个表情 */
    inlineProbability: 0.6,
    /** 同一类别两次之间的冷却 */
    cooldownMs: 120000,
    /** 盗图：看她喜不喜欢别人发的图 */
    steal: {
      /** 每收到一张图，有这个概率去看一眼（0 = 从不看） */
      probability: 0.08,
      /** 按对话覆盖：{ "group-123456": 0.3 } */
      peers: {},
      minBytes: 4096,
      /** 2MB，太大的一律不收 */
      maxBytes: 2097152,
      allowedExt: ['gif', 'png', 'jpg', 'jpeg', 'webp'],
    },
  },

  // ── 入站媒体 ─────────────────────────────────────────────────
  // 这两个数被 src/controller/inbound.js 直接读 —— DESIGN §5 里漏了，
  // 缺了它 Inbound 走自己的兜底（8MB/5张），但面板就调不了。
  inbound: {
    /** 单个文件上限，超了不下载（默认 8MB） */
    maxBytes: 8 * 1024 * 1024,
    /** 一次最多收几张图（防刷） */
    maxImages: 5,
    /** 单次下载超时 */
    timeoutMs: 20000,
  },

  // ── 群管 ─────────────────────────────────────────────────────
  moderation: {
    watchAll: true,
    /** 命中就建议禁言 */
    hotKeywords: [],
    banEnabled: true,
    defaultBanMinutes: 10,
    maxBanMinutes: 60,
    /** 禁言后要不要跟主人汇报 */
    notifyOwner: true,
  },

  // ── NapCat 守护 ──────────────────────────────────────────────
  napcat: {
    dir: '',
    bootExe: 'NapCatWinBootMain.exe',
    autoStart: true,
    watchIntervalMs: 60000,
    minSpawnGapMs: 120000,
    account: '',
  },

  // ── 日志 ─────────────────────────────────────────────────────
  log: {
    level: 'info',
    maxFileBytes: 4 * 1024 * 1024,
  },
}

/** 判断是否纯对象（不含数组 / null / class 实例）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 深合并：对象逐层合，数组整体替换，标量以 patch 为准。
 * 与面板侧 client.js 的 mergeDeep 必须同语义（旧版就栽在两边不一致）。
 */
export function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeDeep(out[key], value) : value
  }
  return out
}

/**
 * 按模板校正类型：模板里是对象就保证还是对象，是数组就保证还是数组。
 * 防的是 `POST /config {"qq": 0}` 把整个 qq 顶成数字、下次读 `config.qq.enabled` 直接 TypeError。
 */
export function sanitizeConfig(raw, template = DEFAULT_CONFIG) {
  const out = {}
  for (const [key, fallback] of Object.entries(template)) {
    const value = raw?.[key]
    if (Array.isArray(fallback)) {
      out[key] = Array.isArray(value) ? value : structuredClone(fallback)
    } else if (isPlainObject(fallback)) {
      out[key] = sanitizeConfig(isPlainObject(value) ? value : {}, fallback)
    } else if (value === undefined || value === null) {
      out[key] = fallback
    } else if (fallback === null) {
      // ⚠️ 模板默认是 null = 「默认不设值」，不是「类型必须是 null」。
      //    旧写法拿 typeof 比会把用户填的字符串直接吞掉 ——
      //    实测 `security.suspiciousPenalty: 'ignore'` 会被静默重置成 null，
      //    于是「可疑级惩罚可配置」这条永远开不起来。这里特判放行。
      out[key] = value
    } else if (typeof value === typeof fallback) {
      out[key] = value
    } else {
      out[key] = fallback
    }
  }
  // 保留默认结构里没有、但用户手写进来的字段（向前兼容）
  if (isPlainObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (!(key in out)) out[key] = value
    }
  }
  return out
}

/**
 * patch 里值为 `null` 的键 = **删除这一项**（不是"设成 null"）。
 *
 * 为什么需要这条语义：
 *   面板上的「切回跟随全局」按钮要删掉一条覆盖（比如 `features.peers['group-9']`）。
 *   但 `mergeDeep` 只会把 `null` 写进去，配置里就留一堆 `{"group-9": null}` ——
 *   功能上确实等效于删（判定时 null 是 falsy），但配置文件越来越脏、主人手改时看不懂。
 *   所以这里在合并之前先把这些键**真删掉**。
 *
 * ⚠️ 只删「patch 里显式给了 null」的键，绝不全局清 null
 *    （`security.suspiciousPenalty` 的默认值本来就是 null，全局清会把它弄没）。
 */
function applyNullDeletes(target, patch) {
  if (!isPlainObject(target) || !isPlainObject(patch)) return 0
  let removed = 0
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (key in target) {
        delete target[key]
        removed += 1
      }
      continue
    }
    if (isPlainObject(value) && isPlainObject(target[key])) {
      removed += applyNullDeletes(target[key], value)
    }
  }
  return removed
}

/** 把 patch 里值为 null 的键摘掉（它们已经按「删除」处理了，不该再参与 merge）。 */
function stripNulls(patch) {
  if (!isPlainObject(patch)) return patch
  const out = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) continue
    out[key] = isPlainObject(value) ? stripNulls(value) : value
  }
  return out
}

/**
 * 一个配置文件句柄。
 * 所有读写都在这里，别处拿到的是同一个对象引用，改完调 save()。
 */
export class ConfigStore {
  /** @param {string} file 绝对路径 */
  constructor(file) {
    this.file = file
    this.value = structuredClone(DEFAULT_CONFIG)
    this.loaded = false
  }

  /** 从磁盘载入（不存在则落一份默认值）。 */
  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      this.value = sanitizeConfig(JSON.parse(text))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`读取配置失败：${this.file} — ${error.message}`)
      this.value = structuredClone(DEFAULT_CONFIG)
    }
    if (!fs.existsSync(this.file)) this.save()
    this.loaded = true
    return this.value
  }

  /** 原子写盘：先写临时文件再改名，避免半截 JSON。 */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
    return this.value
  }

  /**
   * 合并一份补丁并落盘（深合并，绝不整块顶掉）。
   *
   * 特殊语义：patch 里值为 `null` 的键 = **删除该项**
   * （见上面 applyNullDeletes 的注释；面板的「切回跟随全局」靠它）。
   */
  patch(patchPayload) {
    const base = structuredClone(this.value)
    const removed = applyNullDeletes(base, patchPayload)
    const cleaned = stripNulls(patchPayload)
    this.value = sanitizeConfig(mergeDeep(base, cleaned))
    if (removed > 0) this.lastRemovedKeys = removed
    this.save()
    return this.value
  }

  get() {
    return this.value
  }
}

/** 数据目录：默认 $DSH_HOME/plugins/dsh-chacha-qq */
export function resolveDataDir(config) {
  if (typeof config?.dataDir === 'string' && config.dataDir.trim()) return config.dataDir.trim()
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugins', 'dsh-chacha-qq')
}
