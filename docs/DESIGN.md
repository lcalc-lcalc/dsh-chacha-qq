# dsh-chacha-qq v3 · 架构契约

> 作者：茶茶酱（茶茶酱）
> 状态：施工中。**这份文件是组队的唯一契约**，改接口先改这里。
> 旧版 `<旧版目录>` 只当「踩坑字典」参考，不继承代码。

---

## 0. 一句话

**QQ 消息进来 → Controller 加工 → The Mind（砍出来的小 DSH）思考 → Controller 分片发回去。**

三层，边界清楚，每层能单独测。

---

## 1. 三层职责（不许越界）

```
┌─ L1 NapCat ───────────────────────────────────────────┐
│ 只做「协议翻译」。不判断、不决策、不记忆。              │
│ 输入：OneBot 11 原始 JSON 帧（ws）                      │
│ 输出：QqMessage（干净、扁平、可 JSON 化）               │
└──────────────────────┬────────────────────────────────┘
                       ↓ QqMessage
┌─ L2 Controller ──────┴────────────────────────────────┐
│ 所有「要不要回、多久回、回什么语气、安不安全」的判断。   │
│ 不直接调模型。只生产 MindRequest。                      │
│ 输出：MindRequest / 发送动作                            │
└──────────────────────┬────────────────────────────────┘
                       ↓ MindRequest
┌─ L3 The Mind ────────┴────────────────────────────────┐
│ 一个「砍到只剩四种能力」的小 DSH。                      │
│ 能力：制定计划 / 工具调用 / 子Agent / 上网              │
│ 输入：MindRequest。输出：MindReply（流式 + 轨迹）        │
└───────────────────────────────────────────────────────┘
```

**硬规矩**
- L1 不许 import L2/L3。
- L3 不许知道 QQ 协议细节（只认 sessionId + 文本）。
- L2 是唯一知道「谁是谁、该不该理」的地方。
- 三层之间只传纯数据（可 JSON.stringify），不传类实例、不传 socket。

---

## 2. 目录

```
<本项目目录>\
  package.json                 插件声明（dsh.bundle.patch + dsh.client）
  cordis.patch.yml             insert: [{ id: chacha-qq, name: 'dsh-chacha-qq' }]
  index.js                     host 入口：只装配，业务全在 src/
  client.js                    面板前端（UI 阶段，暂缓）

  src/
    napcat/
      gateway.js       OneBot 11 WS：连接/退避重连/回包匹配/心跳/静默检测/forceReconnect
      normalize.js     原始帧 → QqMessage；segments→text；umo/sessionId 计算
      api.js           OneBot action 封装（发消息/禁言/踢人/撤回/成员/文件）

    controller/
      pipeline.js      总调度：收包 → 去重 → 路由 → 观望 → 兴趣 → 组装 → 投 Mind → 发回
      route.js         纯函数路由：owner/guest/黑名单/群白名单/单群黑名单
      observe.js       观望机制：20s~1min，三档例外
      interest.js      Interesting：0~1 兴趣，p(5*interest)
      tags.js          贴标签：给用户/群贴标签，影响语气
      security.js      防提示词注入 + 惩罚
      emotion.js       情绪机制（鱼的心风格）
      rhythm.js        出站节奏：2~5s 间隔 + <20 token 分片
      outbox.js        发送：Markdown 降级 / 重试 / 引用
      inbound.js       媒体落盘
      moderation.js    群管：自动审查 / 禁言判定
      memory/
        store.js       按天记忆 + core.md + 月度摘要
        recall.js      跨会话回忆：派子 Agent 复盘别的对话

    mind/
      preset.js        精简 preset：白名单工具 + 人格 + 记忆上下文
      session.js       一对一会话管理（peer → sessionId，代次）
      turn.js          跑一轮：投递 → 流式 → 停稳 → 终稿 → 轨迹
      tools.js         QQ 工具（owner 专属，14 个）
      compact.js       上下文压缩（用 ctx.compaction）

  presets/
    chacha-mind.yml    精简 preset 的声明（若走 YAML 路线）

  tests/
    harness.mjs        迷你测试框架（抄 v2 的）
    *.mjs              纯函数优先，不需要 DSH / QQ / 网络
```

---

## 3. 核心数据结构（**冻结，改这里要通知全员**）

```js
/** L1 输出：归一化消息 */
export const QqMessageShape = {
  id: 'string',              // message_id，去重用
  scene: 'private|group',
  peerId: 'string',          // 私聊=对方QQ；群聊=群号
  groupId: 'string',         // 群聊才有，否则 ''
  userId: 'string',
  selfId: 'string',          // 机器人自己的 QQ
  // ⚠️ role 是**群内身份**（owner/admin/member），不是 L2 的 owner/guest 角色。
  //    群管工具靠它判「能不能动这个人」—— 缺了它 moderation 永远拿到空、谁都能禁言。
  sender: { id: 'string', nickname: 'string', card: 'string', role: 'owner|admin|member|' },
  text: 'string',            // 纯文本，@已被替换成 @昵称
  segments: 'array',         // 原始消息段，原样保留
  mentionsMe: 'boolean',
  replyId: 'string',         // 引用的那条消息 id（没有就是 ''）
  media: [{ kind: 'image|file|record|video', url: 'string', fileId: 'string', name: 'string' }],
  at: 'number',              // 毫秒时间戳
  raw: 'object',             // 原始帧，排错用
}

/**
 * umo 口径：统一用短横线 —— `qq-private-<uid>` / `qq-group-<gid>`。
 * （旧版是冒号 `qq:group:999`，**别照抄**。两版不一致会让按 umo 索引的东西全部错位。）
 *
 * sender.role 与 L2 role 的区别（容易混，写清楚）：
 *   sender.role  = owner/admin/member  → 群里的身份 → 群管能不能动手
 *   Decision.role = owner/guest        → 是不是主人本人 → 给不给工具、给多大沙箱
 */

/** L2 路由判定 */
export const DecisionShape = {
  action: 'handle|observe|ignore',
  role: 'owner|guest',
  mode: 'read-only|workspace-write|danger-full-access',
  reason: 'string',          // 判定理由，日志用
  priority: 'instant|at|private|observe',  // 决定观望时长
}

/** L2 → L3 */
export const MindRequestShape = {
  sessionId: 'string',       // 一对一：一个 peer 一条
  role: 'owner|guest',
  mode: 'string',
  text: 'string',            // 组装好的这一条输入
  timeoutMs: 'number',
}

/** L3 → L2 */
export const MindReplyShape = {
  text: 'string',            // 终稿（可能为空 = 她选择不说）
  reason: 'string|object',   // turn/end reason，排错用
  elapsedMs: 'number',
  trace: 'Array<{kind, at, text?, name?, args?, result?, error?}>',
}
```

---

## 4. 各模块接口

### L1

```js
// gateway.js — OneBot 11 客户端
export class OneBotGateway extends EventEmitter {
  constructor({ wsUrl, token, log, reconnect, silenceWarnMs, WebSocketImpl })
  connect(): void
  close(): void                 // ⚠️ 只是关。要重连必须 forceReconnect()（v2 坑 15）
  forceReconnect(): void
  /** 热更新连接参数：wsUrl/token 变了才重连，其余就地生效。返回是否重连了 */
  update({ wsUrl, token, reconnect, silenceWarnMs }): boolean
  async call(action, params, timeoutMs?): Promise<any>
  get connected(): boolean
  get selfId(): string
  get healthy(): boolean
  // events: 'open' | 'login' | 'packet' | 'heartbeat' | 'stale' | 'close' | 'error'
}

// normalize.js — 纯函数
export function segmentsToText(segments): string
export function normalizeMessage(packet, selfId): QqMessage | null
export function umoOf(message): string                    // 'qq-private-123' | 'qq-group-456'
export function sessionKeyOf(message, prefix, role): string
export function sessionIdOf(message, prefix, role, generation = 0): string

// api.js — 薄封装
export function createQqApi(gateway) => {
  sendPrivate(userId, segments), sendGroup(groupId, segments),
  sendFile({ scene, peerId, file, name, folder }),      // 统一入口（图片自动转 base64://）
  sendFilePrivate(opts), sendFileGroup(opts),
  ban(groupId, userId, durationSec), kick(groupId, userId, rejectAddRequest),
  recall(messageId), getGroupList(), getGroupMembers(groupId),
  getGroupHistory(groupId, count), getFriendList(),
  friendRequest(flag, approve, remark),
  // ⚠️ OneBot 11 的 set_group_add_request 必须带 sub_type（add/invite），
  //    不给会被 NapCat 报参数错。第 4 参可选，旧调用方式不受影响。
  groupRequest(flag, approve, reason, subType = 'add'),
}
```

### L2

```js
// route.js — 全纯函数，零 IO
export const ACTION = { HANDLE: 'handle', OBSERVE: 'observe', IGNORE: 'ignore' }
export const ROLE = { OWNER: 'owner', GUEST: 'guest' }
export function decideRoute(message, config): Decision
export function createDeduper(capacity = 512) => { fresh(id), size(), clear() }
export function createRateLimiter({ capacity, refillMs }) => { take(key, now), reset(key) }

// observe.js — 观望
/** 这条消息该等多久再处理（0 = 立刻） */
export function waitMsFor(message, decision, config, ctx): number
/** 批次键：私聊按 peer，群聊按群 */
export function batchKeyOf(message): string

/**
 * 观望窗口：同一 peer 的消息在窗口内累积，到期一次性交给 onSettle。
 *
 * 契约（**定时器归窗口、结算回调归调用方**）：
 *  - 调用方不用维护 peer→timer 的 Map，职责不串。
 *  - 同一批只启一次定时器；后续消息只累积、**不重置**（否则越聊越不回，永远等不到）。
 *  - 批次里出现「被 @」→ 清定时器、立刻结算整批。
 *  - 条数超过 observe.maxBatch → 提前结算。
 *  - dispose() 清掉所有定时器。
 */
export class ObservationWindow {
  constructor({ log, onSettle(batchKey, messages), now, rng, windowMs,
                setTimer, clearTimer, maxReadyMsgs })
  /** 入队。flush=true 表示这次 push 提前结算了整批。正常路径交付只走 onSettle */
  push(message, decision, config): { batchKey, settleAfterMs, waitedMs, flush, settled, flushReason }
  /** 只给「没有 onSettle」的单测/排错用 */
  take(batchKey): QqMessage[]
  isSameThread(batchKey, config, at): boolean
  pendingCount(): number
  dispose(): void
}

// interest.js — 纯函数 + 可注入 rng
export function interestOf(userId, groupId, config): number      // 0~1
export function shouldReply(message, interest, { rng = Math.random }): { reply, p, reason }

// rhythm.js — 纯函数
/** 估算 token：汉字 1:1，其他 1:4 */
export function estimateTokens(text): number
/** 按 token 上限分片，优先句末标点切 */
export function splitByTokens(text, maxTokens = 20, maxParts = 20): string[]
/** 两条之间的随机间隔 [minMs, maxMs] */
export function gapMs({ minMs = 2000, maxMs = 5000 }, rng = Math.random): number

// rhythm.js — 纯函数 + 状态机
/** 估算 token：汉字/全角标点/emoji = 1，英文数字半角 = 4 字符 1（向上取整） */
export function estimateTokens(text): number
/** 按 token 上限分片，优先句末标点 → 逗号 → 英文词边界 → 均分硬切；叠词不劈开 */
export function splitByTokens(text, maxTokens = 20, maxParts = 20): string[]
/** 两条之间的随机间隔 [minMs, maxMs] */
export function gapMs({ minMs = 2000, maxMs = 5000 }, rng = Math.random): number
/** 节奏发送器状态机：分片 → 逐条发 → 片间随机等待；可 cancel()/dispose() */
export function createRhythmSender({ outbox, store, log, now, rng }): {
  send(message, text, options), cancel(reason), dispose()
}

// outbox.js
export function markdownToPlain(input): string
export class Outbox {
  // api 优先（sendPrivate/sendGroup）；只给 gateway 也兼容（走 OneBot action）
  constructor({ api, gateway, store, log, rhythm, retryDelayMs })
  plain(text): string
  async send(message, text, { quote }): Promise<{ sent, total, cancelled }>
  async sendPiece(message, text, { quote }): Promise<boolean>
  async push(target, text)
  cancel(reason), dispose()
}

// inbound.js — 媒体落盘
export class Inbound {
  constructor({ gateway, store, log, dataDir, fetchImpl, now, timeoutMs })
  async collect(message): Promise<Array<{ kind, url, path, bytes, failed, reason? }>>
  limits(), dispose()
}
// 读 config.inbound.{maxBytes, maxImages, timeoutMs}；失败不抛，返回 failed: true

// memory/store.js
export class MemoryStore {
  constructor({ dataDir, config /* 对象或 getter */, log, now })
  appendMemory(text, { shared, section, tag, at }): Promise
  buildContext({ role, peerId }): string
  renderGuide({ role }): string
  listDays(), stats(), dispose()
}
// memory/recall.js
export class Recall {
  constructor({ dataDir, runSubagent, config, log, now })
  async recall({ question, excludeSessionId, budgetTokens }): Promise<string>
}
```

### L3

```js
// preset.js
export const MIND_TOOL_ALLOW = [
  // 制定计划
  'todo_write', 'exit_plan_mode',
  // 启动子 Agent
  'subagent', 'subagent_fork', 'send_message', 'list_agents',
  // 上网
  'web_search', 'web_fetch',
]
export function buildMindPersona({ role, tags, custom }): string

// session.js
export class MindSessions { ensure(message, role, mode), dispose(sessionId), list() }

// turn.js
export class Mind {
  get available(): boolean
  async ask({ sessionId, role, mode, text, onDelta, timeoutMs }): Promise<MindReply>
  async dispose(sessionId), async disposeAll()
}
```

---

## 5. 配置 schema（`config.json`，深合并 + 原子落盘）

```jsonc
{
  "qq": { "enabled": true, "wsUrl": "ws://127.0.0.1:3001", "token": "", "selfId": "" },
  "owner": { "qq": "1111111111", "name": "主人", "aliases": [] },

  "mind": {
    "toolAllow": ["todo_write", "exit_plan_mode", "subagent", "subagent_fork",
                  "send_message", "list_agents", "web_search", "web_fetch"],
    "provider": "", "model": "", "reasoningEffort": "",
    "turnTimeoutMs": 180000,
    "compactAtEventCount": 400,     // 软上限：到这数就试压缩
    "hardResetEventCount": 1200,    // 硬上限：压不动就换代次（0 = 不设，不推荐）
    "personaOverride": ""
  },

  "observe": {
    "defaultMinMs": 20000, "defaultMaxMs": 60000,
    "atMs": 10000, "guestPrivateMs": 5000, "ownerPrivateMs": 0,
    "sameThreadMs": 60000
  },

  "interest": {
    "default": 0.5,
    "users": {},                 // { "123456": 0.9 }
    "groups": {},                // { "999": 0.7 }
    "atSureThreshold": 0.1,
    "atMultiplier": 5,
    "unmentionedFactor": 0.35
  },

  "rhythm": {
    "minGapMs": 2000, "maxGapMs": 5000,
    "maxTokensPerPiece": 20,
    "maxPiecesPerTurn": 20,
    "maxCharsPerMessage": 2000
  },

  "access": {
    "defaultPrivateMode": "danger-full-access",
    "defaultGroupMode": "read-only",
    "strangersCanChat": true,
    "strangerReply": "…",
    "blocklist": [],             // [{ qq, level: 'no-at'|'chat-only'|'block' }]
    "groups": []                 // 群白名单，空 = 全管
  },

  "security": {
    "injectionEnabled": true,
    "injectionPatterns": [],     // 命中就给惩罚档
    "penalty": "mute-and-block", // ignore | mute-and-block | ban
    "penaltyMuteMinutes": 10
  },

  "emotion": { "enabled": true, "baseline": 70, "halfLifeHours": 3, "tellIt": "event" },

  "memory": { "enabled": true, "injectCoreMaxChars": 2000, "injectRecentDays": 3,
              "recallEnabled": true, "recallMaxTokens": 1200 },

  "inbound": { "maxBytes": 8388608, "maxImages": 5, "timeoutMs": 20000 },

  "moderation": { "watchAll": true, "hotKeywords": [], "banEnabled": true,
                  "defaultBanMinutes": 10, "maxBanMinutes": 60 },

  "napcat": { "dir": "", "bootExe": "NapCatWinBootMain.exe", "autoStart": true }
}
```

---

## 6. 观望机制（主人的硬要求）

> 原文：每两条消息之间 2~5 秒间隔，由 DSH 决定分片，一片 <20 tokens。
> 消息进入 DSH 后进入「观望」状态（20 秒~1 分钟）。
> 例外：① 被 @ ② 主人的私聊 ③ 他人的私聊在「一坨」聊天中已经有过一次观望。
> 被 @ 后延迟 10 秒回，主人私聊秒回，他人私聊延迟 5 秒。

**实现表**

| 情形 | 处理延迟 |
|---|---|
| 主人私聊 | `0` 秒回 |
| **主人群聊、但没 @ 我** | `5` 秒（`observe.ownerGroupMs`） |
| 主人群聊 @ 我 | `0`~`10` 秒（被 @ 那档） |
| 群聊被 @（非主人） | `10` 秒（`observe.atMs`） |
| 私聊（非主人）首次 | `random(20~60)` 秒观望 |
| 私聊（非主人）同一坨内 | `5` 秒（`observe.guestPrivateMs`） |
| 群聊没 @（observe） | `random(20~60)` 秒，窗口结束一次性投喂 |

> **为什么主人在群里没 @ 不秒回**：主人在群里跟**别人**聊天时，她每句都接会非常吵，
> 而且每句都是一次模型调用。想让她「群里主人一说话就回」就把 `observe.ownerGroupMs` 填 0。

「同一坨」判定：同一 `peerId` 在 `observe.sameThreadMs`（默认 60s）内已经跑完过一次观望 → 认为还在同一段连续对话里。

**观望窗口语义**：窗口内的消息不丢、不打乱，窗口结束时作为一个批次一起交给 Mind（群聊还要带历史上下文）。批次里任何一条被 @ 都要立刻把整批提前结算。

---

## 7. Interesting（主人的硬要求）

> 原文：可以对指定的人/群调节兴趣。0.00~1，越大，DSH 收到消息的概率越大。
> 被 @ 时，只要 p（兴趣）大于 0.1，就一定回。反之按「p(5*兴趣)」概率回复。

```js
function shouldReply(message, interest, { rng }) {
  if (message.mentionsMe) {
    if (interest > 0.1) return { reply: true, p: 1, reason: 'at-sure' }
    const p = Math.min(1, 5 * interest)
    return { reply: rng() < p, p, reason: 'at-roll' }
  }
  // 没 @：兴趣乘一个系数，避免群里话痨
  const p = Math.min(1, interest * 0.35)
  return { reply: rng() < p, p, reason: 'chime-roll' }
}
```

兴趣取值优先级：`interest.users[uid]` > `interest.groups[gid]` > `interest.default`。

---

## 8. Mind = 完整 DSH 砍到四种能力

**砍法（有据可查）**：`headless-guest` profile 注释里的血泪结论 ——
> ✗ 直接 `- id: tools / disabled: true` → 整个 profile 起不来
> ✓ 保留 tools 服务，只把「有副作用的工具」一个个摘掉 —— **服务在，工具没了。模型连 schema 都看不到。**

**本工程用同一原理，两层保险：**

1. **工具白名单**（`MIND_TOOL_ALLOW`）→ 在 agent setup 里 `tools.restrict({ allow })`
   - 制定计划：`todo_write` `exit_plan_mode`
   - 子 Agent：`subagent` `subagent_fork` `send_message` `list_agents`
   - 上网：`web_search` `web_fetch`
   - QQ 工具：`qq_*`（仅 owner）
2. **非 owner 一个工具都不注册**（不是限制，是不注册 —— v2 坑 11）

**人格注入顺序**（`setup(agentCtx)` 里）：
```
① agentPresets.mount(agentCtx)          挂载 preset（不做 = 没工具）
② systemPrompt.section(人格)            静态，order 50
③ systemPrompt.context(记忆 + 情绪 + 标签)  动态，order 60，不破前缀缓存
④ tools.restrict({ allow: 白名单 })      砍
⑤ qqTools.register(agentCtx, ...)       只在 owner
```

**上下文压缩**：优先用原生 `ctx.compaction.compactIfNeeded`；次选 `tokenMeter.contextPressure` 判阈值。**禁止**沿用 v2 的「超限换代次」粗暴丢弃。

### 8.1 上下文：压缩与限制（**两件事，别混**）

| | 压缩（compaction） | 限制（hard cap） |
|---|---|---|
| 目的 | 旧历史压成摘要，**保留信息**省 token | 压不动时兜底，**防止撑爆** |
| 手段 | `ctx.compaction.compactIfNeeded` | 换代次（新 sessionId） |
| 触发 | `used ≥ mind.compactAtEventCount`（软上限，默认 400） | 压不动 **且** `used ≥ mind.hardResetEventCount`（硬上限，默认 1200） |

**为什么必须有硬上限**：压缩是尽力而为的 —— 内核会因为「没有安全的可压段落」
「单个 tool 结果本身就超预算」直接拒绝。没有兜底的话事件数一路涨，
最后 API 报 context overflow，**而且是在最需要回话的时候失败**。

**内核契约（传错会静默失败，踩过）**：

```js
compactIfNeeded(
  agent: CompactionAgentContext,   // ⚠️ 是 { session, options:{provider,model} }，不是 Agent 本身
  trigger: 'pressure' | 'context-overflow',  // ⚠️ 是字面量，不是 {kind:'manual'}
  signal: AbortSignal,
): Promise<CompactionResult | null>   // null = 没得压 / 压不了
```

**换代次不丢数据**：完整轨迹一直在 `archive/*.jsonl`，记忆在 `memory/`。
她只是「想不起来」，需要时用 `qq_recall_memory` 派子 Agent 去翻 ——
这正是主人架构里说的那种回忆方式。换代次前会在记忆里留一条时间戳痕，
免得主人看到「聊着聊着她突然失忆」一头雾水。

---

## 9. 测试约定

- 纯函数优先，不依赖 DSH / QQ / 网络。
- 自制 harness（抄 v2 `tests/harness.mjs`），零外部依赖。
- 运行：`node tests/run-all.mjs`
- 每个模块至少覆盖：正常路径 + 边界 + 主人/陌生人权限边界。
- 安全相关（注入、拉黑、权限）必须有**反向测试**（证明拦得住）。

---

## 10. 文件编码（血泪）

- 所有文件 **UTF-8 无 BOM**。
- 不要用 `Set-Content -Encoding UTF8` / `Out-File -Encoding utf8`（Windows 自带这两个默认带 BOM，DSH 读 profile 会直接崩）。
- 写文件用 write 工具，不用 PowerShell 重定向。
