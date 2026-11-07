/**
 * 关系账本测试 —— 钉住最容易出错、且肉眼看不出来的那几件事。
 *
 * 为什么值得单独一个套件：关系分数是「长期账」，算错了不是这一轮难看，而是慢性病：
 *   · 回落算错 → 她慢慢对天天聊天的人变冷淡（或者隔一夜就翻脸）；
 *   · 主人地板失效 → 一次吵架就把主人打回疏离，体验极差；
 *   · 归因串了 → 她自己心情不好/模型跑偏，却记到用户头上；
 *   · 去重失效 → 一条消息连夸十句，分数瞬间刷满。
 * 这些都不依赖 DSH / QQ / 网络，全部离线跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { group, check, ok, report } from './harness.mjs'

import {
  DEFAULT_RELATION,
  PHASES,
  PHASE_FLOORS,
  PHASE_LABELS,
  RelationStore,
  applyEvent,
  phaseFloor,
  phaseOf,
  phaseTagOf,
  resolveRelationConfig,
  settleDecay,
} from '../src/controller/relation.js'

const DAY = 24 * 60 * 60 * 1000

/** 用本地日历构造第 n 天的中午：不受时区/DST 影响，「第几天」和人的直觉一致。 */
const day = (n) => new Date(2026, 10, 7 + n, 12, 0, 0).getTime()

function dayKeyOf(at) {
  const date = new Date(at)
  const pad = (num) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 可拨的假时钟：回落和去重全靠它测。 */
function makeClock(start = day(0)) {
  let value = start
  const now = () => value
  now.set = (at) => {
    value = at
  }
  now.advance = (ms) => {
    value += ms
  }
  return now
}

const LOG = { debug() {}, info() {}, warn() {}, error() {} }
const BASE = day(0)

function makeStore({ dir, configRoot, clock }) {
  return new RelationStore({
    dataDir: dir,
    config: () => configRoot,
    log: LOG,
    now: clock,
  })
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chacha-relation-'))

// ══════════════════════════════════════════════════════════════
group('常量与配置解析')

{
  check('六个阶段', PHASES.length, 6)
  check('从疏离开始', PHASES[0], 'distant')
  check('到深联结结束', PHASES[PHASES.length - 1], 'deeply_bonded')
  ok('每个阶段都有中文名', PHASES.every((phase) => Boolean(PHASE_LABELS[phase])), JSON.stringify(PHASE_LABELS))
  check('acquaintance 下限 0', PHASE_FLOORS[1], 0)
  check('familiar 下限 200', PHASE_FLOORS[2], 200)
  check('close 下限 600（= 主人地板）', PHASE_FLOORS[3], 600)
  check('intimate 下限 900（= 边际递减硬档）', PHASE_FLOORS[4], 900)
  check('deeply_bonded 下限 1100', PHASE_FLOORS[5], 1100)
  check('phaseFloor(close)', phaseFloor('close'), 600)
  check('phaseFloor(非法阶段) 返回 null', phaseFloor('nope'), null)

  const defaults = resolveRelationConfig({})
  check('默认新人从 0 分起（不是 200）', defaults.initial, 0)
  check('默认单次正向 +4', defaults.singleGainCap, 4)
  check('默认单次负向 −12', defaults.singleLossCap, 12)
  check('默认每日正向 +12', defaults.dailyGainCap, 12)
  check('默认迟滞 20', defaults.hysteresis, 20)
  check('默认去重 30 分钟', defaults.dedupeMs, 30 * 60 * 1000)
  check('默认主人地板 close', defaults.ownerFloorPhase, 'close')
  check('默认账本上限 200', defaults.ledgerMax, 200)
  check('默认回落宽限 3 天', defaults.decay.graceDays, 3)
  check('默认回落第一档到第 7 天', defaults.decay.tiers[0].untilDay, 7)

  const whole = resolveRelationConfig({
    relation: { singleGainCap: 2, dailyGainCap: '20', hysteresis: 0 },
    owner: { qq: '1' },
  })
  check('整份 config 里取 relation 段', whole.singleGainCap, 2)
  check('配置里的字符串数字也认', whole.dailyGainCap, 20)
  check('hysteresis 可配成 0', whole.hysteresis, 0)

  const viaGetter = resolveRelationConfig(() => ({ relation: { ledgerMax: 5 } }))
  check('getter 也能解析', viaGetter.ledgerMax, 5)
}

// ══════════════════════════════════════════════════════════════
group('⭐ 迟滞：分数在阈值附近抖，阶段不跟着抖')

{
  const at19 = phaseOf(190, 'familiar')
  check('familiar(300) 掉到 190 不掉段', at19.phase, 'familiar')
  check('没掉段不算 changed', at19.changed, false)
  check('掉到 180（正好阈值−20）也不掉', phaseOf(180, 'familiar').phase, 'familiar')
  const at179 = phaseOf(179, 'familiar')
  check('掉到 179 才降回 acquaintance', at179.phase, 'acquaintance')
  check('降段算 changed', at179.changed, true)

  check('acquaintance(190) 升到 199 不升', phaseOf(199, 'acquaintance').phase, 'acquaintance')
  check('正好 200 也不算「越过」', phaseOf(200, 'acquaintance').phase, 'acquaintance')
  const at201 = phaseOf(201, 'acquaintance')
  check('201 才升 familiar', at201.phase, 'familiar')
  check('升段算 changed', at201.changed, true)

  check('close 掉到 580 不掉', phaseOf(580, 'close').phase, 'close')
  check('close 掉到 579 才降 familiar', phaseOf(579, 'close').phase, 'familiar')
  check('familiar 升到 601 升 close', phaseOf(601, 'familiar').phase, 'close')

  check('没给上一阶段 → 按裸分数判', phaseOf(300).phase, 'familiar')
  check('没给上一阶段不算 changed', phaseOf(300).changed, false)
  check('未知阶段名当没有', phaseOf(190, '不认识').phase, 'acquaintance')
  check('分数超上限夹紧', phaseOf(99999).phase, 'deeply_bonded')
  check('分数超下限夹紧', phaseOf(-99999).phase, 'distant')
  check('中文标签', phaseOf(300).label, '熟悉')

  // 大跨度（手动重置/导入旧数据）也要能一步到位
  check('distant 直接到 1000 → intimate', phaseOf(1000, 'distant').phase, 'intimate')
  check('intimate 掉到 300 → familiar', phaseOf(300, 'intimate').phase, 'familiar')

  // 迟滞带宽可配：配成 0 就是「跌破阈值立刻降」
  check('hysteresis=0 时 190 立刻降段', phaseOf(190, 'familiar', { hysteresis: 0 }).phase, 'acquaintance')
  check('hysteresis=30 时 175 仍不掉段', phaseOf(175, 'familiar', { hysteresis: 30 }).phase, 'familiar')
}

// ══════════════════════════════════════════════════════════════
group('⭐ 自然回落：只向 0、按段扣、幂等')

{
  const idle = (n) => ({
    score: 300,
    lastActiveAt: day(0),
    lastSettledDay: dayKeyOf(day(n - 1)),
    now: day(n),
  })

  check('第 3 天还在宽限期，不扣', settleDecay(idle(3)).delta, 0)
  check('第 4 天开始 −2/天', settleDecay(idle(4)).delta, 2)
  check('第 7 天仍是 −2/天', settleDecay(idle(7)).delta, 2)
  check('第 8 天进入 −5/天', settleDecay(idle(8)).delta, 5)
  check('第 14 天仍是 −5/天', settleDecay(idle(14)).delta, 5)
  check('第 15 天进入 −8/天', settleDecay(idle(15)).delta, 8)
  check('第 4 天扣完分数正确', settleDecay(idle(4)).score, 298)
  check('第 15 天扣完分数正确', settleDecay(idle(15)).score, 292)

  // 同一天结算两次：第二次 delta=0，分数不动（幂等）
  const sameDay = { score: 300, lastActiveAt: day(0), lastSettledDay: dayKeyOf(day(0)), now: day(0) }
  const firstOnce = settleDecay(sameDay)
  check('同一天第一次结算：还没到第 4 天 → 0', firstOnce.delta, 0)
  const gapOnce = settleDecay({ score: 300, lastActiveAt: day(0), lastSettledDay: dayKeyOf(day(0)), now: day(5) })
  check('一口气结到第 5 天：3 天宽限 + 第 4、5 天各 −2 = 4', gapOnce.delta, 4)
  check('一口气结到第 5 天：300−4=296', gapOnce.score, 296)
  const twice = settleDecay({
    score: gapOnce.score,
    lastActiveAt: day(0),
    lastSettledDay: gapOnce.settledDay,
    now: day(5),
  })
  check('同一天再结算一次：不重复扣', twice.delta, 0)
  check('同一天再结算一次：分数不变', twice.score, 296)
  check('结算日推进到今天', gapOnce.settledDay, dayKeyOf(day(5)))

  // 第 4~15 天累计：4 天×2 + 7 天×5 + 1 天×8
  const longGap = settleDecay({ score: 300, lastActiveAt: day(0), lastSettledDay: dayKeyOf(day(0)), now: day(15) })
  check('第 0 天到第 15 天累计扣 51', longGap.delta, 51)

  // 不转负
  const floorZero = settleDecay({ score: 5, lastActiveAt: day(0), lastSettledDay: dayKeyOf(day(0)), now: day(15) })
  check('分数不会回落成负数', floorZero.score, 0)
  check('最多扣到 0，delta 是实际扣掉的', floorZero.delta, 5)

  // 负分不自动「和好」
  const negative = settleDecay({ score: -50, lastActiveAt: day(0), lastSettledDay: dayKeyOf(day(0)), now: day(20) })
  check('负分不回落（吵架不会自己好）', negative.score, -50)
  check('负分 delta 0', negative.delta, 0)

  // 没有互动记录 → 不回落（没有基准，不能瞎扣）
  const noActivity = settleDecay({ score: 300, lastActiveAt: 0, lastSettledDay: '', now: day(10) })
  check('没有互动记录不回落', noActivity.delta, 0)

  // 非法结算日 → 从今天起算，不许把陈年旧账一次扣光
  const legacy = settleDecay({ score: 300, lastActiveAt: day(0), lastSettledDay: 'garbage', now: day(10) })
  check('非法结算日从今天起算（本次不扣）', legacy.delta, 0)

  // 互动会把回落的钟拨回去：上次结算 3 天前，但今天聊过 → 不扣
  const interacted = settleDecay({ score: 300, lastActiveAt: day(10), lastSettledDay: dayKeyOf(day(0)), now: day(10) })
  check('今天互动过 → 本次不扣', interacted.delta, 0)
}

// ══════════════════════════════════════════════════════════════
group('⭐ 单次上限与边际递减')

{
  const up10 = applyEvent({ score: 300, delta: 10, at: BASE })
  check('单次 +10 只加 4', up10.applied, 4)
  check('单次 +10 落分 304', up10.score, 304)
  check('被单次上限截断标记 capped', up10.capped, true)

  const down20 = applyEvent({ score: 300, delta: -20, at: BASE })
  check('单次 −20 只扣 12', down20.applied, -12)
  check('单次 −20 落分 288', down20.score, 288)
  check('负向截断也标 capped', down20.capped, true)

  check('−3 不截断', applyEvent({ score: 300, delta: -3, at: BASE }).applied, -3)
  check('+3 不截断', applyEvent({ score: 300, delta: 3, at: BASE }).capped, false)

  const mid = applyEvent({ score: 800, delta: 4, at: BASE })
  check('800 分时 +4 只加 3（×0.75）', mid.applied, 3)
  check('800 分时落分 803', mid.score, 803)

  const high = applyEvent({ score: 1000, delta: 4, at: BASE })
  check('1000 分时 +4 只加 2（×0.5）', high.applied, 2)
  check('1000 分时落分 1002', high.score, 1002)

  check('599 分还是满额 +4', applyEvent({ score: 599, delta: 4, at: BASE }).applied, 4)
  check('600 分开始打七五折', applyEvent({ score: 600, delta: 4, at: BASE }).applied, 3)
  check('899 分仍是七五折', applyEvent({ score: 899, delta: 4, at: BASE }).applied, 3)
  check('900 分开始砍半', applyEvent({ score: 900, delta: 4, at: BASE }).applied, 2)

  check('delta 0 什么都不做', applyEvent({ score: 300, delta: 0, at: BASE }).applied, 0)

  // 分数域夹紧
  const top = applyEvent({ score: 1199, delta: 4, at: BASE })
  check('顶到 1200 就不再涨', top.score, 1200)
  check('顶上只拿到 1 分', top.applied, 1)
  const bottom = applyEvent({ score: -1195, delta: -12, at: BASE })
  check('底到 −1200 就不再掉', bottom.score, -1200)
  check('底部只掉 5 分', bottom.applied, -5)
}

// ══════════════════════════════════════════════════════════════
group('⭐ 每日正向上限')

{
  const dayKey = dayKeyOf(BASE)
  check('今天已涨 8，再 +4 刚好到 12', applyEvent({
    score: 300, delta: 4, at: BASE, todayPositive: 8, todayPositiveDay: dayKey,
  }).applied, 4)
  const room2 = applyEvent({ score: 300, delta: 4, at: BASE, todayPositive: 10, todayPositiveDay: dayKey })
  check('今天只差 2 分额度 → 只加 2', room2.applied, 2)
  check('被每日上限截断标记 capped', room2.capped, true)
  const full = applyEvent({ score: 300, delta: 4, at: BASE, todayPositive: 12, todayPositiveDay: dayKey })
  check('今天已满 12 → 加不动', full.applied, 0)
  check('加不动也标 capped', full.capped, true)
  check('加不动分数不变', full.score, 300)

  const otherDay = applyEvent({
    score: 300, delta: 4, at: BASE, todayPositive: 12, todayPositiveDay: dayKeyOf(day(-1)),
  })
  check('跨天额度重置（昨天的累计不算今天）', otherDay.applied, 4)

  const customCap = applyEvent({ score: 300, delta: 4, at: BASE, config: { relation: { dailyGainCap: 5 } } })
  check('每日上限可配（5）', customCap.applied, 4)
  const customRoom = applyEvent({
    score: 300, delta: 4, at: BASE, todayPositive: 4, todayPositiveDay: dayKey,
    config: { relation: { dailyGainCap: 5 } },
  })
  check('自定义上限下只剩 1 分额度', customRoom.applied, 1)
}

// ══════════════════════════════════════════════════════════════
group('⭐ 同一消息同一原因 30 分钟去重')

{
  const ledger = [{ eventKey: '', reason: '夸她', delta: 4, scoreBefore: 300, scoreAfter: 304, at: BASE - 10 * 60 * 1000 }]
  const duplicated = applyEvent({ score: 304, delta: 4, reason: '夸她', at: BASE, recentLedger: ledger })
  check('30 分钟内同一 reason 第二次不记', duplicated.applied, 0)
  check('去重标记 deduped', duplicated.deduped, true)
  check('去重时分数不变', duplicated.score, 304)

  const expired = applyEvent({ score: 304, delta: 4, reason: '夸她', at: BASE, recentLedger: [
    { eventKey: '', reason: '夸她', delta: 4, at: BASE - 31 * 60 * 1000 },
  ] })
  check('超过 30 分钟可以再记', expired.applied, 4)

  const otherReason = applyEvent({ score: 304, delta: 4, reason: '帮了大忙', at: BASE, recentLedger: ledger })
  check('不同 reason 不去重', otherReason.applied, 4)

  const keyed = applyEvent({
    score: 304,
    delta: 4,
    reason: '换了措辞',
    at: BASE,
    eventKey: 'm1:夸她',
    recentLedger: [{ eventKey: 'm1:夸她', reason: '夸她', delta: 4, at: BASE - 60 * 1000 }],
  })
  check('同一 eventKey 即使 reason 不同也去重', keyed.applied, 0)

  const anon = applyEvent({
    score: 304, delta: 4, reason: '', at: BASE,
    recentLedger: [{ eventKey: '', reason: '', delta: 4, at: BASE - 1000 }],
  })
  check('没给 reason/eventKey 时不去重（不能把匿名事件合并成一条）', anon.applied, 4)

  const customWindow = applyEvent({
    score: 304, delta: 4, reason: '夸她', at: BASE,
    recentLedger: [{ eventKey: '', reason: '夸她', delta: 4, at: BASE - 20 * 60 * 1000 }],
    config: { relation: { dedupeMs: 10 * 60 * 1000 } },
  })
  check('去重窗口可配（10 分钟 → 20 分钟前的能再记）', customWindow.applied, 4)
}

// ══════════════════════════════════════════════════════════════
group('⭐ 归因分离：只有用户的行为能扣分')

{
  const bot = applyEvent({ score: 300, delta: -12, attribution: 'bot', at: BASE })
  check('她自己的情绪不能扣用户的分', bot.applied, 0)
  check('被归因拦下时分数不变', bot.score, 300)
  check('标记 dropped', bot.dropped, true)

  const system = applyEvent({ score: 300, delta: -8, attribution: 'system', at: BASE })
  check('系统/模型跑偏也不能扣', system.applied, 0)

  const user = applyEvent({ score: 300, delta: -12, attribution: 'user', at: BASE })
  check('用户自己干的事照扣', user.applied, -12)
  check('用户负向落分 288', user.score, 288)

  const botUp = applyEvent({ score: 300, delta: 4, attribution: 'bot', at: BASE })
  check('非用户归因的正向照涨', botUp.applied, 4)
  check('非用户归因正向不标 dropped', botUp.dropped, false)
}

// ══════════════════════════════════════════════════════════════
group('阶段标签')

{
  ok('每个阶段都有标签', PHASES.every((phase) => Boolean(phaseTagOf(phase))), JSON.stringify(PHASES.map((p) => phaseTagOf(p))))
  check('familiar → 熟人', phaseTagOf('familiar'), '熟人')
  check('非法阶段 → 空串', phaseTagOf('nope'), '')
}

// ══════════════════════════════════════════════════════════════
group('RelationStore：新人、apply、原子写、重启后还在')

{
  const dir = path.join(workDir, 'basic')
  const clock = makeClock(day(0))
  const configRoot = { relation: {} }
  const store = makeStore({ dir, configRoot, clock })

  const fresh = store.get('9001')
  check('新人阶段 acquaintance', fresh.phase, 'acquaintance')
  check('新人分数 0', fresh.score, 0)
  check('新人账本为空', fresh.ledger.length, 0)
  check('新人中文标签', fresh.label, '认识')
  ok('只读不落盘', !fs.existsSync(path.join(dir, 'relation', '9001.json')))

  const applied = await store.apply({ userId: '9001', delta: 4, reason: '主动打招呼', eventKey: 'm1:hi' })
  check('apply 返回 applied', applied.applied, 4)
  check('apply 返回 score', applied.score, 4)
  check('apply 返回阶段', applied.phase, 'acquaintance')

  const snapshot = store.get('9001')
  check('账本一条', snapshot.ledger.length, 1)
  check('账本 eventKey', snapshot.ledger[0].eventKey, 'm1:hi')
  check('账本 reason', snapshot.ledger[0].reason, '主动打招呼')
  check('账本 delta', snapshot.ledger[0].delta, 4)
  check('账本 scoreBefore', snapshot.ledger[0].scoreBefore, 0)
  check('账本 scoreAfter', snapshot.ledger[0].scoreAfter, 4)
  check('账本 at', snapshot.ledger[0].at, day(0))

  const file = path.join(dir, 'relation', '9001.json')
  ok('状态文件已落盘', fs.existsSync(file))
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  check('磁盘分数', raw.score, 4)
  check('磁盘阶段', raw.phase, 'acquaintance')
  check('磁盘账本长度', raw.ledger.length, 1)
  const leftovers = fs.readdirSync(path.join(dir, 'relation')).filter((name) => name.endsWith('.tmp'))
  check('没有残留 .tmp', leftovers.length, 0)

  // 重启（新实例）后状态还在
  const store2 = makeStore({ dir, configRoot, clock })
  const reloaded = store2.get('9001')
  check('重启后分数还在', reloaded.score, 4)
  check('重启后账本还在', reloaded.ledger.length, 1)

  // 空 userId 不炸、也不写文件
  const empty = await store.apply({ userId: '', delta: 4, reason: '空' })
  check('空 userId 的 apply 不生效', empty.applied, 0)
  const files = fs.readdirSync(path.join(dir, 'relation'))
  check('空 userId 不产生文件', files.length, 1)
}

// ══════════════════════════════════════════════════════════════
group('RelationStore：每日上限与跨天重置')

{
  const dir = path.join(workDir, 'daily')
  const clock = makeClock(day(0))
  const store = makeStore({ dir, configRoot: { relation: {} }, clock })

  check('第一笔 +4', (await store.apply({ userId: '9002', delta: 4, reason: 'a' })).score, 4)
  check('第二笔 +8', (await store.apply({ userId: '9002', delta: 4, reason: 'b' })).score, 8)
  check('第三笔 +12', (await store.apply({ userId: '9002', delta: 4, reason: 'c' })).score, 12)
  const blocked = await store.apply({ userId: '9002', delta: 4, reason: 'd' })
  check('第四笔：当天额度用完 → 不加', blocked.applied, 0)
  check('第四笔：capped', blocked.capped, true)
  check('第四笔：分数仍是 12', blocked.score, 12)
  check('被上限挡掉的不进账本', store.get('9002').ledger.length, 3)

  clock.set(day(1))
  const nextDay = await store.apply({ userId: '9002', delta: 4, reason: 'e' })
  check('跨天后额度重置，+16', nextDay.score, 16)
  check('跨天这一笔真的加了', nextDay.applied, 4)
}

// ══════════════════════════════════════════════════════════════
group('RelationStore：去重（同一条消息只记一次）')

{
  const dir = path.join(workDir, 'dedupe')
  const clock = makeClock(day(0))
  const store = makeStore({ dir, configRoot: { relation: {} }, clock })

  const first = await store.apply({ userId: '9003', delta: 4, reason: '亲昵称呼' })
  check('第一次记 4 分', first.score, 4)
  clock.advance(60 * 1000)
  const second = await store.apply({ userId: '9003', delta: 4, reason: '亲昵称呼' })
  check('1 分钟后同一 reason 不再记', second.applied, 0)
  check('去重标记', second.deduped, true)
  check('分数不变', second.score, 4)
  check('账本只有一条', store.get('9003').ledger.length, 1)

  clock.advance(31 * 60 * 1000)
  const third = await store.apply({ userId: '9003', delta: 4, reason: '亲昵称呼' })
  check('超过 30 分钟可以再记', third.applied, 4)
  check('分数到 8', third.score, 8)
}

// ══════════════════════════════════════════════════════════════
group('RelationStore：归因分离（账本里不许出现冤枉用户的负分）')

{
  const dir = path.join(workDir, 'attribution')
  const clock = makeClock(day(0))
  const store = makeStore({ dir, configRoot: { relation: {} }, clock })

  await store.apply({ userId: '9004', delta: 4, reason: '打招呼' })
  const bot = await store.apply({ userId: '9004', delta: -12, reason: '她自己不高兴', attribution: 'bot' })
  check('bot 归因负向不扣', bot.applied, 0)
  check('bot 归因分数不变', bot.score, 4)
  const system = await store.apply({ userId: '9004', delta: -8, reason: '模型跑偏', attribution: 'system' })
  check('system 归因负向不扣', system.applied, 0)
  check('冤枉用户的负分不进账本', store.get('9004').ledger.length, 1)

  const first = await store.apply({ userId: '9004', delta: -12, reason: '骂人', attribution: 'user' })
  check('用户作恶照扣', first.score, -8)
  check('用户负向进账本', store.get('9004').ledger.length, 2)

  // 迟滞在负分侧同样生效：−8 还在 [−20, 0) 的黏着带里，掉不到疏离
  check('−8 还没跌破黏着带，仍是 acquaintance', store.get('9004').phase, 'acquaintance')
  await store.apply({ userId: '9004', delta: -12, reason: '又骂人', attribution: 'user' })
  check('扣到 −20 仍是 acquaintance', store.get('9004').phase, 'acquaintance')
  await store.apply({ userId: '9004', delta: -12, reason: '还骂人', attribution: 'user' })
  const distant = await store.apply({ userId: '9004', delta: -12, reason: '继续骂', attribution: 'user' })
  check('跌破 −20 才到疏离', distant.phase, 'distant')
}

// ══════════════════════════════════════════════════════════════
group('⭐ 回落（RelationStore）：同一天只扣一次，跨实例也幂等')

{
  const dir = path.join(workDir, 'decay')
  const clock = makeClock(day(0))
  const configRoot = { relation: { initial: 300 } }
  const store = makeStore({ dir, configRoot, clock })

  const uid = '9010'
  await store.apply({ userId: uid, delta: 4, reason: '见面' })
  check('先到 304', store.get(uid).score, 304)

  clock.set(day(10))
  const settled = await store.settle(uid)
  // 第 4~7 天每天 −2（共 8），第 8~10 天每天 −5（共 15）→ 一共 23
  check('第 10 天结算掉 23 分', settled.delta, 23)
  check('结算后 281', settled.score, 281)

  const again = await store.settle(uid)
  check('同一天再结算：不再扣', again.delta, 0)
  check('同一天再结算：分数不变', again.score, 281)

  const store2 = makeStore({ dir, configRoot, clock })
  const afterRestart = await store2.settle(uid)
  check('换实例（模拟重启）同一天也不重复扣', afterRestart.delta, 0)
  check('重启后分数一致', afterRestart.score, 281)

  // 真正跨天才会再扣
  clock.set(day(11))
  const nextDay = await store2.settle(uid)
  check('第 11 天再扣 5', nextDay.delta, 5)
  check('第 11 天分数 276', nextDay.score, 276)
}

// ══════════════════════════════════════════════════════════════
group('⭐ 主人地板：永远到不了疏离')

{
  const dir = path.join(workDir, 'owner')
  const clock = makeClock(day(0))
  const configRoot = { owner: { qq: '111', aliases: ['222', 333] }, relation: {} }
  const store = makeStore({ dir, configRoot, clock })

  const owner = store.get('111')
  check('主人一上来就是 close(600)', owner.score, 600)
  check('主人阶段 close', owner.phase, 'close')
  check('主人中文标签', owner.label, '亲近')

  const insult = await store.apply({ userId: '111', delta: -12, reason: '吵架' })
  check('主人扣分被地板挡住 applied=0', insult.applied, 0)
  check('主人分数还是 600', insult.score, 600)
  check('主人阶段还是 close', insult.phase, 'close')
  check('被地板挡掉的负分不进账本', store.get('111').ledger.length, 0)

  for (let i = 0; i < 10; i += 1) {
    await store.apply({ userId: '111', delta: -12, reason: `吵第 ${i + 1} 次` })
  }
  check('连扣 10 次仍是 close', store.get('111').score, 600)
  check('连扣 10 次阶段仍是 close', store.get('111').phase, 'close')

  check('别名也认（字符串）', store.get('222').score, 600)
  check('别名也认（数字）', store.get('333').score, 600)
  check('普通人不受地板影响', store.get('555').score, 0)
  check('普通人阶段 acquaintance', store.get('555').phase, 'acquaintance')

  // 长期不互动也不掉地板
  clock.set(day(60))
  await store.settle('111')
  check('60 天不互动主人仍是 close', store.get('111').score, 600)
  check('60 天不互动主人阶段仍是 close', store.get('111').phase, 'close')

  // 历史脏数据（旧版本分数 0）读出来也要被抬到地板
  const seededDir = path.join(workDir, 'owner-seed')
  fs.mkdirSync(path.join(seededDir, 'relation'), { recursive: true })
  fs.writeFileSync(
    path.join(seededDir, 'relation', '444.json'),
    JSON.stringify({ version: 1, userId: '444', score: 0, phase: 'distant', lastActiveAt: 0, updatedAt: 1 }),
    'utf8',
  )
  const seedClock = makeClock(day(0))
  const seededStore = makeStore({ dir: seededDir, configRoot: { owner: { qq: '444' } }, clock: seedClock })
  const seeded = seededStore.get('444')
  check('脏数据里的主人分数被抬到 600', seeded.score, 600)
  check('脏数据里的主人阶段被抬到 close', seeded.phase, 'close')
}

// ══════════════════════════════════════════════════════════════
group('RelationStore：账本上限')

{
  const dir = path.join(workDir, 'ledger')
  const clock = makeClock(day(0))
  const configRoot = { relation: { dailyGainCap: 100, ledgerMax: 5 } }
  const store = makeStore({ dir, configRoot, clock })

  for (let i = 1; i <= 7; i += 1) {
    await store.apply({ userId: '7001', delta: 1, reason: `r${i}` })
  }
  const ledger = store.get('7001').ledger
  check('账本只留最近 5 条', ledger.length, 5)
  check('最旧的是 r3', ledger[0].reason, 'r3')
  check('最新的是 r7', ledger[ledger.length - 1].reason, 'r7')
  check('分数累计 7', store.get('7001').score, 7)
}

// ══════════════════════════════════════════════════════════════
group('RelationStore：touch 拨回回落钟')

{
  const dir = path.join(workDir, 'touch')
  const clock = makeClock(day(0))
  const configRoot = { relation: { initial: 300 } }
  const store = makeStore({ dir, configRoot, clock })

  // 有 touch：第 3 天聊过天 → 第 5 天结算只按最近一次互动算，还在宽限期
  await store.apply({ userId: '8003', delta: 1, reason: '初次见面' })
  clock.set(day(3))
  store.touch('8003')
  clock.set(day(5))
  const touched = await store.settle('8003')
  check('touch 之后第 5 天不扣（宽限期重新起算）', touched.delta, 0)
  check('touch 之后分数不变', touched.score, 301)

  // 没 touch：同样的时间线，第 4~5 天要扣 4 分
  // （注意先把钟拨回第 0 天才 apply —— 否则等于「第 5 天才见面」，当然不会扣）
  clock.set(day(0))
  await store.apply({ userId: '8004', delta: 1, reason: '初次见面' })
  clock.set(day(5))
  const untouched = await store.settle('8004')
  check('没互动的对照：扣 4 分', untouched.delta, 4)
  check('没互动的对照：301−4=297', untouched.score, 297)

  // 只是群里冒过一句的陌生人：内存里记活跃时间，但不建关系文件（数据目录别被路人占满）
  const strangerDir = path.join(workDir, 'touch-stranger')
  const strangerStore = makeStore({ dir: strangerDir, configRoot: { relation: {} }, clock: makeClock(day(0)) })
  strangerStore.touch('8010')
  check('陌生人只 touch 不建关系文件',
    fs.existsSync(path.join(strangerDir, 'relation', '8010.json')), false)
}

// ══════════════════════════════════════════════════════════════
group('⭐ 阶段在存储层也守迟滞（重启不丢「上一阶段」）')

{
  const dir = path.join(workDir, 'hysteresis-store')
  const clock = makeClock(day(0))
  const configRoot = { relation: { initial: 199, dailyGainCap: 100 } }
  const store = makeStore({ dir, configRoot, clock })

  check('199 分是 acquaintance', store.get('6001').phase, 'acquaintance')
  const up = await store.apply({ userId: '6001', delta: 4, reason: '聊得很好' })
  check('199 +4 = 203 升到 familiar', up.phase, 'familiar')
  check('升段标记 changed', up.changed, true)

  const down = await store.apply({ userId: '6001', delta: -12, reason: '闹别扭' })
  check('203 −12 = 191 仍在黏着带 → 仍是 familiar', down.phase, 'familiar')
  check('分数 191', down.score, 191)

  const store2 = makeStore({ dir, configRoot, clock })
  check('重启后 191 仍是 familiar（阶段是持久化状态）', store2.get('6001').phase, 'familiar')

  const drop = await store2.apply({ userId: '6001', delta: -12, reason: '又吵' })
  check('179 才降回 acquaintance', drop.phase, 'acquaintance')
}

// ══════════════════════════════════════════════════════════════
group('⭐ renderForMind：companion 注入，work 只记不外露')

{
  const dir = path.join(workDir, 'mind')
  const clock = makeClock(day(0))
  const configRoot = { owner: { qq: '111' }, relation: {}, modes: { default: 'companion' } }
  const store = makeStore({ dir, configRoot, clock })

  const guestLine = store.renderForMind({ userId: '555' })
  ok('普通用户有注入话', guestLine.length > 0, guestLine)
  ok('注入里带阶段中文名', guestLine.includes('认识'), guestLine)
  ok('注入里带「关系」', guestLine.includes('关系'), guestLine)
  ok('结尾提醒别念出来', guestLine.includes('别把这段念出来'), guestLine)

  const ownerLine = store.renderForMind({ userId: '111' })
  ok('主人视角说「主人」', ownerLine.includes('主人'), ownerLine)
  ok('主人是 close 文案', ownerLine.includes('亲近'), ownerLine)
  ok('普通人视角说「这个人」', guestLine.includes('这个人'), guestLine)

  // work：账照记，但不注入
  configRoot.modes = { default: 'work' }
  check('work 模式默认不注入', store.renderForMind({ userId: '555' }), '')
  const recorded = await store.apply({ userId: '555', delta: 4, reason: '干活时也记一笔' })
  check('work 模式仍然记账', recorded.applied, 4)
  check('work 模式账本也在长', store.get('555').ledger.length, 1)

  // 按对话覆盖：这个群纯干活，私聊还是陪伴
  configRoot.modes = { default: 'companion', peers: { 'group-5': 'work' } }
  check('work 群不注入', store.renderForMind({ userId: '555', peerKey: 'group-5' }), '')
  ok('私聊照常注入', store.renderForMind({ userId: '555', peerKey: 'private-555' }).length > 0)

  // 直接给 mode（上层手上就有 decision.mode 时）
  configRoot.modes = { default: 'companion' }
  check('显式传 work 也不注入', store.renderForMind({ userId: '555', mode: 'work' }), '')
  ok('显式传 companion 正常注入', store.renderForMind({ userId: '555', mode: 'companion' }).length > 0)

  // enabled=false：彻底关掉
  configRoot.relation = { enabled: false }
  check('relation.enabled=false 不注入', store.renderForMind({ userId: '555' }), '')
  const disabled = await store.apply({ userId: '555', delta: 4, reason: '关掉后' })
  check('relation.enabled=false 不记账', disabled.applied, 0)
  check('relation.enabled=false 标 dropped', disabled.dropped, true)
  configRoot.relation = {}

  // 不同阶段用不同语气
  configRoot.relation = { initial: 1500 }
  const bondedLine = store.renderForMind({ userId: '7777' })
  ok('1500 分（真人极限）注入深联结文案', bondedLine.includes('深联结'), bondedLine)
  configRoot.relation = { initial: 300 }
  ok('300 分注入熟悉文案', store.renderForMind({ userId: '7778' }).includes('熟悉'))
}

// ══════════════════════════════════════════════════════════════
group('RelationStore：统计面板')

{
  const dir = path.join(workDir, 'stats')
  const clock = makeClock(day(0))
  const store = makeStore({ dir, configRoot: { owner: { qq: '111' }, relation: {} }, clock })

  await store.apply({ userId: '555', delta: 4, reason: '打招呼' })
  await store.apply({ userId: '111', delta: -12, reason: '吵一句' })
  await store.apply({ userId: '666', delta: 4, reason: '打招呼' })

  const stats = store.stats()
  check('统计到三个人', stats.users, 3)
  check('owner 是 close', stats.byPhase.close, 1)
  check('两个普通人 acquaintance', stats.byPhase.acquaintance, 2)
  check('账本总条数（主人被地板挡住不算）', stats.ledgerEntries, 2)
  check('平均分 (600+4+4)/3 = 202.67', stats.avgScore, 202.67)
  check('最高分 600', stats.maxScore, 600)
  check('最低分 4', stats.minScore, 4)

  const emptyStore = makeStore({ dir: path.join(workDir, 'stats-empty'), configRoot: {}, clock })
  const emptyStats = emptyStore.stats()
  check('空目录也能统计', emptyStats.users, 0)
  check('空目录平均分 0', emptyStats.avgScore, 0)
}

// ══════════════════════════════════════════════════════════════
group('RelationStore：坏数据与文件名安全')

{
  const dir = path.join(workDir, 'corrupt')
  fs.mkdirSync(path.join(dir, 'relation'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'relation', '9999.json'), '这不是 JSON{{{', 'utf8')
  const clock = makeClock(day(0))
  const store = makeStore({ dir, configRoot: { relation: {} }, clock })
  const corrupted = store.get('9999')
  check('坏文件当新人处理（不炸）', corrupted.score, 0)
  check('坏文件阶段 acquaintance', corrupted.phase, 'acquaintance')

  const safeStore = makeStore({ dir: path.join(workDir, 'safe-name'), configRoot: { relation: {} }, clock })
  await safeStore.apply({ userId: '../evil', delta: 4, reason: '路径注入' })
  ok('userId 里的 ../ 不会逃出 relation 目录', !fs.existsSync(path.join(workDir, 'safe-name', 'evil.json')))
  const safeFiles = fs.readdirSync(path.join(workDir, 'safe-name', 'relation'))
  check('文件确实写在 relation/ 里面', safeFiles.length, 1)
}

// ══════════════════════════════════════════════════════════════
fs.rmSync(workDir, { recursive: true, force: true })

report('关系账本（阶段 / 迟滞 / 回落 / 上限 / 去重 / 归因 / 主人地板）')
