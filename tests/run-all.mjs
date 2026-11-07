/**
 * 一键跑全部测试。
 * 自动发现 tests/ 下所有 *.mjs（排除 harness.mjs 和 run-all.mjs），
 * 每个套件独立进程跑，互不污染。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const SKIP = new Set(['harness.mjs', 'run-all.mjs'])
const suites = fs
  .readdirSync(here)
  .filter((name) => name.endsWith('.mjs') && !SKIP.has(name))
  .sort()

if (suites.length === 0) {
  console.error('没有找到任何测试套件')
  process.exit(1)
}

let failed = 0
const failedNames = []
for (const suite of suites) {
  console.log(`\n════════ ${suite} ════════`)
  const result = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' })
  if (result.status !== 0) {
    failed++
    failedNames.push(suite)
  }
}

if (failed > 0) {
  console.error(`\n❌ ${failed} 个套件失败：${failedNames.join(', ')}\n`)
  process.exit(1)
}
console.log(`\n✅ 全部套件通过（${suites.length} 个套件）\n`)
