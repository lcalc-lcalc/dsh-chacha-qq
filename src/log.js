/**
 * 日志：双写（文件 + 内存环），带轮转。
 *
 * 为什么不用 console：
 *  - DSH 主进程的 stdout 被 GUI 吞了，出问题时看不到任何东西；
 *  - 排查 QQ 问题必须能回溯「十秒前那一步到底怎么了」；
 *  - 主人在面板上要能看到最近日志，不能只靠翻文件。
 *
 * 内存环保留最近 N 条给面板读，文件保留完整历史（带轮转防撑爆磁盘）。
 */
import fs from 'node:fs'
import path from 'node:path'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

/** 把任意值压成一行可读文本。 */
function flatten(args) {
  return args
    .map((item) => {
      if (typeof item === 'string') return item
      if (item instanceof Error) return `${item.message}${item.stack ? `\n${item.stack}` : ''}`
      try {
        return JSON.stringify(item)
      } catch {
        return String(item)
      }
    })
    .join(' ')
}

function stamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  )
}

/** 一个带 tag 的日志器。child() 生成带前缀的子日志器，共享同一个 sink。 */
class Logger {
  constructor({ sink, level, tag }) {
    this.sink = sink
    this.level = LEVELS[level] ?? LEVELS.info
    this.tag = tag
  }

  child(tag) {
    return new Logger({
      sink: this.sink,
      level: Object.keys(LEVELS).find((key) => LEVELS[key] === this.level) ?? 'info',
      tag: this.tag ? `${this.tag}:${tag}` : tag,
    })
  }

  emit(level, args) {
    if (LEVELS[level] < this.level) return
    this.sink({ level, tag: this.tag, text: flatten(args), at: Date.now() })
  }

  debug(...args) {
    this.emit('debug', args)
  }

  info(...args) {
    this.emit('info', args)
  }

  warn(...args) {
    this.emit('warn', args)
  }

  error(...args) {
    this.emit('error', args)
  }
}

/**
 * 建一个日志器。
 * @param {{file?:string, level?:string, maxFileBytes?:number, ringSize?:number}} options
 */
export function createLogger({ file, level = 'info', maxFileBytes = 4 * 1024 * 1024, ringSize = 400 } = {}) {
  /** @type {Array<{at:number, level:string, tag?:string, text:string}>} */
  const ring = []

  const sink = (entry) => {
    ring.push(entry)
    if (ring.length > ringSize) ring.shift()

    const line = `[${stamp(new Date(entry.at))}] ${entry.level.toUpperCase().padEnd(5)} ` +
      `${entry.tag ? `[${entry.tag}] ` : ''}${entry.text}\n`

    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.appendFileSync(file, line, 'utf8')
      } catch {
        // 日志写不进去也不许影响主流程
      }
    }
  }

  const logger = new Logger({ sink, level, tag: '' })

  /** 轮到阈值就滚一份 .1，只留一代（够排查）。 */
  logger.rotate = () => {
    if (!file) return false
    try {
      if (!fs.existsSync(file)) return false
      const { size } = fs.statSync(file)
      if (size < maxFileBytes) return false
      const backup = `${file}.1`
      if (fs.existsSync(backup)) fs.unlinkSync(backup)
      fs.renameSync(file, backup)
      return true
    } catch {
      return false
    }
  }

  /** 面板用：最近 N 条日志。 */
  logger.recent = (limit = 200) => ring.slice(-limit)

  /** 面板用：清空内存环（不动文件）。 */
  logger.clearRing = () => {
    ring.length = 0
  }

  return logger
}
