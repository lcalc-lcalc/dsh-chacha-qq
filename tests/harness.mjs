/**
 * 迷你测试框架：够用就好，不引依赖。
 * 每个 check 失败不中断，最后统一汇总。
 *
 * 用法：
 *   import { group, check, ok, throws, report } from './harness.mjs'
 *   group('路由：主人')
 *   check('身份判定', decideRoute(msg, cfg).role, 'owner')
 *   report('路由套件')
 */

const results = []
let currentGroup = '(未分组)'

export function group(name) {
  currentGroup = name
  results.push({ kind: 'group', name })
}

export function check(name, actual, expected) {
  const pass = deepEqual(actual, expected)
  results.push({ kind: 'check', group: currentGroup, name, pass, actual, expected })
  return pass
}

export function ok(name, condition, detail = '') {
  results.push({
    kind: 'check',
    group: currentGroup,
    name,
    pass: Boolean(condition),
    actual: detail || Boolean(condition),
    expected: 'truthy',
  })
  return Boolean(condition)
}

export function notOk(name, condition, detail = '') {
  return ok(name, !condition, detail)
}

export function throws(name, fn, matcher) {
  try {
    fn()
    results.push({ kind: 'check', group: currentGroup, name, pass: false, actual: '没有抛错', expected: matcher ?? '抛错' })
    return false
  } catch (error) {
    const message = String(error?.message ?? error)
    const pass = matcher === undefined ? true : message.includes(matcher)
    results.push({ kind: 'check', group: currentGroup, name, pass, actual: message, expected: matcher ?? '抛错' })
    return pass
  }
}

/** 异步版本的 throws。 */
export async function rejects(name, fn, matcher) {
  try {
    await fn()
    results.push({ kind: 'check', group: currentGroup, name, pass: false, actual: '没有抛错', expected: matcher ?? '抛错' })
    return false
  } catch (error) {
    const message = String(error?.message ?? error)
    const pass = matcher === undefined ? true : message.includes(matcher)
    results.push({ kind: 'check', group: currentGroup, name, pass, actual: message, expected: matcher ?? '抛错' })
    return pass
  }
}

/** 固定种子的伪随机，测试里不要用 Math.random。 */
export function seededRng(seed = 1) {
  let state = seed >>> 0
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((key) => deepEqual(a[key], b[key]))
}

export function report(title = '测试') {
  let passed = 0
  let failed = 0
  const lines = []
  for (const item of results) {
    if (item.kind === 'group') {
      lines.push(`\n── ${item.name} ──`)
      continue
    }
    if (item.pass) {
      passed++
      lines.push(`  ✓ ${item.name}`)
    } else {
      failed++
      lines.push(`  ✗ ${item.name}`)
      lines.push(`      实际: ${JSON.stringify(item.actual)}`)
      lines.push(`      期望: ${JSON.stringify(item.expected)}`)
    }
  }
  console.log(`\n${title}`)
  console.log(lines.join('\n'))
  console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed}，失败 ${failed}，共 ${passed + failed} 项\n`)
  if (failed > 0) process.exitCode = 1
  return failed === 0
}
