/**
 * 装配层自检：真的调用一次 `apply(ctx, config)`，看整台机器能不能立起来。
 *
 * 为什么需要这个套件：
 *   index.js 是「看不见的入口」—— 它要是抛错，表现是「插件在配置树里、
 *   DSH 不报错、日志一个字都没有」（旧版最惨的一次故障）。
 *   所以这里用一个假 ctx 真的跑一遍装配，断言：
 *     ① 不抛错
 *     ② 该装上的零件都装上了（parts 全 true）
 *     ③ 单例守卫生效（重复 apply 不会留两个 Runtime）
 *
 * 不需要 DSH、不需要 QQ、不需要网络：qq.enabled=false 让网关不连，
 * webServer 用假的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { group, check, ok, notOk, report } from './harness.mjs'

const tick = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

/** 造一个临时数据目录，里面提前放好「关掉 QQ」的配置，避免测试去连 NapCat。 */
function seedDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chacha-v3-asm-'))
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        qq: { enabled: false, wsUrl: 'ws://127.0.0.1:59999' },
        napcat: { autoStart: false },
        rhythm: { minGapMs: 0, maxGapMs: 0 },
        log: { level: 'warn' },
      },
      null,
      2,
    ),
    'utf8',
  )
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** 假 cordis Context：只实现插件入口用到的那几个。 */
function fakeCtx() {
  const handlers = []
  return {
    handlers,
    services: {},
    get(name) {
      return this.services[name]
    },
    on(event, handler) {
      handlers.push({ event, handler })
    },
    effect(fn) {
      handlers.push({ event: 'effect', fn })
    },
  }
}

// ══════════════════════════════════════════════════════════════
group('装配：模块导出形状')

// index.js 在顶层 import 了 config.js / log.js，先确认这两个是好的
const configMod = await import('../src/config.js')
ok('DEFAULT_CONFIG 存在', Boolean(configMod.DEFAULT_CONFIG))
ok('ConfigStore 是类', typeof configMod.ConfigStore === 'function')
ok('resolveDataDir 是函数', typeof configMod.resolveDataDir === 'function')
ok('默认配置里有 observe 段', Boolean(configMod.DEFAULT_CONFIG.observe))
ok('默认配置里有 mind 段', Boolean(configMod.DEFAULT_CONFIG.mind))
ok('默认配置里有 security 段', Boolean(configMod.DEFAULT_CONFIG.security))
ok('默认配置里有 emotion 段', Boolean(configMod.DEFAULT_CONFIG.emotion))
ok('默认配置里有 memory 段', Boolean(configMod.DEFAULT_CONFIG.memory))
check('mind.toolAllow 是「砍过的」那一套', configMod.DEFAULT_CONFIG.mind.toolAllow.includes('web_search'), true)
ok('observe.ownerGroupMs 存在', 'ownerGroupMs' in configMod.DEFAULT_CONFIG.observe)

const indexMod = await import('../index.js')
check('插件名', indexMod.name, 'dsh-chacha-qq')
ok('apply 是函数', typeof indexMod.apply === 'function')

// ══════════════════════════════════════════════════════════════
group('装配：真的 apply 一次')

const { dir, cleanup } = seedDataDir()
const ctx = fakeCtx()

let runtime = null
let threw = null
try {
  const result = indexMod.apply(ctx, { dataDir: dir })
  runtime = result?.runtime ?? null
} catch (error) {
  threw = error
}

notOk('apply 没有抛错', threw, String(threw?.message ?? ''))
ok('apply 返回了 runtime', Boolean(runtime))

// 装配是异步的，等它跑完
await tick(600)

const parts = runtime?.parts ?? {}
ok('gateway 装上了', parts.gateway === true, JSON.stringify(parts))
ok('api 装上了', parts.api === true)
ok('mind 对象建出来了', Boolean(runtime?.mind))
// ⚠️ 假 ctx 里没有 agents 服务，所以 available 必须是 false —— 这恰好证明
//    「拿不到 agents 就不冒充就绪」这条降级是对的。
check('没有 agents 服务时 mind.available=false', runtime?.mind?.available, false)
ok('qqTools 装上了', parts.qqTools === true)
ok('observe 装上了', parts.observe === true)
ok('memory 装上了', parts.memory === true)
ok('emotion 装上了', parts.emotion === true)
ok('recall 装上了', parts.recall === true)
ok('controller 装上了', parts.controller === true)

ok('controller 有一份数据目录', Boolean(runtime?.controller?.dataDir), String(runtime?.controller?.dataDir ?? ''))
ok('controller 有 outbox', Boolean(runtime?.controller?.outbox))
ok('controller 有入站器', Boolean(runtime?.controller?.inbound))
ok('mind 挂了 memory', Boolean(runtime?.controller?.emotion))
check('qq.enabled=false 时不会去连网关', runtime?.gateway?.connected ?? false, false)

// 日志文件应该被创建出来（证明双写生效）
const logFile = path.join(dir, 'logs', 'chacha-qq.log')
ok('日志文件已创建', fs.existsSync(logFile), logFile)

// 数据目录结构
ok('数据目录已创建', fs.existsSync(dir))
ok('配置文件已落盘', fs.existsSync(path.join(dir, 'config.json')))

cleanup()

// ══════════════════════════════════════════════════════════════
group('装配：单例守卫（重复 apply 不会有两个 Runtime）')

const { dir: dir2, cleanup: cleanup2 } = seedDataDir()
const ctx2 = fakeCtx()

const first = indexMod.apply(ctx2, { dataDir: dir2 })
await tick(500)
const firstRuntime = first?.runtime ?? null

const second = indexMod.apply(ctx2, { dataDir: dir2 })
// ⚠️ 必须在第二次 apply **之后**才读 disposed —— 之前写在前面，读到的是拆除前状态
const firstDisposed = Boolean(firstRuntime?.disposed)
await tick(500)

ok('第一次装配成功了', Boolean(firstRuntime))
ok('第二次 apply 把第一个拆掉了', firstDisposed, String(firstDisposed))
ok('第二次拿到的是新 Runtime', Boolean(second?.runtime) && second.runtime !== firstRuntime)

// 收尾：拆掉，别留后台定时器
second?.runtime?.dispose?.()
await tick(100)

cleanup2()

report('装配层（index.js 真的跑起来）')
