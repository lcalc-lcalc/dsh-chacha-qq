/**
 * 把「拟人参数」应用到现有的 config.json。
 *
 * 为什么需要它：`src/config.js` 的 `DEFAULT_CONFIG` 只是**新装时的默认值**。
 * 主人已经在用的 `config.json` 里写的是旧数字，改 DEFAULT_CONFIG 对它毫无影响 ——
 * 这是最容易误判的一件事：「我明明改了默认值，怎么没生效？」
 *
 * 这个脚本只覆盖**明确列出的键**，其余（人格、黑名单、Napcat 路径…）一个字不动。
 *
 * 跑法：
 *   node scripts/apply-persona-preset.mjs --dry     看会改什么
 *   node scripts/apply-persona-preset.mjs           真写（自动备份）
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
  console.log(`没有配置文件：${file}（插件还没启动过？）`)
  process.exit(0)
}

let cfg
try {
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`配置不是合法 JSON，不敢动：${error.message}`)
  process.exit(1)
}

/**
 * 拟人参数（茶茶酱定的那套）。
 *
 * 每一条的「为什么」都写在 src/config.js 的 DEFAULT_CONFIG 里，这里只放数值，
 * 免得两处注释漂移。
 */
const PRESET = {
  observe: {
    // 20~60 秒太慢，真人不会等半分钟；8~25 秒像"看到了、想了一下、回你"
    defaultMinMs: 8000,
    defaultMaxMs: 25000,
    // 被叫名字要快
    atMs: 4000,
    guestPrivateMs: 3000,
    ownerGroupMs: 3000,
    // 90 秒内算"同一坨"：刚聊完的话题还记得
    sameThreadMs: 90000,
    maxBatch: 40,
  },
  interest: {
    // 0.65 × 0.45 ≈ 29%：群里每三四条接一次，活跃但不多话
    default: 0.65,
    unmentionedFactor: 0.45,
  },
  rhythm: {
    // 1.2~3 秒 = 手打字的间隔；一片仍 <20 token
    minGapMs: 1200,
    maxGapMs: 3000,
    maxPiecesPerTurn: 12,
  },
  mind: {
    // 400 事件就压一次 = 花一次模型调用；800 更省
    compactAtEventCount: 800,
    hardResetEventCount: 2000,
  },
  memory: {
    // 主人：「上下文不要太多，不然贵死」
    injectMaxChars: 1600,
    injectCoreMaxChars: 600,
    factsMaxItems: 6,
    injectRecentDays: 1,
    summarize: { enabled: true, minTurns: 12, maxChars: 4000 },
  },
  meme: {
    probability: 0.35,
    maxPerMessage: 1,
    inlineProbability: 0.6,
    steal: { probability: 0.08 },
  },
  group: {
    // 群历史只在被 @ 时才全带，其余只带最近 5 行
    contextOn: 'on-demand',
  },
  emotion: {
    // 情绪判断每次都是一整次模型调用 —— 每 2 轮一次，省一半
    judgeEveryTurns: 2,
  },
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深合并（和 ConfigStore.patch 同语义：对象逐层合，数组/标量整体替换） */
function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeDeep(out[key], value) : value
  }
  return out
}

/** 把「改了哪些键」摊平成一行行，方便主人核对。 */
function diffLines(before, after, prefix = '') {
  const lines = []
  if (!isPlainObject(before) || !isPlainObject(after)) return lines
  for (const [key, value] of Object.entries(after)) {
    const old = before[key]
    const path_ = prefix ? `${prefix}.${key}` : key
    if (isPlainObject(value)) {
      lines.push(...diffLines(isPlainObject(old) ? old : {}, value, path_))
      continue
    }
    if (JSON.stringify(old) !== JSON.stringify(value)) {
      lines.push(`${path_}: ${JSON.stringify(old)} → ${JSON.stringify(value)}`)
    }
  }
  return lines
}

const next = { ...cfg, ...mergeDeep(cfg, PRESET) }
const report = []
for (const section of Object.keys(PRESET)) {
  report.push(...diffLines(cfg[section] ?? {}, next[section] ?? {}, section))
}

if (report.length === 0) {
  console.log('已经是这套参数了，没什么要改的')
  process.exit(0)
}

console.log('将改这些键：')
for (const line of report) console.log(`  ${line}`)

if (DRY) {
  console.log('\n（--dry：只报告，不写盘）')
  process.exit(0)
}

const raw = fs.readFileSync(file, 'utf8')
const backup = `${file}.bak-before-persona-${Date.now()}`
fs.writeFileSync(backup, raw, 'utf8')
const tmp = `${file}.tmp`
fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
fs.renameSync(tmp, file)

console.log(`\n✅ 已写入 ${file}`)
console.log(`   备份：${backup}`)
console.log('   ⚠️ 要重启 DSH 才生效（配置是启动时载入的）')
