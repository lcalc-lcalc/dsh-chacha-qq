# dsh-chacha-qq

> **让 DeepSeek Harness 拥有一台真正的 QQ。**
>
> 不是套壳，不是转发到别人的机器人框架 —— QQ 那一侧的的确确就是 DSH 本人在说话：
> 她能在同一个进程里思考、跑工具、记住你、发图发表情包、按真人节奏分片回复。

```
QQ 用户
  ↓
NapCat（OneBot 11）
  ↓ ws://127.0.0.1:3001
┌──────────────────────────────────────────┐
│ L1  src/napcat/      只做协议翻译          │
│ L2  src/controller/  要不要回、多久回、安不安全 │
│ L3  src/mind/        一个砍过的 DSH         │
└──────────────────────────────────────────┘
  ↓
管理面板（装在 DSH Web UI 里，12 组配置 + 对话流 + 轨迹）
```

---

## 它和「别的 QQ 机器人」有什么不一样

| | 常见做法 | 这个项目 |
|---|---|---|
| **大脑** | 自己拼 prompt 调 API | **真的是 DSH** —— 同一进程的 agent，有会话、有工具、有压缩 |
| **能力** | 全给或全不给 | **砍到只剩四种**：制定计划 / 工具调用 / 子Agent / 上网（物理上不挂载，模型连 schema 都看不到） |
| **回话方式** | 整段丢出去 | **按 token 分片**（每片 <20）+ 2~5 秒随机间隔，像人在打字 |
| **什么时候回** | 收到就回 | **观望窗口** + **兴趣掷骰**（被 @ 时 p>0.1 必回），不当话痨 |
| **记忆** | 塞进上下文 / 外挂向量库 | 结构化事实（`facts.jsonl`）+ **自动总结** + **按相关检索**（不按时间切） |
| **情绪** | 无 或 关键词硬猜 | 心情 0-100 + 七根情绪，指数半衰，**一种变化只说一次** |
| **安全** | 拉黑 + 词表 | 74 条注入规则（组合特征 / 转述降权 / 疑问守卫）+ **输出侧审核** + 主人豁免 |

## 它长什么样

装在 DSH Web UI 里：侧边栏一个图标 → 三栏面板（会话列表 / 对话流+轨迹 / 配置抽屉）。
能看到她想了什么、调了什么工具、花了多少 token、为什么没回你。

配置分 **12 组**（大脑 / 功能总开关 / 模式 / 观望 / 兴趣 / 节奏 / 安全 / 情绪 / 记忆 / 表情包 / 日程 / 关系），
每个功能都能**全局开关**，也都能**按对话单独开关**。

---

## 快速开始

### 你需要

- DeepSeek Harness（DSH）≥ 0.2.1-rc.5
- [NapCat](https://napneko.icu/)（OneBot 11 服务端），监听 3001
- Node.js ≥ 22
- 一个 QQ 小号（**强烈建议不要用主号**）

### 装

```powershell
# 1. 下到本地某个目录（后面要用 link: 引它，别用 file:）
git clone https://github.com/<你>/dsh-chacha-qq E:\dsh-dev\dsh-chacha-qq

# 2. 改 profile 的依赖指向
#    编辑 ~/.dsh/profiles/desktop/package.json：
#    "dsh-chacha-qq": "link:E:/dsh-dev/dsh-chacha-qq"

# 3. 确认没被禁用
#    ~/.dsh/profiles/desktop/cordis.patch.yml 里不能有 `- id: chacha-qq / disabled: true`
#    ~/.dsh/profiles/desktop/.dsh-market/state.json 的 disabled 里也不能有它

# 4. 重启 DSH
```

> ⚠️ 这三步缺一不可。**profile patch 和 market state 是两道独立的锁**，
> 任意一道在，插件在日志里一个字都不会出现（不会报错，最难查）。

### 配

首次启动会在 `~/.dsh/plugins/dsh-chacha-qq/config.json` 生成配置。
**必须填 `owner.qq`**（你自己的 QQ 号）—— 留空的话她认不出谁是谁，
所有人都会被当成陌生人（只读、不给工具）。

也可以在面板里改：侧边栏 →「茶茶酱的 QQ」→ 配置抽屉。

---

## 排错：先看这三个地方

```powershell
# ① 插件日志（唯一真相）
Get-Content ~/.dsh/plugins/dsh-chacha-qq/logs/chacha-qq.log -Tail 40 -Encoding UTF8

# ② QQ 到底在不在线（NapCat 活着 ≠ QQ 在线）
node scripts/probe-qq-status.mjs

# ③ NapCat 到底有没有上报消息
node scripts/probe-inbound.mjs 45
```

**「面板上的绿点亮着，但发不出消息」** —— 那个绿点指的是 DSH ↔ NapCat，
不是 QQ ↔ 腾讯服务器。号被封/掉线时它照样是绿的。用 ② 确认。

---

## 开发

```powershell
npm test                # 16 个套件 / 2700+ 项，全离线（不连 QQ、不连 DSH）
npm run probe:client    # 面板前端 129 项（假 ModuleLoader 真渲染）
npm run probe:moderation # 群管接线
```

架构契约在 [`docs/DESIGN.md`](docs/DESIGN.md)（**改代码前必读**）。
踩过的坑、为什么这样设计、试过又扔掉什么 —— 全在 [`HANDOFF.md`](HANDOFF.md)（开发手记）。

---

## 🥚 彩蛋

都是「只加味道、不加逻辑」的东西 —— 最坏情况是她说了一句有点奇怪的话，
永远不会丢消息、发错人、多花钱。想全关掉：`fun.easterEggs = false`。

| 彩蛋 | 怎么触发 |
|---|---|
| **上线语** | 每次重启 DSH，日志里那句「茶茶酱上线：xxx」后面会跟一句随机的（「尾巴翘起来了」「枕头上还有昨天的口水印」…） |
| **深夜关怀** | 凌晨 **2:00~5:00** 还在跟她聊，有 **8%** 概率她会突然说一句「这个点了还没睡？」 |
| **空状态文案** | 面板对话区没消息时，提示语每次刷新都不一样 |
| **她不是机器人** | 直接问她「你是 AI 吗」，看她的反应（这段写进人格了，不是硬编码） |

> 为什么深夜关怀只有 8%：每晚聊十句顶多撞上一次。
> 每次都提醒就变成教训人了，不是关心。
>
> 为什么放「上下文」而不是替她写回复：这样她**知道**现在很晚了，
> 但怎么表达由她自己决定 —— 可能只是「嗯，早点睡」，也可能什么都不说。

---

## 风险与免责

这个项目通过 NapCat 驱动 QQ，属于**非官方客户端行为**：

- 可能触发风控、限权、**封号**
- 建议用小号；不要用来发广告/刷屏/自动化营销
- 与腾讯公司无关，不提供任何账号安全保证
- 详见 [LICENSE](LICENSE) 末尾的说明

---

## 下面这些是「给原来的使用者」的记录

以下内容保留了项目演进过程（v2 → v3 的对比、切换步骤、历史细节）。
新使用者可以跳过，直接看上面的快速开始。

---

## 一句话

**QQ 消息进来 → Controller 加工（要不要回、多久回、安不安全）→ The Mind（砍到只剩四种能力的小 DSH）思考 → Controller 按 2~5 秒节奏分片发回去。**

和 v2 最大的区别：

| | v2 | v3（本仓库） |
|---|---|---|
| 结构 | `lib/` 平铺 11 个模块 | 三层：`src/napcat` / `src/controller` / `src/mind` |
| Mind | 寄生宿主，拿全套工具 | **砍到只剩：制定计划 / 工具调用 / 子Agent / 上网** |
| 回话节奏 | 几乎不分片（`splitOverChars: 99999`） | **一片 <20 token，两条之间 2~5 秒** |
| 观望 | 无（`batches` 定义了从没实现） | **20s~1min，@ 10s，主人秒回，老熟人 5s** |
| 兴趣 | 全局 `chimeChance: 0.08` | **按人/群 0~1，被 @ 时 p>0.1 必回** |
| 上下文超限 | 直接换代次，历史全丢 | **软上限(800)先压成摘要；压不动且到硬上限(2000)才换代次** |
| 情绪 | 无 | 鱼的心风格：心情 0-100 + 七根情绪 + 半衰期衰减 |
| 安全 | 只有拉黑 + 广告词 | 74 条注入规则 + 分级惩罚 + 主人豁免 |

---

## 装（从 v2 切过来，四步）

### 1. 改 profile 的依赖指向

`<用户目录>\.dsh\profiles\desktop\package.json`：

```jsonc
"dependencies": {
  // "dsh-chacha-qq": "link:<旧版目录>",   ← 旧
  "dsh-chacha-qq": "link:<本项目目录>"        //  新
}
```

**用 `link:` 不要用 `file:`** —— `file:` 是复制，改了代码跑的还是旧副本。

### 2. 摘掉 profile patch 里的 `disabled`

`<用户目录>\.dsh\profiles\desktop\cordis.patch.yml` 最后几行：

```yaml
- id: chacha-qq
  disabled: true        # ← 把这块整段删掉，或者改成 disabled: false
```

> 🔴 **这一步最容易漏**。v2 的交接文档只提了 `.dsh-market/state.json` 里的 disabled，
> 但 **profile patch 里还有一道锁**。两道锁任意一道在，插件在日志里一个字都不会出现。

### 3. 确认 market 的 disabled 里没有它

`<用户目录>\.dsh\profiles\desktop\.dsh-market\state.json`：

```jsonc
{ "disabled": ["dsh-plugin-whale-pet", "dsh-whale-widget"] }   // 不能有 dsh-chacha-qq
```

### 4. 重启 DSH

插件是 host 侧代码，**HMR 不监听插件目录**，必须重启。前端面板改动才只要刷新页面。

---

## 怎么确认它真的在跑

```powershell
# ① 数据目录应该出现（第一次启动会自动生成 config.json）
Get-ChildItem <用户目录>\.dsh\plugins\dsh-chacha-qq

# ② 日志应该有「装配完成：...」
Get-Content <用户目录>\.dsh\plugins\dsh-chacha-qq\logs\chacha-qq.log -Encoding UTF8 -Tail 40

# ③ 面板端点（端口从 DSH 的 web 地址拿，每次都变）
(Invoke-WebRequest "http://127.0.0.1:<端口>/chacha-qq/state" -UseBasicParsing).Content
```

日志里这几行是关键：

```
数据目录 C:\Users\...\.dsh\plugins\dsh-chacha-qq
已挂载 agent preset：...
已砍工具：只留 8 个（todo_write, exit_plan_mode, subagent, ...）
agent 就绪：qq-private-<QQ号>（owner/danger-full-access/...）
装配完成：gateway / api / mind / controller / observe / memory / emotion
```

「已砍工具」那行**一定要看到**：它证明 Mind 真的是「砍过的 DSH」，而不是把全套工具都给它了。

---

## 配置

唯一真相源：`<用户目录>\.dsh\plugins\dsh-chacha-qq\config.json`。
字段全表与默认值见 [`docs/DESIGN.md` §5](docs/DESIGN.md)，也可以直接看 `src/config.js` 的 `DEFAULT_CONFIG`。

主人最可能想调的几项：

```jsonc
{
  "observe": {
    "defaultMinMs": 20000,      // 观望下限
    "defaultMaxMs": 60000,      // 观望上限
    "atMs": 10000,              // 被 @ 的固定延迟
    "guestPrivateMs": 5000,     // 老熟人私聊的延迟
    "ownerPrivateMs": 0         // 主人私聊秒回
  },
  "interest": {
    "default": 0.5,
    "users": { "123456789": 0.9 },   // 单独给某人调高兴趣
    "groups": { "999999": 0.7 }
  },
  "rhythm": {
    "minGapMs": 2000,
    "maxGapMs": 5000,
    "maxTokensPerPiece": 20     // 「一片 20 token」就是它
  },
  "mind": {
    "toolAllow": ["todo_write", "exit_plan_mode", "subagent", "subagent_fork",
                  "send_message", "list_agents", "web_search", "web_fetch"]
  },
  "security": {
    "penalty": "mute-and-block"  // ignore | mute-and-block | ban
  }
}
```

---

## 测试

```powershell
cd <本项目目录>
node tests/run-all.mjs
```

不依赖 DSH、不依赖 QQ、不依赖网络。每个套件也能单独跑：

```powershell
node tests/napcat.mjs        # L1：网关 / 归一化 / api
node tests/mind.mjs          # L3：人格 / 会话 / 工具白名单
node tests/integration.mjs   # 三层串起来跑一条真消息
```

---

## 排错

**插件完全没反应（日志一个字都没有）**
1. 先看 `~/.dsh/profiles/desktop/cordis.patch.yml` 里有没有 `- id: chacha-qq / disabled: true`
2. 再看 `.dsh-market/state.json` 的 `disabled` 里有没有它
3. 都没有 → 才算插件自己的问题，去看日志

**面板 404 / 没连上**
`ctx.get('webServer')` 拿不到时端点不会注册（不影响 QQ 功能）。日志里会有「面板端点注册失败」。

**她一个工具都没有**
日志里搜「已挂载 agent preset」。没有这行 = `agentPresets.mount()` 没跑成，
agent 里连工具 schema 都不会有（旧版踩过：她回「我手上只有一个切目录的工具」）。

**她回话很慢 / 一句话等半分钟**
正常。观望机制就是这样：群友没 @ 她，默认等 20~60 秒攒一批。主人私聊是秒回的。
想改就调 `observe.defaultMinMs` / `defaultMaxMs`。

**Mind 判了 but 不回**
看日志有没有「不接话（chime-roll，p=0.17）」。那是兴趣掷骰没过，不是故障。

---

## 目录

```
index.js                 host 入口，只做装配（缺哪个模块就降级哪个）
cordis.patch.yml         bundle patch（insert chacha-qq）
client.js                面板前端（UI 阶段，暂缓）

src/
  config.js              配置 schema + 深合并 + 原子落盘
  log.js                 双写日志（文件 + 内存环）+ 轮转
  watchdog.js            NapCat 守护（含卡死判定）

  napcat/                L1：只做协议翻译
    gateway.js           OneBot 11 WS 客户端
    normalize.js         原始帧 → QqMessage
    api.js               action 封装（图片走 base64://）

  controller/            L2：所有判断
    pipeline.js          总调度
    route.js             路由（纯函数）
    observe.js           观望窗口
    interest.js          Interesting 掷骰
    tags.js              贴标签
    security.js          防注入 + 惩罚（纯函数）
    emotion.js           情绪状态机（纯函数 + 一个类）
    rhythm.js            token 分片 + 2~5 秒间隔
    outbox.js            发送（Markdown 降级 / 重试）
    inbound.js           媒体落盘
    moderation.js        群管判定
    memory/
      store.js           按天记忆 + core
      recall.js          跨会话回忆（派子 Agent）

  mind/                  L3：砍过的 DSH
    preset.js            工具白名单 + 人格
    session.js           一对一会话 + 代次
    turn.js              跑一轮（流式 / 定稿 / 轨迹 / 压缩）
    tools.js             14 个 QQ 工具（只有主人拿得到）

docs/DESIGN.md           架构契约（唯一权威）
```

---

## 已知没做 / 还没验证

- **面板的真机观感**：前端有 106 项离线探针（factory 能起、槽位注册对、组件渲染得出来），
  但**没有浏览器控制** —— 渲染效果、错位、丑不丑，只有主人亲眼看。
- **真机群聊验证**：代码和测试齐了，还没在真实群里跑过。
- **`chunk` 序号**：`record()` 一轮只写一条 `out`、只带总数 `chunks`，
  面板显示不出「第 2/3 片」。要细分得让 `rhythm.createRhythmSender` 每发一片回调一次。
- **语音转文字**：DSH 里有 sherpa-onnx，没接。
- **QQ 空间**（主人说「再说」）：技术上能做（NapCat 的 `get_cookies` 扩展 action +
  直接打 `user.qzone.qq.com`），但参考实现没做任何限速，有封号风险。
- **自定义精简 preset**：现在走「默认 preset + `tools.restrict` 白名单」。
  `agentPresets.register()` 注册一份自己的 preset 是下一步（能省掉一次 restrict，
  也能让「砍」发生在挂载阶段而不只是收窄阶段）。
- **表情包图库还是空的**：9 个类别目录建好了但一张图都没有。
  要么主人往里丢图，要么靠「盗图」慢慢长（`meme.steal.probability: 0.08`）。

---

## ⚡ 想改「像人」的程度？只有一个文件

`scripts/apply-persona-preset.mjs` —— 里面就是那套拟人参数，改数字然后重跑：

```powershell
node scripts/apply-persona-preset.mjs --dry   # 先看会改什么
node scripts/apply-persona-preset.mjs         # 真写（自动备份）
# 然后重启 DSH
```

**注意**：改 `src/config.js` 的 `DEFAULT_CONFIG` 只影响**新装**，
已经在用的 `config.json` 不会跟着变 —— 这就是那个脚本存在的理由。

---

## 三条铁律（改代码前读）

1. **别用 `agent.whenIdle()`** —— 它在微任务里空转，会把整个 DSH 主进程饿死。
   只能轮询 `status` + `seq`。
2. **别直接读 `ctx.agents` / `ctx.sessions`** —— 没 inject 时是**抛异常**不是 undefined。
   一律走 `service(ctx, name)`。
3. **文件一律 UTF-8 无 BOM** —— 不要用 PowerShell 的 `Set-Content -Encoding UTF8` 或
   `Out-File -Encoding utf8`（Windows 自带这两个默认带 BOM，DSH 读到直接崩）。
