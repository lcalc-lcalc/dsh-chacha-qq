/**
 * dsh-chacha-qq v3 — 客户端半边（面板）
 *
 * 形态：侧边栏一行「茶茶酱的 QQ」→ 点进去是整页面板（顶部状态条 + 会话列表 + 对话区 + 配置抽屉）。
 *
 * 三条来自官方实现的硬规则（v2 踩过，写错会「面板不出来且不报错」）：
 *  1. 客户端 bundle **不是 ESM**：必须走 `window.__ModuleLoader__.load({ id, factory })`，
 *     `factory` 里 return 一个 `{ inject, apply }`。文件里不能有 import / export 语句。
 *  2. 侧边栏必须包在 `ctx.slots.inject('sidebar.panellist', …)` 里再 register，
 *     否则槽位声明还没出现就注册，**行会静默消失**。
 *  3. 整页面板是 root 作用域的 **keyed** slot，`key` 必须和侧边栏行的 `id` 同名（都叫 chacha-qq），
 *     `selectPanel(id)` 才能同时点亮导航行 + 挂载页面。**没有 URL 路由**。
 *
 * 数据契约见 docs/PANEL-DESIGN.md。宿主端点还没全部就绪时，面板必须**降级但不空白**：
 *  - /conversations 不可用 → 用 /state 里的 recent 推导会话列表
 *  - /messages 不可用     → 用 /state 里的 recent 过滤出当前会话
 *  - /config  不可用      → 抽屉显示「配置端点未就绪」，所有控件禁用但不报错
 * 这样宿主侧可以分步上线，面板先能用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-chacha-qq',

  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useCallback } = React
    const prim = require('@deepseek-ai/dsh-client-ui-primitives') || {}

    // primitives 有可能一个都没导出（宿主换版本 / 树摇掉），全部给兜底，绝不让面板白屏。
    // 注意：`fallback*` 是函数声明，会提升，所以这里能用。
    const { Button = fallbackButton, Switch = fallbackSwitch, Input = fallbackInput } = prim

    const PANEL_ID = 'chacha-qq'
    const API = '/chacha-qq'

    /** 轮询间隔（主人拍板 2~3 秒）。 */
    const POLL = {
      state: 3000,
      conversations: 3000,
      messages: 2000,
    }

    const MODE_LABEL = { companion: '陪伴', work: '干活' }

    // ── 「大脑」组的枚举与代价说明 ─────────────────────────────
    //
    // 为什么枚举要写死在客户端：宿主 `src/config.js` 对 `mind.reasoningEffort` 只做**类型**
    // 校验（只要是个字符串就收）。`'ultra'` 这种手改出来的脏值会原样落盘，然后每一轮
    // turn 都把它递给内核 —— 轻则被忽略（主人以为调了、其实没调），重则整轮失败。
    // 所以面板这边必须守住：下拉只给这四档，保存前再验一次，非法值一个 POST 都不发。
    const EFFORT_VALUES = ['', 'off', 'low', 'high', 'max']
    /** 档位 → 人话（TopBar 的 chip 和「大脑」组的徽章共用，别两处各写一套）。 */
    const EFFORT_LABEL = { off: '不思考', low: '轻思考', high: '深思考', max: '最深' }
    /**
     * 档位 → 代价说明（灰色小字）。
     * 原生 `<select>` 的 option 没法单独上色，所以「说明」做两件事：
     *  1. 拼进 option 的文字里 —— 展开下拉时每一项都看得到自己的代价；
     *  2. 当前选中的那一句另外显示在下拉**右边**（cq-effort-desc），不用展开也看得到。
     */
    const EFFORT_DESC = {
      '': '不指定，跟 DSH 自己的设置走（最省心）',
      off: '不做推理，回得最快、花得最少',
      low: '轻量思考，日常闲聊的默认档',
      high: '想得深一些，会慢一点、贵一点',
      max: '最深最慢，烧钱也最狠',
    }

    // ── 功能总开关（features.*）的 10 个功能 ────────────────────
    //
    // 为什么在客户端再抄一份：宿主 `src/config.js` 对 `features.*` 只做**类型**校验
    // （只要是个 boolean 就收），键名抄错（`memes` / `memeSend`）会静默落盘、静默失效，
    // 面板上还看不出来。把「有哪 10 个功能、叫什么、关掉到底省了什么」写死在面板这边，
    // 下拉/开关的键名就不可能写错。
    //
    // 顺序 = 面板上的顺序，也 = `src/config.js` 里 `DEFAULT_CONFIG.features` 的顺序。
    // 说明文字是主人拍板的原话，别自己改写：他要看的就是这几句。
    const FEATURES = [
      { key: 'schedule', title: '日程', desc: '每天生成一份她的日程（关掉省一次模型调用）' },
      { key: 'life', title: '当日状态', desc: '精力/心情底色注入到上下文' },
      { key: 'emotion', title: '情绪', desc: '判断心情 + 注入（关掉连判断都不跑，省最多）' },
      { key: 'proactive', title: '主动消息', desc: '她主动来找你（功能还没实现，先占位）' },
      { key: 'meme', title: '发表情包', desc: '句内 &&类别&& 标记换成图片' },
      { key: 'memeSteal', title: '盗图', desc: '看她喜不喜欢别人发的图' },
      { key: 'relation', title: '关系账本', desc: '记账 + 语气提示' },
      { key: 'memory', title: '记忆', desc: '读写记忆（关掉 = 不注入、不总结）' },
      { key: 'moderation', title: '群管', desc: '热词审查 + 自动禁言' },
      { key: 'replyGuard', title: '输出侧审核', desc: '她要说出去的话出门前再看一遍' },
    ]

    // ──────────────────────────── 样式 ────────────────────────────
    //
    // 颜色**一律**取宿主的 CSS 变量（并在 .cq-root 上收成 --cq-* 别名）：
    // 宿主换主题（浅色/深色/毛玻璃）时面板自己跟着变，不用维护两套色值。
    // 任何地方都不写死 #fff / #000。
    const CSS = `
.cq-root {
  --cq-bg: var(--dsw-alias-bg-base);
  --cq-layer1: var(--dsw-alias-bg-layer-1);
  --cq-layer2: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  --cq-text: var(--dsw-alias-label-primary);
  --cq-dim: var(--dsw-alias-label-tertiary);
  --cq-line: var(--dsw-alias-border-l3);
  --cq-ok: var(--dsw-alias-state-success-primary);
  --cq-bad: var(--dsw-alias-state-error-primary);
  --cq-accent: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary));
  width: 100%; height: 100%; min-width: 0; min-height: 0;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--cq-bg); color: var(--cq-text);
  font-family: var(--dsw-font-family);
  font-size: 13px; line-height: 1.6;
  position: relative;
}

/* ── 顶部状态条 ───────────────────────────────────────────── */
.cq-top {
  display: flex; align-items: center; gap: 10px; flex-shrink: 0;
  padding: 8px 16px; min-height: 46px;
  border-bottom: 0.5px solid var(--cq-line);
  background: var(--cq-layer1);
  transition: opacity var(--ds-transition-duration, .18s) var(--ds-ease-in-out, ease);
}
/* 请求失败：整条变灰，但**不隐藏**——数据还是旧数据，状态条负责说明这件事 */
.cq-top[data-stale="true"] { opacity: .55; }
.cq-top-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cq-dot {
  width: 8px; height: 8px; border-radius: 999px; flex-shrink: 0;
  transition: background var(--ds-transition-duration, .18s) ease, box-shadow .18s ease;
}
.cq-dot[data-on="true"] {
  background: var(--cq-ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cq-ok) 18%, transparent);
}
.cq-dot[data-on="false"] { background: var(--cq-dim); }
.cq-dot[data-on="error"] { background: var(--cq-bad); }
.cq-title { font-weight: 600; font-size: 14px; letter-spacing: .2px; white-space: nowrap; }
.cq-sub { color: var(--cq-dim); font-size: 11.5px; white-space: nowrap; }
.cq-sep { width: 1px; height: 18px; background: var(--cq-line); flex-shrink: 0; }
.cq-chip {
  /* provider · model · 思考强度 三个都要显示，150px 装不下就只会剩下省略号，所以放宽到 300px；
     窗口真的窄了它还能 flex-shrink（下面 .cq-chip-v 自带 ellipsis），不会挤坏别的控件。 */
  display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; max-width: 300px;
  font-size: 11.5px; color: var(--cq-dim);
}
.cq-chip-v {
  color: var(--cq-text); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px;
}
.cq-spacer { flex: 1; min-width: 4px; }
.cq-sel-wrap { display: inline-flex; align-items: center; gap: 5px; }
.cq-select-sm { max-width: 120px; padding: 3px 6px; font-size: 11.5px; }
.cq-iconbtn {
  flex-shrink: 0; padding: 4px 9px; font-size: 11.5px; cursor: pointer;
  color: var(--cq-text); font-family: var(--dsw-font-family);
  background: var(--cq-layer2);
  border: 0.5px solid var(--cq-line); border-radius: var(--dsw-radius-sm, 6px);
  transition: background .15s ease, border-color .15s ease;
}
.cq-iconbtn:hover { border-color: var(--cq-accent); }
.cq-iconbtn[disabled] { cursor: default; opacity: .5; }
.cq-savebtn {
  display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
  padding: 4px 10px; font-size: 11.5px; cursor: pointer;
  color: var(--cq-text); font-family: var(--dsw-font-family);
  background: transparent; border: 0.5px solid var(--cq-line);
  border-radius: var(--dsw-radius-sm, 6px);
}
.cq-savebtn[data-state="dirty"] { border-color: var(--cq-bad); }
.cq-savebtn[disabled] { cursor: default; }
.cq-savebtn-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--cq-dim); flex-shrink: 0; }
.cq-savebtn[data-state="dirty"] .cq-savebtn-dot { background: var(--cq-bad); }
.cq-savebtn[data-state="saved"] .cq-savebtn-dot { background: var(--cq-ok); }
.cq-savebtn[data-state="saving"] .cq-savebtn-dot { background: var(--cq-accent); }

/* ── 三栏主体 ─────────────────────────────────────────────── */
.cq-body { flex: 1; min-height: 0; min-width: 0; display: flex; overflow: hidden; }

/* 左：会话列表 */
.cq-side {
  width: 268px; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden;
  border-right: 0.5px solid var(--cq-line); background: var(--cq-layer1);
}
.cq-side-head { padding: 9px 10px 7px; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.cq-search { width: 100%; box-sizing: border-box; }
.cq-side-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 6px 10px; display: flex; flex-direction: column; gap: 2px; }
.cq-side-foot {
  flex-shrink: 0; padding: 6px 10px; border-top: 0.5px solid var(--cq-line);
  font-size: 10.5px; color: var(--cq-dim); display: flex; gap: 6px; align-items: center;
}
.cq-side-foot b { font-weight: 600; color: var(--cq-text); }
.cq-conv {
  display: flex; flex-direction: column; gap: 2px;
  padding: 7px 8px; border-radius: var(--dsw-radius-sm, 6px);
  cursor: pointer; min-width: 0;
  border: 0.5px solid transparent;
  transition: background .14s ease, border-color .14s ease;
}
.cq-conv:hover { background: color-mix(in srgb, var(--cq-text) 6%, transparent); }
.cq-conv[data-active="true"] { background: color-mix(in srgb, var(--cq-accent) 12%, transparent); border-color: color-mix(in srgb, var(--cq-accent) 45%, transparent); }
.cq-conv-name { font-size: 12.5px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cq-conv-time { font-size: 10px; color: var(--cq-dim); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.cq-conv-last {
  font-size: 11.5px; color: var(--cq-dim); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cq-conv-foot { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-top: 1px; }
.cq-badge {
  font-size: 10px; padding: 0 5px; line-height: 1.55; border-radius: var(--dsw-radius-xs, 4px);
  border: 0.5px solid var(--cq-line); color: var(--cq-dim);
  white-space: nowrap; flex-shrink: 0;
}
.cq-badge[data-mode="companion"] { color: var(--cq-accent); border-color: color-mix(in srgb, var(--cq-accent) 45%, transparent); }
.cq-badge[data-mode="work"] { color: var(--cq-text); border-color: var(--cq-line); }
.cq-badge[data-ok="true"] { color: var(--cq-ok); border-color: color-mix(in srgb, var(--cq-ok) 45%, transparent); }
.cq-badge[data-bad="true"] { color: var(--cq-bad); border-color: color-mix(in srgb, var(--cq-bad) 45%, transparent); }

/* 中：对话区 */
.cq-chat { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--cq-bg); }
.cq-chat-head {
  flex-shrink: 0; padding: 8px 16px; display: flex; align-items: center; gap: 8px;
  border-bottom: 0.5px solid var(--cq-line); background: var(--cq-layer1);
}
.cq-chat-title { font-size: 13px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cq-chat-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
.cq-stream {
  flex: 1; min-height: 0; overflow-y: auto; padding: 14px 18px 10px;
  display: flex; flex-direction: column; gap: 8px;
}
.cq-stream::-webkit-scrollbar, .cq-side-list::-webkit-scrollbar, .cq-drawer-body::-webkit-scrollbar { width: 8px; }
.cq-stream::-webkit-scrollbar-thumb, .cq-side-list::-webkit-scrollbar-thumb, .cq-drawer-body::-webkit-scrollbar-thumb {
  background: var(--cq-line); border-radius: 4px;
}
.cq-empty {
  margin: auto; text-align: center; color: var(--cq-dim);
  font-size: 12.5px; line-height: 1.9; max-width: 380px;
}
.cq-empty b { color: var(--cq-text); font-weight: 600; }

/* 气泡：进 = 左，出 = 右 */
.cq-row { display: flex; flex-direction: column; max-width: 78%; min-width: 0; animation: cq-in .18s ease; }
.cq-row[data-dir="in"] { align-self: flex-start; align-items: flex-start; }
.cq-row[data-dir="out"] { align-self: flex-end; align-items: flex-end; }
@keyframes cq-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.cq-meta { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--cq-dim); margin: 0 3px 2px; }
.cq-bubble {
  padding: 7px 11px; border-radius: var(--dsw-radius-md, 10px);
  white-space: pre-wrap; word-break: break-word;
  font-size: 13px; line-height: 1.65; min-width: 0;
}
.cq-row[data-dir="in"] .cq-bubble {
  background: var(--cq-layer2); border: 0.5px solid var(--cq-line);
  border-bottom-left-radius: var(--dsw-radius-xs, 4px);
}
.cq-row[data-dir="out"] .cq-bubble {
  background: color-mix(in srgb, var(--cq-accent) 16%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--cq-accent) 38%, transparent);
  border-bottom-right-radius: var(--dsw-radius-xs, 4px);
}
.cq-chunk { font-size: 9.5px; color: var(--cq-dim); margin-top: 1px; }
.cq-mono { font-family: var(--dsh-font-family-code-default, monospace); }

/* 轨迹：思考 / 工具 / 计划 / token（左侧竖线，不是聊天气泡） */
.cq-trace {
  align-self: stretch; max-width: 100%; min-width: 0;
  border-left: 2px solid var(--cq-line);
  padding: 3px 0 3px 9px; margin: 1px 0; font-size: 12px;
  animation: cq-in .16s ease;
}
.cq-trace[data-kind="reasoning"] { border-left-color: color-mix(in srgb, var(--cq-text) 30%, transparent); }
.cq-trace[data-kind="tool"] { border-left-color: var(--cq-accent); }
.cq-trace[data-kind="tool-result"] { border-left-color: var(--cq-ok); }
.cq-trace[data-kind="plan"] { border-left-color: var(--cq-accent); }
.cq-trace[data-kind="usage"] { border-left-color: var(--cq-line); }
.cq-trace[data-error="true"] { border-left-color: var(--cq-bad); }
.cq-trace-head {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  color: var(--cq-dim); cursor: pointer; user-select: none;
}
.cq-trace-head:hover { color: var(--cq-text); }
.cq-trace-caret { font-size: 9px; flex-shrink: 0; }
.cq-trace-name { font-weight: 600; color: var(--cq-text); flex-shrink: 0; }
.cq-trace-hint { font-size: 10.5px; color: var(--cq-dim); }
.cq-trace-hint[data-bad="true"] { color: var(--cq-bad); }
.cq-trace-time { margin-left: auto; font-size: 10px; color: var(--cq-dim); font-variant-numeric: tabular-nums; }
.cq-trace-body {
  margin-top: 3px; color: var(--cq-dim); line-height: 1.65;
  white-space: pre-wrap; word-break: break-word; font-size: 11.5px;
}
.cq-trace-body[data-italic="true"] { font-style: italic; }
.cq-trace-pre {
  margin: 4px 0 0; padding: 6px 8px; max-height: 200px; overflow: auto;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--cq-layer2); border: 0.5px solid var(--cq-line);
  font-family: var(--dsh-font-family-code-default, monospace);
  font-size: 10.5px; line-height: 1.55; color: var(--cq-text);
  white-space: pre-wrap; word-break: break-all;
}
.cq-trace-pre[data-error="true"] { border-color: var(--cq-bad); }
.cq-plan { display: flex; flex-direction: column; gap: 2px; margin-top: 3px; }
.cq-plan-item { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; line-height: 1.55; color: var(--cq-dim); }
.cq-plan-item[data-status="in_progress"] { color: var(--cq-text); }
.cq-plan-item[data-status="completed"] { text-decoration: line-through; opacity: .75; }
.cq-plan-icon { flex-shrink: 0; width: 12px; text-align: center; }
.cq-usage { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 2px; font-size: 11px; color: var(--cq-dim); }
.cq-usage b { color: var(--cq-text); font-weight: 600; font-variant-numeric: tabular-nums; }

/* 输入框（给自己发测试） */
.cq-composer { flex-shrink: 0; border-top: 0.5px solid var(--cq-line); background: var(--cq-layer1); padding: 8px 12px 10px; }
.cq-composer-row { display: flex; gap: 8px; align-items: flex-end; }
.cq-composer-input { flex: 1; min-width: 0; resize: none; }
.cq-composer-foot { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 10.5px; color: var(--cq-dim); min-width: 0; }
.cq-hint { font-size: 10.5px; color: var(--cq-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cq-hint[data-bad="true"] { color: var(--cq-bad); }
.cq-hint[data-ok="true"] { color: var(--cq-ok); }
.cq-loading { font-size: 11px; color: var(--cq-dim); }

/* ── 右：配置抽屉 ─────────────────────────────────────────── */
.cq-drawer {
  width: 340px; flex-shrink: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
  border-left: 0.5px solid var(--cq-line); background: var(--cq-layer1);
}
.cq-drawer[data-open="false"] { display: none; }
.cq-drawer-head {
  flex-shrink: 0; display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 0.5px solid var(--cq-line);
}
.cq-drawer-title { font-size: 12.5px; font-weight: 600; flex-shrink: 0; }
.cq-drawer-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-shrink: 0; }
.cq-drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px 28px; display: flex; flex-direction: column; gap: 4px; }
.cq-save-state { font-size: 10.5px; color: var(--cq-dim); }
.cq-save-state[data-bad="true"] { color: var(--cq-bad); }
.cq-save-state[data-ok="true"] { color: var(--cq-ok); }
.cq-notice {
  padding: 6px 8px; margin: 2px 0 6px; border-radius: var(--dsw-radius-sm, 6px);
  border: 0.5px dashed var(--cq-line); font-size: 11px; line-height: 1.6; color: var(--cq-dim);
}
.cq-notice[data-bad="true"] { border-color: var(--cq-bad); color: var(--cq-bad); }

/* 当前对话覆盖（抽屉顶部） */
.cq-peer-card {
  border: 0.5px solid var(--cq-line); border-radius: var(--dsw-radius-sm, 6px);
  padding: 8px; margin: 4px 0 6px; background: var(--cq-layer2);
  display: flex; flex-direction: column; gap: 7px;
}
.cq-peer-title { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; }
.cq-peer-title .cq-badge { font-weight: 400; }
.cq-peer-sub { font-size: 10.5px; color: var(--cq-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 功能开关的行（总开关组 + 本对话三态开关共用一套排版） */
.cq-featrow { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 1px 0; }
.cq-featrow-label {
  flex: 1; min-width: 0; font-size: 11.5px; color: var(--cq-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 「全局已关」这类提醒：字小、灰、不抢眼，但必须在按钮旁边看得见 */
.cq-featrow-note { flex-shrink: 0; font-size: 10px; color: var(--cq-dim); }
/* 三态按钮：跟随全局（灰）→ 开（绿）→ 关（红）。颜色全走变量，换主题跟着变 */
.cq-tri {
  flex-shrink: 0; min-width: 64px; padding: 2px 8px;
  font-family: var(--dsw-font-family); font-size: 11px; line-height: 1.5;
  cursor: pointer; color: var(--cq-dim);
  background: transparent; border: 0.5px solid var(--cq-line);
  border-radius: var(--dsw-radius-sm, 6px);
  transition: color .15s ease, border-color .15s ease, background .15s ease;
}
.cq-tri:hover { border-color: var(--cq-accent); color: var(--cq-text); }
.cq-tri[disabled] { cursor: default; opacity: .5; }
.cq-tri[data-state="on"] {
  color: var(--cq-ok); border-color: color-mix(in srgb, var(--cq-ok) 45%, transparent);
  background: color-mix(in srgb, var(--cq-ok) 10%, transparent);
}
.cq-tri[data-state="off"] {
  color: var(--cq-bad); border-color: color-mix(in srgb, var(--cq-bad) 45%, transparent);
  background: color-mix(in srgb, var(--cq-bad) 10%, transparent);
}
.cq-tri[data-state="follow"] { color: var(--cq-dim); }
/* 「本对话功能开关」的小标题：和上面的滑块之间留一点呼吸，别糊成一片 */
.cq-feathead { display: flex; align-items: baseline; gap: 6px; margin-top: 3px; min-width: 0; }
.cq-feathead-t { flex-shrink: 0; font-size: 11px; font-weight: 600; color: var(--cq-text); }
.cq-feathead-h {
  min-width: 0; font-size: 10px; color: var(--cq-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cq-featlist { display: flex; flex-direction: column; gap: 3px; }

/* 分组（可折叠） */
.cq-sec { border-bottom: 0.5px solid var(--cq-line); }
.cq-sec-head {
  width: 100%; display: flex; align-items: center; gap: 6px;
  padding: 7px 2px; background: transparent; border: 0;
  color: var(--cq-text); font-family: var(--dsw-font-family); font-size: 12px;
  text-align: left; cursor: pointer;
}
.cq-sec-head:hover { color: var(--cq-accent); }
.cq-sec-caret { font-size: 9px; color: var(--cq-dim); width: 9px; flex-shrink: 0; }
.cq-sec-title { font-weight: 600; flex-shrink: 0; }
.cq-sec-badge { font-size: 10px; color: var(--cq-dim); flex-shrink: 0; }
.cq-sec-hint { font-size: 10px; color: var(--cq-dim); margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cq-sec-body { padding: 2px 2px 10px; display: flex; flex-direction: column; gap: 8px; }

/* 字段 */
.cq-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cq-field-label { font-size: 11.5px; color: var(--cq-dim); display: flex; align-items: center; gap: 5px; min-width: 0; }
.cq-field-hint { font-size: 10px; color: var(--cq-dim); line-height: 1.5; opacity: .9; }
.cq-input, .cq-select, .cq-textarea {
  width: 100%; box-sizing: border-box; padding: 5px 7px;
  font-family: var(--dsw-font-family); font-size: 11.5px; color: var(--cq-text);
  background: var(--cq-bg); border: 0.5px solid var(--cq-line);
  border-radius: var(--dsw-radius-sm, 6px); outline: none;
}
.cq-input:focus, .cq-select:focus, .cq-textarea:focus { border-color: var(--cq-accent); }
.cq-input[disabled], .cq-select[disabled], .cq-textarea[disabled] { opacity: .55; cursor: default; }
.cq-textarea { resize: vertical; line-height: 1.6; font-family: var(--dsh-font-family-code-default, monospace); font-size: 11px; }
/* 「大脑」组的思考强度：左边下拉，右边一句灰色的代价说明（不展开下拉也看得到） */
.cq-effort-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cq-effort-row .cq-select { flex: 0 1 58%; min-width: 0; }
.cq-effort-desc { flex: 1; min-width: 0; font-size: 10px; color: var(--cq-dim); line-height: 1.4; }
.cq-effort-desc[data-bad="true"] { color: var(--cq-bad); }
.cq-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.cq-range-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cq-range { flex: 1; min-width: 0; accent-color: var(--cq-accent); cursor: pointer; }
.cq-range-v { font-size: 11px; color: var(--cq-text); font-variant-numeric: tabular-nums; width: 34px; text-align: right; flex-shrink: 0; }
.cq-kv { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 11.5px; padding: 2px 0; min-width: 0; }
.cq-kv-k { color: var(--cq-dim); flex-shrink: 0; }
.cq-kv-v { color: var(--cq-text); font-variant-numeric: tabular-nums; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cq-maprow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cq-maprow .cq-input { flex: 1; }
.cq-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 2px 0; }
.cq-switch-text { min-width: 0; flex: 1; }
.cq-switch-label { font-size: 11.5px; line-height: 1.4; }
.cq-switch-hint { font-size: 10px; color: var(--cq-dim); line-height: 1.4; }

/* 日志 */
.cq-log { display: flex; flex-direction: column; gap: 1px; font-family: var(--dsh-font-family-code-default, monospace); font-size: 10px; line-height: 1.5; }
.cq-logline { display: flex; gap: 5px; min-width: 0; color: var(--cq-dim); }
.cq-logline[data-level="warn"] { color: var(--cq-dim); }
.cq-logline[data-level="error"] { color: var(--cq-bad); }
.cq-log-time { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.cq-log-tag { flex-shrink: 0; }
.cq-log-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`

    /**
     * 注入样式。
     * 带 data-plugin 标记：宿主 HMR / 插件卸载时会按标记回收，我们自己也在返回的
     * 清理函数里 remove()，两边兜底 —— 否则热重载几次后 <head> 里会堆一串同样的 CSS。
     */
    function mountStyle() {
      const existing = document.querySelector('style[data-plugin="dsh-chacha-qq"]')
      if (existing) return () => {}
      const node = document.createElement('style')
      node.setAttribute('data-plugin', 'dsh-chacha-qq')
      node.setAttribute('data-plugin-css', '')
      node.textContent = CSS
      document.head.appendChild(node)
      return () => node.remove()
    }

    // ──────────────────────────── 网络 ────────────────────────────

    /**
     * 统一请求。
     *
     * POST 失败时退回 `?payload=` 走 GET：Electron 的桥接在某些版本会把 body 吞掉，
     * 表现是「GET 正常、POST 永远空 body」。宿主端点两种都收，所以这里无脑兜底。
     */
    async function api(path, { method = 'GET', body } = {}) {
      const url = API + path
      const readJson = async (res) => {
        if (!res) throw new Error('没有响应')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      }
      if (method === 'GET') {
        return readJson(await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' }))
      }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        const json = await res.json().catch(() => ({}))
        if (json && json.ok === false) throw new Error(json.error || '服务端拒绝')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return json
      } catch (error) {
        // body 被吞掉 → 改走 GET + payload
        const encoded = encodeURIComponent(JSON.stringify(body ?? {}))
        const res = await fetch(`${url}?payload=${encoded}`, { headers: { accept: 'application/json' } })
        const json = await readJson(res).catch(() => null)
        if (!json) throw error
        if (json.ok === false) throw new Error(json.error || '服务端拒绝')
        return json
      }
    }

    // ──────────────────────────── 小工具 ────────────────────────────

    function pad2(n) {
      return String(n).padStart(2, '0')
    }

    /** 时间戳 → HH:MM:SS（面板里的时间一律本地时区，别用 UTC 让主人迷惑）。 */
    function timeText(at) {
      const t = Number(at)
      if (!t) return '—'
      const date = new Date(t)
      if (Number.isNaN(date.getTime())) return '—'
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    }

    /** 时间戳 → 「刚刚 / 3 分钟前 / 2 小时前 / 8/12 14:30」。 */
    function agoText(at) {
      const t = Number(at)
      if (!t) return '—'
      const diff = Date.now() - t
      if (diff < 5 * 1000) return '刚刚'
      if (diff < 60 * 1000) return `${Math.floor(diff / 1000)} 秒前`
      if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
      if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
      const date = new Date(t)
      if (diff < 7 * 24 * 3600 * 1000) {
        return `${date.getMonth() + 1}/${date.getDate()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
      }
      return `${date.getMonth() + 1}/${date.getDate()}`
    }

    function durationText(ms) {
      const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
      if (total < 60) return `${total} 秒`
      const m = Math.floor(total / 60)
      if (m < 60) return `${m} 分 ${total % 60} 秒`
      const hrs = Math.floor(m / 60)
      if (hrs < 24) return `${hrs} 小时 ${m % 60} 分`
      return `${Math.floor(hrs / 24)} 天 ${hrs % 24} 小时`
    }

    /** token 数的人话：1234 → 1.2k。 */
    function fmtTokens(n) {
      const value = Number(n) || 0
      if (value < 1000) return String(value)
      if (value < 10000) return `${(value / 1000).toFixed(1)}k`
      if (value < 1000000) return `${Math.round(value / 1000)}k`
      return `${(value / 1000000).toFixed(1)}M`
    }

    /** 截断长文本（列表/标题都用它，CSS 的 ellipsis 只是兜底）。 */
    function clip(text, max) {
      const value = String(text ?? '')
      const limit = Number(max) || 80
      return value.length > limit ? `${value.slice(0, limit)}…` : value
    }

    function clamp01(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return 0
      return Math.min(1, Math.max(0, number))
    }

    /** 只接受有限数字，脏数据一律回落到 fallback（面板不能被宿主的一个 null 打死）。 */
    function num(value, fallback = 0) {
      const number = Number(value)
      return Number.isFinite(number) ? number : fallback
    }

    function msToSec(ms) {
      return Math.round((Number(ms) || 0) / 100) / 10
    }

    function secToMs(sec) {
      return Math.round((Number(sec) || 0) * 1000)
    }

    /** 深拷贝：草稿必须和 config 完全脱钩，否则「还原」还原不回去。 */
    function deepClone(value) {
      if (value === undefined || value === null) return value
      try {
        return JSON.parse(JSON.stringify(value))
      } catch {
        return value
      }
    }

    /** 按 'a.b.c' 或 ['a','b','c'] 取值。 */
    function getPath(obj, path, fallback) {
      const parts = Array.isArray(path) ? path : String(path ?? '').split('.')
      let cur = obj
      for (const part of parts) {
        if (cur === undefined || cur === null || typeof cur !== 'object') return fallback
        cur = cur[part]
      }
      return cur === undefined || cur === null ? fallback : cur
    }

    /** 按路径写值（返回新对象，不改入参）。 */
    function setPathIn(base, path, value) {
      const parts = (Array.isArray(path) ? path : String(path ?? '').split('.')).map(String)
      const out = deepClone(base && typeof base === 'object' ? base : {}) ?? {}
      let cur = out
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i]
        if (cur[key] === undefined || cur[key] === null || typeof cur[key] !== 'object') cur[key] = {}
        cur = cur[key]
      }
      cur[parts[parts.length - 1]] = value
      return out
    }

    /**
     * 按路径把值写成 `null`（**不是删键**）。
     *
     * 为什么写 null 而不是从草稿里删掉这个键：
     *   保存时 `patch` 就是这份草稿，而**patch 里没有的键后端不会去删**
     *   （`mergeDeep` 只合并不删除）。所以以前「切回跟随全局」保存之后，
     *   磁盘上那条旧覆盖还留着、还在生效 —— 面板显示「跟随全局」，行为却是旧的。
     *   现在写 `null`：`ConfigStore.patch` 会把它当成「删除这一项」真删掉
     *   （见 src/config.js 的 applyNullDeletes），面板和行为就一致了。
     */
    function unsetPathIn(base, path) {
      const parts = (Array.isArray(path) ? path : String(path ?? '').split('.')).map(String)
      const out = deepClone(base && typeof base === 'object' ? base : {}) ?? {}
      let cur = out
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i]
        if (cur[key] === undefined || cur[key] === null || typeof cur[key] !== 'object') return out
        cur = cur[key]
      }
      cur[parts[parts.length - 1]] = null
      return out
    }

    /** 思考强度 → 人话。空 / auto 显示为空（「跟随默认」由调用方自己说），未知值原样返回。 */
    function effortText(effort) {
      const raw = String(effort ?? '').trim()
      // `auto` 是 DSH 自己的「你帮我定」标记，等于没指定，不要显示成一个奇怪的字。
      if (!raw || raw === 'auto') return ''
      return EFFORT_LABEL[raw] ?? raw
    }

    /** 「大脑」组的徽章：空档也要有个像样的说法，不能显示空徽章。 */
    function effortBadge(effort) {
      const raw = String(effort ?? '').trim()
      if (!raw || raw === 'auto') return '跟随默认'
      return EFFORT_LABEL[raw] ?? raw
    }

    /**
     * 「大脑」组的保存前校验。返回 '' = 通过，返回字符串 = 人话错误。
     *
     * 为什么非要在前端挡：后端只校验类型，`reasoningEffort: 'ultra'` / `maxTokens: -1`
     * 都会照收落盘，坏起来很难查。调用方拿到非空字符串就必须**停止保存**（不发 POST），
     * 并把这句话显示出来 —— 静默失败是最糟的。
     */
    function validateMind(draft) {
      const effort = String(getPath(draft, 'mind.reasoningEffort', '') ?? '')
      if (!EFFORT_VALUES.includes(effort)) {
        return `思考强度只能是 off / low / high / max（留空 = 跟随默认），配置里却是「${effort}」`
      }
      const rawMax = getPath(draft, 'mind.maxTokens', 0)
      if (rawMax !== undefined && rawMax !== null && rawMax !== '') {
        const maxTokens = Number(rawMax)
        if (!Number.isFinite(maxTokens)) return `单轮 token 上限必须是数字，配置里却是「${rawMax}」`
        if (maxTokens < 0) return '单轮 token 上限不能是负数（0 = 不限制）'
      }
      return ''
    }

    /**
     * 「校验 → POST」的唯一出口。
     *
     * 为什么单独抽出来：探针要能证明「非法值不会打网络」。这里一旦返回 blocked，
     * 投递函数（生产上是 api，探针里换成计数用的假 fetch）**一次都不会被调用**。
     * 这么写也顺手把「校验」和「发请求」绑死，以后谁加保存路径都绕不过这道闸。
     */
    async function postConfig(post, patch) {
      const invalid = validateMind(patch)
      if (invalid) return { ok: false, error: invalid, blocked: true }
      return post('/config', { method: 'POST', body: { patch } })
    }

    /**
     * 逗号/换行/空白分隔的文本 → 去重数组。
     *
     * ⚠️ 只能**在保存时**调用。输入框绝不能 `value={list.join(',')} + onChange={split(',')}`，
     * 那样用户刚敲下去的那个逗号会被当场吃掉（v2 坑 20）。输入框用草稿字符串。
     */
    function parseCsv(text) {
      const seen = new Set()
      const out = []
      for (const piece of String(text ?? '').split(/[\n,，、;；\s]+/)) {
        const value = piece.trim()
        if (!value || seen.has(value)) continue
        seen.add(value)
        out.push(value)
      }
      return out
    }

    /** 数组 → 一行逗号文本（只用于**灌草稿**，不参与每次渲染）。 */
    function formatCsv(list) {
      if (!Array.isArray(list)) return ''
      return list.map((item) => String(item)).join(', ')
    }

    /** 一行一个的文本 → 数组。 */
    function parseLines(text) {
      return String(text ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    }

    function formatLines(list) {
      if (!Array.isArray(list)) return ''
      return list.map((item) => String(item)).join('\n')
    }

    /** 「123=0.9」每行一条 → 对象。key 里不允许出现 `=`，value 必须能转数字。 */
    function parseNumMap(text) {
      const out = {}
      for (const line of String(text ?? '').split(/\r?\n/)) {
        const raw = line.trim()
        if (!raw || raw.startsWith('#')) continue
        const at = raw.search(/[=:：,，\s]/)
        const key = (at < 0 ? raw : raw.slice(0, at)).trim()
        const rest = at < 0 ? '' : raw.slice(at + 1).trim()
        if (!key) continue
        const value = Number(rest)
        out[key] = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
      }
      return out
    }

    function formatNumMap(map) {
      if (!map || typeof map !== 'object') return ''
      return Object.entries(map)
        .map(([key, value]) => `${key}=${Number(value)}`)
        .join('\n')
    }

    // ──────────────────────────── 数据归一化 ────────────────────────────
    //
    // PANEL-DESIGN §2 描述的是**目标**形状，宿主还没全部就绪；而今天的 /state 是
    // 「顶层扁平 + controller 嵌套」两种混着。这里统一归一化，UI 只认一套形状 ——
    // 宿主怎么演进都不会把面板打穿。

    function normalizeModel(raw) {
      if (!raw) return null
      if (typeof raw === 'string') return { provider: '', model: raw, effort: '', source: '' }
      return {
        provider: String(raw.provider ?? ''),
        model: String(raw.model ?? raw.name ?? ''),
        effort: String(raw.effort ?? raw.reasoningEffort ?? ''),
        source: String(raw.source ?? ''),
      }
    }

    /** 一条消息（含轨迹）。兼容 `dir`/`direction`、`args`/`toolArgs`、`result`/`toolResult`。 */
    function normalizeMessage(raw) {
      if (!raw || typeof raw !== 'object') return null
      const dirRaw = String(raw.dir ?? raw.direction ?? 'in')
      const dir = dirRaw === 'internal' ? 'internal' : dirRaw === 'out' ? 'out' : 'in'
      const scene = raw.scene === 'group' ? 'group' : 'private'
      const groupId = String(raw.groupId ?? '')
      const userId = String(raw.userId ?? '')
      const peerId = String(raw.peerId ?? (scene === 'group' ? groupId : userId))
      const peerKey = String(
        raw.peerKey ?? (scene === 'group' ? `group-${groupId || peerId}` : `private-${userId || peerId}`),
      )
      return {
        at: Number(raw.at) || 0,
        dir,
        scene,
        peerId,
        peerKey,
        kind: raw.kind ? String(raw.kind) : '',
        text: String(raw.text ?? ''),
        name: String(raw.name ?? ''),
        args: raw.args ?? raw.toolArgs ?? null,
        result: raw.result ?? raw.toolResult ?? '',
        error: Boolean(raw.error ?? raw.toolError ?? false),
        chunk: Number(raw.chunk) || 0,
        chunks: Number(raw.chunks) || 0,
        tokens: raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : null,
        plan: Array.isArray(raw.plan) ? raw.plan : null,
        role: raw.role ? String(raw.role) : '',
      }
    }

    /** 一条会话。字段缺就缺，UI 自己隐藏对应徽章。 */
    function normalizeConversation(raw) {
      if (!raw || typeof raw !== 'object') return null
      const scene = raw.scene === 'group' ? 'group' : 'private'
      const peerId = String(raw.peerId ?? '')
      const peerKey = String(raw.peerKey ?? (scene === 'group' ? `group-${peerId}` : `private-${peerId}`))
      const relationRaw = raw.relation && typeof raw.relation === 'object' ? raw.relation : null
      return {
        peerKey,
        scene,
        peerId,
        name: String(raw.name ?? '') || peerId || peerKey,
        mode: raw.mode === 'work' ? 'work' : raw.mode === 'companion' ? 'companion' : '',
        role: raw.role === 'owner' ? 'owner' : raw.role === 'guest' ? 'guest' : '',
        lastAt: Number(raw.lastAt) || 0,
        lastText: String(raw.lastText ?? ''),
        counts: {
          in: num(raw.counts?.in, 0),
          out: num(raw.counts?.out, 0),
        },
        relation: relationRaw
          ? {
            score: num(relationRaw.score, 0),
            phase: String(relationRaw.phase ?? ''),
            label: String(relationRaw.label ?? relationRaw.phase ?? ''),
          }
          : null,
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
        session: raw.session && typeof raw.session === 'object'
          ? {
            sessionId: String(raw.session.sessionId ?? ''),
            events: num(raw.session.events, 0),
            pressure: Number(raw.session.pressure),
          }
          : null,
        derived: Boolean(raw.derived),
      }
    }

    function normalizeLog(item) {
      if (!item || typeof item !== 'object') return null
      return {
        at: Number(item.at) || 0,
        level: String(item.level ?? 'info'),
        tag: String(item.tag ?? ''),
        text: String(item.text ?? ''),
      }
    }

    /** /state 归一化：兼容 §2.1 的扁平形状和今天「controller 嵌套」的形状。 */
    function normalizeState(raw) {
      if (!raw || typeof raw !== 'object') return null
      const c = raw.controller && typeof raw.controller === 'object' ? raw.controller : null
      const connRaw = raw.conn && typeof raw.conn === 'object' ? raw.conn : null
      const rawLog = Array.isArray(raw.log) ? raw.log : []
      const rawRecent = Array.isArray(raw.recent) ? raw.recent : Array.isArray(c?.recent) ? c.recent : []
      const mindRaw = raw.mind && typeof raw.mind === 'object' ? raw.mind : c?.mind
      return {
        ok: raw.ok !== false,
        now: Number(raw.now ?? c?.now) || Date.now(),
        parts: raw.parts && typeof raw.parts === 'object' ? raw.parts : {},
        dataDir: String(raw.dataDir ?? c?.dataDir ?? ''),
        conn: {
          connected: Boolean(connRaw?.connected ?? c?.connected ?? false),
          selfId: String(connRaw?.selfId ?? c?.selfId ?? ''),
          uptimeMs: Number(connRaw?.uptimeMs ?? c?.uptimeMs ?? 0) || 0,
          wsUrl: String(connRaw?.wsUrl ?? ''),
        },
        model: normalizeModel(raw.model ?? mindRaw?.model ?? null),
        mind: {
          available: Boolean(mindRaw?.available),
          sessions: Array.isArray(mindRaw?.sessions) ? mindRaw.sessions : [],
        },
        stats: raw.stats && typeof raw.stats === 'object' ? raw.stats : c?.stats ?? {},
        groups: Array.isArray(raw.groups) ? raw.groups : Array.isArray(c?.groups) ? c.groups : [],
        usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : null,
        modes: raw.modes && typeof raw.modes === 'object' ? raw.modes : null,
        pendingRequests: num(raw.pendingRequests ?? c?.pendingRequests, 0),
        log: rawLog.slice(-40).map(normalizeLog).filter(Boolean),
        recent: rawRecent.map(normalizeMessage).filter(Boolean),
      }
    }

    /**
     * 会话列表的降级来源：/conversations 还没上线时，从 /state 的 recent 里聚合。
     *
     * 为什么值得写这坨：宿主和面板是两个人分头写的，面板不能等宿主 ——
     * 有 recent 就能看见「谁在说话、最后一句是什么」，足够先把面板用起来。
     */
    function deriveConversations(state) {
      const list = state?.recent ?? []
      const map = new Map()
      for (const item of list) {
        const key = item.peerKey
        if (!key) continue
        let conv = map.get(key)
        if (!conv) {
          conv = {
            peerKey: key,
            scene: item.scene,
            peerId: item.peerId,
            name: '',
            mode: '',
            role: item.role,
            lastAt: 0,
            lastText: '',
            counts: { in: 0, out: 0 },
            relation: null,
            tags: [],
            session: null,
            derived: true,
          }
          map.set(key, conv)
        }
        if (item.dir === 'in') {
          conv.counts.in += 1
          // 私聊用说话人的昵称；群聊用群号（recent 里没有群名）
          if (item.scene === 'private' && item.name) conv.name = item.name
        } else if (item.dir === 'out') {
          conv.counts.out += 1
        }
        if (item.role && !conv.role) conv.role = item.role
        if (item.at >= conv.lastAt) {
          conv.lastAt = item.at
          if (item.dir !== 'internal' && item.text) conv.lastText = item.text
        }
      }
      const out = [...map.values()]
      for (const conv of out) {
        if (!conv.name) conv.name = conv.scene === 'group' ? `群 ${conv.peerId}` : conv.peerId || conv.peerKey
      }
      out.sort((a, b) => b.lastAt - a.lastAt)
      return out
    }

    /** 消息流的降级来源：从 /state 的 recent 里按 peerKey 过滤。 */
    function messagesFromState(state, peerKey) {
      const list = state?.recent ?? []
      const picked = peerKey ? list.filter((item) => item.peerKey === peerKey) : list.slice()
      return picked.slice().sort((a, b) => a.at - b.at)
    }

    /**
     * 面板侧算模式（配置还没到 / 端点没就绪时，顶部和列表也要能显示一个合理的值）。
     *
     * 语义必须和 `src/modes.js` 的 `resolveMode` 一致 —— 否则会出现
     * 「面板说这个群是陪伴、她实际按干活跑」这种最难查的分歧。
     * 关键点：群聊的键要归一化成 `group-<群号>`，**不按发言人拆**。
     */
    function normalizePeerKeyLocal(peerKey) {
      const text = String(peerKey ?? '').trim()
      if (!text) return ''
      const group = /^group-(.+)$/.exec(text)
      if (group) return `group-${group[1].split('-')[0]}`
      return text
    }

    function resolveModeLocal(peerKey, config) {
      const peers = config?.modes?.peers ?? {}
      const raw = String(peerKey ?? '')
      const key = normalizePeerKeyLocal(raw)
      // ① 原始键精确命中
      if (peers[raw] === 'work' || peers[raw] === 'companion') return peers[raw]
      // ② 归一化后的键命中
      if (key && (peers[key] === 'work' || peers[key] === 'companion')) return peers[key]
      // ③ 把 peers 里的键也归一化后比对（group-333-owner 对 group-333-guest 同样生效）
      if (key) {
        for (const [peerId, mode] of Object.entries(peers)) {
          if (mode !== 'work' && mode !== 'companion') continue
          if (normalizePeerKeyLocal(peerId) === key) return mode
        }
      }
      return config?.modes?.default === 'work' ? 'work' : 'companion'
    }

    // ── 功能开关（features.*）的读取 / 三态 / 清扫 ──────────────
    //
    // 三层优先级和 `src/modes.js` 的 `featureMode` 必须**完全一致**，顺序别自己发明：
    //   ① features.peers[peerKey][功能]  ← 某个群/某个人单独开关
    //   ② features[功能]                 ← 全局总开关（一票否决）
    //   ③ modes 矩阵                     ← 「① 模式」组负责的那一维
    // 面板只读写 ①②；③ 不在这里。
    //
    // 为什么查找要跟 featureMode 一样绕三圈：主人手改 config.json 写成
    // `group-123-owner` 是常有的事。面板只认 `group-123` 就会出现
    // 「面板显示跟随全局，她实际按那条覆盖跑」——这种分歧最难查。

    /** 全局总开关。缺省 = 开（和 DEFAULT_CONFIG.features 保持一致）。 */
    function featureOnHere(config, feature) {
      return getPath(config, ['features', feature], true) !== false
    }

    /**
     * 某个对话对这个功能的覆盖值：true / false / undefined（undefined = 跟随全局，不写进配置）。
     */
    function featurePeerValue(config, peerKey, feature) {
      const peers = getPath(config, 'features.peers', {})
      if (!peers || typeof peers !== 'object') return undefined
      const raw = String(peerKey ?? '')
      const key = normalizePeerKeyLocal(raw)
      // ① 归一化键优先、② 再看原始键（和 featureMode 的取法一致，别反过来）
      for (const candidate of [key, raw]) {
        if (!candidate) continue
        const own = peers[candidate]
        if (!own || typeof own !== 'object') continue
        if (typeof own[feature] === 'boolean') return own[feature]
      }
      // ③ 把 peers 的键也归一化后比对
      if (key) {
        for (const [peerId, own] of Object.entries(peers)) {
          if (!own || typeof own !== 'object') continue
          if (typeof own[feature] !== 'boolean') continue
          if (normalizePeerKeyLocal(peerId) === key) return own[feature]
        }
      }
      return undefined
    }

    /** 三态循环：跟随全局 → 开 → 关 → 跟随全局（undefined 表示「不写进配置」）。 */
    function nextFeatureTri(value) {
      if (value === undefined || value === null) return true
      return value === true ? false : undefined
    }

    /** 三态 → 按钮上的人话。 */
    function featureTriText(value) {
      if (value === undefined || value === null) return '跟随全局'
      return value ? '开' : '关'
    }

    /**
     * 把「一条覆盖都没剩」的 `features.peers[peerKey]` 清掉。
     *
     * 为什么每次保存前都要扫一遍：`features.peers` 是深合并写进去的，
     * 只要有人点过三态按钮又点回「跟随全局」，配置里就会留下 `{}`、`null` 这种空壳。
     * 攒上十几个之后，主人打开 config.json 根本看不出「这个群到底配了什么」。
     * 返回新对象（不改入参），调用方照旧走 postConfig。
     */
    function pruneFeaturePeers(config) {
      if (!config || typeof config !== 'object') return config
      const features = config.features
      if (!features || typeof features !== 'object') return config
      const peers = features.peers
      if (!peers || typeof peers !== 'object' || Array.isArray(peers)) return config
      let changed = false
      const nextPeers = {}
      for (const [peerId, own] of Object.entries(peers)) {
        // ⚠️ `null` 必须**保留**：它是「删除这一项」的信号，
        //    后端 ConfigStore.patch 靠它把磁盘上那条旧覆盖真删掉。
        //    清掉它等于把删除指令扔了 —— 面板显示「跟随全局」，磁盘上却还留着旧值。
        if (own === null) {
          nextPeers[peerId] = null
          continue
        }
        const plain = own && typeof own === 'object' && !Array.isArray(own)
        if (!plain || Object.keys(own).length === 0) {
          changed = true
          continue
        }
        nextPeers[peerId] = own
      }
      if (!changed) return config
      return { ...config, features: { ...features, peers: nextPeers } }
    }

    // ──────────────────────────── 图标 ────────────────────────────

    /**
     * 猫耳气泡：圆角气泡 + 两只耳朵 + 两个眼睛。
     * 内联 SVG（不引外链、不用图片），颜色一律 currentColor，跟着宿主的图标色走。
     */
    function ChachaIcon(props) {
      const size = Number(props?.size) || 18
      const active = Boolean(props?.active)
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      }, [
        h('path', { key: 'ear-l', d: 'M6.2 7.2 5 3.4l3.6 2.1' }),
        h('path', { key: 'ear-r', d: 'M17.8 7.2 19 3.4l-3.6 2.1' }),
        h('path', {
          key: 'bubble',
          d: 'M4.2 9.1A3.6 3.6 0 0 1 7.8 5.5h8.4a3.6 3.6 0 0 1 3.6 3.6v5.2a3.6 3.6 0 0 1-3.6 3.6h-4.3L7 21.4v-3.5a3.6 3.6 0 0 1-2.8-3.5Z',
          fill: 'currentColor',
          opacity: active ? 0.16 : 0,
        }),
        h('circle', { key: 'eye-l', cx: 10, cy: 11.6, r: 0.85, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'eye-r', cx: 14, cy: 11.6, r: 0.85, fill: 'currentColor', stroke: 'none' }),
      ])
    }

    // ──────────────────────────── 基础控件 ────────────────────────────
    //
    // 为什么这些都要自己写一遍：
    //  - primitives 只保证部分导出，取不到就白屏是最蠢的故障；
    //  - primitives 的 Switch **不渲染 label**（实测传了 label 也只出一个滑块），
    //    所以文字必须自己画（LabeledSwitch）。

    /** 兜底按钮。 */
    function fallbackButton(props) {
      const { children, onClick, disabled, title } = props || {}
      return h('button', {
        type: 'button',
        className: 'cq-iconbtn',
        onClick,
        disabled,
        title,
      }, children)
    }

    /** 兜底开关（原生 checkbox）。 */
    function fallbackSwitch(props) {
      const { checked, onChange, disabled } = props || {}
      return h('input', {
        type: 'checkbox',
        checked: Boolean(checked),
        disabled,
        style: { width: 15, height: 15, cursor: disabled ? 'default' : 'pointer' },
        onChange: (event) => onChange?.(event.target.checked),
      })
    }

    /** 兜底输入框。 */
    function fallbackInput(props) {
      const { value, placeholder, onChange, disabled, type } = props || {}
      return h('input', {
        type: type || 'text',
        className: 'cq-input',
        value: value ?? '',
        placeholder,
        disabled,
        onChange: (event) => onChange?.(event.target.value),
      })
    }

    /**
     * 带文字的开关 —— 文字我们自己画。
     * 宿主 Switch 的 API 只保证 `checked` + `onChange(boolean)`，别的都别指望。
     */
    function LabeledSwitch(props) {
      const { checked, label, hint, onChange, disabled } = props || {}
      return h('div', { className: 'cq-switch-row' }, [
        h('div', { key: 't', className: 'cq-switch-text' }, [
          h('div', { key: 'l', className: 'cq-switch-label' }, label),
          hint ? h('div', { key: 'h', className: 'cq-switch-hint' }, hint) : null,
        ]),
        h('div', { key: 'c', style: { flexShrink: 0, display: 'flex', alignItems: 'center' } },
          Switch
            ? h(Switch, {
              checked: Boolean(checked),
              disabled: Boolean(disabled),
              onChange: (value) => {
                // 宿主个别版本回传 event 而不是 boolean，两种都接住
                const next = typeof value === 'boolean' ? value : Boolean(value?.target?.checked)
                onChange?.(next)
              },
            })
            : h(fallbackSwitch, { checked, disabled, onChange })),
      ])
    }

    /** 一个「标签 + 控件 + 说明」的字段容器。 */
    function Field(props) {
      const { label, hint, children } = props || {}
      return h('div', { className: 'cq-field' }, [
        label ? h('div', { key: 'l', className: 'cq-field-label' }, label) : null,
        h('div', { key: 'c', style: { minWidth: 0 } }, children),
        hint ? h('div', { key: 'h', className: 'cq-field-hint' }, hint) : null,
      ])
    }

    /**
     * 数字输入框（受控 + 草稿字符串）。
     *
     * 为什么不能直接 `value={value}`：数字框里用户敲「12.」或清空时，Number() 会把它
     * 变成 12 或 0，光标和内容当场被改写，根本没法输入。这里维护一个本地字符串 `text`，
     * 只有外部 value 真的变了（比如点「还原」）才回灌。
     */
    function NumField(props) {
      const { label, hint, value, onChange, min, max, step, suffix, disabled } = props || {}
      const [text, setText] = useState(() => (value === undefined || value === null ? '' : String(value)))
      const valueRef = useRef(value)

      useEffect(() => {
        if (valueRef.current === value) return
        valueRef.current = value
        const current = text.trim() === '' ? null : Number(text)
        if (current !== value) setText(value === undefined || value === null ? '' : String(value))
        // 故意不依赖 text：依赖了就等于每敲一个字重灌一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [value])

      return h(Field, { label: label ? `${label}${suffix ? `（${suffix}）` : ''}` : label, hint }, h('input', {
        type: 'number',
        className: 'cq-input',
        value: text,
        min,
        max,
        step: step ?? 'any',
        disabled,
        inputMode: 'decimal',
        onChange: (event) => {
          const raw = event.target.value
          setText(raw)
          const parsed = raw.trim() === '' ? 0 : Number(raw)
          if (!Number.isFinite(parsed)) return
          valueRef.current = parsed
          onChange?.(parsed)
        },
        onBlur: () => {
          // 失焦时把「12.」这种半成品规整掉，避免草稿里躺一个怪值
          const parsed = text.trim() === '' ? 0 : Number(text)
          if (!Number.isFinite(parsed)) {
            setText(value === undefined || value === null ? '' : String(value))
            return
          }
          if (String(parsed) !== text) setText(String(parsed))
        },
      }))
    }

    /** 毫秒字段：界面上显示秒（人看得懂），草稿里存毫秒（后端要的）。 */
    function SecField(props) {
      const { label, hint, ms, onMs, min, max, step, disabled } = props || {}
      return h(NumField, {
        label,
        hint,
        suffix: '秒',
        value: msToSec(ms),
        min,
        max,
        step: step ?? 0.5,
        disabled,
        onChange: (seconds) => onMs?.(secToMs(seconds)),
      })
    }

    /** 下拉。 */
    function SelectField(props) {
      const { label, hint, value, options, onChange, disabled } = props || {}
      return h(Field, { label, hint }, h('select', {
        className: 'cq-select',
        value: value ?? '',
        disabled,
        onChange: (event) => onChange?.(event.target.value),
      }, (options ?? []).map((option) => h('option', {
        key: String(option.value),
        value: String(option.value),
      }, option.label))))
    }

    /**
     * 思考强度下拉：**只有** 空 / off / low / high / max 五档，不许自由文本。
     *
     * 为什么不用 TextField：这是枚举。自由输入下写错一个字母（`loww`）等于什么都没配，
     * 而主人根本没法从界面上看出来 —— 下拉从结构上就不可能写错。
     * 现在选中的那一档，右边同步显示它的代价（EFFORT_DESC），省得主人为了看一眼说明去点开下拉。
     */
    function EffortField(props) {
      const { label, hint, value, onChange, disabled } = props || {}
      const raw = String(value ?? '')
      const known = EFFORT_VALUES.includes(raw)
      const options = EFFORT_VALUES.map((optionValue) => h('option', {
        key: optionValue || 'default',
        value: optionValue,
      }, optionValue
        ? `${optionValue} —— ${EFFORT_LABEL[optionValue]}（${EFFORT_DESC[optionValue]}）`
        : `跟随 DSH 默认（${EFFORT_DESC['']}）`))
      // 手改 config.json 塞进来的非法值：**照实**在下拉里多摆一项。
      // 为什么不「显示成跟随默认」：那样下拉的 value 就是 ''，而主人再选一次「跟随默认」
      // 不会触发 change（选中的项没变），脏值永远清不掉、保存永远被拦 —— 死循环。
      if (!known) {
        options.push(h('option', { key: `bad-${raw}`, value: raw },
          `「${raw}」不是合法档位（请重选）`))
      }
      return h(Field, { label, hint }, h('div', { className: 'cq-effort-row' }, [
        h('select', {
          key: 's',
          className: 'cq-select',
          value: raw,
          disabled,
          'data-role': 'mind-effort',
          title: '只有 off / low / high / max 四档；留空 = 跟随 DSH 默认',
          onChange: (event) => onChange?.(event.target.value),
        }, options),
        h('span', {
          key: 'd',
          className: 'cq-effort-desc',
          'data-effort': raw,
          'data-bad': known ? null : 'true',
        }, known ? EFFORT_DESC[raw] : `配置里的「${raw}」不是合法档位，请重选一档`),
      ]))
    }

    /** 0~1 滑块（兴趣 / 概率都用它）。 */
    function SliderField(props) {
      const { label, hint, value, onChange, min, max, step, format, disabled } = props || {}
      const safe = Number.isFinite(Number(value)) ? Number(value) : 0
      const low = min ?? 0
      const high = max ?? 1
      return h(Field, { label, hint }, h('div', { className: 'cq-range-row' }, [
        h('input', {
          key: 'r',
          type: 'range',
          className: 'cq-range',
          min: low,
          max: high,
          step: step ?? 0.05,
          value: safe,
          disabled,
          onChange: (event) => onChange?.(Number(event.target.value)),
        }),
        h('span', { key: 'v', className: 'cq-range-v' },
          format ? format(safe) : safe.toFixed(2)),
      ]))
    }

    /** 纯文本输入。 */
    function TextField(props) {
      const { label, hint, value, onChange, placeholder, disabled, mono } = props || {}
      return h(Field, { label, hint }, h('input', {
        type: 'text',
        className: mono ? 'cq-input cq-mono' : 'cq-input',
        value: value ?? '',
        placeholder,
        disabled,
        onChange: (event) => onChange?.(event.target.value),
      }))
    }

    /** 多行文本（列表型配置一律用草稿字符串，保存时才解析）。 */
    function TextAreaField(props) {
      const { label, hint, value, onChange, rows, placeholder, disabled } = props || {}
      return h(Field, { label, hint }, h('textarea', {
        className: 'cq-textarea',
        rows: rows ?? 4,
        value: value ?? '',
        placeholder,
        disabled,
        onChange: (event) => onChange?.(event.target.value),
      }))
    }

    /**
     * 可折叠分组。
     * 折叠状态**由父组件持有**（这样「全部展开/收起」和默认展开哪些组都好办，
     * 也不会有十几个 Section 各自 useState 导致重挂载时状态错位）。
     */
    function Section(props) {
      const { title, badge, hint, open, onToggle, children } = props || {}
      return h('section', { className: 'cq-sec', 'data-open': open ? 'true' : 'false' }, [
        h('button', {
          key: 'head',
          type: 'button',
          className: 'cq-sec-head',
          onClick: onToggle,
          title: open ? '收起' : '展开',
        }, [
          h('span', { key: 'c', className: 'cq-sec-caret' }, open ? '▾' : '▸'),
          h('span', { key: 't', className: 'cq-sec-title' }, title),
          badge !== undefined && badge !== null ? h('span', { key: 'b', className: 'cq-sec-badge' }, String(badge)) : null,
          hint ? h('span', { key: 'h', className: 'cq-sec-hint' }, hint) : null,
        ]),
        open ? h('div', { key: 'body', className: 'cq-sec-body' }, children) : null,
      ])
    }

    /** 小按钮（行内动作：清除 / 重置 / 刷新）。 */
    function SmallBtn(props) {
      const { children, onClick, disabled, title } = props || {}
      return h('button', {
        type: 'button',
        className: 'cq-iconbtn',
        onClick,
        disabled,
        title,
      }, children)
    }

    /** 一行只读键值。 */
    function KV(props) {
      const { k, v } = props || {}
      return h('div', { className: 'cq-kv' }, [
        h('span', { key: 'k', className: 'cq-kv-k' }, k),
        h('span', { key: 'v', className: 'cq-kv-v', title: String(v ?? '') }, v),
      ])
    }

    // ──────────────────────────── 区块①：顶部状态条 ────────────────────────────
    //
    // 一行说清四件事：连没连上、用的什么脑子、全局什么模式、改动存没存。
    // 请求失败时整条变灰（data-stale），而**不是**弹窗或清空 —— 旧数据还有用。

    function TopBar(props) {
      const {
        state, online, draft, saveState, onSave, onRefresh, refreshing,
        drawerOpen, onToggleDrawer, onSetDefaultMode, onTestConnect, onRestart,
        busy, actionHint, stats,
      } = props || {}

      const conn = state?.conn
      const connected = Boolean(conn?.connected)
      const dotState = !online ? 'error' : connected ? 'true' : 'false'
      const model = state?.model
      // provider 和 model 都显示（只显示一个的话，主人换 provider 时会看不出来）。
      // 思考强度翻成人话（EFFORT_LABEL）；空 = 不显示，别在状态条上挂个孤零零的分隔点。
      // 第一轮还没跑过时 state.model 是空的：显示「跟随默认」——「未知模型」会让主人以为坏了。
      const modelParts = model
        ? [model.provider, model.model, effortText(model.effort)].filter(Boolean)
        : []
      const modelText = modelParts.length ? modelParts.join(' · ') : '跟随默认'
      const modelTitle = model
        ? `provider：${model.provider || '（跟随默认）'} / model：${model.model || '（跟随默认）'} / 思考强度：${effortBadge(model.effort)}`
        : '还没跑过第一轮，正在跟随 DSH 默认模型'

      const modeValue = draft?.modes?.default ?? state?.modes?.default ?? 'companion'
      const dirty = Boolean(saveState?.dirty)
      const saving = Boolean(saveState?.saving)
      const hint = saveState?.hint ?? ''
      const saveWord = saving ? '保存中…' : dirty ? '未保存' : (hint || '已保存')
      const saveStateAttr = saving ? 'saving' : dirty ? 'dirty' : 'saved'

      return h('div', { className: 'cq-top', 'data-stale': online ? 'false' : 'true' }, [
        h('div', { key: 'left', className: 'cq-top-left' }, [
          h('div', { key: 'dot', className: 'cq-dot', 'data-on': dotState }),
          h('div', { key: 'txt', style: { display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 } }, [
            h('div', { key: 't', className: 'cq-title' }, '茶茶酱的 QQ'),
            h('div', { key: 's', className: 'cq-sub' },
              !online
                ? '请求失败 · 显示的是旧数据'
                : connected
                  ? `${conn?.selfId || '已连接'} · 在线 ${durationText(conn?.uptimeMs)}`
                  : '未连接 NapCat'),
          ]),
        ]),

        h('div', { key: 's1', className: 'cq-sep' }),

        h('div', { key: 'model', className: 'cq-chip', title: modelTitle }, [
          h('span', { key: 'k' }, '模型'),
          h('span', { key: 'v', className: 'cq-chip-v' }, modelText),
        ]),

        h('div', { key: 's2', className: 'cq-sep' }),

        h('div', { key: 'mode', className: 'cq-sel-wrap' }, [
          h('span', { key: 'k', className: 'cq-sub' }, '模式'),
          h('select', {
            key: 'sel',
            className: 'cq-select cq-select-sm',
            value: modeValue,
            disabled: !draft,
            title: draft ? '改完记得点右边的保存（或抽屉里的「保存」）' : '配置还没加载到',
            onChange: (event) => onSetDefaultMode?.(event.target.value),
          }, [
            h('option', { key: 'c', value: 'companion' }, '陪伴 companion'),
            h('option', { key: 'w', value: 'work' }, '干活 work'),
          ]),
        ]),

        stats && stats.pending > 0
          ? h('span', { key: 'pending', className: 'cq-badge', title: '待处理的好友/加群请求' }, `待处理 ${stats.pending}`)
          : null,
        state && state.mind && state.mind.available === false
          ? h('span', { key: 'mind', className: 'cq-badge', 'data-bad': 'true', title: 'ctx.agents 不可用，她只会记录不会回复' }, 'Mind 离线')
          : null,

        h('div', { key: 'sp', className: 'cq-spacer' }),

        actionHint
          ? h('span', {
            key: 'act',
            className: 'cq-hint',
            'data-bad': String(actionHint).startsWith('✗') ? 'true' : null,
            'data-ok': String(actionHint).startsWith('✓') ? 'true' : null,
            title: String(actionHint),
          }, String(actionHint))
          : null,

        h('button', {
          key: 'save',
          type: 'button',
          className: 'cq-savebtn',
          'data-state': saveStateAttr,
          disabled: !dirty || saving || !draft,
          title: dirty ? '点这里保存到 config.json' : '没有未保存的修改',
          onClick: onSave,
        }, [
          h('span', { key: 'd', className: 'cq-savebtn-dot' }),
          h('span', { key: 't' }, saveWord),
        ]),

        h(SmallBtn, {
          key: 'probe',
          title: '探一次 NapCat（POST /chacha-qq/action test-connect）',
          disabled: Boolean(busy),
          onClick: onTestConnect,
        }, busy === 'test-connect' ? '探活…' : '探活'),
        h(SmallBtn, {
          key: 'restart',
          title: '杀→起→等端口→连（会短暂掉线）',
          disabled: Boolean(busy),
          onClick: onRestart,
        }, busy === 'hard-restart' ? '重启中…' : '重启'),

        h(SmallBtn, {
          key: 'refresh',
          title: '立刻刷新状态 / 会话 / 消息 / 配置',
          disabled: Boolean(refreshing),
          onClick: onRefresh,
        }, refreshing ? '刷新中…' : '刷新'),

        h(SmallBtn, {
          key: 'drawer',
          title: drawerOpen ? '收起配置抽屉' : '展开配置抽屉',
          onClick: onToggleDrawer,
        }, drawerOpen ? '配置 ▸' : '配置 ◂'),
      ])
    }

    // ──────────────────────────── 区块②：会话列表 ────────────────────────────

    function ConversationList(props) {
      const {
        conversations, selected, onSelect, query, onQuery,
        source, modeOf, onRefresh,
      } = props || {}

      const list = Array.isArray(conversations) ? conversations : []
      const keyword = String(query ?? '').trim().toLowerCase()
      const filtered = keyword
        ? list.filter((item) => [
          item.name, item.peerId, item.peerKey, item.lastText,
        ].some((field) => String(field ?? '').toLowerCase().includes(keyword)))
        : list

      const searchProps = {
        value: query ?? '',
        placeholder: '搜名字 / 号 / 内容',
        onChange: (event) => onQuery?.(event?.target ? event.target.value : String(event ?? '')),
        className: 'cq-input cq-search',
      }

      return h('div', { className: 'cq-side' }, [
        h('div', { key: 'head', className: 'cq-side-head' }, [
          Input
            ? h(Input, { key: 'search', ...searchProps })
            : h(fallbackInput, { key: 'search', ...searchProps }),
        ]),
        h('div', { key: 'list', className: 'cq-side-list' }, [
          h('div', {
            key: '__all__',
            className: 'cq-conv',
            'data-active': selected === '' ? 'true' : 'false',
            role: 'button',
            tabIndex: 0,
            title: '不带 peerKey 拉消息 —— 所有会话混在一起，调试用',
            onClick: () => onSelect?.(''),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect?.('')
            },
          }, [
            h('div', { key: 'r1', style: { display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 } }, [
              h('span', { key: 'n', className: 'cq-conv-name' }, '全部会话（混合）'),
            ]),
            h('div', { key: 'last', className: 'cq-conv-last' }, '调试视图：不按会话过滤'),
          ]),

          filtered.length === 0
            ? h('div', { key: 'none', className: 'cq-empty', style: { padding: '18px 8px' } },
              keyword ? '没有匹配的会话' : '还没有会话。有人在 QQ 里说话就会出现在这里。')
            : filtered.map((item) => {
              const active = selected === item.peerKey
              const mode = item.mode || modeOf?.(item.peerKey) || ''
              return h('div', {
                key: item.peerKey,
                className: 'cq-conv',
                'data-active': active ? 'true' : 'false',
                role: 'button',
                tabIndex: 0,
                title: `${item.peerKey}${item.session?.events ? ` · 上下文 ${item.session.events} 条` : ''}`,
                onClick: () => onSelect?.(item.peerKey),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelect?.(item.peerKey)
                },
              }, [
                h('div', { key: 'r1', style: { display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 } }, [
                  h('span', { key: 'n', className: 'cq-conv-name' }, clip(item.name || item.peerKey, 26)),
                  h('span', { key: 't', className: 'cq-conv-time' }, agoText(item.lastAt)),
                ]),
                h('div', { key: 'last', className: 'cq-conv-last' },
                  item.lastText ? clip(item.lastText.replace(/\s+/g, ' '), 60) : '（还没说过话）'),
                h('div', { key: 'foot', className: 'cq-conv-foot' }, [
                  h('span', { key: 'scene', className: 'cq-badge' }, item.scene === 'group' ? '群' : '私聊'),
                  mode
                    ? h('span', { key: 'mode', className: 'cq-badge', 'data-mode': mode }, MODE_LABEL[mode] || mode)
                    : null,
                  item.role === 'owner'
                    ? h('span', { key: 'role', className: 'cq-badge', 'data-ok': 'true' }, '主人')
                    : null,
                  item.relation
                    ? h('span', {
                      key: 'rel',
                      className: 'cq-badge',
                      title: `关系分 ${item.relation.score}`,
                    }, item.relation.label || item.relation.phase || '关系')
                    : null,
                  !item.relation && item.session?.events
                    ? h('span', { key: 'ev', className: 'cq-badge' }, `上下文 ${item.session.events}`)
                    : null,
                ]),
              ])
            }),
        ]),
        h('div', { key: 'foot', className: 'cq-side-foot' }, [
          h('span', { key: 'n' }, [h('b', { key: 'b' }, String(list.length)), ' 个会话']),
          h('span', { key: 'src' }, source === 'derived' ? '· 由 state 推导' : ''),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h(SmallBtn, { key: 'r', title: '刷新会话列表', onClick: onRefresh }, '↻'),
        ]),
      ])
    }

    // ──────────────────────────── 区块③：对话区 ────────────────────────────

    /** 一条 in / out 消息。out 显示分片信息（宿主把每一片都记一条）。 */
    function ChatMessage(props) {
      const { item, conversation } = props || {}
      if (!item) return null
      const out = item.dir === 'out'
      const chunkLabel = item.chunks > 0
        ? (item.chunk > 0 ? `第 ${item.chunk}/${item.chunks} 片` : `共 ${item.chunks} 片`)
        : ''
      const who = item.name || (out ? '茶茶酱' : conversation?.name || '对方')
      return h('div', { className: 'cq-row', 'data-dir': out ? 'out' : 'in' }, [
        h('div', { key: 'meta', className: 'cq-meta' }, [
          h('span', { key: 'n' }, clip(who, 20)),
          h('span', { key: 't' }, timeText(item.at)),
        ]),
        h('div', { key: 'b', className: 'cq-bubble' }, item.text || '（空消息）'),
        chunkLabel ? h('div', { key: 'c', className: 'cq-chunk' }, chunkLabel) : null,
      ])
    }

    /**
     * 一条运行轨迹：思考 / 工具 / 工具结果 / 计划 / token。
     *
     * 参照 DSH 自己的展示方式：过程不塞进聊天气泡，用左侧竖线区分，默认折叠长内容
     * （思考很长、工具参数一大坨），点标题展开。这里**只用一个 return**，
     * 因为按 kind 提前 return 会让 hooks 数量随 kind 变化（换一条轨迹就炸）。
     */
    function TraceRow(props) {
      const { item } = props || {}
      const [open, setOpen] = useState(false)
      const kind = String(item?.kind ?? '')
      const time = timeText(item?.at)
      const body = []
      let name = item?.name || kind || '轨迹'
      let summary = ''
      let bad = false

      if (kind === 'reasoning') {
        name = '💭 思考'
        const text = String(item?.text ?? '')
        summary = `${text.length} 字`
        body.push(h('div', {
          key: 'txt',
          className: 'cq-trace-body',
          'data-italic': 'true',
        }, open ? text : clip(text, 120)))
      } else if (kind === 'tool' || kind === 'tool-result') {
        // 契约里工具名在 `name`；只有宿主把名字塞进 args 时才退回 args.name
        const toolName = String(item?.name || item?.args?.name || '工具').replace(/^调用\s*/, '')
        name = `🔧 ${toolName}`
        bad = Boolean(item?.error)
        const resultText = String(item?.result ?? '') || (kind === 'tool-result' ? String(item?.text ?? '') : '')
        summary = bad ? '失败' : resultText ? '完成' : '调用中'
        if (open && item?.args && typeof item.args === 'object') {
          body.push(h('pre', { key: 'args', className: 'cq-trace-pre' },
            clip(JSON.stringify(item.args, null, 2), 1600)))
        }
        if (open && resultText) {
          body.push(h('pre', {
            key: 'res',
            className: 'cq-trace-pre',
            'data-error': bad ? 'true' : 'false',
          }, clip(resultText, 2400)))
        }
        if (open && !resultText && !bad) {
          body.push(h('div', { key: 'wait', className: 'cq-trace-body' }, '还在跑…'))
        }
      } else if (kind === 'plan') {
        name = '📋 计划'
        const plan = Array.isArray(item?.plan) ? item.plan : []
        const done = plan.filter((todo) => todo?.status === 'completed').length
        summary = plan.length ? `${done}/${plan.length} 完成` : '空计划'
        if (open) {
          body.push(h('div', { key: 'plan', className: 'cq-plan' }, plan.map((todo, index) => {
            const status = String(todo?.status ?? 'pending')
            const glyph = status === 'completed' ? '✔' : status === 'in_progress' ? '◐' : '○'
            return h('div', {
              key: `p${index}`,
              className: 'cq-plan-item',
              'data-status': status,
            }, [
              h('span', { key: 'i', className: 'cq-plan-icon' }, glyph),
              h('span', { key: 't', style: { minWidth: 0 } }, String(todo?.content ?? '')),
            ])
          })))
        } else if (plan.length) {
          const current = plan.find((todo) => todo?.status === 'in_progress') || plan.find((todo) => todo?.status !== 'completed')
          if (current) body.push(h('div', { key: 'cur', className: 'cq-trace-body' }, clip(String(current.content ?? ''), 100)))
        }
      } else if (kind === 'usage') {
        name = '📊 token'
        const tokens = item?.tokens && typeof item.tokens === 'object' ? item.tokens : null
        const input = num(tokens?.input, 0)
        const output = num(tokens?.output, 0)
        const total = num(tokens?.total, input + output)
        summary = `in ${fmtTokens(input)} · out ${fmtTokens(output)}`
        // 摘要已经写在标题里了，明细只在展开时出现（否则那个 ▸ 就变成摆设）
        if (open) {
          body.push(h('div', { key: 'u', className: 'cq-usage' }, [
            h('span', { key: 'i' }, ['输入 ', h('b', { key: 'b' }, fmtTokens(input))]),
            h('span', { key: 'o' }, ['输出 ', h('b', { key: 'b' }, fmtTokens(output))]),
            h('span', { key: 't' }, ['合计 ', h('b', { key: 'b' }, fmtTokens(total))]),
          ]))
        }
      } else {
        const text = String(item?.text ?? '')
        summary = text ? `${text.length} 字` : '空'
        body.push(h('div', { key: 'txt', className: 'cq-trace-body' }, open ? text : clip(text, 120)))
      }

      return h('div', {
        className: 'cq-trace',
        'data-kind': kind || 'other',
        'data-error': bad ? 'true' : 'false',
      }, [
        h('div', {
          key: 'head',
          className: 'cq-trace-head',
          onClick: () => setOpen((value) => !value),
          role: 'button',
          tabIndex: 0,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') setOpen((value) => !value)
          },
        }, [
          h('span', { key: 'c', className: 'cq-trace-caret' }, open ? '▾' : '▸'),
          h('span', { key: 'n', className: 'cq-trace-name' }, name),
          h('span', { key: 's', className: 'cq-trace-hint', 'data-bad': bad ? 'true' : null }, summary),
          h('span', { key: 't', className: 'cq-trace-time' }, time),
        ]),
        body.length ? h('div', { key: 'body' }, body) : null,
      ])
    }

    /** 输入框：给自己发测试消息（省得拿真号去试）。 */
    function Composer(props) {
      const { onSend, sending, hint, disabled } = props || {}
      const [text, setText] = useState('')

      const submit = async () => {
        const value = text.trim()
        if (!value || sending || disabled) return
        const ok = await onSend?.(value)
        if (ok) setText('')
      }

      const bad = String(hint ?? '').startsWith('✗') || String(hint ?? '').includes('失败')

      return h('div', { className: 'cq-composer' }, [
        h('div', { key: 'row', className: 'cq-composer-row' }, [
          h('textarea', {
            key: 'input',
            className: 'cq-textarea cq-composer-input',
            rows: 2,
            value: text,
            disabled,
            placeholder: disabled ? '先在左边选一个会话' : '给自己发一条测试消息（走 action: send-test）',
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            },
          }),
          h('button', {
            key: 'send',
            type: 'button',
            className: 'cq-iconbtn',
            disabled: disabled || sending || !text.trim(),
            onClick: () => void submit(),
          }, sending ? '发送中…' : '发送'),
        ]),
        h('div', { key: 'foot', className: 'cq-composer-foot' }, [
          h('span', {
            key: 'hint',
            className: 'cq-hint',
            'data-bad': bad ? 'true' : null,
            'data-ok': hint && !bad ? 'true' : null,
            title: String(hint ?? ''),
          }, hint || '回车发送 · Shift+回车换行'),
        ]),
      ])
    }

    function ChatArea(props) {
      const {
        conversation, mixed, messages, loading, source,
        onResetSession, onSendTest, sending, sendHint, busy,
      } = props || {}

      const streamRef = useRef(null)
      const stickRef = useRef(true)
      const count = Array.isArray(messages) ? messages.length : 0
      const peerKey = conversation?.peerKey ?? ''

      // 切会话：强制回到底部（否则会停在上一个会话的滚动位置，看起来像「没消息」）
      useEffect(() => {
        stickRef.current = true
        const node = streamRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [peerKey])

      // 新消息：只有贴着底部时才自动跟随（主人在翻旧记录时别抢滚动条）
      useEffect(() => {
        const node = streamRef.current
        if (node && stickRef.current) node.scrollTop = node.scrollHeight
      }, [count])

      const title = conversation
        ? conversation.name || conversation.peerKey
        : mixed
          ? '全部会话（混合流）'
          : '未选择会话'

      const headBadges = []
      if (conversation) {
        headBadges.push(h('span', { key: 'scene', className: 'cq-badge' },
          conversation.scene === 'group' ? '群聊' : '私聊'))
        headBadges.push(h('span', { key: 'peer', className: 'cq-badge cq-mono' }, conversation.peerKey))
        if (conversation.role) {
          headBadges.push(h('span', {
            key: 'role',
            className: 'cq-badge',
            'data-ok': conversation.role === 'owner' ? 'true' : null,
          }, conversation.role === 'owner' ? '主人' : '客人'))
        }
        if (conversation.relation) {
          headBadges.push(h('span', { key: 'rel', className: 'cq-badge' },
            `${conversation.relation.label || conversation.relation.phase || '关系'} ${conversation.relation.score}`))
        }
        if (conversation.session?.events) {
          const pressure = Number(conversation.session.pressure)
          headBadges.push(h('span', {
            key: 'ev',
            className: 'cq-badge',
            'data-bad': Number.isFinite(pressure) && pressure > 0.8 ? 'true' : null,
          }, `上下文 ${conversation.session.events}${Number.isFinite(pressure) ? ` · ${Math.round(pressure * 100)}%` : ''}`))
        }
        if (conversation.counts && (conversation.counts.in || conversation.counts.out)) {
          headBadges.push(h('span', { key: 'cnt', className: 'cq-badge' },
            `收 ${conversation.counts.in} / 发 ${conversation.counts.out}`))
        }
      }

      const body = count === 0
        ? h('div', { key: 'empty', className: 'cq-empty' }, loading
          ? [h('div', { key: 'a' }, '加载中…')]
          : [
            h('div', { key: 'a' }, [h('b', { key: 'b' }, '这里还没有消息')]),
            h('div', { key: 'b' }, conversation
              ? '在 QQ 里给茶茶酱发一句，2 秒内就会出现在这里'
              : '先在左边选一个会话；或者点「全部会话」看混合流'),
          ])
        : h('div', { key: 'list', style: { display: 'contents' } }, messages.map((item, index) => {
          const key = `${item.peerKey || ''}-${item.at}-${index}`
          if (item.dir === 'internal') return h(TraceRow, { key: `t-${key}`, item })
          return h(ChatMessage, { key: `m-${key}`, item, conversation })
        }))

      return h('div', { className: 'cq-chat' }, [
        h('div', { key: 'head', className: 'cq-chat-head' }, [
          h('div', { key: 'l', style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } }, [
            h('div', { key: 't', className: 'cq-chat-title', title }, title),
            h('div', { key: 'm', className: 'cq-chat-meta' }, headBadges),
          ]),
          h('div', { key: 'sp', style: { flex: 1 } }),
          source === 'state' && count > 0
            ? h('span', {
              key: 'src',
              className: 'cq-badge',
              title: '/chacha-qq/messages 还没就绪，这里显示的是 /state 里的 recent',
            }, '由 state 推导')
            : null,
          conversation
            ? h(SmallBtn, {
              key: 'reset',
              title: '换代次：清空上下文，保留记忆（action: reset-session）',
              disabled: Boolean(busy),
              onClick: () => onResetSession?.(conversation),
            }, busy === 'reset-session' ? '重置中…' : '重置上下文')
            : null,
        ]),
        h('div', {
          key: 'stream',
          className: 'cq-stream',
          ref: streamRef,
          onScroll: () => {
            const node = streamRef.current
            if (!node) return
            stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
          },
        }, body),
        h(Composer, {
          key: 'composer',
          disabled: !conversation,
          sending,
          hint: sendHint,
          onSend: onSendTest,
        }),
      ])
    }

    // ──────────────────────────── 区块④：配置抽屉 ────────────────────────────

    const PHASE_OPTIONS = [
      { value: 'distant', label: '疏离 distant' },
      { value: 'acquaintance', label: '认识 acquaintance' },
      { value: 'familiar', label: '熟悉 familiar' },
      { value: 'close', label: '亲近 close' },
      { value: 'intimate', label: '亲密 intimate' },
      { value: 'deeply_bonded', label: '深联结 deeply_bonded' },
    ]

    /**
     * 「当前对话覆盖」：只写三张表 + 一张前瞻表 + 功能开关。
     *  - 模式   → modes.peers[peerKey]
     *  - 兴趣   → interest.users[QQ] / interest.groups[群号]
     *  - 盗图   → meme.steal.peers[peerKey]
     *  - 观望   → observe.peers[peerKey].{minMs,maxMs}
     *  - 功能   → features.peers[peerKey][功能]（三态，见下面的说明）
     *
     * ⚠️ observe.peers 在 DEFAULT_CONFIG 里**还没有**（宿主 observe.js 目前只读全局值）。
     *    这里先让主人能写，值会落进 config.json；等宿主读它才真正生效。
     *    抽屉里明确标了「宿主待支持」，不骗人。
     */
    function PeerOverrideCard(props) {
      const { conversation, draft, disabled, setField, unsetField, setFeaturePeer } = props || {}

      if (!conversation) {
        return h('div', { className: 'cq-notice' },
          '先在左边选一个会话，这里会显示它自己的覆盖项。')
      }

      const peerKey = conversation.peerKey
      const peerId = conversation.peerId || conversation.peerKey
      // 功能开关的键和 pipeline 的 sessionKey 同构：群聊一律 `group-<群号>`。
      // 会话里万一带了 `-owner` / `-guest` 后缀，也要先归一，否则开关只对一种身份生效。
      const featurePeerKey = normalizePeerKeyLocal(peerKey) || String(peerKey ?? '')
      const mode = getPath(draft, ['modes', 'peers', peerKey], '')
      const modeOn = mode === 'companion' || mode === 'work'

      const interestPath = conversation.scene === 'group'
        ? ['interest', 'groups', peerId]
        : ['interest', 'users', peerId]
      const interestRaw = getPath(draft, interestPath, undefined)
      const interestSet = interestRaw !== undefined && interestRaw !== null
      const interestValue = interestSet ? clamp01(interestRaw) : clamp01(getPath(draft, 'interest.default', 0.5))

      const stealRaw = getPath(draft, ['meme', 'steal', 'peers', peerKey], undefined)
      const stealSet = stealRaw !== undefined && stealRaw !== null
      const stealValue = stealSet ? clamp01(stealRaw) : clamp01(getPath(draft, 'meme.steal.probability', 0))

      const obsRaw = getPath(draft, ['observe', 'peers', peerKey], undefined)
      const obsSet = obsRaw !== undefined && obsRaw !== null
      const obsMin = obsSet ? getPath(draft, ['observe', 'peers', peerKey, 'minMs'], getPath(draft, 'observe.defaultMinMs', 20000)) : getPath(draft, 'observe.defaultMinMs', 20000)
      const obsMax = obsSet ? getPath(draft, ['observe', 'peers', peerKey, 'maxMs'], getPath(draft, 'observe.defaultMaxMs', 60000)) : getPath(draft, 'observe.defaultMaxMs', 60000)

      return h('div', { className: 'cq-peer-card' }, [
        h('div', { key: 'title', className: 'cq-peer-title' }, [
          h('span', { key: 't' }, '当前对话覆盖'),
          h('span', { key: 'b', className: 'cq-badge', 'data-mode': modeOn ? mode : null }, modeOn ? (MODE_LABEL[mode] || mode) : '跟随全局'),
        ]),
        h('div', { key: 'sub', className: 'cq-peer-sub', title: `${peerKey} · ${conversation.name || ''}` },
          `${peerKey} · ${conversation.name || ''}`),

        h(SelectField, {
          key: 'mode',
          label: '模式',
          value: modeOn ? mode : '',
          disabled,
          options: [
            { value: '', label: '跟随全局默认' },
            { value: 'companion', label: '陪伴 companion' },
            { value: 'work', label: '干活 work' },
          ],
          onChange: (next) => {
            if (!next) unsetField(['modes', 'peers', peerKey])
            else setField(['modes', 'peers', peerKey], next)
          },
        }),

        h(SliderField, {
          key: 'interest',
          label: interestSet ? '兴趣（已覆盖）' : '兴趣（跟随默认，拖动即覆盖）',
          value: interestValue,
          disabled,
          format: (value) => value.toFixed(2),
          onChange: (value) => setField(interestPath, Math.round(value * 100) / 100),
        }),
        interestSet
          ? h('div', { key: 'iclear', style: { marginTop: -2, marginBottom: 2 } },
            h(SmallBtn, { disabled, onClick: () => unsetField(interestPath) }, '跟随默认'))
          : null,

        h(SliderField, {
          key: 'steal',
          label: stealSet ? '盗图概率（已覆盖）' : '盗图概率（跟随默认，拖动即覆盖）',
          value: stealValue,
          disabled,
          format: (value) => value.toFixed(2),
          onChange: (value) => setField(['meme', 'steal', 'peers', peerKey], Math.round(value * 100) / 100),
        }),
        stealSet
          ? h('div', { key: 'sclear', style: { marginTop: -2, marginBottom: 2 } },
            h(SmallBtn, { disabled, onClick: () => unsetField(['meme', 'steal', 'peers', peerKey]) }, '跟随默认'))
          : null,

        h('div', { key: 'obs', className: 'cq-grid2' }, [
          h(SecField, {
            key: 'min',
            label: '观望最短',
            ms: obsMin,
            disabled,
            onChange: (ms) => setField(['observe', 'peers', peerKey, 'minMs'], ms),
          }),
          h(SecField, {
            key: 'max',
            label: '观望最长',
            ms: obsMax,
            disabled,
            onChange: (ms) => setField(['observe', 'peers', peerKey, 'maxMs'], ms),
          }),
        ]),

        // ── 本对话功能开关（features.peers[peerKey]）──────────────
        // 三态：跟随全局（**不写这个键**）/ 开 / 关。
        // 为什么必须是三态而不是开关：默认「跟随全局」意味着「什么都没配」，
        // 二态开关会逼主人先给每个对话显式写一遍 true，等于把全局值抄成本地覆盖。
        h('div', { key: 'feathead', className: 'cq-feathead' }, [
          h('span', { key: 't', className: 'cq-feathead-t' }, '本对话功能开关'),
          h('span', { key: 'h', className: 'cq-feathead-h' }, '点一下切：跟随全局 → 开 → 关'),
        ]),
        h('div', { key: 'featlist', className: 'cq-featlist' }, FEATURES.map((item) => {
          const own = featurePeerValue(draft, peerKey, item.key)
          const state = own === undefined ? 'follow' : own ? 'on' : 'off'
          const globalOff = !featureOnHere(draft, item.key)
          return h('div', {
            key: item.key,
            className: 'cq-featrow',
            'data-role': 'feature-peer-row',
            'data-feature': item.key,
            'data-state': state,
          }, [
            h('span', { key: 'l', className: 'cq-featrow-label', title: item.desc }, item.title),
            // 「跟随全局」而全局已经关了 → 必须说破。否则主人看着这行什么都没标，
            // 会以为这个功能在本对话是开的（实际是关的）。灰字即可，别用红色抢戏。
            state === 'follow' && globalOff
              ? h('span', { key: 'n', className: 'cq-featrow-note' }, '（全局已关）')
              : null,
            h('button', {
              key: 'b',
              type: 'button',
              className: 'cq-tri',
              'data-state': state,
              'data-role': 'feature-tri',
              'data-feature': item.key,
              disabled,
              title: `本对话：${featureTriText(own)}；全局：${globalOff ? '关' : '开'}。点一下切下一个状态（跟随全局 → 开 → 关）。`,
              // 键用归一的 peerKey：写 `group-123-owner` 的话，这个开关只对某一种身份生效
              onClick: () => setFeaturePeer?.(featurePeerKey, item.key, nextFeatureTri(own)),
            }, featureTriText(own)),
          ])
        })),

        h('div', { key: 'obshint', className: 'cq-field-hint' },
          '宿主待支持：observe.js 现在只读全局 observe.*，observe.peers 会先存进 config.json。'),
      ])
    }

    /**
     * 整页配置抽屉。
     *
     * 两条铁律（v2 坑 19、20）：
     *  1. **不用 defaultValue**。首次渲染时 config 还没到，defaultValue 会把框定死成空值；
     *     统一走「草稿 state + 受控组件」，config 到达时由 useEffect 灌一次。
     *  2. 逗号/换行输入框**不能由数组派生**（`value={list.join(',')}` 会把正在输入的逗号当场吃掉），
     *     一律草稿字符串，保存时才 parse。
     */
    function ConfigDrawer(props) {
      const {
        open, onClose, draft, config, configError, dirty, saving, saveHint, formError,
        setField, unsetField, onSave, onReset, onReload,
        texts, setText, conversation, memes, memesError, onReloadMemes,
        logs, onClearLog, busy, defaultOpen, setFeaturePeer,
      } = props || {}

      // 默认只展开「大脑」和「模式」（最常改的两项）。`defaultOpen` 只是初始展开表的覆盖口：
      // 探针用它一次把全部分组都展开来验证每个控件都 render 得出来，
      // 将来要加「全部展开」按钮也是走这个口。
      const [openMap, setOpenMap] = useState(() => ({ mind: true, modes: true, ...(defaultOpen || {}) }))
      const toggle = useCallback((id) => {
        setOpenMap((prev) => ({ ...prev, [id]: !prev[id] }))
      }, [])
      const isOpen = useCallback((id) => Boolean(openMap[id]), [openMap])

      // 只读只在「草稿还没来」时启用。
      // 注意**不能**拿 configError 当只读条件：读取抖一次就把整个抽屉锁死太难用，
      // 端点没就绪时 draft 本来就是 null，天然只读。
      const ro = !draft
      const v = useCallback((path, fallback) => getPath(draft, path, fallback), [draft])

      const peerRows = (() => {
        const peers = v('modes.peers', {})
        if (!peers || typeof peers !== 'object') return []
        return Object.keys(peers).map((key) => h('div', { key, className: 'cq-maprow' }, [
          h('span', { key: 'k', className: 'cq-conv-name', style: { flex: 1 }, title: key }, key),
          h('select', {
            key: 's',
            className: 'cq-select',
            style: { maxWidth: 86 },
            value: peers[key] === 'work' ? 'work' : 'companion',
            disabled: ro,
            onChange: (event) => setField(['modes', 'peers', key], event.target.value),
          }, [
            h('option', { key: 'c', value: 'companion' }, '陪伴'),
            h('option', { key: 'w', value: 'work' }, '干活'),
          ]),
          h(SmallBtn, {
            key: 'x',
            disabled: ro,
            title: '删掉这个覆盖，回到全局默认',
            onClick: () => unsetField(['modes', 'peers', key]),
          }, '✕'),
        ]))
      })()

      const stealRows = (() => {
        const peers = v('meme.steal.peers', {})
        if (!peers || typeof peers !== 'object') return []
        return Object.keys(peers).map((key) => h('div', { key, className: 'cq-maprow' }, [
          h('span', { key: 'k', className: 'cq-conv-name', style: { flex: 1 }, title: key }, key),
          h('span', { key: 'v', className: 'cq-badge' }, clamp01(peers[key]).toFixed(2)),
          h(SmallBtn, {
            key: 'x',
            disabled: ro,
            title: '删掉这个覆盖',
            onClick: () => unsetField(['meme', 'steal', 'peers', key]),
          }, '✕'),
        ]))
      })()

      const tiers = v('relation.decay.tiers', [])
      const tierRows = Array.isArray(tiers)
        ? tiers.map((tier, index) => h(KV, {
          key: `t${index}`,
          k: tier?.untilDay
            ? `第 ${index === 0 ? 1 : (tiers[index - 1]?.untilDay ?? 0) + 1}~${tier.untilDay} 天`
            : '之后每天',
          v: `每天 -${num(tier?.perDay, 0)}`,
        }))
        : []

      const memeRows = Array.isArray(memes) && memes.length > 0
        ? memes.map((item, index) => h(KV, {
          key: String(item?.key ?? item?.name ?? index),
          k: String(item?.name || item?.key || '未命名'),
          v: `${num(item?.count, 0)} 张`,
        }))
        : null

      const logRows = Array.isArray(logs) && logs.length > 0
        ? logs.slice(-40).map((line, index) => h('div', {
          key: `${line?.at ?? 0}-${index}`,
          className: 'cq-logline',
          'data-level': line?.level ?? 'info',
        }, [
          h('span', { key: 't', className: 'cq-log-time' }, timeText(line?.at)),
          h('span', { key: 'g', className: 'cq-log-tag' }, `[${line?.tag || line?.level || 'log'}]`),
          h('span', { key: 'x', className: 'cq-log-text', title: String(line?.text ?? '') }, String(line?.text ?? '')),
        ]))
        : h('div', { key: 'nolog', className: 'cq-field-hint' }, '还没有日志')

      const stateText = saving ? '保存中…' : dirty ? '未保存' : (saveHint || '已保存')
      const stateBad = /失败|✗/.test(String(saveHint || ''))
      const stateOk = !saving && !dirty && !stateBad && /已保存|已还原/.test(String(saveHint || '已保存'))

      return h('aside', { className: 'cq-drawer', 'data-open': open ? 'true' : 'false' }, [
        h('div', { key: 'head', className: 'cq-drawer-head' }, [
          h('span', { key: 't', className: 'cq-drawer-title' }, '配置'),
          h('span', { key: 's', className: 'cq-badge' }, v('modes.default', 'companion')),
          h('div', { key: 'sp', style: { flex: 1 } }),
          h(SmallBtn, { key: 'close', title: '收起配置抽屉', onClick: onClose }, '✕'),
        ]),

        h('div', { key: 'body', className: 'cq-drawer-body' }, [
          h('div', {
            key: 'savebar',
            style: {
              position: 'sticky',
              top: 0,
              zIndex: 3,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 0 8px',
              background: 'var(--cq-layer1)',
              borderBottom: '0.5px solid var(--cq-line)',
            },
          }, [
            h(Button, {
              key: 'save',
              variant: 'primary',
              size: 'sm',
              disabled: !draft || !dirty || saving,
              onClick: onSave,
            }, saving ? '保存中…' : '保存'),
            h(Button, {
              key: 'reset',
              variant: 'outline',
              size: 'sm',
              disabled: !draft || !dirty || saving,
              onClick: onReset,
            }, '还原'),
            h(SmallBtn, { key: 'reload', disabled: Boolean(saving) || Boolean(busy), onClick: onReload }, '重读'),
            h('span', {
              key: 'state',
              className: 'cq-save-state',
              'data-bad': stateBad ? 'true' : null,
              'data-ok': stateOk ? 'true' : null,
              style: { marginLeft: 'auto' },
            }, stateText),
          ]),

          h('div', {
            key: 'notice',
            className: 'cq-notice',
            'data-bad': configError && !draft ? 'true' : null,
          }, configError
            ? (draft
              ? `配置最近一次读取失败（${configError}）——下面显示的是上一次读到的值，保存仍可尝试。`
              : `配置端点不可用（${configError}）——控件暂时只读。宿主补上 GET/POST /chacha-qq/config 后自动恢复。`)
            : !draft
              ? '配置加载中…'
              : '改动先落在草稿里，点「保存」才写进 config.json（POST 深合并，不会顶掉别的段）。'),

          // 校验失败的红条：保存被拦下时唯一能看见原因的地方（顶部按钮在 dirty 时只显示「未保存」）
          formError
            ? h('div', {
              key: 'formerr',
              className: 'cq-notice',
              'data-bad': 'true',
              'data-role': 'mind-error',
            }, `✗ 没保存：${formError}`)
            : null,

          // ── 大脑（新增，摆在最前：主人第一件要改的就是「她用什么脑子」）──
          h(Section, {
            key: 'mind',
            title: '大脑（她用什么模型想事情）',
            badge: effortBadge(v('mind.reasoningEffort', '')),
            open: isOpen('mind'),
            onToggle: () => toggle('mind'),
          }, [
            h('div', { key: 'lead', className: 'cq-field-hint' },
              'provider / model 留空 = 跟随 DSH 默认。这里填了才会换脑子，保存后下一轮生效。'),
            h(TextField, {
              key: 'provider',
              label: 'provider（服务商）',
              value: v('mind.provider', ''),
              placeholder: '留空 = 跟随 DSH 默认（deepseek-account）',
              disabled: ro,
              mono: true,
              onChange: (value) => setField('mind.provider', value),
            }),
            h(TextField, {
              key: 'model',
              label: 'model（模型名）',
              value: v('mind.model', ''),
              placeholder: '留空 = 跟随 DSH 默认（deepseek-flash）',
              disabled: ro,
              mono: true,
              onChange: (value) => setField('mind.model', value),
            }),
            h(EffortField, {
              key: 'effort',
              label: '思考强度 reasoningEffort',
              hint: '只有 off / low / high / max 四档，下拉选，不能手打。留空 = 跟随 DSH 默认；max 又慢又贵，别一直开着。',
              value: v('mind.reasoningEffort', ''),
              disabled: ro,
              onChange: (value) => setField('mind.reasoningEffort', value),
            }),
            h(NumField, {
              key: 'tokens',
              label: '单轮最多多少 token',
              hint: '0 = 不限制（交给内核默认）；负数会被拦下来，不会写进 config.json。',
              value: v('mind.maxTokens', 0),
              min: 0,
              step: 1,
              disabled: ro,
              // 故意不在输入时就夹到 0：主人得看见自己填了负数、以及为什么不让保存，
              // 悄悄改成 0 等于骗人。Math.round 只负责把 1.5 这种半成品收成整数。
              onChange: (value) => setField('mind.maxTokens', Math.round(value)),
            }),
            h(TextAreaField, {
              key: 'persona',
              label: '人格覆盖 personaOverride',
              hint: '留空 = 用内置人格。这段文字会替换她的内置人格（只改「她是谁」，不改工具和流程）。',
              rows: 8,
              value: v('mind.personaOverride', ''),
              placeholder: '留空 = 用内置人格',
              disabled: ro,
              onChange: (value) => setField('mind.personaOverride', value),
            }),
            h('div', { key: 'rest', className: 'cq-field-hint' },
              'mind.* 的其它项（工具白名单、轮次超时、压缩阈值）还得手改 config.json。'),
          ]),

          // ── 功能总开关（第二组）────────────────────────────────
          // 为什么排在「① 模式」之前：它是**一票否决**的那一层 —— 总开关关了，
          // 下面模式配成什么都不跑。把否决权摆在被否决的东西上面，读起来才顺。
          h(Section, {
            key: 'features',
            title: '功能总开关（一票否决，跟模式无关）',
            badge: `${FEATURES.filter((item) => featureOnHere(draft, item.key)).length}/${FEATURES.length} 开`,
            open: isOpen('features'),
            onToggle: () => toggle('features'),
          }, [
            h('div', { key: 'lead', className: 'cq-field-hint' },
              '这 10 个是「功能到底跑不跑」，跟「① 模式」是两个维度：总开关关掉，模式配成什么都不跑。'),
            // 每个开关包一层带 data-role 的 div：探针要能精确定位「总开关」而不是
            // 下面「本对话」那一排三态按钮（两边标题文字是一样的）。
            ...FEATURES.map((item) => h('div', {
              key: item.key,
              'data-role': 'feature-toggle',
              'data-feature': item.key,
              'data-on': featureOnHere(draft, item.key) ? 'true' : 'false',
            }, h(LabeledSwitch, {
              checked: featureOnHere(draft, item.key),
              label: item.title,
              hint: item.desc,
              disabled: ro,
              // 只写 boolean：万一宿主的 Switch 回传字符串 'false'，
              // 落盘的就会是字符串而不是 false —— 后端 `=== false` 判定当场失效。
              onChange: (checked) => setField(`features.${item.key}`, checked === true),
            }))),
            h('div', { key: 'foot', className: 'cq-field-hint' },
              '总开关关掉 = 这个功能彻底停，跟下面的「模式」无关。'),
          ]),

          h(PeerOverrideCard, {
            key: 'peer',
            conversation,
            draft,
            disabled: ro,
            setField,
            unsetField,
            setFeaturePeer,
          }),

          // ── 1/11 模式 ─────────────────────────────────────────
          h(Section, {
            key: 'modes',
            title: '① 模式',
            badge: v('modes.default', 'companion'),
            open: isOpen('modes'),
            onToggle: () => toggle('modes'),
          }, [
            h(SelectField, {
              key: 'def',
              label: '全局默认模式',
              hint: 'companion 全开（日程/情绪/主动/表情包）；work 不生成日程、不主动搭话。',
              value: v('modes.default', 'companion'),
              disabled: ro,
              options: [
                { value: 'companion', label: '陪伴 companion' },
                { value: 'work', label: '干活 work' },
              ],
              onChange: (value) => setField('modes.default', value),
            }),
            h('div', { key: 'peerh', className: 'cq-field-hint' }, '每个会话的覆盖（优先级高于全局）：'),
            peerRows.length ? peerRows : h('div', { key: 'none', className: 'cq-field-hint' }, '还没有单独设置的会话。'),
          ]),

          // ── 2/11 观望 ─────────────────────────────────────────
          h(Section, {
            key: 'observe',
            title: '② 观望',
            badge: `${msToSec(v('observe.defaultMinMs', 20000))}~${msToSec(v('observe.defaultMaxMs', 60000))}s`,
            open: isOpen('observe'),
            onToggle: () => toggle('observe'),
          }, [
            h(LabeledSwitch, {
              key: 'on',
              checked: v('observe.enabled', true) !== false,
              label: '启用观望窗口',
              hint: '关掉 = 每条消息立刻处理，不再攒批',
              disabled: ro,
              onChange: (checked) => setField('observe.enabled', checked),
            }),
            h('div', { key: 'g1', className: 'cq-grid2' }, [
              h(SecField, { key: 'a', label: '默认最短', ms: v('observe.defaultMinMs', 20000), disabled: ro, onChange: (ms) => setField('observe.defaultMinMs', ms) }),
              h(SecField, { key: 'b', label: '默认最长', ms: v('observe.defaultMaxMs', 60000), disabled: ro, onChange: (ms) => setField('observe.defaultMaxMs', ms) }),
            ]),
            h('div', { key: 'g2', className: 'cq-grid2' }, [
              h(SecField, { key: 'a', label: '被 @', ms: v('observe.atMs', 10000), disabled: ro, onChange: (ms) => setField('observe.atMs', ms) }),
              h(SecField, { key: 'b', label: '陌生人私聊', ms: v('observe.guestPrivateMs', 5000), disabled: ro, onChange: (ms) => setField('observe.guestPrivateMs', ms) }),
            ]),
            h('div', { key: 'g3', className: 'cq-grid2' }, [
              h(SecField, { key: 'a', label: '主人私聊', ms: v('observe.ownerPrivateMs', 0), disabled: ro, onChange: (ms) => setField('observe.ownerPrivateMs', ms) }),
              h(SecField, { key: 'b', label: '主人群里没 @', ms: v('observe.ownerGroupMs', 5000), disabled: ro, onChange: (ms) => setField('observe.ownerGroupMs', ms) }),
            ]),
            h('div', { key: 'g4', className: 'cq-grid2' }, [
              h(SecField, { key: 'a', label: '同一坨对话', ms: v('observe.sameThreadMs', 60000), disabled: ro, onChange: (ms) => setField('observe.sameThreadMs', ms) }),
              h(NumField, { key: 'b', label: '一批最多', value: v('observe.maxBatch', 60), min: 1, step: 1, disabled: ro, onChange: (value) => setField('observe.maxBatch', Math.round(value)) }),
            ]),
          ]),

          // ── 3/11 兴趣 ─────────────────────────────────────────
          h(Section, {
            key: 'interest',
            title: '③ 兴趣',
            badge: Number(v('interest.default', 0.5)).toFixed(2),
            open: isOpen('interest'),
            onToggle: () => toggle('interest'),
          }, [
            h(SliderField, {
              key: 'def',
              label: '默认兴趣',
              hint: '被 @ 且兴趣 > 阈值就必回；没被 @ 时概率 = 兴趣 × 0.35',
              value: v('interest.default', 0.5),
              disabled: ro,
              onChange: (value) => setField('interest.default', Math.round(value * 100) / 100),
            }),
            h('div', { key: 'g1', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '@ 必回阈值', value: v('interest.atSureThreshold', 0.1), min: 0, max: 1, step: 0.01, disabled: ro, onChange: (value) => setField('interest.atSureThreshold', value) }),
              h(NumField, { key: 'b', label: '@ 倍率', value: v('interest.atMultiplier', 5), step: 0.5, disabled: ro, onChange: (value) => setField('interest.atMultiplier', value) }),
            ]),
            h(NumField, {
              key: 'unm',
              label: '没被 @ 的系数',
              value: v('interest.unmentionedFactor', 0.35),
              min: 0,
              max: 1,
              step: 0.01,
              disabled: ro,
              onChange: (value) => setField('interest.unmentionedFactor', value),
            }),
            h(TextAreaField, {
              key: 'users',
              label: '按人覆盖（QQ号=0~1，一行一个）',
              rows: 3,
              value: texts?.users ?? '',
              placeholder: '1111111111=0.95',
              disabled: ro,
              onChange: (value) => setText('users', value),
            }),
            h(TextAreaField, {
              key: 'groups',
              label: '按群覆盖（群号=0~1，一行一个）',
              rows: 3,
              value: texts?.groups ?? '',
              placeholder: '1085327714=0.7',
              disabled: ro,
              onChange: (value) => setText('groups', value),
            }),
          ]),

          // ── 4/11 节奏 ─────────────────────────────────────────
          h(Section, {
            key: 'rhythm',
            title: '④ 节奏',
            badge: `${msToSec(v('rhythm.minGapMs', 2000))}~${msToSec(v('rhythm.maxGapMs', 5000))}s`,
            open: isOpen('rhythm'),
            onToggle: () => toggle('rhythm'),
          }, [
            h(LabeledSwitch, {
              key: 'on',
              checked: v('rhythm.enabled', true) !== false,
              label: '按节奏分片发送',
              hint: '关掉 = 一次性发整段',
              disabled: ro,
              onChange: (checked) => setField('rhythm.enabled', checked),
            }),
            h(SliderField, {
              key: 'min',
              label: '两条之间最短',
              value: msToSec(v('rhythm.minGapMs', 2000)),
              min: 0,
              max: 20,
              step: 0.5,
              disabled: ro,
              format: (value) => `${value.toFixed(1)}s`,
              onChange: (value) => setField('rhythm.minGapMs', secToMs(value)),
            }),
            h(SliderField, {
              key: 'max',
              label: '两条之间最长',
              value: msToSec(v('rhythm.maxGapMs', 5000)),
              min: 0,
              max: 30,
              step: 0.5,
              disabled: ro,
              format: (value) => `${value.toFixed(1)}s`,
              onChange: (value) => setField('rhythm.maxGapMs', secToMs(value)),
            }),
            h('div', { key: 'g1', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '每片 token 上限', value: v('rhythm.maxTokensPerPiece', 20), min: 1, step: 1, disabled: ro, onChange: (value) => setField('rhythm.maxTokensPerPiece', Math.round(value)) }),
              h(NumField, { key: 'b', label: '一轮最多几片', value: v('rhythm.maxPiecesPerTurn', 20), min: 1, step: 1, disabled: ro, onChange: (value) => setField('rhythm.maxPiecesPerTurn', Math.round(value)) }),
            ]),
            h(NumField, {
              key: 'chars',
              label: '单条最多多少字',
              value: v('rhythm.maxCharsPerMessage', 2000),
              min: 1,
              step: 1,
              disabled: ro,
              onChange: (value) => setField('rhythm.maxCharsPerMessage', Math.round(value)),
            }),
          ]),

          // ── 5/11 安全 ─────────────────────────────────────────
          h(Section, {
            key: 'security',
            title: '⑤ 安全',
            badge: v('security.penalty', 'mute-and-block'),
            open: isOpen('security'),
            onToggle: () => toggle('security'),
          }, [
            h(LabeledSwitch, {
              key: 'inj',
              checked: v('security.injectionEnabled', true) !== false,
              label: '防提示词注入（输入侧）',
              hint: '主人永不惩罚；引号转述会降权',
              disabled: ro,
              onChange: (checked) => setField('security.injectionEnabled', checked),
            }),
            h(SelectField, {
              key: 'pen',
              label: '命中后的惩罚档',
              value: v('security.penalty', 'mute-and-block'),
              disabled: ro,
              options: [
                { value: 'ignore', label: 'ignore 忽略（不罚）' },
                { value: 'mute-and-block', label: 'mute-and-block 禁言+拉黑' },
                { value: 'ban', label: 'ban 踢出' },
              ],
              onChange: (value) => setField('security.penalty', value),
            }),
            h(SelectField, {
              key: 'susp',
              label: '可疑级是否罚',
              hint: 'null = 不罚（宁可漏判）',
              value: String(v('security.suspiciousPenalty', null)),
              disabled: ro,
              options: [
                { value: 'null', label: '不罚（null）' },
                { value: 'ignore', label: 'ignore' },
                { value: 'mute-and-block', label: 'mute-and-block' },
                { value: 'ban', label: 'ban' },
              ],
              onChange: (value) => setField('security.suspiciousPenalty', value === 'null' ? null : value),
            }),
            h('div', { key: 'g1', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '禁言分钟', value: v('security.penaltyMuteMinutes', 10), min: 0, step: 1, disabled: ro, onChange: (value) => setField('security.penaltyMuteMinutes', Math.round(value)) }),
              h(NumField, { key: 'b', label: '可疑分', value: v('security.suspiciousScore', 2), min: 0, step: 1, disabled: ro, onChange: (value) => setField('security.suspiciousScore', Math.round(value)) }),
            ]),
            h('div', { key: 'g2', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '恶意分', value: v('security.maliciousScore', 4), min: 0, step: 1, disabled: ro, onChange: (value) => setField('security.maliciousScore', Math.round(value)) }),
              h(NumField, { key: 'b', label: '自定义正则权重', value: v('security.customPatternWeight', 3), min: 0, step: 1, disabled: ro, onChange: (value) => setField('security.customPatternWeight', Math.round(value)) }),
            ]),
            h('div', { key: 'g3', className: 'cq-grid2' }, [
              h(SecField, { key: 'a', label: '惩罚冷却', ms: v('security.penaltyCooldownMs', 3600000), disabled: ro, onChange: (ms) => setField('security.penaltyCooldownMs', ms) }),
              h(NumField, { key: 'b', label: '最多扫多少字符', value: v('security.maxScanChars', 20000), min: 0, step: 100, disabled: ro, onChange: (value) => setField('security.maxScanChars', Math.round(value)) }),
            ]),
            h(TextAreaField, {
              key: 'patterns',
              label: '额外的注入特征（一行一个正则）',
              rows: 3,
              value: texts?.patterns ?? '',
              disabled: ro,
              onChange: (value) => setText('patterns', value),
            }),
            h(LabeledSwitch, {
              key: 'out',
              checked: v('security.outputGuard', true) !== false,
              label: '输出侧审核',
              hint: '挡「她自己被带歪了」要说出去的话',
              disabled: ro,
              onChange: (checked) => setField('security.outputGuard', checked),
            }),
            h(SelectField, {
              key: 'rp',
              label: '输出命中后的处置',
              value: v('security.replyPenalty', 'fallback'),
              disabled: ro,
              options: [
                { value: 'fallback', label: 'fallback 换一句兜底话' },
                { value: 'discard', label: 'discard 这条不发' },
              ],
              onChange: (value) => setField('security.replyPenalty', value),
            }),
          ]),

          // ── 6/11 情绪 ─────────────────────────────────────────
          h(Section, {
            key: 'emotion',
            title: '⑥ 情绪',
            badge: v('emotion.tellIt', 'event'),
            open: isOpen('emotion'),
            onToggle: () => toggle('emotion'),
          }, [
            h(LabeledSwitch, {
              key: 'on',
              checked: v('emotion.enabled', true) !== false,
              label: '启用情绪',
              disabled: ro,
              onChange: (checked) => setField('emotion.enabled', checked),
            }),
            h('div', { key: 'g1', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '心情基线', value: v('emotion.baseline', 70), min: 0, max: 100, step: 1, disabled: ro, onChange: (value) => setField('emotion.baseline', Math.round(value)) }),
              h(NumField, { key: 'b', label: '心情半衰期', value: v('emotion.moodHalfLifeHours', 3), min: 0, step: 0.5, suffix: '小时', disabled: ro, onChange: (value) => setField('emotion.moodHalfLifeHours', value) }),
            ]),
            h('div', { key: 'g2', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '七情半衰期', value: v('emotion.feelingHalfLifeMinutes', 90), min: 0, step: 1, suffix: '分钟', disabled: ro, onChange: (value) => setField('emotion.feelingHalfLifeMinutes', Math.round(value)) }),
              h(NumField, { key: 'b', label: '置信门槛', value: v('emotion.confidenceThreshold', 60), min: 0, step: 1, disabled: ro, onChange: (value) => setField('emotion.confidenceThreshold', Math.round(value)) }),
            ]),
            h(SelectField, {
              key: 'tell',
              label: '注入方式',
              value: v('emotion.tellIt', 'event'),
              disabled: ro,
              options: [
                { value: 'none', label: 'none 不告诉它' },
                { value: 'mood-only', label: 'mood-only 只说心情' },
                { value: 'event', label: 'event 说刚才那件事' },
              ],
              onChange: (value) => setField('emotion.tellIt', value),
            }),
            h(NumField, {
              key: 'floor',
              label: '心情下限',
              hint: '0 = 不设底线',
              value: v('emotion.floor', 0),
              min: 0,
              max: 100,
              step: 1,
              disabled: ro,
              onChange: (value) => setField('emotion.floor', Math.round(value)),
            }),
          ]),

          // ── 7/11 记忆 ─────────────────────────────────────────
          h(Section, {
            key: 'memory',
            title: '⑦ 记忆',
            badge: `${v('memory.injectRecentDays', 3)} 天`,
            open: isOpen('memory'),
            onToggle: () => toggle('memory'),
          }, [
            h(LabeledSwitch, {
              key: 'on',
              checked: v('memory.enabled', true) !== false,
              label: '启用长期记忆',
              disabled: ro,
              onChange: (checked) => setField('memory.enabled', checked),
            }),
            h('div', { key: 'g1', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '注入核心上限', value: v('memory.injectCoreMaxChars', 2000), min: 0, step: 100, suffix: '字', disabled: ro, onChange: (value) => setField('memory.injectCoreMaxChars', Math.round(value)) }),
              h(NumField, { key: 'b', label: '注入最近日记', value: v('memory.injectRecentDays', 3), min: 0, step: 1, suffix: '天', disabled: ro, onChange: (value) => setField('memory.injectRecentDays', Math.round(value)) }),
            ]),
            h('div', { key: 'g2', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '摘要上限', value: v('memory.injectSummaryMaxChars', 3000), min: 0, step: 100, suffix: '字', disabled: ro, onChange: (value) => setField('memory.injectSummaryMaxChars', Math.round(value)) }),
              h(NumField, { key: 'b', label: '注入总上限', value: v('memory.injectMaxChars', 6000), min: 0, step: 100, suffix: '字', disabled: ro, onChange: (value) => setField('memory.injectMaxChars', Math.round(value)) }),
            ]),
            h(LabeledSwitch, {
              key: 'recall',
              checked: v('memory.recallEnabled', true) !== false,
              label: '跨会话回忆',
              hint: '派子 Agent 去翻别的对话',
              disabled: ro,
              onChange: (checked) => setField('memory.recallEnabled', checked),
            }),
            h('div', { key: 'g3', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '回忆 token 预算', value: v('memory.recallMaxTokens', 1200), min: 0, step: 100, disabled: ro, onChange: (value) => setField('memory.recallMaxTokens', Math.round(value)) }),
              h(NumField, { key: 'b', label: '最多扫', value: v('memory.recallScanDays', 14), min: 0, step: 1, suffix: '天', disabled: ro, onChange: (value) => setField('memory.recallScanDays', Math.round(value)) }),
            ]),
          ]),

          // ── 8/11 表情包 ───────────────────────────────────────
          h(Section, {
            key: 'meme',
            title: '⑧ 表情包',
            badge: Number(v('meme.probability', 0.5)).toFixed(2),
            open: isOpen('meme'),
            onToggle: () => toggle('meme'),
          }, [
            h(SliderField, {
              key: 'p',
              label: '发图总闸（0 = 从不发）',
              value: v('meme.probability', 0.5),
              disabled: ro,
              onChange: (value) => setField('meme.probability', Math.round(value * 100) / 100),
            }),
            h('div', { key: 'g1', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '一条最多几张', value: v('meme.maxPerMessage', 2), min: 0, step: 1, disabled: ro, onChange: (value) => setField('meme.maxPerMessage', Math.round(value)) }),
              h(SecField, { key: 'b', label: '同类冷却', ms: v('meme.cooldownMs', 120000), disabled: ro, onChange: (ms) => setField('meme.cooldownMs', ms) }),
            ]),
            h(SliderField, {
              key: 'inline',
              label: '图文混排概率',
              value: v('meme.inlineProbability', 0.5),
              disabled: ro,
              onChange: (value) => setField('meme.inlineProbability', Math.round(value * 100) / 100),
            }),
            h('div', { key: 'stealh', className: 'cq-field-hint' }, '盗图（收到别人的图，有概率看一眼并存进图库）：'),
            h(SliderField, {
              key: 'steal',
              label: '盗图概率',
              value: v('meme.steal.probability', 0.15),
              disabled: ro,
              onChange: (value) => setField('meme.steal.probability', Math.round(value * 100) / 100),
            }),
            h('div', { key: 'g2', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '最小', value: Math.round(num(v('meme.steal.minBytes', 4096), 0) / 1024), min: 0, step: 1, suffix: 'KB', disabled: ro, onChange: (value) => setField('meme.steal.minBytes', Math.round(value * 1024)) }),
              h(NumField, { key: 'b', label: '最大', value: Math.round(num(v('meme.steal.maxBytes', 2097152), 0) / 1024), min: 0, step: 256, suffix: 'KB', disabled: ro, onChange: (value) => setField('meme.steal.maxBytes', Math.round(value * 1024)) }),
            ]),
            h(TextField, {
              key: 'ext',
              label: '允许的扩展名（逗号分隔）',
              value: texts?.ext ?? '',
              placeholder: 'gif, png, jpg, webp',
              disabled: ro,
              onChange: (value) => setText('ext', value),
            }),
            stealRows.length
              ? h('div', { key: 'stealrows' }, [h('div', { key: 'h', className: 'cq-field-hint' }, '按会话覆盖：'), ...stealRows])
              : null,
            h('div', { key: 'lib', className: 'cq-field-hint', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
              h('span', { key: 't', style: { flex: 1 } }, memesError ? `图库不可用（${memesError}）` : '图库类别：'),
              h(SmallBtn, { key: 'r', disabled: ro, onClick: onReloadMemes }, '刷新'),
            ]),
            memeRows || h('div', { key: 'nomeme', className: 'cq-field-hint' }, '（没有类别数据）'),
          ]),

          // ── 9/11 日程 ─────────────────────────────────────────
          h(Section, {
            key: 'life',
            title: '⑨ 日程',
            badge: `${v('life.schedule.segments', 6)} 段`,
            open: isOpen('life'),
            onToggle: () => toggle('life'),
          }, [
            h(LabeledSwitch, {
              key: 'on',
              checked: v('life.enabled', true) !== false,
              label: '让她有自己的生活',
              hint: '只在 companion 模式跑；work 模式连生成都不触发',
              disabled: ro,
              onChange: (checked) => setField('life.enabled', checked),
            }),
            h('div', { key: 'g1', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '每天几段', hint: '会被夹在 6~8', value: v('life.schedule.segments', 6), min: 1, max: 12, step: 1, disabled: ro, onChange: (value) => setField('life.schedule.segments', Math.round(value)) }),
              h(TextField, { key: 'b', label: '生成时间', value: v('life.schedule.generateAfter', '07:30'), placeholder: '07:30 / off', disabled: ro, onChange: (value) => setField('life.schedule.generateAfter', value) }),
            ]),
            h(LabeledSwitch, {
              key: 'regen',
              checked: v('life.schedule.regenerateAllowed', false) === true,
              label: '允许当天重新生成',
              hint: '关着 = 防精神分裂',
              disabled: ro,
              onChange: (checked) => setField('life.schedule.regenerateAllowed', checked),
            }),
            h('div', { key: 'g2', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '精力基线', value: v('life.state.energyBaseline', 75), min: 10, max: 100, step: 1, disabled: ro, onChange: (value) => setField('life.state.energyBaseline', Math.round(value)) }),
              h(SelectField, { key: 'b', label: '状态注入', value: v('life.state.injectMode', 'companion-only'), disabled: ro, options: [{ value: 'companion-only', label: 'companion-only' }, { value: 'off', label: 'off 不注入' }], onChange: (value) => setField('life.state.injectMode', value) }),
            ]),
          ]),

          // ── 10/11 关系 ────────────────────────────────────────
          h(Section, {
            key: 'relation',
            title: '⑩ 关系',
            badge: v('relation.ownerFloorPhase', 'close'),
            open: isOpen('relation'),
            onToggle: () => toggle('relation'),
          }, [
            h(LabeledSwitch, {
              key: 'on',
              checked: v('relation.enabled', true) !== false,
              label: '启用关系账本',
              disabled: ro,
              onChange: (checked) => setField('relation.enabled', checked),
            }),
            h('div', { key: 'g1', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '初始分', value: v('relation.initial', 0), step: 1, disabled: ro, onChange: (value) => setField('relation.initial', Math.round(value)) }),
              h(NumField, { key: 'b', label: '迟滞带', value: v('relation.hysteresis', 20), min: 0, step: 1, disabled: ro, onChange: (value) => setField('relation.hysteresis', Math.round(value)) }),
            ]),
            h('div', { key: 'g2', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '单次涨上限', value: v('relation.singleGainCap', 4), min: 0, step: 1, disabled: ro, onChange: (value) => setField('relation.singleGainCap', Math.round(value)) }),
              h(NumField, { key: 'b', label: '单次跌上限', value: v('relation.singleLossCap', 12), min: 0, step: 1, disabled: ro, onChange: (value) => setField('relation.singleLossCap', Math.round(value)) }),
            ]),
            h('div', { key: 'g3', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '每日涨上限', value: v('relation.dailyGainCap', 12), min: 0, step: 1, disabled: ro, onChange: (value) => setField('relation.dailyGainCap', Math.round(value)) }),
              h(NumField, { key: 'b', label: '账本最多几条', value: v('relation.ledgerMax', 200), min: 0, step: 10, disabled: ro, onChange: (value) => setField('relation.ledgerMax', Math.round(value)) }),
            ]),
            h(NumField, {
              key: 'grace',
              label: '回落宽限',
              value: v('relation.decay.graceDays', 3),
              min: 0,
              step: 1,
              suffix: '天',
              disabled: ro,
              onChange: (value) => setField('relation.decay.graceDays', Math.round(value)),
            }),
            h(SelectField, {
              key: 'floor',
              label: '主人分数地板',
              hint: '掉不到这个阶段以下（一次吵架不能让她不理人）',
              value: v('relation.ownerFloorPhase', 'close'),
              disabled: ro,
              options: PHASE_OPTIONS,
              onChange: (value) => setField('relation.ownerFloorPhase', value),
            }),
            h('div', { key: 'tiers' }, [h('div', { key: 'h', className: 'cq-field-hint' }, '回落档（只读展示，手改 config.json）：'), ...tierRows]),
          ]),

          // ── 11/11 群管 ────────────────────────────────────────
          h(Section, {
            key: 'moderation',
            title: '⑪ 群管',
            badge: v('moderation.watchAll', true) !== false ? '全群' : '白名单',
            open: isOpen('moderation'),
            onToggle: () => toggle('moderation'),
          }, [
            h(LabeledSwitch, {
              key: 'watch',
              checked: v('moderation.watchAll', true) !== false,
              label: '盯所有群',
              disabled: ro,
              onChange: (checked) => setField('moderation.watchAll', checked),
            }),
            h(LabeledSwitch, {
              key: 'ban',
              checked: v('moderation.banEnabled', true) !== false,
              label: '允许禁言',
              disabled: ro,
              onChange: (checked) => setField('moderation.banEnabled', checked),
            }),
            h('div', { key: 'g1', className: 'cq-grid2' }, [
              h(NumField, { key: 'a', label: '默认禁言', value: v('moderation.defaultBanMinutes', 10), min: 0, step: 1, suffix: '分钟', disabled: ro, onChange: (value) => setField('moderation.defaultBanMinutes', Math.round(value)) }),
              h(NumField, { key: 'b', label: '最长禁言', value: v('moderation.maxBanMinutes', 60), min: 0, step: 1, suffix: '分钟', disabled: ro, onChange: (value) => setField('moderation.maxBanMinutes', Math.round(value)) }),
            ]),
            h(LabeledSwitch, {
              key: 'notify',
              checked: v('moderation.notifyOwner', true) !== false,
              label: '禁言后跟主人汇报',
              disabled: ro,
              onChange: (checked) => setField('moderation.notifyOwner', checked),
            }),
            h(TextAreaField, {
              key: 'hot',
              label: '热词（逗号或换行分隔）',
              hint: '命中就建议禁言。输入框是草稿字符串，保存时才切分 —— 边打字边切会把逗号吃掉。',
              rows: 3,
              value: texts?.hot ?? '',
              placeholder: '加群, 广告, 代刷',
              disabled: ro,
              onChange: (value) => setText('hot', value),
            }),
          ]),

          // ── 运行日志（不是配置，放最后）────────────────────────
          h(Section, {
            key: 'log',
            title: '运行日志',
            badge: `${Array.isArray(logs) ? logs.length : 0} 条`,
            open: isOpen('log'),
            onToggle: () => toggle('log'),
          }, [
            h('div', { key: 'h', className: 'cq-field-hint' }, '来自 /state 的内存日志环（最近 40 条）。'),
            h('div', { key: 'rows', className: 'cq-log' }, logRows),
            h('div', { key: 'act', style: { display: 'flex', gap: 6, marginTop: 4 } }, [
              h(SmallBtn, { key: 'clear', disabled: Boolean(busy), onClick: onClearLog }, '清空日志'),
            ]),
          ]),
        ]),
      ])
    }

    /** 从 /config 的返回里抠出配置本体（兼容 `{ok,config}` 和裸配置两种形状）。 */
    function pickConfig(res) {
      if (!res || typeof res !== 'object') return null
      if (res.config && typeof res.config === 'object') return res.config
      // {ok:true} 但没有配置本体 = 端点还没实现，不要拿它当配置
      if (res.ok === true && !res.qq && !res.modes && !res.observe && !res.mind) return null
      return res
    }

    // ──────────────────────────── 区块⑤：整页面板 ────────────────────────────
    //
    // 状态管理不用 redux：三个轮询 + useState 就够。
    // 三个必须成立的约束（v2 踩过）：
    //  1. 每个轮询都在 useEffect 里 setInterval，卸载/切会话**必须** clearInterval
    //  2. 切会话时旧请求可能后到 → 每个轮询一个 `seq` 计数器，回来时比对，不对就丢弃
    //  3. 请求失败不弹窗、不空白：保留上一次数据，顶部状态条变灰

    function ChachaPanel() {
      // ── 数据 ──────────────────────────────────────────────
      const [state, setState] = useState(null)
      const [online, setOnline] = useState(true)
      const [conversations, setConversations] = useState([])
      const [convSource, setConvSource] = useState('api')
      const [messageState, setMessageState] = useState({ key: null, list: [] })
      const [msgSource, setMsgSource] = useState('api')
      const [loadingMessages, setLoadingMessages] = useState(false)

      // ── 交互 ──────────────────────────────────────────────
      const [selected, setSelected] = useState(null) // null = 还没选；'' = 全部混合
      const [query, setQuery] = useState('')
      const [drawerOpen, setDrawerOpen] = useState(true)
      const [refreshing, setRefreshing] = useState(false)
      const [busy, setBusy] = useState('')
      const [actionHint, setActionHint] = useState('')
      const [sending, setSending] = useState(false)
      const [sendHint, setSendHint] = useState('')

      // ── 配置草稿 ──────────────────────────────────────────
      const [config, setConfig] = useState(null)
      const [draft, setDraft] = useState(null)
      const [configError, setConfigError] = useState('')
      const [dirty, setDirty] = useState(false)
      const [saving, setSaving] = useState(false)
      const [saveHint, setSaveHint] = useState('')
      // 前端校验的报错（目前只有「大脑」组会产出）：它和 saveHint 分开，
      // 因为 dirty 时保存按钮只显示「未保存」，saveHint 根本露不出来。
      const [formError, setFormError] = useState('')
      const [texts, setTexts] = useState({ hot: '', ext: '', users: '', groups: '', patterns: '' })
      const [resetToken, setResetToken] = useState(0)
      const [memes, setMemes] = useState([])
      const [memesError, setMemesError] = useState('')

      // ── refs（轮询守卫 / 定时器）──────────────────────────
      const aliveRef = useRef(true)
      const stateRef = useRef(null)
      const stateSeq = useRef(0)
      const convSeq = useRef(0)
      const msgSeq = useRef(0)
      const flashTimer = useRef(null)
      const seedRef = useRef(-1)
      const tickRef = useRef({ state: null, conversations: null, messages: null })

      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          if (flashTimer.current) clearTimeout(flashTimer.current)
        }
      }, [])

      useEffect(() => {
        stateRef.current = state
      }, [state])

      // ── ① /state 每 3s ────────────────────────────────────
      useEffect(() => {
        let alive = true
        const tick = async () => {
          const my = ++stateSeq.current
          try {
            const raw = await api('/state')
            if (!alive || my !== stateSeq.current) return
            // 200 + {ok:false} 也算失败：不能拿空壳把上一份好数据顶掉
            if (raw && raw.ok === false) throw new Error(raw.error || 'state 返回 ok=false')
            const next = normalizeState(raw)
            if (next) {
              stateRef.current = next
              setState(next)
            }
            if (aliveRef.current) setOnline(true)
          } catch (error) {
            // 失败不弹窗、不清数据：只把顶部变灰（online=false）
            if (!alive) return
            if (aliveRef.current) setOnline(false)
          }
        }
        tickRef.current.state = tick
        void tick()
        const timer = setInterval(() => { void tick() }, POLL.state)
        return () => {
          alive = false
          clearInterval(timer)
          tickRef.current.state = null
        }
      }, [])

      // ── ② /conversations 每 3s（端点没就绪就用 state.recent 推导）──
      useEffect(() => {
        let alive = true
        // 这个接口在这一轮里通过吗？通过过 = 失败时只当「抖了一下」，保留上一次数据；
        // 从来没通过 = 端点还没上线，才退回用 state.recent 推导。
        let apiOk = false
        const tick = async () => {
          const my = ++convSeq.current
          try {
            const res = await api('/conversations')
            if (res && res.ok === false) throw new Error(res.error || 'conversations 返回 ok=false')
            const list = Array.isArray(res)
              ? res
              : Array.isArray(res?.conversations) ? res.conversations : null
            if (!alive || my !== convSeq.current) return
            if (!list) throw new Error('形状不对')
            setConversations(list.map(normalizeConversation).filter(Boolean))
            setConvSource('api')
            apiOk = true
          } catch (error) {
            if (!alive || my !== convSeq.current) return
            if (apiOk) return
            const snap = stateRef.current
            // 连 state 都没有 = 后端彻底没起来：保留上一次列表，别清空
            if (!snap) return
            setConversations(deriveConversations(snap))
            setConvSource('derived')
          }
        }
        tickRef.current.conversations = tick
        void tick()
        const timer = setInterval(() => { void tick() }, POLL.conversations)
        return () => {
          alive = false
          clearInterval(timer)
          tickRef.current.conversations = null
        }
      }, [])

      // ── ③ /messages（选中会话）每 2s ──────────────────────
      useEffect(() => {
        let alive = true
        const peerKey = selected ?? ''
        // 同上：接口通着就绝不用 state 降级数据覆盖它
        let apiOk = false
        setLoadingMessages(true)
        const tick = async () => {
          const my = ++msgSeq.current
          try {
            const qs = `?limit=200${peerKey ? `&peerKey=${encodeURIComponent(peerKey)}` : ''}`
            const res = await api(`/messages${qs}`)
            if (res && res.ok === false) throw new Error(res.error || 'messages 返回 ok=false')
            const list = Array.isArray(res) ? res : Array.isArray(res?.messages) ? res.messages : null
            if (!alive || my !== msgSeq.current) return
            if (!list) throw new Error('形状不对')
            const normalized = list.map(normalizeMessage).filter(Boolean)
            normalized.sort((a, b) => a.at - b.at)
            setMessageState({ key: peerKey, list: normalized })
            setMsgSource('api')
            apiOk = true
            setLoadingMessages(false)
          } catch (error) {
            if (!alive || my !== msgSeq.current) return
            const snap = stateRef.current
            if (!apiOk && snap) {
              setMessageState({ key: peerKey, list: messagesFromState(snap, peerKey) })
              setMsgSource('state')
            }
            setLoadingMessages(false)
          }
        }
        tickRef.current.messages = tick
        void tick()
        const timer = setInterval(() => { void tick() }, POLL.messages)
        return () => {
          // 切会话 / 卸载：停轮询，并且让在飞的旧请求作废（seq 号对不上就丢弃）
          alive = false
          clearInterval(timer)
          tickRef.current.messages = null
        }
      }, [selected])

      // ── 配置 ──────────────────────────────────────────────
      const loadConfig = useCallback(async (options) => {
        const opts = options || {}
        try {
          const res = await api('/config')
          const next = pickConfig(res)
          if (!next) throw new Error('配置接口返回的形状不对')
          setConfig(next)
          setConfigError('')
          if (opts.reset) {
            setDraft(deepClone(next))
            setDirty(false)
            setSaveHint('')
            setFormError('')
            setResetToken((value) => value + 1)
          }
          return next
        } catch (error) {
          setConfigError(String(error?.message ?? error))
          return null
        }
      }, [])

      useEffect(() => {
        void loadConfig()
      }, [loadConfig])

      /**
       * config 到达时把草稿灌一次。
       *
       * 为什么不用 defaultValue：首次渲染时 config 还是 null，defaultValue 会把框
       * 定死成空值，之后配置到了也不更新 —— 看起来就是「改了不生效」（v2 坑 19）。
       */
      useEffect(() => {
        if (!config || dirty) return
        setDraft((prev) => prev ?? deepClone(config))
      }, [config, dirty])

      /** 列表型字段的文本草稿：只在「第一次拿到 draft / 保存后 / 还原」时灌一次。 */
      useEffect(() => {
        if (!draft) return
        if (seedRef.current === resetToken) return
        seedRef.current = resetToken
        setTexts({
          hot: formatCsv(getPath(draft, 'moderation.hotKeywords', [])),
          ext: formatCsv(getPath(draft, 'meme.steal.allowedExt', [])),
          users: formatNumMap(getPath(draft, 'interest.users', {})),
          groups: formatNumMap(getPath(draft, 'interest.groups', {})),
          patterns: formatLines(getPath(draft, 'security.injectionPatterns', [])),
        })
      }, [draft, resetToken])

      const setField = useCallback((path, value) => {
        setDraft((prev) => (prev ? setPathIn(prev, path, value) : prev))
        setDirty(true)
        setSaveHint('')
        // 一改就把上次的校验错误撤掉：错误还挂在那儿但值已经改对了，只会让人困惑。
        setFormError('')
      }, [])

      const unsetField = useCallback((path) => {
        setDraft((prev) => (prev ? unsetPathIn(prev, path) : prev))
        setDirty(true)
        setSaveHint('')
      }, [])

      /**
       * 「本对话功能开关」的三态写入：`value === undefined` = 跟随全局。
       *
       * 为什么单独一个回调、而不是直接 setField/unsetField：
       *  1. 跟随全局必须**删键**（不是写 false），否则那个对话会永久钉死在「关」；
       *  2. 删完还要顺手清扫空壳 `{}`，config.json 才不会被一堆空对象塞满；
       *  3. 键必须按群号归一（`group-123`），和 pipeline 里 featureMode 的取法同构。
       */
      const setFeaturePeer = useCallback((peerKey, feature, value) => {
        const raw = String(peerKey ?? '')
        const key = normalizePeerKeyLocal(raw) || raw
        if (!key) return
        setDraft((prev) => {
          if (!prev) return prev
          let next = prev
          if (value === undefined) {
            next = unsetPathIn(next, ['features', 'peers', key, feature])
            // 手改过配置的人可能把覆盖写在 `group-123-owner` 上：原始键和归一化键
            // 不是同一个时两个都清，否则切回「跟随全局」后那条老覆盖还在生效。
            if (raw && raw !== key) next = unsetPathIn(next, ['features', 'peers', raw, feature])
          } else {
            next = setPathIn(next, ['features', 'peers', key, feature], value === true)
          }
          return pruneFeaturePeers(next)
        })
        setDirty(true)
        setSaveHint('')
        setFormError('')
      }, [])

      const setText = useCallback((key, value) => {
        setTexts((prev) => ({ ...prev, [key]: value }))
        setDirty(true)
        setSaveHint('')
      }, [])

      const flash = useCallback((text) => {
        setActionHint(text)
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => {
          if (aliveRef.current) setActionHint('')
        }, 4000)
      }, [])

      const runAction = useCallback(async (action, extra) => {
        if (aliveRef.current) setBusy(action)
        try {
          const res = await api('/action', { method: 'POST', body: { action, ...(extra ?? {}) } })
          if (res && res.ok === false) throw new Error(res.error || '动作被拒绝')
          return { ok: true, res }
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }, [])

      // ── 表情包类别（抽屉打开时拉一次，失败不影响别的）──────
      const loadMemes = useCallback(async () => {
        try {
          const res = await api('/memes')
          const list = Array.isArray(res) ? res : Array.isArray(res?.memes) ? res.memes : null
          if (!list) throw new Error('形状不对')
          setMemes(list)
          setMemesError('')
        } catch (error) {
          setMemesError(String(error?.message ?? error))
        }
      }, [])

      useEffect(() => {
        if (drawerOpen) void loadMemes()
      }, [drawerOpen, loadMemes])

      // 第一次拿到会话列表就选中第一个（否则对话区是「未选择」的空壳）
      useEffect(() => {
        if (selected !== null) return
        const first = conversations[0]
        if (first?.peerKey) setSelected(first.peerKey)
      }, [conversations, selected])

      const selectedConversation = useMemo(() => {
        if (selected === null || selected === '') return null
        return conversations.find((item) => item.peerKey === selected) ?? null
      }, [conversations, selected])

      const modeOf = useCallback((peerKey) => resolveModeLocal(peerKey, draft), [draft])

      const visibleMessages = messageState.key === (selected ?? '') ? messageState.list : []

      // ── 动作 ──────────────────────────────────────────────
      const saveAll = useCallback(async () => {
        if (!draft) return
        // 保存前的最后一道闸。后端只校验类型不校验枚举，非法值落盘后会每轮都递给内核，
        // 所以这里先验：不通过就**只显示错误、一个请求都不发**。
        const invalid = validateMind(draft)
        if (invalid) {
          setFormError(invalid)
          setSaveHint('')
          // 抽屉可能被收起：顶部状态条也闪一下错误，绝不能「点了保存什么都不发生」。
          flash(`✗ 没保存：${invalid}`)
          return
        }
        setFormError('')
        setSaving(true)
        setSaveHint('')
        try {
          // 存进 config.json 之前先扫一遍 features.peers：三态点回「跟随全局」留下的
          // 空对象 / null 在这里删掉，别把 config.json 养成一堆 `{}`。
          const patch = pruneFeaturePeers(deepClone(draft) || {}) || {}
          // 文本草稿在这里才解析（边打字边解析会把逗号吃掉）
          patch.moderation = { ...(patch.moderation || {}), hotKeywords: parseCsv(texts.hot) }
          const meme = { ...(patch.meme || {}) }
          meme.steal = {
            ...(meme.steal || {}),
            allowedExt: parseCsv(texts.ext).map((item) => item.toLowerCase()),
          }
          patch.meme = meme
          patch.interest = {
            ...(patch.interest || {}),
            users: parseNumMap(texts.users),
            groups: parseNumMap(texts.groups),
          }
          patch.security = {
            ...(patch.security || {}),
            injectionPatterns: parseLines(texts.patterns),
          }

          const res = await postConfig(api, patch)
          if (res && res.ok === false) throw new Error(res.error || '保存被拒绝')
          const next = pickConfig(res) || patch
          setConfig(next)
          setDraft(deepClone(next))
          setDirty(false)
          setSaveHint('已保存')
          setResetToken((value) => value + 1)
          flash('✓ 配置已保存')
        } catch (error) {
          setSaveHint(`保存失败：${String(error?.message ?? error)}`)
        } finally {
          if (aliveRef.current) setSaving(false)
        }
      }, [draft, texts, flash])

      const resetDraft = useCallback(() => {
        if (!config) return
        setDraft(deepClone(config))
        setDirty(false)
        setSaveHint('已还原')
        setFormError('')
        setResetToken((value) => value + 1)
      }, [config])

      const refreshAll = useCallback(async () => {
        setRefreshing(true)
        try {
          await Promise.all([
            tickRef.current.state?.(),
            tickRef.current.conversations?.(),
            tickRef.current.messages?.(),
            loadConfig({ reset: !dirty }),
            loadMemes(),
          ])
        } finally {
          if (aliveRef.current) setRefreshing(false)
        }
      }, [loadConfig, loadMemes, dirty])

      const onTestConnect = useCallback(async () => {
        const result = await runAction('test-connect')
        if (!result.ok) {
          flash(`✗ 探活失败：${result.error}`)
          return
        }
        const latency = Number(result.res?.latencyMs)
        flash(Number.isFinite(latency) ? `✓ NapCat ${latency}ms` : '✓ 探活完成')
      }, [runAction, flash])

      const onRestart = useCallback(async () => {
        const result = await runAction('hard-restart')
        flash(result.ok ? '✓ 重启请求已发出（会短暂掉线）' : `✗ 重启失败：${result.error}`)
      }, [runAction, flash])

      const onResetSession = useCallback(async (conversation) => {
        if (!conversation) return
        const result = await runAction('reset-session', { peerKey: conversation.peerKey })
        if (!result.ok) {
          flash(`✗ 重置失败：${result.error}`)
          return
        }
        flash(`✓ 已换代次：${conversation.name || conversation.peerKey}`)
        await tickRef.current.messages?.()
      }, [runAction, flash])

      const onSendTest = useCallback(async (text) => {
        if (!selectedConversation) {
          setSendHint('✗ 先在左边选一个会话')
          return false
        }
        setSending(true)
        setSendHint('')
        try {
          // 动作名 send-test 是面板侧约定的（PANEL-DESIGN §2.5 没列），宿主侧要接一下。
          const res = await api('/action', {
            method: 'POST',
            body: { action: 'send-test', peerKey: selectedConversation.peerKey, text },
          })
          if (res && res.ok === false) throw new Error(res.error || '被拒绝')
          setSendHint('✓ 已交给宿主（看上面两秒内的新消息）')
          return true
        } catch (error) {
          setSendHint(`✗ 发送失败：${String(error?.message ?? error)}`)
          return false
        } finally {
          if (aliveRef.current) setSending(false)
        }
      }, [selectedConversation])

      const onClearLog = useCallback(async () => {
        const result = await runAction('clear-log')
        flash(result.ok ? '✓ 日志已清空' : `✗ 清空失败：${result.error}`)
      }, [runAction, flash])

      return h('div', { className: 'cq-root' }, [
        h(TopBar, {
          key: 'top',
          state,
          online,
          draft,
          saveState: { dirty, saving, hint: saveHint },
          onSave: saveAll,
          onRefresh: refreshAll,
          refreshing,
          drawerOpen,
          onToggleDrawer: () => setDrawerOpen((value) => !value),
          onSetDefaultMode: (mode) => setField('modes.default', mode),
          onTestConnect,
          onRestart,
          busy,
          actionHint,
          stats: { pending: state?.pendingRequests ?? 0 },
        }),
        h('div', { key: 'body', className: 'cq-body' }, [
          h(ConversationList, {
            key: 'side',
            conversations,
            selected,
            onSelect: setSelected,
            query,
            onQuery: setQuery,
            source: convSource,
            modeOf,
            onRefresh: refreshAll,
          }),
          h(ChatArea, {
            key: 'chat',
            conversation: selectedConversation,
            mixed: selected === '',
            messages: visibleMessages,
            loading: loadingMessages,
            source: msgSource,
            onResetSession,
            onSendTest,
            sending,
            sendHint,
            busy,
          }),
          h(ConfigDrawer, {
            key: 'drawer',
            open: drawerOpen,
            onClose: () => setDrawerOpen(false),
            draft,
            config,
            configError,
            dirty,
            saving,
            saveHint,
            formError,
            setField,
            unsetField,
            setFeaturePeer,
            onSave: saveAll,
            onReset: resetDraft,
            onReload: () => { void loadConfig({ reset: !dirty }) },
            texts,
            setText,
            resetToken,
            conversation: selectedConversation,
            memes,
            memesError,
            onReloadMemes: loadMemes,
            logs: state?.log ?? [],
            onClearLog,
            busy,
          }),
        ]),
      ])
    }

    // ──────────────────────────── 注册 ────────────────────────────
    //
    // 三条硬规则照写，别改（PANEL-DESIGN §1）：
    //  - 侧边栏包在 slots.inject 里再 register（否则槽位还没声明，行静默消失）
    //  - main 是 keyed slot，key 必须等于侧边栏的 id
    //  - 每个注册单独 try/catch：一条挂了不能让另一条也不出现
    return {
      inject: ['slots'],

      apply(ctx) {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => mountStyle(), 'chacha-qq: styles')
        } else {
          mountStyle()
        }

        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: -30,
            label: '茶茶酱的 QQ',
          }, ChachaIcon))
        } catch (error) {
          console.error('[chacha-qq] 侧边栏注册失败', error)
        }

        try {
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, ChachaPanel))
        } catch (error) {
          console.error('[chacha-qq] 面板注册失败', error)
        }
      },
    }
  },
})
