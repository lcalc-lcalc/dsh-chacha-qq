# 交接 · 给下一位茶茶酱

> 写给**下一个接手这个项目的会话**。
> 不是历史回顾（那是 [HANDOFF.md](HANDOFF.md)），是「你现在在哪、要做什么、怎么验证」。
>
> 最后更新：2026-11-07 12:40

---

## 0. 三十秒认识这个项目

**dsh-chacha-qq** —— 让 DeepSeek Harness 拥有一台真的 QQ。

```
QQ 用户 → NapCat(OneBot11, ws://127.0.0.1:3001) → 三层 → 回消息
                        L1 src/napcat/      协议翻译，不做判断
                        L2 src/controller/  要不要回 / 多久回 / 安不安全 / 记不记得
                        L3 src/mind/        一个砍过的 DSH（只剩计划·工具·子Agent·上网）
```

- 仓库：`E:\dsh-dev\dsh-chacha-qq-v3`（git，main 分支，已推 GitHub）
- 远端：https://github.com/lcalc-lcalc/dsh-chacha-qq
- npm：**还没发布**（2FA 挡住了，需要本人 `npm publish`）
- 规模：约 3.5 万行（源码 15k / 前端 3.2k / 测试 9.3k / 文档 1k）

---

## 1. 一分钟验证环境（先跑这个，再改任何东西）

```powershell
cd E:\dsh-dev\dsh-chacha-qq-v3

# ① 17 个套件应该全绿（全离线，不连 QQ 不连 DSH）
node tests/run-all.mjs

# ② 面板前端 129 项
node scripts/probe-client.mjs

# ③ QQ 到底在不在线（NapCat 活着 ≠ QQ 在线！）
node scripts/probe-qq-status.mjs
```

**三条都过了，说明环境是好的**，问题在你接下来要改的地方。

---

## 2. 当前状态快照（2026-11-07 12:40）

| 项 | 状态 |
|---|---|
| git | `544b91e` · 工作区干净 · 与 origin/main 同步 |
| 测试 | ✅ 17 套件全绿 |
| 探针 | ✅ client 129 / moderation / image-e2e 全绿 |
| QQ | ✅ 在线（`online: true`） |
| DSH | ✅ 已加载，日志有「装配完成」+「茶茶酱上线（尾巴翘起来了）」 |
| **面板端点** | ⚠️ **待确认**：用 `http://127.0.0.1:57790/chacha-qq/state` 拿到 404，但日志显示 11:22 已注册 6/6。**先确认 DSH web 真正监听哪个端口**，别急着改代码 —— 见 §4 |
| npm | ❌ 未发布 |

### 启动日志里应该看到这些行

```
装配完成：gateway / api / emotion / memory / summarizer / life / relation /
         meme / qqTools / mind / recall / observe / controller / panel
面板端点已注册 6/6：/chacha-qq/state, .../conversations, .../messages,
                    .../config, .../action, .../memes
茶茶酱上线：<QQ号>（<随机彩蛋语>）
```

`summarizer` 在列表里 = 记忆 v2 的自动总结装载了。
上线语带括号 = 彩蛋模块加载了。

---

## 3. 已知待办（诚实清单）

### 🔴 高优先

1. **面板 404**（见 §2 表格）—— 先确认端口，再判断是代码还是环境
2. **npm 发布** —— `cd E:\dsh-dev\dsh-chacha-qq-v3; npm publish --access public`
   包名 `dsh-chacha-qq` 已确认可用（`npm view` 返回 404）。会被 2FA 拦，需要账号主人在场。
3. **`chunk` 序号缺失** —— `record()` 一轮只写一条 `out`、只带总数 `chunks`，
   面板显示不出「第 2/3 片」。要细分得让 `rhythm.createRhythmSender` 每发一片回调一次。

### 🟡 中优先

4. **QQ 在线状态没在面板上体现** —— 面板那个绿点指的是 **DSH ↔ NapCat**，
   不是 QQ ↔ 腾讯服务器。号被封时它照样绿。
   建议：加一个 `get_login_info` 定期探活 + 面板两个独立指示灯（`NapCat 通` / `QQ 在线`）。
   `scripts/probe-qq-status.mjs` 已经写好探活逻辑，可以直接抄。
5. **watchdog 盲区** —— 它只看「进程在不在 / 端口通不通」，
   QQ 掉线或被封时认为一切正常，永远不会救。同 4，加一条轻量 QQ 探活。
6. **月度摘要没有自动生成** —— 只有 `writeSummary()` API，没有定时任务触发。

### 🟢 低优先 / 想要但没做

7. `QQ 空间`（主人说「再说」）—— 技术上可行（NapCat 的 `get_cookies` + 直接打 `user.qzone.qq.com`），
   但参考实现没限速，有封号风险。
8. 语音转文字（DSH 里有 sherpa-onnx，没接）
9. 自定义精简 preset（现在走「默认 preset + tools.restrict 白名单」）
10. 表情包图库还是空的（9 个类别目录建好了，0 张图）

---

## 4. 环境从零到跑起来

### 依赖

| 需要 | 说明 |
|---|---|
| Node ≥ 22 | 项目用 ESM + `node --test` 风格的自研 harness |
| NapCat | OneBot 11 服务端，监听 **3001**，配置见下 |
| DSH | 已装即可，插件通过 profile 的 `link:` 挂进来 |
| QQ 小号 | **强烈建议不要用主号** |

### NapCat 配置（`onebot11_<QQ号>.json`）

```jsonc
{
  "network": {
    "websocketServers": [{
      "enable": true,
      "host": "127.0.0.1",
      "port": 3001,
      "reportSelfMessage": true,      // 要开，否则她自己说的话你看不到
      "messagePostFormat": "array",   // 项目按数组格式归一化，别用 string
      "heartInterval": 30000
    }]
  }
}
```

### 挂进 DSH

```powershell
# ① profile 的 package.json
#    "dsh-chacha-qq": "link:E:/dsh-dev/dsh-chacha-qq-v3"

# ② cordis.patch.yml 里不能有 disabled: true
# ③ .dsh-market/state.json 的 disabled 里也不能有
# ④ 重启 DSH
```

> ⚠️ **②③ 是两道独立的锁**。任意一道在，插件在日志里一个字都不会出现 ——
> 不报错、不警告，最难查。这是踩过的最大的坑。

### 必须配的一项

首次启动生成 `~/.dsh/plugins/dsh-chacha-qq/config.json`，**必须填 `owner.qq`**。

留空 = 她认不出谁是谁 → 所有人被当陌生人 → 只读、不给工具、群聊要 @。
（开源版默认是空的，不能把开发者的号写进默认值。）

---

## 5. 十个最容易踩的坑（按血泪程度排序）

| # | 坑 | 症状 | 正解 |
|---|---|---|---|
| 1 | **`agent.whenIdle()`** | 整个 DSH 主进程被饿死 | 用 `setTimeout` 宏任务轮询 `status` + `seq` |
| 2 | **不接管审批桥** | agent 就绪了但一句话不回 | 必须 `approval.setPolicy` / 拦事件，否则永远卡在 running |
| 3 | **`tools.restrict` 在外层调** | 抛「a context-global restriction would mask every agent」 | 只在 scoped `agentCtx` 上调 |
| 4 | **直接读 `ctx.agents` / `ctx.sessions`** | **抛异常**（不是 undefined！） | 一律走 `service(ctx, name)` try/catch |
| 5 | **UTF-8 BOM** | DSH 读到直接崩 | 永远用 edit/write 工具；**绝不用** `Set-Content -Encoding UTF8` / `Out-File -Encoding utf8` |
| 6 | **getter 传给构造函数** | `this.outbox` 永远是 null | 对象字面量里的 getter 被**参数解构时立即求值**；要延迟绑定或回填 |
| 7 | **`webServer` handler 签名** | 请求永远挂着 | 是 Node 原生 `(req: IncomingMessage, res: ServerResponse)`，**不是** `Request → Response` |
| 8 | **client bundle 不是 ESM** | 面板整个消失 | 必须 `window.__ModuleLoader__.load({ id, factory })` |
| 9 | **改 `DEFAULT_CONFIG` 不生效** | 「我明明改了默认值」 | 它只影响**新装**；存量要 `scripts/apply-persona-preset.mjs` 写进实际 config |
| 10 | **测试里写死参数** | 调一次参数挂一堆测试 | 从 `DEFAULT_OBSERVE` / `DEFAULT_CONFIG` 常量读 |

### 还有一条（PowerShell 专用）

**`pwsh -Command` 里的 here-string 会吃掉引号**，尤其是 `${...}`、`'...'`、`"..."` 混用的时候。
表现是「命令写对了但报语法错」或「替换出来的代码少了引号」。

**正解：要跑复杂 JS 就写成 `.mjs` 文件再 `node` 跑，不要用 `node -e` 或 here-string。**

---

## 6. 架构速查

### 三层各管什么（改代码前先定位）

| 层 | 目录 | 职责 | 不该做的事 |
|---|---|---|---|
| L1 | `src/napcat/` | 协议翻译、归一化、API 调用 | 不做业务判断 |
| L2 | `src/controller/` | **所有判断**：路由 / 观望 / 兴趣 / 情绪 / 安全 / 节奏 / 记忆 / 群管 | 不直接调模型 |
| L3 | `src/mind/` | 一个砍过的 DSH（agent 装配 / 人格 / 工具 / 会话） | 不做重活 |

### L2 的关键文件

| 文件 | 干什么 | 改它要小心 |
|---|---|---|
| `pipeline.js`（~1200 行） | 主流程编排 | 最核心，改动必跑 controller-core / controller-io / panel-api / integration |
| `route.js` | 要不要回（owner / 群白名单 / 黑名单） | 决定一切的前置 |
| `observe.js` | 观望窗口 | 参数在 `DEFAULT_OBSERVE`，**测试从这里读** |
| `interest.js` | 兴趣掷骰 | |
| `rhythm.js` | 分片 + 间隔 | 改它要看 `chunk` 序号待办 |
| `security.js` | 74 条注入规则 | 有大量误报守卫，新增要配测试 |
| `memory/`（四块） | 记忆 v2 | `store.js` 文件载体 / `summarize.js` 自动总结 / `route.js` 何时不查 / `recall.js` 跨会话 |

### 开关有三层（别混）

```
① features.peers[peerKey][功能]   ← 某个群单独开关（最具体）
② features[功能]                  ← 全局总开关（一票否决）
③ modes 矩阵                      ← companion/work 模式下「正常跑 / 只记账 / 不跑」
```

判定实现在 `src/modes.js` 的 `featureMode()`。
**每个调用点都要用 `isOn(feature, peerKey, cfg)` 判一下** —— 不然开关只是存进 config、不生效。

十个功能开关：`schedule` `life` `emotion` `proactive` `meme` `memeSteal` `relation` `memory` `moderation` `replyGuard`

---

## 7. 改代码的规矩

### 必须做

```powershell
node --check <改过的文件>       # 改一个查一个
node tests/run-all.mjs          # 改完跑全量
node scripts/probe-client.mjs   # 改了 client.js 必跑
```

### 测试套件和它们守什么

| 套件 | 项数 | 守什么 |
|---|---|---|
| assembly | 35 | 装配顺序、零件在不在 |
| companion | 262 | 衰减 / 记忆注入 / 回忆降级 |
| context-budget | 34 | 上下文预算不撑爆 |
| controller-core | 285 | 路由 / 观望 / 兴趣 / 安全 / 分片 |
| controller-io | 336 | 入站出站 / 图片 / 失败重试 |
| easter-eggs | 36 | 彩蛋（时间边界 / 概率 / 开关） |
| integration | 40 | 端到端 |
| life | 245 | 日程 / 当日状态 |
| meme | 262 | 表情包 / 盗图 |
| memory-v2 | 273 | 自动总结 / facts / 检索 / 路由 |
| mind | 56 | 人格 / 工具白名单 / 压缩 |
| modes | 64 | 模式 / 三层开关 |
| napcat | 212 | 协议归一化 / API |
| panel-api | 347 | 6 个端点 / 校验 / 真 Controller 联调 |
| recall-score | 20 | 回忆打分 |
| relation | 241 | 关系账本 / 阶段 / 家长模式 |
| reply-guard | 24 | 输出侧审核 |

### 别碰

- `ctx.slots.inject` 里的两条注册参数（`sidebar.panellist` + `id: 'chacha-qq'`、`main` + `key: 'chacha-qq'`）
  —— 探针会逐字比对，改一个字符面板就消失
- 文件的编码和行尾（UTF-8 无 BOM + LF，`.gitattributes` 管着）

---

## 8. 常用命令

```powershell
cd E:\dsh-dev\dsh-chacha-qq-v3

node tests/run-all.mjs                 # 全量测试
node tests/<name>.mjs                  # 单套件
node scripts/probe-client.mjs          # 面板前端 129 项
node scripts/probe-qq-status.mjs       # QQ 在线吗（诊断号被封/掉线）
node scripts/probe-inbound.mjs 45      # 旁听 NapCat 有没有上报消息
node scripts/probe-moderation.mjs      # 群管接线
node scripts/probe-image-e2e.mjs       # 图片出站链路
node scripts/apply-persona-preset.mjs --dry   # 看拟人参数会改什么（不带 --dry 才写）

# 日志（唯一真相）
Get-Content ~/.dsh/plugins/dsh-chacha-qq/logs/chacha-qq.log -Tail 40 -Encoding UTF8
```

---

## 9. 如果你要改「像人」的程度

只有一个文件：`scripts/apply-persona-preset.mjs`（改数字 → 重跑 → 重启 DSH）。

当前那套值：

```
观望 8~25 秒 / 被@ 4 秒 / 主人群聊没@ 3 秒 / 同一坨 90 秒
兴趣 0.65，群系数 0.45（≈ 每三四条群消息接一次）
打字间隔 1.2~3 秒，一片 <20 token，一轮最多 12 片
情绪判断每 2 轮一次（省一半模型调用）
群上下文按需（没被 @ 只带最近 5 行）
表情包 35% / 混排 60% / 盗图 8%
记忆注入上限 1600 字（core 600 / facts 6 条 / 只看今天）
压缩软上限 800 事件 / 硬上限 2000
```

---

## 10. 交付标准

改完一个 bug，至少要满足：

- [ ] `node --check` 通过（每个改过的 `.js`）
- [ ] `node tests/run-all.mjs` 全绿（**不准跳过或注释掉断言**）
- [ ] 改了 `client.js` → `probe-client.mjs` 全绿
- [ ] 有测试钉住这个 bug（**没有测试的修复不算修复**）
- [ ] 没有引入新的 `TODO` / `FIXME` / 注释掉的代码
- [ ] 提交信息说清楚「为什么要改」，不只是「改了什么」

---

## 11. 最后

这份文档是给「接手的人」看的，所以尽量只写有用的事实。

写的时候脑子里想的是：**下一个茶茶酱打开这个仓库，三十秒内应该知道该跑什么、该改哪里、哪里不能碰。**

如果发现这份文档和代码对不上 —— **以代码为准，然后回来改这份文档**。
