# 面板设计（PANEL）—— 前后端契约

> 作者：茶茶酱。配合 `docs/DESIGN.md`（三层架构）与 `docs/PLAN-v3.1.md` 看。
> 主人拍板：**一把做全**（对话 / 调试 / 配置 / 轨迹）+ **轮询 2~3 秒**。

---

## 0. 截图级的布局（照 DSH 的骨架）

```
┌────────────┬────────────────────────────────┬──────────────┐
│  会话列表   │          对话区                 │   配置抽屉    │
│            │                                │              │
│ ▸ 主人      │  ┌─ 消息流 ─────────────────┐  │  这个对话的   │
│   群 A      │  │ 用户：……                  │  │  独立配置     │
│   群 B      │  │ 🤔 思考（可折叠）          │  │              │
│            │  │ 🔧 工具  qq_group_history  │  │  模式         │
│            │  │ 📋 计划（todo 列表）        │  │  兴趣         │
│            │  │ 💬 回复（分片显示）         │  │  观望         │
│            │  │ 📊 token 12.3k / 上下文 34% │  │  表情包       │
│            │  └────────────────────────────┘  │              │
│            │  ┌─ 输入框（给自己发测试）──┐    │              │
├────────────┴────────────────────────────────┴──────────────┤
│ 顶部：连接状态 · 模型 · 模式全局切换 · 系统配置 · 日志        │
└─────────────────────────────────────────────────────────────┘
```

**为什么自绘三栏而不是挂 DSH 的右侧边栏**：
DSH 的右侧边栏没有开放的通用列表槽（只有 `sidebar.right.tab.document` / `.guide` 这类业务专属的），
强挂内部槽位升级就碎。自绘三栏布局完全可控，视觉上就是主人说的 ctrl+alt+b 那块位置。

---

## 1. 宿主侧槽位（client.js 的注册点）

从 `Slots.listSubTree` 实测：

| 用途 | 槽位 | 种类 | 注册参数 |
|---|---|---|---|
| 侧边栏图标入口 | `sidebar.panellist` | list | `{ id, order, label }` |
| 整页面板 | `main` | **keyed** | `{ key }`，**key 必须等于侧边栏的 id** |

```js
return {
  inject: ['slots'],
  apply(ctx) {
    ctx.effect(() => mountStyle(), 'chacha-qq: styles')
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: 'chacha-qq', order: -30, label: '茶茶酱的 QQ' },
      ChachaIcon,
    ))
    ctx.slots.inject('main', () => ctx.slots.register(
      { name: 'main', key: 'chacha-qq' },
      ChachaPanel,
    ))
  },
}
```

**三条硬规则（v2 踩出来的，别改）**：
1. 客户端 bundle **不是 ESM** → 必须 `window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 里 return `{ inject, apply }`
2. 侧边栏**必须包在 `ctx.slots.inject(...)` 里**再 register，否则槽位声明还没出现就注册，**行会静默消失**
3. 整页面板是 **keyed slot**，`key` 与侧边栏行 `id` 同名，`selectPanel(id)` 才能同时点亮导航 + 挂载页面。**没有 URL 路由**

样式：用 CSS 变量继承宿主主题（`--dsw-alias-*` / `--dsw-font-family`），别写死颜色。

---

## 2. 宿主侧 REST 端点（全部 `GET`/`POST`，只允许回环）

⚠️ 面板 API **不受** DSH 的 `/api` 鉴权保护 —— 每个 handler 都要自己校验
`remoteAddress` 是回环 + Host 合法（v2 坑 22）。

### 2.1 `GET /chacha-qq/state`
顶部状态条 + 全局概览。

```jsonc
{
  "ok": true,
  "now": 1762..., 
  "parts": { "gateway": true, "mind": true, "controller": true, "life": true, "meme": true, ... },
  "dataDir": "...",
  "conn": { "connected": true, "selfId": "1000000001", "uptimeMs": 123456, "wsUrl": "ws://..." },
  "model": { "provider": "deepseek-account", "model": "deepseek-flash", "effort": "max", "source": "config" },
  "mind": { "available": true, "sessions": [ { "sessionId", "role", "mode", "events", "pressure" } ] },
  "stats": { "blocked": 0, "injected": 0, "replyBlocked": 0, "byReason": {} },
  "groups": [ { "groupId": "999", "cached": 30 } ],
  "usage": { "todayInput": 0, "todayOutput": 0, "todayTurns": 0 },
  "modes": { "default": "companion", "counts": { "companion": 3, "work": 1 } },
  "log": [ { "at", "level", "tag", "text" } ]
}
```

### 2.2 `GET /chacha-qq/conversations`
左侧会话列表。

```jsonc
[
  {
    "peerKey": "private-1111111111",   // 会话 key（= modes.peers 的键）
    "scene": "private",                // private | group
    "peerId": "1111111111",
    "name": "主人",                     // 群名 / 好友昵称 / QQ 号
    "mode": "companion",               // companion | work
    "role": "owner",                   // owner | guest（主人私聊=owner，群=guest）
    "lastAt": 1762...,
    "lastText": "主人早安呀",
    "counts": { "in": 12, "out": 13 },
    "relation": { "score": 620, "phase": "close", "label": "亲近" },
    "tags": ["老朋友"],
    "session": { "sessionId": "qq-private-1111111111", "events": 210, "pressure": 0.17 }
  }
]
```

### 2.3 `GET /chacha-qq/messages?peerKey=<key>&limit=200`
对话区。（`peerKey` 省略 = 全部混在一起，调试用）

```jsonc
[
  {
    "at": 1762...,
    "dir": "in" | "out" | "internal",
    "//in":       "用户说的话",
    "//out":      "她发出去的（分片后的每一片一条，chunks 标第几片）",
    "//internal": "轨迹：思考 / 工具 / 计划 / token",
    "kind": "reasoning" | "tool" | "tool-result" | "plan" | "usage",
    "text": "…",
    "name": "qq_group_history",     // kind=tool 时
    "args": { … },
    "result": "…",
    "error": false,
    "chunk": 1, "chunks": 3,         // dir=out 时
    "tokens": { "input": 1234, "output": 56, "total": 1290 },  // kind=usage 时
    "plan": [ { "content": "…", "status": "pending|in_progress|completed" } ]  // kind=plan 时
  }
]
```

### 2.4 `GET /chacha-qq/config` · `POST /chacha-qq/config`
配置抽屉。`POST` body：`{ "patch": { "observe": { "defaultMinMs": 25000 } } }`（**深合并**，不整块顶掉）。

返回：`{ ok: true, config: <完整配置> }`

### 2.5 `POST /chacha-qq/action`
按钮动作。

```jsonc
{ "action": "test-connect" }                        // 探一次 NapCat，返回 { ok, latencyMs, error? }
{ "action": "hard-restart" }                        // 杀→起→等端口→连
{ "action": "reset-session", "peerKey": "..." }     // 换代次（清上下文，保留记忆）
{ "action": "set-mode", "peerKey": "...", "mode": "work" }
{ "action": "clear-log" }                           // 清内存日志环
{ "action": "list-categories" }                     // 表情包类别（供配置页填默认类别）
```

### 2.6 `GET /chacha-qq/memes`
图库概览（配置页画类别 + 数量 + 缩略图路径）。

```jsonc
[ { "key": "happy", "name": "开心", "hint": "…什么时候用…", "count": 23 } ]
```

---

## 3. 数据从哪来（宿主侧要补的东西）

| 数据 | 现状 | 要补 |
|---|---|---|
| 会话列表 | Controller 没有这个概念 | **新增 `Controller.listConversations()`**：从 recent + groupHistory + sessions + relation + modes 聚合 |
| 消息流 + 轨迹 | `recent` 只留 200 条内存，字段不全 | 扩 `record()`：补 `chunk/chunks/tokens/plan/args/result` |
| token 统计 | 完全没采 | **`turn.js` 的 `collectTrace` 要采 `assistant/message` 的 `usage`** |
| 计划（todo） | 轨迹里有 tool 调用，但没单独归类 | 识别 `todo_write` 的调用 → 落成 `kind:'plan'` |
| 关系阶段 | 有 `relation.get()` | 接进 `listConversations()` |
| 表情包类别 | 有 `meme.listCategories()` | 接进 REST |

---

## 4. 前端结构（client.js 单文件，约 1800 行）

⚠️ **client.js 必须一个人写**：bundle 是 `__ModuleLoader__.load` 单入口，拆不了文件。
内部按「区块」组织，每块一个函数：

```
window.__ModuleLoader__.load({ id: 'dsh-chacha-qq', factory(require) {
  const React = require('react')
  const prim  = require('@deepseek-ai/dsh-client-ui-primitives') || {}
  ...
  // ── 样式（一个 CSS 字符串，append 到 head，配色全走 --dsw-* 变量）
  const CSS = `…`

  // ── 小工具
  function api(path, init) / usePoll(fn, ms) / fmtTime / fmtTokens / clip

  // ── 区块①：顶部状态条   TopBar
  // ── 区块②：左侧会话列表 ConversationList
  // ── 区块③：中间对话区   ChatArea
  //      ├ ChatMessage      一条消息（in/out）
  //      ├ TraceRow         一条轨迹（思考/工具/计划/usage，可折叠）
  //      └ Composer         给自己发测试消息
  // ── 区块④：右侧配置抽屉 ConfigDrawer
  //      ├ 通用配置分组（观望/兴趣/节奏/安全/情绪/记忆/表情包/日程/关系）
  //      └ 当前对话覆盖（模式、兴趣、盗图概率、观望时长）
  // ── 区块⑤：整页面板   ChachaPanel（组合 ①~④，管选中状态）
  return { inject: ['slots'], apply(ctx) { … } }
}})
```

**状态管理**：不用 redux，`useState` + 三个轮询：
- `state` 每 3s
- `conversations` 每 3s
- `messages(选中会话)` 每 2s

轮询要能**随时停**（`useEffect` 清理），切会话时不能两个请求互相覆盖（用 `seq` 守卫）。

---

## 5. 配置抽屉的分组（照 `DEFAULT_CONFIG` 的段）

| 分组 | 键 | 控件 |
|---|---|---|
| **大脑（她用什么模型想事情）** | `mind.provider` / `model` / `reasoningEffort` / `maxTokens` / `personaOverride` | 两个文本框 + **四档下拉** + 数字 + 人格 textarea |
| 模式 | `modes.default` / `modes.peers` | 下拉 + 每会话覆盖列表 |
| 观望 | `observe.*` | 6 个数字输入（毫秒，显示成秒） |
| 兴趣 | `interest.default` / `users` / `groups` | 滑块 0~1 + 键值表 |
| 节奏 | `rhythm.*` | 数字（间隔改成「1.2~3 秒」双滑） |
| 安全 | `security.*` | 开关 + 惩罚下拉 + 数字 |
| 情绪 | `emotion.*` | 开关 + 基线 + 半衰期 + tellIt 下拉 + 判断频率 |
| 记忆 | `memory.*` | 开关 + 预算（1600 字）+ facts 条数 + 自动总结开关 |
| 表情包 | `meme.*` | 概率滑块 + 盗图概率 + 类别列表（只读数量） |
| 日程 | `life.*` | 开关 + 段数 + 生成时间 + 精力基线 |
| 关系 | `relation.*` | 开关 + 上下限 + 迟滞 + 回落档（只读展示） |
| 群管 | `moderation.*` | 开关 + 热词（逗号分隔文本，**用草稿 state 不用数组派生**） |

### 5.1 「思考强度」只有四档（主人拍板）

```
（空）  跟随 DSH 默认
off     不思考 —— 最快最便宜
low     轻思考 —— 默认
high    深思考 —— 慢一些
max     最深   —— 最慢最贵
```

**必须是 `<select>`，不许自由文本** —— 后端 `sanitizeConfig` 只校验类型、不校验枚举，
所以前端这一层是唯一能挡住 `ultra` 这种脏值的地方。两道闸：
`saveAll` 先 `validateMind`，`postConfig` 内再验一次，任何入口都绕不过。

> 历史教训：面板原本**根本没有「大脑」这一组**，`reasoningEffort` 只作为只读文字显示在
> TopBar 的 chip 里。主人的原话是「为什么调节不了模型信息？」「你这整的一坨什么玩意」。

⚠️ v2 坑 20：**逗号/换行输入框不能由数组派生**（`value={list.join(',')} + onChange={split(',')}`
会把正在输入的逗号当场吃掉）。一律用草稿字符串，保存时才解析。

---

## 6. 验证要点（没有浏览器控制时）

1. `GET /chacha-qq/state` 返回 200 且 JSON 合法
2. 每个端点在 `remoteAddress` 非回环时返回 403
3. `client.js` 语法过 `node --check`（它引用 `window`，但要能解析）
4. **安装后页面真的出现侧边栏图标** —— 这一步必须主人重启后亲眼看
5. 面板打开后四个区块都在、切换会话不串数据
6. 配置改动保存后 `GET /chacha-qq/config` 能读回（说明深合并 + 落盘生效）
