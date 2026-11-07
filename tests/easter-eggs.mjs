/**
 * 🥚 彩蛋测试。
 *
 * 彩蛋也要有测试 —— 因为它跑在**每一轮对话**的上下文组装里，
 * 一旦它抛异常，整条回复就没了。测试要保证：
 *   1. 时间判断正确（只在 2:00~5:00）
 *   2. 概率真的低（不是每次都触发）
 *   3. 关掉开关就彻底静音
 *   4. 随机函数是坏的时候也不崩
 */
import { group, check, ok, notOk, report } from './harness.mjs'
import {
  STARTUP_LINES,
  SHUTDOWN_LINES,
  NIGHT_CARE_LINES,
  NOT_A_ROBOT_LINES,
  pickOne,
  isLateNight,
  maybeNightCare,
  eggsEnabled,
} from '../src/mind/easter-eggs.js'

group('彩蛋：语录库')

{
  ok('启动语录非空', STARTUP_LINES.length >= 5, STARTUP_LINES.length)
  ok('每条都是非空字符串', STARTUP_LINES.every((line) => typeof line === 'string' && line.trim()), STARTUP_LINES.join('|'))
  ok('下线语录非空', SHUTDOWN_LINES.length >= 3)
  ok('深夜关怀非空', NIGHT_CARE_LINES.length >= 4)
  ok('不是机器人语录非空', NOT_A_ROBOT_LINES.length >= 3)

  // 语录是「给她看的调味料」，不该出现 Markdown（QQ 不渲染）
  const all = [...STARTUP_LINES, ...SHUTDOWN_LINES, ...NIGHT_CARE_LINES, ...NOT_A_ROBOT_LINES]
  notOk('语录里没有 Markdown 星号', all.some((line) => line.includes('**')))
  notOk('语录里没有换行', all.some((line) => line.includes('\n')))
  ok('语录都不太长（<= 30 字）', all.every((line) => line.length <= 30), Math.max(...all.map((line) => line.length)))
}

group('彩蛋：pickOne')

{
  const lines = ['a', 'b', 'c']
  check('random=0 → 第一条', pickOne(lines, () => 0), 'a')
  check('random=0.5 → 中间', pickOne(lines, () => 0.5), 'b')
  check('random=0.99 → 最后一条', pickOne(lines, () => 0.99), 'c')
  // random 返回 1 时不能越界（有些人写 Math.random 的假实现会返回 1）
  check('random=1 不越界', pickOne(lines, () => 1), 'a')
  check('空数组 → 空串', pickOne([], () => 0), '')
  check('非数组 → 空串', pickOne(null, () => 0), '')
  check('数组里是 undefined 也不崩', pickOne([undefined], () => 0), '')
}

group('彩蛋：深夜判断（2:00~5:00）')

{
  const at = (hour, minute = 0) => new Date(2026, 10, 7, hour, minute, 0)

  ok('2:00 → 是深夜', isLateNight(at(2)))
  ok('3:30 → 是深夜', isLateNight(at(3, 30)))
  ok('4:59 → 是深夜', isLateNight(at(4, 59)))
  notOk('5:00 → 不是（天要亮了）', isLateNight(at(5)))
  notOk('1:59 → 不是（还没到最困的时候）', isLateNight(at(1, 59)))
  notOk('12:00 → 不是', isLateNight(at(12)))
  notOk('23:00 → 不是（睡前刷手机是正常的）', isLateNight(at(23)))
  notOk('0:00 → 不是（刚过零点还算早）', isLateNight(at(0)))

  // 时间戳也要能吃
  ok('时间戳也能判', isLateNight(at(3).getTime()))
}

group('彩蛋：深夜关怀（概率 + 开关）')

{
  const night = new Date(2026, 10, 7, 3, 0, 0)
  const day = new Date(2026, 10, 7, 15, 0, 0)

  // random 固定为 0 → 一定 < probability，必触发
  ok('深夜 + random=0 → 会说', maybeNightCare({ now: night, random: () => 0 }) !== '')
  // random 固定为 0.99 → 一定 >= probability，不触发
  check('深夜 + random=0.99 → 不说', maybeNightCare({ now: night, random: () => 0.99 }), '')
  // 白天永远不说
  check('白天 + random=0 → 也不说', maybeNightCare({ now: day, random: () => 0 }), '')
  // 总开关关掉 → 深夜也说不出
  check('关掉开关 → 静音', maybeNightCare({ now: night, random: () => 0, enabled: false }), '')
  // 概率为 0 → 永远不会说
  check('probability=0 → 静音', maybeNightCare({ now: night, random: () => 0, probability: 0 }), '')

  // 统计：跑 1000 次，默认 8% 概率，命中数应该在合理范围（不爆、不哑）
  let hits = 0
  for (let i = 0; i < 1000; i += 1) {
    if (maybeNightCare({ now: night }) !== '') hits += 1
  }
  ok(`1000 次里命中 ${hits} 次（期望 ~80，允许 30~180）`, hits >= 30 && hits <= 180, hits)

  // 说出来的话必须来自语录库
  ok('说出来的话来自语录库', NIGHT_CARE_LINES.includes(maybeNightCare({ now: night, random: () => 0 })))
}

group('彩蛋：总开关')

{
  check('默认开', eggsEnabled({}), true)
  check('没有 fun 段 → 开', eggsEnabled({ memory: {} }), true)
  check('fun.easterEggs=false → 关', eggsEnabled({ fun: { easterEggs: false } }), false)
  check('fun.easterEggs=true → 开', eggsEnabled({ fun: { easterEggs: true } }), true)
  check('传 null 也不崩', eggsEnabled(null), true)
}

report('彩蛋')
