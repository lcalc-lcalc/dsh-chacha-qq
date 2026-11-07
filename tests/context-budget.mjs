/**
 * 上下文「压缩 + 限制」测试。
 *
 * 这个套件是补漏的：v3 一开始只有压缩、而且**参数传错**（传 Agent 而不是
 * `{session, options}`，trigger 也传成了对象）—— 那等于压缩是个摆设，
 * 同时又删掉了 v2 的「超限换代次」，上下文会一路涨到 API 报 overflow。
 *
 * 这里把四个档位和「参数是否严格符合内核契约」都钉死。
 */
import { group, check, ok, notOk, report } from './harness.mjs'

import { Mind } from '../src/mind/turn.js'
import { DEFAULT_CONFIG, mergeDeep, sanitizeConfig } from '../src/config.js'

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }

/** 假配置句柄：只需要 get()。 */
function fakeStore(overrides = {}) {
  const value = sanitizeConfig(mergeDeep(DEFAULT_CONFIG, overrides))
  return { get: () => value }
}

/** 假 ctx：按名字给服务。 */
function fakeCtx({ compaction = null, tokenMeter = null } = {}) {
  return {
    get(name) {
      if (name === 'compaction') return compaction ?? undefined
      if (name === 'tokenMeter') return tokenMeter ?? undefined
      return undefined
    },
  }
}

/** 假 agent：只需要 session.seq。 */
function fakeAgent(seq = 0) {
  return { id: 'agent-test', session: { seq } }
}

/** 造一个 Mind，但绕开 ensure（这些测试只测压缩判定）。 */
function makeMind({ ctx, store }) {
  return new Mind({ ctx, store, log: SILENT })
}

// ══════════════════════════════════════════════════════════════
group('压缩：配置与默认值')

ok('软上限默认存在', Number(DEFAULT_CONFIG.mind.compactAtEventCount) > 0,
  String(DEFAULT_CONFIG.mind.compactAtEventCount))
ok('硬上限默认存在（这是 v3 补的兜底）', Number(DEFAULT_CONFIG.mind.hardResetEventCount) > 0,
  String(DEFAULT_CONFIG.mind.hardResetEventCount))
ok('硬上限 > 软上限（不然压缩永远来不及）',
  DEFAULT_CONFIG.mind.hardResetEventCount > DEFAULT_CONFIG.mind.compactAtEventCount,
  `${DEFAULT_CONFIG.mind.hardResetEventCount} > ${DEFAULT_CONFIG.mind.compactAtEventCount}`)

// ══════════════════════════════════════════════════════════════
group('压缩：档位一 —— 低于软上限，什么都不做')

{
  const calls = []
  const compaction = {
    async compactIfNeeded(...args) {
      calls.push(args)
      return { ok: true }
    },
  }
  const mind = makeMind({ ctx: fakeCtx({ compaction }), store: fakeStore() })
  const verdict = await mind.maybeCompact(fakeAgent(10), {})

  check('没有触发压缩', calls.length, 0)
  check('compacted=false', verdict.compacted, false)
  check('needReset=false', verdict.needReset, false)
  check('理由正确', verdict.reason, 'below-soft-limit')
}

// ══════════════════════════════════════════════════════════════
group('压缩：档位二 —— 过软上限，压缩成功')

{
  const calls = []
  const compaction = {
    async compactIfNeeded(agentCtx, trigger, signal) {
      calls.push({ agentCtx, trigger, signal })
      return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 999 }
    },
  }
  const store = fakeStore({ mind: { compactAtEventCount: 100, hardResetEventCount: 1000 } })
  const mind = makeMind({ ctx: fakeCtx({ compaction }), store })
  const agent = fakeAgent(150)
  const verdict = await mind.maybeCompact(agent, { provider: 'deepseek-account', model: 'deepseek-flash' })

  check('调了一次压缩', calls.length, 1)
  check('compacted=true', verdict.compacted, true)
  check('不需要换代次', verdict.needReset, false)
  check('理由 native', verdict.reason, 'native')

  // ⭐ 参数严格性 —— 这就是之前写错的地方
  const got = calls[0] ?? {}
  ok('第一个参数不是 Agent 本身', got.agentCtx !== agent, typeof got.agentCtx)
  ok('第一个参数带 session', Boolean(got.agentCtx?.session), JSON.stringify(Object.keys(got.agentCtx ?? {})))
  check('session 就是 agent.session', got.agentCtx?.session, agent.session)
  check('options 带上了 provider', got.agentCtx?.options?.provider, 'deepseek-account')
  check('options 带上了 model', got.agentCtx?.options?.model, 'deepseek-flash')
  check('第二个参数是 pressure 字面量', got.trigger, 'pressure')
  ok('第三个参数是 AbortSignal', Boolean(got.signal) && typeof got.signal.aborted === 'boolean',
    String(got.signal))
}

// ══════════════════════════════════════════════════════════════
group('压缩：档位三 —— 过软上限但内核拒绝，还没到硬上限')

{
  const compaction = { async compactIfNeeded() { return null } } // 内核说「没得压」
  const store = fakeStore({ mind: { compactAtEventCount: 100, hardResetEventCount: 1000 } })
  const mind = makeMind({ ctx: fakeCtx({ compaction }), store })
  const verdict = await mind.maybeCompact(fakeAgent(200), {})

  check('没有压成', verdict.compacted, false)
  check('理由 native-declined', verdict.reason, 'native-declined')
  check('还没到硬上限 → 不换代次', verdict.needReset, false)
}

// ══════════════════════════════════════════════════════════════
group('压缩：档位四 —— 压不动且到硬上限 → 必须换代次')

{
  const compaction = { async compactIfNeeded() { return null } }
  const store = fakeStore({ mind: { compactAtEventCount: 100, hardResetEventCount: 300 } })
  const mind = makeMind({ ctx: fakeCtx({ compaction }), store })
  const verdict = await mind.maybeCompact(fakeAgent(400), {})

  check('没压成', verdict.compacted, false)
  ok('⭐ 要求换代次（这是硬限制）', verdict.needReset === true, String(verdict.needReset))
  check('事件数带回来了', verdict.used, 400)
}

// ══════════════════════════════════════════════════════════════
group('压缩：compaction 服务整个不可用')

{
  const store = fakeStore({ mind: { compactAtEventCount: 100, hardResetEventCount: 300 } })
  const mind = makeMind({ ctx: fakeCtx({ compaction: null }), store })

  const low = await mind.maybeCompact(fakeAgent(150), {})
  check('没到硬上限不换代次', low.needReset, false)
  check('理由是 unavailable', low.reason, 'unavailable')

  const high = await mind.maybeCompact(fakeAgent(500), {})
  ok('⭐ 到了硬上限仍然要换代次（服务挂了也不能无限涨）', high.needReset === true,
    JSON.stringify(high))
}

// ══════════════════════════════════════════════════════════════
group('压缩：压缩本身抛错')

{
  const compaction = { async compactIfNeeded() { throw new Error('summarization failed') } }
  const store = fakeStore({ mind: { compactAtEventCount: 100, hardResetEventCount: 300 } })
  const mind = makeMind({ ctx: fakeCtx({ compaction }), store })

  const low = await mind.maybeCompact(fakeAgent(150), {})
  check('抛错被吃掉，不往上冒', low.compacted, false)
  ok('理由里带上了错误信息', String(low.reason).includes('summarization'), low.reason)
  check('没到硬上限不换代次', low.needReset, false)

  const high = await mind.maybeCompact(fakeAgent(500), {})
  ok('到硬上限照样换代次', high.needReset === true, String(high.needReset))
}

// ══════════════════════════════════════════════════════════════
group('压缩：压力计算')

{
  // 有 tokenMeter 就用真实测量
  const tokenMeter = {
    contextPressure() {
      return { pressureTokens: 90_000, contextWindow: 100_000 }
    },
  }
  const mind = makeMind({ ctx: fakeCtx({ tokenMeter }), store: fakeStore() })
  const pressure = mind.pressureOf(fakeAgent(10), 10, 400)
  check('用 tokenMeter 算出 0.9', Math.round(pressure * 100) / 100, 0.9)

  // 没有 tokenMeter 退回事件数比例
  const mind2 = makeMind({ ctx: fakeCtx({}), store: fakeStore() })
  const rough = mind2.pressureOf(fakeAgent(200), 200, 400)
  check('退回事件数比例 = 0.5', rough, 0.5)

  // contextWindow 为 0（未知）时也不能除零
  const zeroMeter = { contextPressure: () => ({ pressureTokens: 5, contextWindow: 0 }) }
  const mind3 = makeMind({ ctx: fakeCtx({ tokenMeter: zeroMeter }), store: fakeStore() })
  const safe = mind3.pressureOf(fakeAgent(200), 200, 400)
  check('窗口未知时不除零、退回事件数', safe, 0.5)
}

report('上下文压缩与限制')
