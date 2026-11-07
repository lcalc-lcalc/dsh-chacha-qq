/**
 * 模式（Mode）测试 —— 这是所有「好玩但费钱」功能的总开关。
 *
 * 主人原话：「我可能有时候要她纯干活，加日程影响工作加大消耗，但是日程真非常好玩」
 * 所以这里必须钉死两件事：
 *   ① work 模式下，日程/主动消息/盗图**一次都不许跑**（省的不是一点半点）
 *   ② 开关要能按对话覆盖（某个群纯干活，别的地方照常陪伴）
 */
import { group, check, ok, notOk, report } from './harness.mjs'

import {
  MODE,
  MODES,
  featureMode,
  isOff,
  isOn,
  isRecordOnly,
  modeMatrix,
  normalizePeerKey,
  resolveMode,
} from '../src/modes.js'

// ══════════════════════════════════════════════════════════════
group('常量')

check('两种模式', MODES, ['companion', 'work'])
check('COMPANION 字面量', MODE.COMPANION, 'companion')
check('WORK 字面量', MODE.WORK, 'work')

// ══════════════════════════════════════════════════════════════
group('peerKey 归一化（一个群一个模式，不按发言人拆）')

check('私聊原样', normalizePeerKey('private-1111111111'), 'private-1111111111')
check('群聊去角色', normalizePeerKey('group-123456-owner'), 'group-123456')
check('群聊去角色（guest）', normalizePeerKey('group-123456-guest'), 'group-123456')
check('群聊本来就没角色', normalizePeerKey('group-123456'), 'group-123456')
check('空值', normalizePeerKey(''), '')
check('null', normalizePeerKey(null), '')

// ══════════════════════════════════════════════════════════════
group('resolveMode：三层优先级')

{
  const config = {
    modes: {
      default: 'companion',
      peers: {
        'group-111': 'work',
        'private-222': 'companion',
        'group-333-owner': 'work', // 带角色写的，也要能命中
      },
    },
  }

  check('默认跟随', resolveMode('private-999', config), 'companion')
  check('群里纯干活', resolveMode('group-111', config), 'work')
  check('群里纯干活（带角色也认）', resolveMode('group-111-owner', config), 'work')
  check('单独指定陪伴', resolveMode('private-222', config), 'companion')
  check('带角色精确命中', resolveMode('group-333-owner', config), 'work')
  check('归一化后也能命中', resolveMode('group-333-guest', config), 'work')
}

{
  // 没配 modes 时默认陪伴
  check('没配置时默认 companion', resolveMode('private-1', {}), 'companion')
  check('配置为空对象', resolveMode('private-1', { modes: {} }), 'companion')
  check('默认值非法时兜底 companion', resolveMode('private-1', { modes: { default: 'nonsense' } }), 'companion')
  check('peer 值非法时忽略，回落默认', resolveMode('group-1', {
    modes: { default: 'work', peers: { 'group-1': '乱写' } },
  }), 'work')
}

{
  // 全局 work 时，单独把主人私聊设成 companion
  const config = { modes: { default: 'work', peers: { 'private-1111111111': 'companion' } } }
  check('全局纯干活', resolveMode('group-9', config), 'work')
  check('主人私聊例外', resolveMode('private-1111111111', config), 'companion')
}

// ══════════════════════════════════════════════════════════════
group('功能矩阵：companion 全开')

{
  const config = { modes: { default: 'companion', peers: {} } }
  const peer = 'private-1'

  for (const feature of ['schedule', 'life', 'emotion', 'proactive', 'memeSend', 'memeSteal', 'relation']) {
    ok(`companion 下 ${feature} 开着`, isOn(feature, peer, config), String(featureMode(feature, peer, config)))
  }
}

// ══════════════════════════════════════════════════════════════
group('⭐ 功能矩阵：work 模式省钱（主人最在意的）')

{
  const config = { modes: { default: 'work', peers: {} } }
  const peer = 'group-111'

  // 这三项是「真正花钱」的：日程要一次模型调用、主动消息要一次、盗图要一次视觉调用
  ok('⭐ work 下日程不跑（省模型调用）', isOff('schedule', peer, config), String(featureMode('schedule', peer, config)))
  ok('⭐ work 下主动消息不跑', isOff('proactive', peer, config))
  ok('⭐ work 下盗图不跑', isOff('memeSteal', peer, config))

  // 这三项只记账，不外露（成本几乎为零，但状态要连续）
  check('work 下情绪只记账', featureMode('emotion', peer, config), 'record')
  check('work 下关系只记账', featureMode('relation', peer, config), 'record')
  check('work 下当日状态只记账', featureMode('life', peer, config), 'record')
  check('work 下表情包只发不收', featureMode('memeSend', peer, config), 'record')

  ok('isRecordOnly 认得出来', isRecordOnly('relation', peer, config))
  notOk('record 不算 on', isOn('relation', peer, config))
  notOk('record 不算 off', isOff('relation', peer, config))
}

// ══════════════════════════════════════════════════════════════
group('功能矩阵：按对话混合')

{
  const config = {
    modes: {
      default: 'companion',
      peers: { 'group-work': 'work' },
    },
  }

  ok('工作群日程关掉', isOff('schedule', 'group-work', config))
  ok('主人私聊日程开着', isOn('schedule', 'private-1111111111', config))
  ok('工作群里的情绪只记账', isRecordOnly('emotion', 'group-work', config))
  ok('主人私聊的情绪正常注入', isOn('emotion', 'private-1111111111', config))
}

// ══════════════════════════════════════════════════════════════
group('未知功能 / 缺参')

{
  check('未知功能默认放行（不认识的别拦）', featureMode('不存在的功能', 'private-1', {}), true)
  check('空 config 也能跑', resolveMode('private-1', undefined), 'companion')
  check('null config 也能跑', resolveMode('private-1', null), 'companion')
}

// ══════════════════════════════════════════════════════════════
group('面板用：矩阵摊开')

{
  const rows = modeMatrix()
  ok('有行', rows.length >= 7, `${rows.length} 个功能`)
  ok('每行都有 companion 和 work', rows.every((row) => 'companion' in row && 'work' in row))
  const schedule = rows.find((row) => row.feature === 'schedule')
  check('日程在 companion 下开', schedule.companion, true)
  check('日程在 work 下关', schedule.work, false)
  const relation = rows.find((row) => row.feature === 'relation')
  check('关系在 work 下只记账', relation.work, 'record')
}

// ══════════════════════════════════════════════════════════════
group('⭐ 功能总开关 features —— 一票否决')

{
  const base = (features = {}) => ({
    modes: { default: 'companion', peers: {} },
    features: { schedule: true, meme: true, emotion: true, peers: {}, ...features },
  })

  check('没配 features 时功能照旧（向后兼容）', isOn('meme', 'private-1', { modes: { default: 'companion', peers: {} } }), true)
  check('全局关掉 → 关', isOn('meme', 'private-1', base({ meme: false })), false)
  check(
    '总开关优先于模式（companion 开着也白搭）',
    isOn('meme', 'private-1', base({ meme: false })),
    false,
  )
  check(
    '全局关 + work 模式 = 双保险还是关',
    featureMode('schedule', 'group-1', {
      modes: { default: 'work', peers: {} },
      features: { schedule: false, peers: {} },
    }),
    false,
  )
  check('没被关的功能不受影响', isOn('emotion', 'private-1', base({ meme: false })), true)
}

// ══════════════════════════════════════════════════════════════
group('⭐ 按对话开关 features.peers —— 最具体的一层')

{
  const cfg = (peers, extra = {}) => ({
    modes: { default: 'companion', peers: {} },
    features: { schedule: true, meme: true, emotion: true, peers, ...extra },
  })

  check('某群单独关表情包', isOn('meme', 'group-9', cfg({ 'group-9': { meme: false } })), false)
  check('别的群不受影响', isOn('meme', 'group-8', cfg({ 'group-9': { meme: false } })), true)
  check('私聊也能单独关', isOn('meme', 'private-1', cfg({ 'private-1': { meme: false } })), false)

  check(
    '⭐ 全局关 + 某群单独开 → 该群打开（覆盖生效）',
    isOn('meme', 'group-9', {
      modes: { default: 'companion', peers: {} },
      features: { meme: false, peers: { 'group-9': { meme: true } } },
    }),
    true,
  )

  check(
    '群聊按群号归一：group-9-owner 也认 group-9 的覆盖',
    isOn('meme', 'group-9-owner', cfg({ 'group-9': { meme: false } })),
    false,
  )

  check(
    '显式 true 能绕过 work 模式的 record（主人说开就是要它真动）',
    isOn('emotion', 'group-9', {
      modes: { default: 'work', peers: {} },
      features: { peers: { 'group-9': { emotion: true } } },
    }),
    true,
  )

  check(
    '没配这个功能就走模式矩阵（不被别人的覆盖带偏）',
    featureMode('emotion', 'group-9', {
      modes: { default: 'work', peers: {} },
      features: { peers: { 'group-9': { meme: false } } },
    }),
    'record',
  )

  check(
    '覆盖值不是布尔时忽略（坏配置不许把功能意外关掉）',
    isOn('meme', 'group-9', cfg({ 'group-9': { meme: 'yes' } })),
    true,
  )
  check('peers 是空对象时一切照旧', isOn('meme', 'group-9', cfg({})), true)
}

report('模式总开关')
