# v3.1 施工图 —— 从 AstrBot 五个插件里搬回来的东西

> 作者：茶茶酱。这份是**施工契约**，配合 `docs/DESIGN.md`（v3 三层架构）一起看。
> 来源：8 个分身精读了 `meme_manager` / `qzone_ultra` / `content_safety_guard` /
> `memory_companion` / `private_companion`（约 49 万行），这里只留**值得搬的**。

---

## 0. 主人拍板的四个决定

| 问题 | 决定 |
|---|---|
| 记忆存储 | **继续 md 文件树**（痛点是召回质量不是存储能力），抽一层接口留后路 |
| 日程 | 要，但**必须是「模式」**：纯干活模式下完全不生成、不注入（省 token） |
| QQ 空间 | **暂缓**（技术可行但没人做限速，封号风险不值得） |
| 表情包 | 要，且**要能盗图**，每对话可配触发概率 |

---

## 1. 模式（Mode）—— 一切的开关源头

这是新增的**顶层概念**，比"每个功能一个开关"清楚得多。

```jsonc
"modes": {
  "default": "companion",          // 默认给谁用什么模式
  "peers": {                       // 按对话覆盖
    "group-123456": "work",        // 这个群她纯干活
    "private-1111111111": "companion"
  }
}
```

| 模式 | 日程 | 情绪 | 主动消息 | 表情包 | 盗图 | 关系账本 |
|---|---|---|---|---|---|---|
| `companion`（陪伴） | ✅ 生成 + 注入 | ✅ | ✅ | ✅ | ✅ | ✅ |
| `work`（纯干活） | ❌ 不生成不注入 | ⚪ 只记不注入 | ❌ | ⚪ 只发不收 | ❌ | ⚪ 只记 |

> **为什么要有 `work`**：主人的原话 ——「我可能有时候要她纯干活，加日程影响工作加大消耗，但是日程真非常好玩」。
> `work` 模式下日程**根本不生成**（省一次模型调用）、**不注入**（省上下文 token），
> 而不是"生成了但不展示"（那还是白花钱）。
>
> `⚪` = 状态照常维护（成本几乎为零），只是不往上下文里塞。

---

## 2. 表情包系统（`src/controller/meme/` + `src/mind/meme-tools.js`）

### 2.1 设计来源
`meme_manager` 真正的精华只有两条，其余 4000 行（图床 / WebUI / 5 级容错匹配）都不要：

1. **模型选「类别」，代码在类别内随机取图** —— 图库增删完全不影响提示词稳定性
2. **类别描述写「什么时候用」而不是「图长什么样」** —— 这才是"同类随机抽一张"安全的原因

### 2.2 目录与命名（主人的要求：文件名说明内容，方便发送）

```
dataDir/memes/
  happy/          开心
    眯眼笑_竖大拇指.gif
    转圈圈撒花.gif
  sad/            难过
  angry/          生气
  shocked/        震惊
  speechless/     无语
  hug/            抱抱
  ...
  _catalog.json   ← 每个类别的「使用场景描述」+ 每张图的元数据（自动维护）
```

- **文件名 = 内容描述**（主人明确要求）：`开心_眯眼笑.gif` 比 `IMG_2831.gif` 有用得多
- **识图辅助**：收图时用一次视觉调用生成「内容描述 + 推荐类别 + 是否适合当表情包」
- **她也可以去别处翻图**：主人的原话「这并不能保证她不会跑去别的地方翻图片」——
  所以除了表情库工具，还要给她一个**受限的图片搜索**工具（只在 `dataDir/` 和
  `dataDir/workspace/` 下 glob 图片扩展名），不去碰主人其它盘。

### 2.3 发送：句内标记 + 三级闸门

```
她要发：  "主人早安呀 &&happy&& 今天也要开心哦"
代码渲染：  [
              { text: "主人早安呀 " },
              { image: "memes/happy/眯眼笑_竖大拇指.gif" },   ← base64 由 L1 转
              { text: " 今天也要开心哦" }
            ]
```

闸门（照 `meme_manager` 的三级，但**改成请求级上下文**，它原来挂在实例上有并发竞态）：

| 闸 | 配置 | 默认 | 作用 |
|---|---|---|---|
| 消息级概率 | `meme.probability` | 0.5 | 整条消息一把闸 |
| 单条上限 | `meme.maxPerMessage` | 2 | 超过就丢多余的标记 |
| 混排率 | `meme.inlineProbability` | 0.5 | 50% 夹在文字里 / 50% 发完再单独发 |
| 类别内冷却 | `meme.cooldownMs` | 120000 | 同一类别不要连着抽 |

**必须做**：`<thinking>` 区保护（思考里提到 `&&happy&&` 不能真发图）+ 残留标记防御清理。

### 2.4 盗图（主人明确要）

**触发链**（每对话可配概率，主人的要求）：

```jsonc
"meme": {
  "steal": {
    "probability": 0.15,              // 每收到一张图，有 15% 概率「看看喜不喜欢」
    "peers": { "group-123456": 0.3, "private-1111111111": 0.05 },
    "minBytes": 4096, "maxBytes": 2097152,
    "allowedExt": ["gif", "png", "jpg", "jpeg", "webp"]
  }
}
```

流程：
```
群消息带图
  ↓ 按概率 p 掷骰（不通过就完全不管，零成本）
  ↓ 下载到临时文件（走 inbound 已有的落盘能力）
  ↓ 一次视觉调用：「这是什么？适合当表情包吗？给个内容描述 + 推荐类别」
  ↓ 是 → 生成描述性文件名 → 入库（sha256 去重）
  ↓ 否 → 删临时文件
```

**主人的额外要求**：「也要提供细化到对话的配置调节」→ `steal.peers[peerKey]` 覆盖默认概率。
**另外**：主人可以直接指定收录（命令 / 或者她自己调工具 `qq_steal_meme`）。

**腾讯 CDN 坑**（`meme_manager` 踩过）：`multimedia.nt.qq.com.cn` 的图要手动把
`https` 降成 `http` 才能下。这条写进 `inbound.js` 的注释。

### 2.5 接口

```js
// src/controller/meme/store.js
export class MemeStore {
  constructor({ dataDir, config, log })
  listCategories(): Array<{ key, name, hint, count }>
  pick(category, { rng }): { path, name } | null          // 类别内随机抽
  ingest({ buffer, ext, description, category }): Promise<{ path, deduped }>
  stats()
}

// src/controller/meme/render.js  —— 纯函数
export function extractTags(text, { maxTags, validCategories }): { tags, cleaned }
export function buildSegments(text, tags, store, { inlineProbability, rng })
  : Array<{ type: 'text', text } | { type: 'image', path }>
export function stripResidualMarkers(text): string

// src/controller/meme/steal.js
export class StealGate {
  constructor({ store, config, log, vision, inbound })
  maybeSteal(message): Promise<boolean>   // 掷骰 + 下载 + 判断 + 入库
}
```

---

## 3. 日程与当日状态（`src/controller/life/`）

### 3.1 设计来源
`private_companion` 的 `daily_state.py` + `planning.py`。**只搬两件**：

1. **「状态是合成视图，不是被改写的存储」** —— condition 列表 → 每次现算 energy/mood/note
2. **日程每天生成一次，当天不改**（主人的要求：「一天 0 点（后）只能改一次，防止精神分裂」）

### 3.2 日程

```jsonc
"life": {
  "enabled": true,
  "schedule": {
    "segments": 6,                    // 6~8 段，别做 10 段
    "generateAfter": "07:30",         // 过了这个点、当天第一次用到才生成
    "regenerateAllowed": false         // 当天生成后不再改（防精神分裂）
  }
}
```

一段的结构（比原版砍掉 `basis/confidence`，留够用的）：

```js
{ time: "08:30", end: "10:00", activity: "在咖啡厅写东西", mood: "安静", seed: "刚坐下，杯子还是烫的" }
```

**注入**：只注入「当前这一段」+ 下一段的开头，不整份注入（省 token）。
`work` 模式下**完全不生成、不注入**。

### 3.3 当日状态（condition → 现算）

```js
// 状态条目
{ id, kind: 'sleep'|'hunger'|'health'|'mood', title, mood, energyDelta, startTs, endTs, cause }
```

- `energy`（10~100，基线 75）、`moodBias`（取强度最高的 condition）、`note`（一句话自我说明）
- **跨天**：日抛项（睡眠/饥饿）重抽，带 `endTs` 的（感冒/生理期）继承
- 停在哪：不做天气、不做生理期、不做细节强化（那 8000 行我们不要）

### 3.4 接口

```js
// src/controller/life/state.js
export class LifeState {
  constructor({ dataDir, config, log, now })
  get(): { energy, moodBias, note, conditions }
  async ensureToday(): Promise<void>        // 跨天结算 + 触发生成
  async plan(): Promise<Segment[]>          // 今天日程（work 模式返回 []）
  currentSegment(at = Date.now()): Segment | null
  renderForMind({ mode }): string           // 一句注入话；work 模式返回 ''
}
```

---

## 4. 关系账本（`src/controller/relation.js`）

### 4.1 设计来源
`private_companion` 的 `relationship_ledger.py`。这是「人味」最大来源，也是**最该小心**的一块。

- 分数域 **−1200 ~ 1200**，八阶段（极疏 → 深联结）
- **迟滞 ±20**：跨段要越过阈值 20 分才生效（防抖动）
- 单次上限 +4 / −12；每日正向累计上限 12
- **边际递减**：≥600 时正向 ×3/4，≥900 时 ×1/2
- **只向 0 回落**：3 天不动 → 第 4~7 天每天 −2 → 第 8~14 天 −5 → 第 15 天起 −8
- **同一消息同一原因 30 分钟去重**
- **只有用户输入违规才记账，模型自己跑偏不算用户的**（`content_safety_guard` 的归因分离）

### 4.2 我们砍掉的
多人格、群聊贡献、六重上限、边界档位链、"专属联结冻结" —— 一对一 QQ bot 全用不上。

### 4.3 主人要不要能降级？
茶茶酱建议：**主人永远不降到「疏离」以下**（否则一次吵架她就不理人了，体验很糟），
但可以让 `familiar → close → intimate` 这几个正向阶段真实反映互动质量。

### 4.4 接口

```js
// src/controller/relation.js  —— 纯函数 + 一个状态类
export const PHASES = ['distant','acquaintance','familiar','close','intimate','deeply_bonded']
export function phaseOf(score, previousPhase): { phase, label, capped }
export function settleDecay({ score, lastActiveAt, now }): number
export function applyEvent({ score, delta, reason, todayTotal }): { score, applied, capped }

export class RelationStore {
  constructor({ dataDir, config, log, now })
  get(userId): { score, phase, ledger }
  async apply({ userId, delta, reason }): Promise<{ score, phase }>
  renderForMind({ userId }): string      // 一句语气提示
}
```

---

## 5. 记忆召回质量（`src/controller/memory/`）

**已经修掉的**：长度归一化 + 摘要切 bullet（20 项测试钉住了）。

**还要补的**（从 `memory_companion` 的 retrieval 里挑最值钱的）：

| # | 搬什么 | 原因 | 工作量 |
|---|---|---|---|
| 1 | **IDF + TF 饱和** | 现在「命中个数」当分数，常见词和罕见词一个价 | S |
| 2 | **min_hits 硬门控** | 长中文问题只命中 1 个词就召回 = 噪音 | S |
| 3 | **MMR 去冗余** | 现在只按「前 80 字符相同」去重，同一件事的多个片段会占满预算 | S |
| 4 | **分槽配额** | 现在摘要/日记/core 混在一个池子里抢名额 | M |
| 5 | **「什么时候不查」路由表**（12 层压成 6 层） | 现在**每轮都试**，纯浪费 | M |

**不搬**：FTS5 / embedding / RRF 多路 / rerank / 知识图谱。

---

## 6. 输出侧安全（`security.js` 补一块）

`content_safety_guard` 唯一真正有价值的东西 —— **我们完全空白**。

```js
// 纯函数，复用现有 74 条规则
export function inspectReply(replyText, { role, config }): { risk, hits }
```

落点：`pipeline.js` 在 `outbox.send()` **之前**检查。
处置三选一（配置）：`discard`（丢弃） / `fallback`（换一句兜底话） / `regenerate`（带原因重生）。
**默认 `discard`** —— 重生成要再跑一轮，钱和延迟都翻倍。

⚠️ 三条不能照抄的坏设计：
1. **别在流式时 early-return** —— 它是 `if response.is_chunk: return`，等于流式完全绕过审查
2. **重生必须用同一个 sessionId** —— 它用裸 `llm_generate` 重生，把历史/记忆/工具全丢了
3. **审查扫原始用户输入，不扫组装后的 prompt** —— 它踩过：记忆里有敏感词 → 之后每条全被拦

---

## 7. 施工顺序

```
第一批（能立刻玩到的）
  ① 表情包：存储 + 句内标记 + 发送渲染 + 三级闸门      S~M
  ② 盗图：概率闸 + 视觉判断 + 入库去重                M
  ③ 日程 + 当日状态 + 模式开关                        M

第二批（关系与人味）
  ④ 关系账本 + 阶段 + 迟滞 + 回落                      M
  ⑤ 主动消息：闸门链 + 频控三维 + ignored_streak 降频   M

第三批（质量与安全）
  ⑥ 记忆召回：IDF / min_hits / MMR / 分槽              S~M
  ⑦ 输出侧审核                                        M
  ⑧ 请求级工具裁剪                                    M

暂缓
  · QQ 空间（封号风险，主人说「再说」）
  · 戳一戳 / 复读跟随 / 语音（细节，等前面稳了再说）
```

---

## 8. 全局约束（每个模块都要守）

1. **纯函数优先**，有状态的要能 `dispose()`
2. **时间注入**（`now()`）、**随机注入**（`rng()`）—— 不然测不了
3. **一切开关都要能按对话覆盖**（`peers[peerKey]`）
4. **`work` 模式下所有"好玩但费钱"的东西都不许跑**
5. 中文注释写「为什么」，文件 UTF-8 无 BOM
6. 每个模块配自己的测试套件，`node tests/run-all.mjs` 必须全绿
