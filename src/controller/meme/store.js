/**
 * meme/store.js · 表情包图库（存储层）
 *
 * 设计来源（PLAN-v3.1 §2.1，meme_manager 唯一值得留的两条）：
 *   ① 模型只选「类别」，代码在类别内随机取一张 —— 图库增删完全不影响提示词稳定性；
 *   ② 类别描述写「什么时候用」而不是「图长什么样」 —— 这才是「同类随机抽一张」安全的原因。
 *
 * 所以存储做成**文件即分类、文件名即描述**：
 *
 *   dataDir/memes/<类别>/<描述>.gif|png|jpg|jpeg|webp
 *   dataDir/memes/_catalog.json      ← 类别描述 + 每张图元数据（本文件自动维护）
 *
 * 主人明确要求「文件名说明内容，方便发送」：`眯眼笑_竖大拇指.gif` 比 `IMG_2831.gif`
 * 有用得多 —— 所以 ingest 会把视觉模型给的描述清洗成安全文件名，而不是丢掉它。
 *
 * 刻意不做的事：
 *   · 不做向量检索 / embedding —— 主人的原话是「这就是全部检索，别做向量」；
 *   · 不做图床、不做 WebUI、不做 meme_manager 那套 5 级容错匹配；
 *   · 不引 sharp/jimp —— 判格式只读文件头前十几字节，判不出来就放行。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 允许的图片扩展名。
 *
 * 为什么不收 bmp/svg：
 *   svg 是文本、能被 QQ 当文件而不是图片渲染；bmp 一张就几 MB，盗图闸门（2MB）本来就会挡掉。
 */
export const IMAGE_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp']

/**
 * 内置类别骨架（6~8 个，主人点名要的）。
 *
 * ⚠️ hint 必须写「**什么时候用**」，不能写「图长什么样」：
 *   写「一只猫在笑」的话模型会按画面去配图，一旦图库里那张猫被删了，她的选择就飘了；
 *   写「当对话轻松、想分享喜悦时使用」，随机抽到哪张都成立 —— 这是整个设计的支点。
 *
 * 类别 key 只允许小写英文/数字/下划线（要能被 `&&happy&&` 这种标记安全引用）。
 */
export const MEME_CATEGORIES = [
  { key: 'happy', name: '开心', hint: '当对话气氛轻松、想分享喜悦、或者为对方高兴时使用' },
  { key: 'sad', name: '难过', hint: '当对方情绪低落需要共情、或者她自己感到失落时使用' },
  { key: 'angry', name: '生气', hint: '当对话包含抱怨、批评、激烈反对或她自己在气头上时使用' },
  { key: 'shocked', name: '震惊', hint: '当收到出乎意料的消息、需要夸张反应时使用' },
  { key: 'speechless', name: '无语', hint: '当对方说了离谱、尴尬或接不下去的话时使用' },
  { key: 'hug', name: '抱抱', hint: '当对方需要安慰、想念、撒娇或久别重逢时使用' },
  { key: 'cute', name: '卖萌', hint: '当想缓和气氛、撒娇、回应夸奖或讨要关注时使用' },
  { key: 'other', name: '其它', hint: '当情绪不属于以上任何一类时使用的兜底类别' },
]

/**
 * meme 配置的模块内默认值。
 *
 * 为什么要在这里兜底：`src/config.js` 的 DEFAULT_CONFIG 是别人的地盘（只读），
 * 面板还没长出 meme 段的时候，配置里 `meme` 整个键都可能不存在 —— 缺了也不能崩。
 * 键名以本文件为准（配置键在这里定下来，面板/文档照这个写）。
 */
export const DEFAULT_MEME_CONFIG = {
  /** 整条消息发图的总闸：一条回复有多大概率夹表情包 */
  probability: 0.5,
  /** 单条消息最多几张图（超过的标记直接丢） */
  maxPerMessage: 2,
  /** 混排率：图夹在文字里 vs 文字发完再单独发 */
  inlineProbability: 0.5,
  /** 同类别冷却（毫秒）：避免连续两条都用「开心」那一类 */
  cooldownMs: 120000,
  /** 盗图 */
  steal: {
    /** 每收到一张图，有这个概率「看看喜不喜欢」 */
    probability: 0.15,
    /** 按对话覆盖：{ "group-123456": 0.3, "private-1111111111": 0.05 } */
    peers: {},
    /** 小于这个字节很难是像样的表情包（头像/缩略图） */
    minBytes: 4096,
    /** 大于 2MB 的不收：发出去慢，也容易触发 QQ 侧限制 */
    maxBytes: 2 * 1024 * 1024,
    /** 只收这几种格式 */
    allowedExt: ['gif', 'png', 'jpg', 'jpeg', 'webp'],
  },
}

/* ========================================================================== *
 * 小工具（store/render/steal 共用，render 是纯函数不 import 这里）
 * ========================================================================== */

/** 判断是否纯对象（不含数组 / null / 类实例）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

/** 非负整数，至少 min。 */
function intAtLeast(value, fallback, min = 0) {
  return Math.max(min, Math.floor(numberOr(value, fallback)))
}

/** 日志归一化：没传 log 就静音 —— 不能因为日志器缺失把存储搞崩。 */
export function normalizeLog(log) {
  const noop = () => {}
  return {
    debug: typeof log?.debug === 'function' ? log.debug.bind(log) : noop,
    info: typeof log?.info === 'function' ? log.info.bind(log) : noop,
    warn: typeof log?.warn === 'function' ? log.warn.bind(log) : noop,
    error: typeof log?.error === 'function' ? log.error.bind(log) : noop,
  }
}

/**
 * 读配置根：兼容「对象 / getter 函数」两种形态（index.js 传的通常是 getter，
 * 这样面板改了设置不用重启就生效）。
 */
export function configRootOf(config) {
  if (typeof config === 'function') {
    try {
      const value = config()
      return isPlainObject(value) ? value : {}
    } catch {
      return {}
    }
  }
  return isPlainObject(config) ? config : {}
}

/**
 * 取 meme 配置段。
 *
 * 兼容两种传法：整份配置（有 `meme` 段）或已经切好的 meme 段
 * —— 别的模块（emotion/memory）拿子配置，本模块要判 modes，所以两种都认。
 */
export function memeSectionOf(config) {
  const root = configRootOf(config)
  return isPlainObject(root.meme) ? root.meme : root
}

/** 扩展名归一化：去点、转小写、常见别名归位。 */
export function normalizeExt(ext) {
  const text = String(ext ?? '').trim().toLowerCase().replace(/^\./, '')
  if (text === 'jpe' || text === 'jfif') return 'jpg'
  return text
}

function normalizeExtList(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const ext = normalizeExt(item)
    // 只收 store 真正能写盘/发送的图片格式：放 bmp/svg 进来只会在入库时失败
    if (!IMAGE_EXTS.includes(ext) || seen.has(ext)) continue
    seen.add(ext)
    out.push(ext)
  }
  // jpg/jpeg 是同一件事：用户只写一个时，另一个也认（不然「明明能放」的图会被挡）
  if (out.includes('jpg') && !out.includes('jpeg')) out.push('jpeg')
  if (out.includes('jpeg') && !out.includes('jpg')) out.push('jpg')
  return out
}

/**
 * 读 meme 配置（缺键用模块默认值补齐，非法值钳到安全范围）。
 *
 * 每次都现读：面板改完概率，下一条消息就生效，不需要重启。
 */
export function readMemeConfig(config) {
  const section = memeSectionOf(config)
  const steal = isPlainObject(section.steal) ? section.steal : {}
  const fallback = DEFAULT_MEME_CONFIG
  const allowedRaw = Array.isArray(steal.allowedExt) ? normalizeExtList(steal.allowedExt) : []
  return {
    probability: clamp01(numberOr(section.probability, fallback.probability)),
    maxPerMessage: intAtLeast(section.maxPerMessage, fallback.maxPerMessage),
    inlineProbability: clamp01(numberOr(section.inlineProbability, fallback.inlineProbability)),
    cooldownMs: intAtLeast(section.cooldownMs, fallback.cooldownMs),
    steal: {
      probability: clamp01(numberOr(steal.probability, fallback.steal.probability)),
      peers: isPlainObject(steal.peers) ? { ...steal.peers } : {},
      minBytes: intAtLeast(steal.minBytes, fallback.steal.minBytes),
      maxBytes: intAtLeast(steal.maxBytes, fallback.steal.maxBytes),
      allowedExt: allowedRaw.length > 0 ? allowedRaw : [...fallback.steal.allowedExt],
    },
  }
}

/** 类别 key 白名单化：只留 ascii 字母/数字/下划线/短横线，限长 24。 */
export function safeCategoryKey(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '')
  return text.slice(0, 24)
}

/**
 * 把描述清洗成安全文件名（英文/中文都允许，这和「文件名即描述」的设计配套）。
 *
 * 规则（对应任务书「去 \/:*?"<>|、限长」）：
 *   · 去掉 Windows 文件名非法字符与控制字符；
 *   · 空白变下划线（文件名里空格容易在命令行/日志里被截断）；
 *   · 合并重复下划线；去掉首尾的 `_ . -`（Windows 不允许结尾是点/空格）；
 *   · 命中 CON/PRN/AUX/NUL/COM1~9/LPT1~9 这些保留名时加前缀（否则在 Windows 上建不出来）；
 *   · 按**码点**限长 40，避免把 emoji 从中间劈开。
 *
 * @param {unknown} description 视觉模型给的内容描述
 * @param {{maxLen?: number}} [options]
 * @returns {string} 安全文件名主体（可能为空，空时由调用方兜底）
 */
export function sanitizeFileNameBase(description, { maxLen = 40 } = {}) {
  let text = String(description ?? '')
  // NFKC 把全角字母数字归一（视觉模型偶尔输出全角）。中文/emoji 不受影响。
  try {
    text = text.normalize('NFKC')
  } catch {
    // 极老环境没有 normalize：原样用，不影响正确性
  }
  text = text.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
  text = text.replace(/\s+/g, '_')
  text = text.replace(/_+/g, '_')
  text = text.replace(/^[._-]+|[._-]+$/g, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(text)) text = `_${text}`
  const chars = [...text]
  const limit = Math.max(1, Math.floor(numberOr(maxLen, 40)))
  if (chars.length > limit) {
    text = chars.slice(0, limit).join('').replace(/[._-]+$/g, '')
  }
  return text
}

/**
 * 读文件头前 12 字节判图片格式（零依赖，对应「尺寸/格式判断读文件头就够」）。
 *
 * 判不出来返回 ''，由调用方**放行**（宁可放过一张怪图，也不要把真表情包挡在门外）。
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {'gif'|'png'|'jpg'|'webp'|''}
 */
export function sniffImageExt(buffer) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length < 12) return ''
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif' // GIF87a/89a
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return ''
}

/** sha256：图库去重与「这图是不是已经收藏过」都靠它。 */
export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/* ========================================================================== *
 * MemeStore
 * ========================================================================== */

const CATALOG_FILE = '_catalog.json'
const CATALOG_VERSION = 1

export class MemeStore {
  /**
   * @param {object} options
   * @param {string} options.dataDir 数据根目录（表情库落在 `<dataDir>/memes`）
   * @param {object|Function} [options.config] 整份配置或 meme 段（对象 / getter 都行）
   * @param {object} [options.log]
   * @param {() => number} [options.now] 时间注入（catalog 的 addedAt/updatedAt）
   */
  constructor({ dataDir, config, log, now = Date.now } = {}) {
    const root = String(dataDir ?? path.join(process.cwd(), 'data'))
    this.dataDir = root
    /** 表情库根目录：`<dataDir>/memes` */
    this.root = path.join(root, 'memes')
    /** catalog 文件：`<dataDir>/memes/_catalog.json` */
    this.catalogPath = path.join(this.root, CATALOG_FILE)
    this.config = config
    this.now = typeof now === 'function' ? now : Date.now
    this.log = normalizeLog(log)
    /** 懒加载的 catalog，第一次用时才读盘 */
    this.catalog = null
    /** 写操作串行链：两个盗图同时入库时不能互相踩 catalog */
    this.pending = Promise.resolve()
    this.disposed = false
  }

  /* ── catalog ───────────────────────────────────────────────── */

  /** 读 catalog（懒加载 + 坏文件降级成空库）。 */
  readCatalog() {
    if (this.catalog) return this.catalog
    const empty = { version: CATALOG_VERSION, updatedAt: 0, categories: {}, memes: {} }
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(this.catalogPath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 坏 JSON 不删（主人的图库描述可能在里面），只降级 + 告警，下次入库会整份重写
        this.log.warn(`表情目录 ${this.catalogPath} 读取失败，按空库继续：${error?.message ?? error}`)
      }
      this.catalog = empty
      return this.catalog
    }
    this.catalog = {
      version: CATALOG_VERSION,
      updatedAt: numberOr(parsed?.updatedAt, 0),
      categories: isPlainObject(parsed?.categories) ? parsed.categories : {},
      memes: isPlainObject(parsed?.memes) ? parsed.memes : {},
    }
    return this.catalog
  }

  /** 原子写 catalog（先写 .tmp 再 rename，避免半截 JSON 把图库读废）。 */
  saveCatalog(catalog) {
    fs.mkdirSync(this.root, { recursive: true })
    const tmp = `${this.catalogPath}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.catalogPath)
    this.catalog = catalog
  }

  /* ── 磁盘扫描 ─────────────────────────────────────────────── */

  /** 列出某个类别目录下的可用图片（按文件名排序，保证注入 rng 后结果可复现）。 */
  listFiles(category) {
    const key = safeCategoryKey(category)
    if (!key) return []
    const dir = path.join(this.root, key)
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name
      // 下划线开头是元数据/临时文件（_catalog.json、.tmp），点开头是隐藏文件
      if (name.startsWith('.') || name.startsWith('_')) continue
      const ext = normalizeExt(path.extname(name))
      if (!IMAGE_EXTS.includes(ext)) continue
      const full = path.join(dir, name)
      let bytes = 0
      try {
        bytes = fs.statSync(full).size
      } catch {
        continue
      }
      if (bytes <= 0) continue
      files.push({ name, path: full, ext, bytes })
    }
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return files
  }

  /** 磁盘上真实存在的类别目录（用户手工建的也算）。 */
  listCategoryDirs() {
    let entries
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true })
    } catch {
      return []
    }
    const keys = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
      const key = entry.name.toLowerCase()
      // 目录名必须能当 `&&标记&&` 用，否则忽略（中文目录名会让标记系统对不上）
      if (safeCategoryKey(key) !== key) continue
      keys.push(key)
    }
    keys.sort()
    return keys
  }

  /* ── 对外接口 ─────────────────────────────────────────────── */

  /**
   * 类别列表（骨架永远在，即使目录还没建）。
   *
   * `hint` 是给模型看的「什么时候用」；`count` 是磁盘上真实张数
   * —— 图库增删立刻反映，不需要维护计数。
   *
   * @returns {Array<{key: string, name: string, hint: string, count: number}>}
   */
  listCategories() {
    const catalog = this.readCatalog()
    const merged = new Map()
    for (const item of MEME_CATEGORIES) {
      merged.set(item.key, { key: item.key, name: item.name, hint: item.hint })
    }
    // catalog 里用户手改过的 name/hint 优先（面板/手改都可以）
    for (const [key, meta] of Object.entries(catalog.categories ?? {})) {
      if (!isPlainObject(meta)) continue
      const safe = safeCategoryKey(key)
      if (!safe) continue
      const base = merged.get(safe) ?? { key: safe, name: safe, hint: '' }
      merged.set(safe, {
        key: safe,
        name: String(meta.name ?? '').trim() || base.name,
        hint: String(meta.hint ?? '').trim() || base.hint,
      })
    }
    // 磁盘上手工建的类别（不在骨架里）
    for (const key of this.listCategoryDirs()) {
      if (!merged.has(key)) merged.set(key, { key, name: key, hint: '' })
    }
    return [...merged.values()].map((item) => ({
      ...item,
      count: this.listFiles(item.key).length,
    }))
  }

  /**
   * 把视觉模型/用户给的类别名归一化成图库里的 key。
   *
   * @param {unknown} raw
   * @param {{allowNew?: boolean}} [options]
   *        `allowNew=true` 只在 ingest 手动收录时用：允许建新类别；
   *        视觉判断走默认（false），不认识的类别落到 other，避免图库被模型随口分类搞乱。
   * @returns {string} 合法 key，归一化不出来时返回 'other'
   */
  normalizeCategory(raw, { allowNew = false } = {}) {
    const text = String(raw ?? '').trim()
    if (!text) return 'other'
    // 中文类别名 → key（视觉模型可能直接回「开心」）
    const byName = MEME_CATEGORIES.find((item) => item.name === text)
    if (byName) return byName.key
    const key = safeCategoryKey(text)
    if (!key) return 'other'
    const known = MEME_CATEGORIES.some((item) => item.key === key) || this.listCategoryDirs().includes(key)
    if (known) return key
    // 新建类别只认「干净的英文 token」：`meme_custom` 可以，视觉模型随口写的
    // `garbage name!!` 不行 —— 否则图库会被模型随手分类堆出一堆垃圾目录
    const cleanToken = /^[a-zA-Z0-9_-]{1,24}$/.test(text)
    return allowNew && cleanToken ? key : 'other'
  }

  /**
   * 类别内随机抽一张 —— **这就是全部的「检索」**，别做向量。
   *
   * @param {string} category
   * @param {{rng?: () => number}} [options] rng 必须可注入（测试才能复现）
   * @returns {{path: string, name: string, ext: string, bytes: number, category: string}|null}
   *          类别空 / 目录不存在 → null（调用方退回纯文本）
   */
  pick(category, { rng = Math.random } = {}) {
    if (this.disposed) return null
    const key = this.normalizeCategory(category, { allowNew: false })
    const files = this.listFiles(key)
    if (files.length === 0) return null
    const roll = typeof rng === 'function' ? Number(rng()) : 0.5
    const ratio = Number.isFinite(roll) ? clamp01(roll) : 0.5
    const index = Math.min(files.length - 1, Math.floor(ratio * files.length))
    const file = files[index]
    return { path: file.path, name: file.name, ext: file.ext, bytes: file.bytes, category: key }
  }

  /**
   * 按 sha256 找已经收藏过的图（盗图前先查，省一次视觉调用）。
   *
   * @param {string} hash
   * @returns {{path: string, relative: string, category: string, name: string}|null}
   */
  findBySha256(hash) {
    const value = String(hash ?? '')
    if (!value) return null
    const catalog = this.readCatalog()
    for (const [relative, meta] of Object.entries(catalog.memes ?? {})) {
      if (!isPlainObject(meta) || meta.sha256 !== value) continue
      const full = path.join(this.root, ...relative.split('/'))
      if (fs.existsSync(full)) {
        return {
          path: full,
          relative,
          category: String(meta.category ?? ''),
          name: String(meta.name ?? path.basename(full)),
        }
      }
      // 文件被主人手工删了：顺手清掉陈旧索引（下次 saveCatalog 落盘）
      delete catalog.memes[relative]
    }
    return null
  }

  /**
   * 入库：写文件 + sha256 去重 + 同名补序号 + 更新 catalog。
   *
   * 串行执行：盗图和手动收录可能同时发生，catalog 是「读-改-写」，
   * 不串行会丢更新（同一个 sha 也可能被写两遍）。
   *
   * @param {{buffer: Buffer, ext: string, description?: string, category?: string}} options
   * @returns {Promise<{path: string, deduped: boolean, category: string, name: string, bytes: number}>}
   */
  async ingest({ buffer, ext, description = '', category = '' } = {}) {
    if (this.disposed) throw new Error('MemeStore 已 dispose，不再入库')
    const run = this.pending.then(
      () => this._ingest({ buffer, ext, description, category }),
      () => this._ingest({ buffer, ext, description, category }),
    )
    // 串行链：不管成功失败都往下走，但把结果（或错误）交给本次调用者
    this.pending = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async _ingest({ buffer, ext, description, category }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('ingest 需要一个非空的图片 Buffer')
    }

    // 格式以文件头为准，扩展名只作后备（URL 的扩展名经常是假的，文件头不会）
    const sniffed = sniffImageExt(buffer)
    const declared = normalizeExt(ext)
    const finalExt = sniffed || declared
    if (!IMAGE_EXTS.includes(finalExt)) {
      throw new Error(`不支持的图片格式：${ext || '(空)'}（只收 ${IMAGE_EXTS.join('/')}）`)
    }

    const key = this.normalizeCategory(category, { allowNew: true })
    const sha256 = sha256Of(buffer)
    const catalog = this.readCatalog()

    // ① 同内容去重（同 sha 不管叫什么描述、什么类别，都算同一张图）
    const existing = this.findBySha256(sha256)
    if (existing) {
      this.log.debug(`表情包去重：${existing.relative}`)
      return {
        path: existing.path,
        deduped: true,
        category: existing.category || key,
        name: existing.name,
        bytes: buffer.length,
      }
    }

    // ② 落盘：描述 → 安全文件名；同名（不同图）补 _2/_3…
    const dir = path.join(this.root, key)
    fs.mkdirSync(dir, { recursive: true })
    const base = sanitizeFileNameBase(description) || `表情_${numberOr(this.now(), Date.now())}`
    let name = `${base}.${finalExt}`
    let counter = 2
    while (fs.existsSync(path.join(dir, name))) {
      if (counter > 999) {
        // 病态情况（同名 1000 张）：直接用时间戳兜底，绝不覆盖已有文件
        name = `${base}_${numberOr(this.now(), Date.now())}.${finalExt}`
        break
      }
      name = `${base}_${counter}.${finalExt}`
      counter += 1
    }
    const dest = path.join(dir, name)
    // 先写临时文件再 rename：中途崩溃不会留下半张坏图，也不会覆盖同名文件
    const tmp = path.join(dir, `.tmp-${sha256.slice(0, 12)}-${name}`)
    fs.writeFileSync(tmp, buffer)
    fs.renameSync(tmp, dest)

    // ③ 更新 catalog
    const relative = `${key}/${name}`
    const stem = name.slice(0, name.length - (finalExt.length + 1))
    catalog.memes[relative] = {
      category: key,
      file: name,
      name: stem,
      description: String(description ?? '').trim() || stem,
      ext: finalExt,
      bytes: buffer.length,
      sha256,
      addedAt: numberOr(this.now(), Date.now()),
    }
    const skeleton = MEME_CATEGORIES.find((item) => item.key === key)
    const prev = isPlainObject(catalog.categories[key]) ? catalog.categories[key] : {}
    catalog.categories[key] = {
      name: String(prev.name ?? '').trim() || skeleton?.name || key,
      hint: String(prev.hint ?? '').trim() || skeleton?.hint || '',
      updatedAt: numberOr(this.now(), Date.now()),
    }
    catalog.version = CATALOG_VERSION
    catalog.updatedAt = numberOr(this.now(), Date.now())
    this.saveCatalog(catalog)

    this.log.info(`表情包入库：${relative}（${buffer.length} 字节）`)
    return { path: dest, deduped: false, category: key, name: stem, bytes: buffer.length }
  }

  /**
   * 建好骨架目录 + 首次运行时把类别描述写进 catalog。
   *
   * 为什么需要：主人要能直接打开 `dataDir/memes/` 把图拖进去；
   * 目录不存在的话连「往哪放」都不知道。失败只告警，不影响发送。
   *
   * @returns {Promise<{created: string[], seeded: boolean}>}
   */
  async ensureDirs() {
    const created = []
    for (const item of MEME_CATEGORIES) {
      const dir = path.join(this.root, item.key)
      try {
        await fs.promises.mkdir(dir, { recursive: true })
        created.push(dir)
      } catch (error) {
        this.log.warn(`表情类别目录创建失败（${item.key}）：${error?.message ?? error}`)
      }
    }
    const catalog = this.readCatalog()
    let seeded = false
    for (const item of MEME_CATEGORIES) {
      if (isPlainObject(catalog.categories[item.key])) continue
      catalog.categories[item.key] = {
        name: item.name,
        hint: item.hint,
        updatedAt: numberOr(this.now(), Date.now()),
      }
      seeded = true
    }
    if (seeded) {
      catalog.version = CATALOG_VERSION
      catalog.updatedAt = numberOr(this.now(), Date.now())
      try {
        this.saveCatalog(catalog)
      } catch (error) {
        this.log.warn(`表情目录 catalog 初始化写入失败：${error?.message ?? error}`)
      }
    }
    return { created, seeded }
  }

  /** 面板/排错用：图库现状。 */
  stats() {
    const categories = this.listCategories()
    const byCategory = {}
    let memes = 0
    let bytes = 0
    for (const item of categories) {
      const files = this.listFiles(item.key)
      const size = files.reduce((sum, file) => sum + file.bytes, 0)
      byCategory[item.key] = { name: item.name, count: files.length, bytes: size }
      memes += files.length
      bytes += size
    }
    return {
      dataDir: this.dataDir,
      memesDir: this.root,
      catalogPath: this.catalogPath,
      categories: categories.length,
      memes,
      bytes,
      byCategory,
    }
  }

  /** 没有定时器 / 连接；dispose 只做生命周期统一（可重复调用）。 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.catalog = null
  }
}
