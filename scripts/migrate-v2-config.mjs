/**
 * 从 v2 的 config.json 里搬走 v3 还能用的东西。
 *
 * 为什么需要它：
 *   v2 和 v3 **共用同一个数据目录**（`~/.dsh/plugins/dsh-chacha-qq`），
 *   所以升级后读到的还是 v2 写的那份 `config.json`。
 *   键名对不上的字段会被 ConfigStore 的「向前兼容」逻辑**保留下来但没人读** ——
 *   不会丢，但也不生效。人格（`brain.personaOverride`）就是最典型的一个：
 *   不搬过去，主人重启后会发现自己写的一大段设定「消失了」（其实躺在文件里）。
 *
 * 只搬「语义没变」的，不硬凑：
 *   ✅ brain.personaOverride  → mind.personaOverride
 *   ✅ brain.turnTimeoutMs    → mind.turnTimeoutMs
 *   ✅ brain.provider/model   → mind.provider/model（v3 叫 mind）
 *   ❌ brain.maxContextEvents → **不搬**：v3 的语义变了
 *        （v2 是「超了就换成新会话」，v3 是「先压成摘要，压不动才换代次」），
 *        硬搬会把压缩阈值设成 200，太频繁（每次都花一次模型调用）。
 *        想早压就改 `mind.compactAtEventCount`，默认 400。
 *   ❌ brain.mode / brain.dsh / brain.local → v2 的「spawn 子进程」残留，v3 不用
 *   ❌ outbound.* → v3 叫 rhythm.*，语义也不同（v2 按字数，v3 按 token），不搬
 *
 * 跑法：node scripts/migrate-v2-config.mjs [--dry]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DRY = process.argv.includes('--dry')
const dataDir = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'plugins', 'dsh-chacha-qq')
  : path.join(os.homedir(), '.dsh', 'plugins', 'dsh-chacha-qq')
const file = path.join(dataDir, 'config.json')

if (!fs.existsSync(file)) {
  console.log(`没有配置文件：${file}`)
  process.exit(0)
}

const raw = fs.readFileSync(file, 'utf8')
let cfg
try {
  cfg = JSON.parse(raw)
} catch (error) {
  console.error(`配置不是合法 JSON，不敢动：${error.message}`)
  process.exit(1)
}

const brain = cfg.brain && typeof cfg.brain === 'object' ? cfg.brain : {}
const mind = cfg.mind && typeof cfg.mind === 'object' ? cfg.mind : {}

const moves = []
function move(field, from, to) {
  const value = from
  if (value === undefined || value === null || value === '') return
  if (to !== undefined && to !== null && to !== '') return // 已经有值就不覆盖
  moves.push(field)
  return value
}

const nextMind = { ...mind }
const persona = move('personaOverride', brain.personaOverride, mind.personaOverride)
if (persona !== undefined) nextMind.personaOverride = persona
const timeout = move('turnTimeoutMs', brain.turnTimeoutMs, mind.turnTimeoutMs)
if (timeout !== undefined) nextMind.turnTimeoutMs = timeout
const provider = move('provider', brain.provider, mind.provider)
if (provider !== undefined) nextMind.provider = provider
const model = move('model', brain.model, mind.model)
if (model !== undefined) nextMind.model = model
const effort = move('reasoningEffort', brain.reasoningEffort, mind.reasoningEffort)
if (effort !== undefined) nextMind.reasoningEffort = effort

if (moves.length === 0) {
  console.log('没有什么要搬的（v3 的 mind 段已经有值，或者 v2 的 brain 段是空的）')
  process.exit(0)
}

const next = { ...cfg, mind: nextMind }

console.log(`将搬这几项到 mind.*：${moves.join(', ')}`)
if (DRY) {
  console.log('（--dry：只报告，不写盘）')
  process.exit(0)
}

// 备份一份，再从同一份内容改成新结构（原子写）
const backup = `${file}.bak-before-migrate-${Date.now()}`
fs.writeFileSync(backup, raw, 'utf8')
const tmp = `${file}.tmp`
fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
fs.renameSync(tmp, file)

console.log(`✅ 已写入 ${file}`)
console.log(`   备份：${backup}`)
console.log('   注意：v2 的 brain 段原样保留（不会被删），v3 不读它而已。')
