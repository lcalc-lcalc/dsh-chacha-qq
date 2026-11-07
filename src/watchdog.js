/**
 * NapCat 守护：它不是我们的子进程，是独立的 QQ 客户端。
 * QQ 客户端一崩，NapCat 就跟着消失，插件只会看到无限重连。
 *
 * 这个模块干四件事：
 *  1. 每 N 秒检查一次「网关连上了吗」
 *  2. 没连上就查进程：**进程不在 = 真挂了**，拉起
 *  3. **进程在但端口一直不通 = 卡死**，杀掉重启（旧版漏了这一条，会永远等下去）
 *  4. 拉起重试有节制：最短间隔、连续失败指数退避，绝不把机器拖垮
 *
 * 两个旧版踩过的坑，这里直接修掉：
 *   - `windowsHide: false` 会每分钟弹一个黑窗 → 改 true
 *   - 只看「进程在不在」→ 加端口探测，卡死判定
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/** 跑一个命令，拿 stdout（失败给空串）。 */
function run(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        resolve(error ? '' : String(stdout ?? ''))
      })
    } catch {
      resolve('')
    }
  })
}

/** 探一个端口通不通。 */
function probePort(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
    try {
      socket.connect(port, host)
    } catch {
      done(false)
    }
  })
}

export class NapCatWatchdog {
  /**
   * @param {object} options
   * @param {{get:()=>object}} options.store
   * @param {object} options.gateway
   * @param {object} options.log
   */
  constructor({ store, gateway, log }) {
    this.store = store
    this.gateway = gateway
    this.log = log
    this.timer = null
    this.lastSpawnAt = 0
    this.failures = 0
    this.backoffUntil = 0
    this.lastState = 'unknown'
    /** 进程在、但端口从什么时候开始不通（0 = 没在不通知状态） */
    this.unhealthySince = 0
  }

  get cfg() {
    return this.store.get().napcat ?? {}
  }

  start() {
    if (this.timer) return
    const interval = Math.max(15000, Number(this.cfg.watchIntervalMs) || 60000)
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.log.warn('守护检查出错：', error?.message ?? error))
    }, interval)
    this.timer.unref?.()
    this.log.info(`NapCat 守护已启动（每 ${Math.round(interval / 1000)} 秒检查一次）`)
    // 启动后先查一次，别等到第一个间隔
    const kick = setTimeout(() => this.tick().catch(() => {}), 3000)
    kick.unref?.()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** NapCat 主进程在不在（Windows）。 */
  async isRunning() {
    const exe = String(this.cfg.bootExe || 'NapCatWinBootMain.exe').replace(/\.exe$/i, '')
    const out = await run('tasklist', ['/FI', `IMAGENAME eq ${exe}.exe`, '/NH', '/FO', 'CSV'])
    return out.includes(`${exe}.exe`) || out.includes(exe)
  }

  /** 从 wsUrl 解出端口。 */
  wsPort() {
    const wsUrl = String(this.store.get().qq?.wsUrl ?? 'ws://127.0.0.1:3001')
    try {
      return Number(new URL(wsUrl).port) || 3001
    } catch {
      return 3001
    }
  }

  /** 主循环。 */
  async tick() {
    const now = Date.now()

    // 已经连上了：一切正常，清空计数
    if (this.gateway.connected) {
      if (this.failures > 0 || this.lastState !== 'connected') {
        this.log.info('NapCat 连接正常，守护待命')
      }
      this.lastState = 'connected'
      this.failures = 0
      this.backoffUntil = 0
      this.unhealthySince = 0
      return
    }

    // 退避中
    if (now < this.backoffUntil) {
      this.log.debug(`守护退避中，还有 ${Math.round((this.backoffUntil - now) / 1000)} 秒`)
      return
    }

    // 太频繁就跳过
    const minGap = Number(this.cfg.minSpawnGapMs) || 120000
    if (now - this.lastSpawnAt < minGap) return

    const running = await this.isRunning()

    if (running) {
      // 进程在，但网关没连上：先看端口
      const port = this.wsPort()
      const open = await probePort(port)

      if (open) {
        // 端口开着说明 NapCat 活着、只是 WS 还没建立或正在登录 —— 不打扰
        if (this.lastState !== 'not-connected') {
          this.log.warn(`NapCat 进程在、端口 ${port} 通，但网关未连上（可能在登录），继续等`)
          this.lastState = 'not-connected'
        }
        this.unhealthySince = 0
        return
      }

      // 进程在、端口不通 → 开始计卡死时间
      if (this.unhealthySince === 0) {
        this.unhealthySince = now
        this.log.warn(`NapCat 进程在但端口 ${port} 不通，开始计时（卡死判定）`)
        return
      }

      const stuckTimeout = Math.max(60000, Number(this.cfg.stuckTimeoutMs) || 180000)
      const stuckFor = now - this.unhealthySince
      if (stuckFor < stuckTimeout) {
        this.log.debug(`NapCat 不健康 ${Math.round(stuckFor / 1000)} 秒（阈值 ${Math.round(stuckTimeout / 1000)}）`)
        return
      }

      // 确认卡死：杀掉重启
      this.log.error(`NapCat 卡死 ${Math.round(stuckFor / 1000)} 秒（进程在、端口不通），杀掉重启`)
      await this.kill()
      this.unhealthySince = 0
      this.lastState = 'stuck-killed'
      return
    }

    // 进程不在 → 真挂了
    this.log.warn('NapCat 进程不在，尝试自动拉起')
    const ok = await this.launch()

    if (ok) {
      this.lastSpawnAt = now
      this.failures = 0
      this.lastState = 'spawned'
      this.unhealthySince = 0
      this.log.info('已拉起 NapCat，等待它登录（通常 10~30 秒）')
      return
    }

    this.failures += 1
    const backoff = Math.min(30 * 60 * 1000, 60000 * 2 ** Math.min(this.failures, 5))
    this.backoffUntil = now + backoff
    this.log.error(
      `拉起 NapCat 失败（连续 ${this.failures} 次），${Math.round(backoff / 1000)} 秒后再试。` +
      `请检查路径：${this.cfg.dir}`,
    )
  }

  /** 杀掉 NapCat（含它的 QQ 子进程树）。 */
  kill() {
    const exe = String(this.cfg.bootExe || 'NapCatWinBootMain.exe').replace(/\.exe$/i, '')
    return new Promise((resolve) => {
      execFile('taskkill', ['/IM', `${exe}.exe`, '/T', '/F'], { windowsHide: true }, (error) => {
        // 进程本来就不在时 taskkill 也报错，视为「已经没了」
        resolve(!error)
      })
    })
  }

  /** 拉起 NapCat（隐藏窗口 —— 否则每次重启弹一个黑窗）。 */
  async launch() {
    const dir = String(this.cfg.dir ?? '').trim()
    const exe = String(this.cfg.bootExe || 'NapCatWinBootMain.exe').trim()
    const selfId = String(this.store.get().qq?.selfId || this.cfg.account || '').trim()

    if (!dir) {
      this.log.error('没配 napcat.dir，无法拉起')
      return false
    }
    const full = path.join(dir, exe)
    if (!fs.existsSync(full)) {
      this.log.error(`找不到 NapCat 启动器：${full}`)
      return false
    }

    try {
      const child = spawn(full, selfId ? [selfId] : [], {
        cwd: dir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return true
    } catch (error) {
      this.log.error('spawn NapCat 失败：', error?.message ?? error)
      return false
    }
  }

  /** 给面板看的守护状态。 */
  stats() {
    return {
      enabled: this.cfg.autoStart !== false,
      lastState: this.lastState,
      failures: this.failures,
      backoffUntil: this.backoffUntil,
      lastSpawnAt: this.lastSpawnAt,
      unhealthyForMs: this.unhealthySince > 0 ? Date.now() - this.unhealthySince : 0,
    }
  }
}
