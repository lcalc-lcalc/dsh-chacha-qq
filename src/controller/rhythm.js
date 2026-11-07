/**
 * rhythm.js · L2 Controller 出站节奏
 *
 * 主人的原话：
 *   「每两条消息之间 2~5 秒间隔，由 DSH 决定如何分片。一片应控制在 20 tokens 以内。」
 *
 * 这个文件只干四件事，全部可单测：
 *   ① estimateTokens —— 近似 token 估算（不引 tokenizer，见下）
 *   ② splitByTokens  —— 按 token 上限切片，优先句末标点、其次逗号、最后硬切
 *   ③ gapMs          —— 两条之间的随机间隔，rng 可注入
 *   ④ createRhythmSender —— 状态机：分片 → 逐条发 → 间隔随机等；支持 cancel/dispose
 *
 * 为什么不用真 tokenizer：
 *   我们只需要「一片大概多长」来分期，不需要精确分词；引一个 tokenizer 依赖会让
 *   插件在宿主机/DSH 两套环境里都要装包，得不偿失。汉字/全角标点按 1 token、
 *   英文/数字/符号按 4 字符 1 token 的近似，已经足够让「20 tokens」在大致相同的
 *   长度上生效。**这是估算，不是精确分词。**
 *
 * 分片的排序原则（有冲突时从高到低）：
 *   ① 不丢字：所有分片拼起来 === 去掉首尾空白的原文
 *   ② 硬上限：每一片 estimateTokens <= maxTokens
 *   ③ 自然边界：句末标点 > 逗号 > 空白（英文单词） > 硬切
 *   ④ 不要碎片：<3 token 的碎片尽量并进相邻片，不单发「嗯。」
 *
 * 关于「切不动时宁可超一点点也不要切半句话」：任务书同时写了「单片绝不超过 maxTokens
 * （硬上限）」和测试标准「每片 estimateTokens <= 20」。两者在「一整段没标点的长文」上
 * 冲突，本实现选择**硬上限优先**：长句硬切时用「均分」而不是「切到 20 再说」，
 * 避免出现 20+1 这种把最后一个字甩出去的情况；只有一整段里确实没有任何标点时才会
 * 切在句子中间（那时本来也没有「半句话」可保）。
 */

/** 小于这个 token 数的碎片不单独成片（主人原话：「嗯。」这种不要单独发）。 */
const MIN_PIECE_TOKENS = 3

/** 英文/数字/符号的估算：4 字符 ≈ 1 token。 */
const ASCII_CHARS_PER_TOKEN = 4

/* ========================================================================== *
 * ① token 估算（近似值，只用于分片）
 * ========================================================================== */

/**
 * 一个码点是否按「1 token」估算。
 *
 * 依据主人的要求：「中文汉字按 1 token，全角标点算 1」。
 * 这里把汉字、假名、CJK 标点、全角字符、通用标点（…—‘’“”）、BMP 之外的字符
 * （emoji、生僻字扩展区）统一按 1 token —— 它们视觉上都占满一格，按 1 算只会
 * 让分片更保守，不会把一条消息塞爆。
 * 换行按 1 token：它在分片里是句末边界，不会堆很多。
 *
 * @param {number} codePoint
 * @returns {boolean}
 */
function isWideCodePoint(codePoint) {
  if (codePoint === 0x0a || codePoint === 0x0d) return true // \n \r
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return true // CJK 扩展 A
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return true // CJK 基本区
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return true // 兼容汉字
  if (codePoint >= 0x3000 && codePoint <= 0x303f) return true // CJK 标点（、。〈〉等）
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) return true // 平假名 / 片假名
  if (codePoint >= 0xff00 && codePoint <= 0xffef) return true // 全角形式（！？，：等）
  if (codePoint >= 0x2000 && codePoint <= 0x206f) return true // 通用标点（…—‘’“”）
  if (codePoint >= 0xfe30 && codePoint <= 0xfe4f) return true // 兼容标点
  if (codePoint > 0xffff) return true // emoji / 扩展区
  return false
}

/**
 * 估算一段文本的 token 数（近似，不是精确分词）。
 *
 * 规则：宽字符（汉字/全角/emoji…）1 个码点 = 1 token；
 * 其余（英文、数字、半角符号、空格）每 4 个字符 = 1 token，不足 4 个按 1 算。
 * 连续的「其余」字符算作一段再向上取整，所以 "hello"（5 个字符）≈ 2 tokens。
 *
 * @param {string} text
 * @returns {number} 非负整数
 */
export function estimateTokens(text) {
  const source = String(text ?? '')
  if (!source) return 0
  let total = 0
  let asciiRun = 0
  for (const char of source) {
    if (isWideCodePoint(char.codePointAt(0))) {
      if (asciiRun > 0) {
        total += Math.ceil(asciiRun / ASCII_CHARS_PER_TOKEN)
        asciiRun = 0
      }
      total += 1
    } else {
      asciiRun += 1
    }
  }
  if (asciiRun > 0) total += Math.ceil(asciiRun / ASCII_CHARS_PER_TOKEN)
  return total
}

/* ========================================================================== *
 * ② 分片
 * ========================================================================== */

/** 句末标点：。！？!?；;…（换行另算）。 */
const SENTENCE_PUNCT = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n', '\r'])

/** 逗号一级的停顿。 */
const COMMA_PUNCT = new Set(['，', ',', '、'])

/**
 * 判断 index 处是不是「句末边界」。
 *
 * 英文句号 '.' 只在后面是空白/结尾时才算句末 —— 避免把小数（3.14）、域名（a.b）、
 * 缩写（e.g.）切成两半；这是对任务书标点列表的一个小扩展（任务书只列了中文标点）。
 */
function isSentenceBoundaryAt(source, index) {
  const char = source[index]
  if (SENTENCE_PUNCT.has(char)) return true
  if (char === '.') {
    const next = source[index + 1]
    return next === undefined || /\s/.test(next)
  }
  return false
}

/**
 * 按「边界判定」把文本切成连续子串。
 *
 * 切点特性（保证不丢字）：
 *  - 连续多个边界标点算一个切点（「？！」不拆开）
 *  - 紧跟边界后面的空白留给前一段，下一段从非空白开始（消息不会以空格抬头）
 *  - 返回的每一段拼起来 === 入参
 *
 * @param {string} source
 * @param {(source: string, index: number) => boolean} isBoundary
 * @returns {string[]}
 */
function cutChunks(source, isBoundary) {
  const chunks = []
  let start = 0
  let index = 0
  while (index < source.length) {
    if (!isBoundary(source, index)) {
      index += 1
      continue
    }
    index += 1
    // 连续标点整体算一个边界
    while (index < source.length && isBoundary(source, index)) index += 1
    // 把边界后的空白并进前一段（保持切点落在「可读的缝」上）
    while (index < source.length && /\s/.test(source[index])) index += 1
    chunks.push(source.slice(start, index))
    start = index
  }
  if (start < source.length) chunks.push(source.slice(start))
  return chunks.filter((chunk) => chunk.length > 0)
}

/** 英文单词字符：用来判断硬切有没有切在单词中间。 */
function isAsciiWordChar(char) {
  return typeof char === 'string' && /[0-9A-Za-z_]/.test(char)
}

/**
 * 「叠词不劈开」的兜底阈值。
 * 连续同一个字不超过这么多个，就当作叠词/笑声（「看看」「的的」「哈哈哈」），
 * 切到它中间时把切点挪开；比这更长的一串同字（比如 '春'.repeat(200) 这种
 * 无标点测试串）当填充字符，不去挪 —— 否则长串同字的均分会被打乱。
 */
const REPEAT_PROTECT_MAX_RUN = 6

/** 切点是不是劈在同一对相同字符中间。 */
function isRepeatedSplit(source, cut) {
  return cut > 0 && cut < source.length && source[cut - 1] === source[cut]
}

/** 切点所在的那一串相同字符有多长（要求 cut 落在重复字符中间）。 */
function repeatedRunLength(source, cut) {
  const char = source[cut]
  let start = cut - 1
  while (start > 0 && source[start - 1] === char) start -= 1
  let end = cut
  while (end < source.length && source[end] === char) end += 1
  return end - start
}

/** 下一个码点边界（不会把 emoji 的代理对切开）。 */
function nextBoundary(source, index) {
  const codePoint = source.codePointAt(index)
  if (codePoint === undefined) return source.length
  return index + (codePoint > 0xffff ? 2 : 1)
}

/** 上一个码点边界（不会把 emoji 的代理对切开）。 */
function previousBoundary(source, index) {
  if (index <= 0) return 0
  const before = source.charCodeAt(index - 1)
  return index - (before >= 0xdc00 && before <= 0xdfff ? 2 : 1)
}

/**
 * 叠词保护：切点落在「看看」「的的」「哈哈哈」中间时把切点挪开。
 *
 * 顺序：先往后挪（最多 2 个码点，且不能撑破单片上限），
 * 后往前挪（最多 2 个码点，且不能把片切成 <3 token 的碎片）。
 * 前后都躲不开就保持原切点 —— 硬上限永远不能让位给手感。
 *
 * @param {string} source
 * @param {number} cut
 * @param {number} maxTokens
 * @returns {number}
 */
function avoidRepeatedSplit(source, cut, maxTokens) {
  if (!isRepeatedSplit(source, cut)) return cut
  if (repeatedRunLength(source, cut) > REPEAT_PROTECT_MAX_RUN) return cut

  const minHeadTokens = Math.min(MIN_PIECE_TOKENS, maxTokens)
  let candidate = cut

  // ① 往后挪：叠词整段留给这一片（不超上限才允许）
  for (let step = 0; step < 2; step += 1) {
    candidate = nextBoundary(source, candidate)
    if (candidate >= source.length) break
    if (estimateTokens(source.slice(0, candidate)) > maxTokens) break
    if (!isRepeatedSplit(source, candidate)) return candidate
  }

  // ② 往后挪会破上限 → 往前挪，叠词整段留给下一片
  candidate = cut
  for (let step = 0; step < 2; step += 1) {
    candidate = previousBoundary(source, candidate)
    if (candidate <= 0) break
    if (estimateTokens(source.slice(0, candidate)) < minHeadTokens) break
    if (!isRepeatedSplit(source, candidate)) return candidate
  }

  // 前后都躲不开（比如整段开头就是叠词）：保持原样，硬上限优先
  return cut
}

/**
 * 在文本里找一个「不超过 targetTokens」的硬切点（返回 code unit 下标）。
 *
 * 优先切在空白之后（英文单词边界），但退让不能退成碎片：
 *   - 切点落在英文单词中间时，退到最近的空白；
 *   - 退过去的头段至少 min(3, targetTokens) tokens，否则不如果断切；
 *   - 切点劈开叠词（看看 / 的的 / 哈哈哈）时挪开，见 avoidRepeatedSplit。
 * 迭代按码点前进，所以不会把代理对（emoji）切成两半。
 *
 * @param {string} source
 * @param {number} targetTokens
 * @param {number} [maxTokens=targetTokens] 单片硬上限（叠词挪切点时要守着）
 * @returns {number} 0 < 返回值 < source.length 的 code unit 下标
 */
function findHardCut(source, targetTokens, maxTokens = targetTokens) {
  let wideCount = 0
  let asciiRun = 0
  let index = 0
  let cut = source.length
  let lastWhitespaceEnd = -1
  let lastWhitespaceTokens = 0
  const minHeadTokens = Math.min(MIN_PIECE_TOKENS, targetTokens)

  for (const char of source) {
    const start = index
    index += char.length
    if (isWideCodePoint(char.codePointAt(0))) {
      wideCount += 1
      asciiRun = 0
    } else {
      asciiRun += 1
    }
    const tokens = wideCount + Math.ceil(asciiRun / ASCII_CHARS_PER_TOKEN)
    if (tokens > targetTokens) {
      // 当前码点已经超了 → 切在它前面，保证头段 <= targetTokens
      cut = start
      break
    }
    if (/\s/.test(char)) {
      lastWhitespaceEnd = index
      lastWhitespaceTokens = tokens
    }
    if (tokens >= targetTokens) {
      cut = index
      break
    }
  }

  // 切在英文单词中间 → 往最近的空白退，但不能退成 <3 token 的碎块
  const before = cut > 0 ? source[cut - 1] : undefined
  const after = cut < source.length ? source[cut] : undefined
  const midWord =
    cut > 0 &&
    cut < source.length &&
    before !== undefined &&
    after !== undefined &&
    !/\s/.test(before) &&
    !/\s/.test(after) &&
    isAsciiWordChar(before) &&
    isAsciiWordChar(after)
  if (midWord && lastWhitespaceEnd > 0 && lastWhitespaceEnd < cut && lastWhitespaceTokens >= minHeadTokens) {
    return avoidRepeatedSplit(source, lastWhitespaceEnd, maxTokens)
  }
  return avoidRepeatedSplit(source, Math.max(1, cut), maxTokens)
}

/**
 * 硬切：把一段「没有可用标点」的文本按 token 均分。
 *
 * 为什么均分而不是「先切 20 再说」：
 *   21 tokens 切成 20+1，最后一片就是「嗯。」级别甚至一个字的碎片；
 *   均分成 11+10 既守住上限，也不会把尾巴甩出去。
 *
 * @param {string} source
 * @param {number} maxTokens
 * @returns {string[]}
 */
function hardSplit(source, maxTokens) {
  const parts = []
  let rest = source
  let guard = 0
  // 防御：正常情况下每轮至少切掉 1 个码点，最坏也只会循环到原文长度
  while (rest.length > 0 && guard < 100000) {
    guard += 1
    const total = estimateTokens(rest)
    if (total <= maxTokens) {
      parts.push(rest)
      break
    }
    const pieceCount = Math.ceil(total / maxTokens)
    const target = Math.max(1, Math.min(maxTokens, Math.ceil(total / pieceCount)))
    const cut = findHardCut(rest, target, maxTokens)
    if (cut <= 0 || cut >= rest.length) {
      // 切不动了（理论上不会发生）——整段收下，宁可这一片超一点，也不能死循环
      parts.push(rest)
      break
    }
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  return parts.filter((part) => part.length > 0)
}

/**
 * 把原文切成「语义原子」：句末标点为一级，逗号为二级，再不行硬切。
 * 每个原子都 <= maxTokens，且原子顺序拼起来 === 原文。
 *
 * @param {string} source
 * @param {number} maxTokens
 * @returns {Array<{text: string, tokens: number}>}
 */
function atomize(source, maxTokens) {
  const atoms = []
  const pushAtom = (text) => {
    if (!text) return
    const tokens = estimateTokens(text)
    if (tokens <= maxTokens) {
      atoms.push({ text, tokens })
      return
    }
    for (const part of hardSplit(text, maxTokens)) {
      atoms.push({ text: part, tokens: estimateTokens(part) })
    }
  }

  for (const sentence of cutChunks(source, isSentenceBoundaryAt)) {
    if (estimateTokens(sentence) <= maxTokens) {
      atoms.push({ text: sentence, tokens: estimateTokens(sentence) })
      continue
    }
    // 整句太长 → 退到逗号一级
    for (const clause of cutChunks(sentence, (text, index) => COMMA_PUNCT.has(text[index]))) {
      pushAtom(clause)
    }
  }
  return atoms
}

/**
 * 把 <3 token 的碎片并进相邻原子（优先往后并，主人原话「往后并」）。
 *
 * 并完若超过单片上限，就让 hardSplit 重新均分这块 —— 也就是宁可把邻句切开，
 * 也不单独发「嗯。」。上限是硬的，碎片的容忍是有条件的。
 *
 * @param {Array<{text: string, tokens: number}>} atoms
 * @param {number} maxTokens
 * @returns {Array<{text: string, tokens: number}>}
 */
function mergeTinyAtoms(atoms, maxTokens) {
  if (atoms.length <= 1) return atoms
  if (maxTokens < MIN_PIECE_TOKENS) return atoms // 上限本身比碎片阈值还小，救不了

  const list = atoms.slice()
  let index = 0
  let guard = 0
  const guardLimit = list.length * 8 + 64
  while (index < list.length && guard < guardLimit) {
    guard += 1
    if (list[index].tokens >= MIN_PIECE_TOKENS) {
      index += 1
      continue
    }
    const hasNext = index + 1 < list.length
    const mergeIndex = hasNext ? index : index - 1
    if (mergeIndex < 0) break // 只剩自己一个，确实没法并
    const mergedText = list[mergeIndex].text + list[mergeIndex + 1].text
    const mergedTokens = estimateTokens(mergedText)
    const replacement =
      mergedTokens > maxTokens
        ? hardSplit(mergedText, maxTokens).map((text) => ({ text, tokens: estimateTokens(text) }))
        : [{ text: mergedText, tokens: mergedTokens }]
    list.splice(mergeIndex, 2, ...replacement)
    // 并进后一个：替换结果从 index 开始，留在原地重新检查（可能还是碎，比如 1+1=2）
    // 并进前一个：替换结果从 index-1 开始，回到那一格重新检查
    index = Math.max(0, Math.min(mergeIndex, list.length - 1))
  }
  return list
}

/**
 * 贪心打包：把原子拼成不超过 maxTokens 的片。
 *
 * 用「拼好之后重新估算」而不是「两个估算值相加」：ascii 段跨边界时
 * ceil 会多算，宁可少装一点，也不能让单片超过上限。
 *
 * @param {Array<{text: string, tokens: number}>} atoms
 * @param {number} maxTokens
 * @returns {string[]}
 */
function packAtoms(atoms, maxTokens) {
  const pieces = []
  let currentText = ''
  let currentTokens = 0
  for (const atom of atoms) {
    if (!currentText) {
      currentText = atom.text
      currentTokens = atom.tokens
      continue
    }
    const mergedText = currentText + atom.text
    const mergedTokens = estimateTokens(mergedText)
    if (mergedTokens <= maxTokens) {
      currentText = mergedText
      currentTokens = mergedTokens
    } else {
      pieces.push(currentText)
      currentText = atom.text
      currentTokens = atom.tokens
    }
  }
  if (currentText) pieces.push(currentText)
  return pieces
}

/**
 * 片数超过 maxParts 时的兜底：把溢出的尾巴并进最后一片。
 *
 * 为什么不直接丢掉/截断：主人说过不能丢内容；为什么不让片数无限涨：
 * 一段几千字的输出如果按 20 tokens 一片发，几百条消息加 2~5 秒间隔会刷屏半小时。
 * 两害相权：片数守 maxParts，最后一片长一点（token 上限在这一种病态输入下让位）。
 * 正常聊天回复（几百字以内）根本碰不到这个分支。
 *
 * @param {string[]} pieces
 * @param {number} maxParts
 * @returns {string[]}
 */
function capPieces(pieces, maxParts) {
  if (pieces.length <= maxParts) return pieces
  const head = pieces.slice(0, maxParts - 1)
  head.push(pieces.slice(maxParts - 1).join(''))
  return head
}

/**
 * 按 token 上限切片。
 *
 * @param {string} text 原文（会先去掉首尾空白）
 * @param {number} [maxTokens=20] 单片 token 上限（硬上限）
 * @param {number} [maxParts=20] 片段数上限（病态长文兜底，见 capPieces）
 * @returns {string[]} 分片；空输入返回 []
 */
export function splitByTokens(text, maxTokens = 20, maxParts = 20) {
  const source = String(text ?? '').trim()
  if (!source) return []

  const tokenLimit = Math.max(1, Math.floor(Number(maxTokens) || 20))
  const partsLimit = Math.max(1, Math.floor(Number(maxParts) || 20))

  // 短文本直接一片 —— 不为了「切」而切
  if (estimateTokens(source) <= tokenLimit) return [source]

  const atoms = mergeTinyAtoms(atomize(source, tokenLimit), tokenLimit)
  const pieces = packAtoms(atoms, tokenLimit)
  return capPieces(pieces, partsLimit)
}

/* ========================================================================== *
 * ③ 两条消息之间的间隔
 * ========================================================================== */

/**
 * 返回 [minMs, maxMs] 区间内的随机整数。
 *
 * rng 必须可注入（测试用 seededRng，生产用 Math.random），
 * 否则没法复现「这次间隔是不是真的落在 2~5 秒」。
 * rng 返回值会被钳在 [0, 1]，min/max 传反了自动换位，负数归零。
 *
 * @param {{minMs?: number, maxMs?: number}} [range]
 * @param {() => number} [rng]
 * @returns {number} 整数毫秒
 */
export function gapMs({ minMs = 2000, maxMs = 5000 } = {}, rng = Math.random) {
  let min = Number(minMs)
  let max = Number(maxMs)
  if (!Number.isFinite(min)) min = 2000
  if (!Number.isFinite(max)) max = 5000
  min = Math.max(0, Math.round(min))
  max = Math.max(0, Math.round(max))
  if (min > max) {
    const swap = min
    min = max
    max = swap
  }
  const roll = typeof rng === 'function' ? Number(rng()) : 0.5
  const ratio = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0
  const result = min + Math.floor(ratio * (max - min + 1))
  return Math.min(max, result)
}

/* ========================================================================== *
 * ④ 节奏发送状态机
 * ========================================================================== */

/** 读配置：兼容 store.get() / store() / 直接给对象三种形态（组装层可能给任意一种）。 */
function readConfig(store) {
  if (!store) return {}
  try {
    if (typeof store.get === 'function') {
      const value = store.get()
      return value && typeof value === 'object' ? value : {}
    }
    if (typeof store === 'function') {
      const value = store()
      return value && typeof value === 'object' ? value : {}
    }
    return typeof store === 'object' ? store : {}
  } catch {
    return {}
  }
}

function numberOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 造一个「按节奏发消息」的状态机。
 *
 * 契约：
 *   - outbox 需要有 `plain(text)`（Markdown 降级）和 `sendPiece(message, text, { quote })`
 *     （发单条，失败自己消化，返回 boolean）。Outbox 类正好提供这两个。
 *   - send() 发一整段：先降级 → 分片 → 逐条发 → 两条之间等 gapMs。
 *   - cancel() 中途打断：不再发后续分片（新消息进来抢占时用）。
 *   - dispose() 清掉所有挂着的定时器，不泄漏；dispose 后 send 直接返回 cancelled。
 *
 * 时序细节：间隔按「上一条发完的时间点」算，用注入的 now() 扣掉发送本身耗时，
 * 保证两条消息之间真的隔了 2~5 秒，而不是「发送耗时 + 2~5 秒」。
 *
 * @param {object} options
 * @param {object} options.outbox 需要 plain() + sendPiece()
 * @param {object} [options.store] 配置存储（读 rhythm 段）
 * @param {object} [options.log]
 * @param {() => number} [options.now]
 * @param {() => number} [options.rng]
 * @returns {{
 *   send: (message: object, text: string, options?: { quote?: boolean }) => Promise<{sent: number, total: number, cancelled: boolean}>,
 *   cancel: (reason?: string) => boolean,
 *   dispose: () => void,
 *   readonly disposed: boolean,
 *   readonly sending: number,
 *   readonly pendingTimers: number,
 *   status: () => { disposed: boolean, sending: number, pendingTimers: number, generation: number },
 * }}
 */
export function createRhythmSender({ outbox, store, log, now = Date.now, rng = Math.random } = {}) {
  /** 挂着的等待定时器：timerId -> resolve（dispose 时要 resolve 掉，不能留悬空 await）。 */
  const timers = new Map()
  /** 批次代号：每次 send / cancel 都自增；批次发现自己代号过期就停手。 */
  let generation = 0
  let disposed = false
  let sending = 0

  const warn = (message) => {
    if (typeof log?.warn === 'function') log.warn(message)
  }
  const debug = (message) => {
    if (typeof log?.debug === 'function') log.debug(message)
  }

  function config() {
    const rhythm = readConfig(store).rhythm ?? {}
    return {
      minGapMs: Math.max(0, numberOr(rhythm.minGapMs, 2000)),
      maxGapMs: Math.max(0, numberOr(rhythm.maxGapMs, 5000)),
      maxTokens: Math.max(1, Math.floor(numberOr(rhythm.maxTokensPerPiece, 20))),
      maxParts: Math.max(1, Math.floor(numberOr(rhythm.maxPiecesPerTurn, 20))),
      maxCharsPerMessage: Math.max(0, Math.floor(numberOr(rhythm.maxCharsPerMessage, 2000))),
    }
  }

  function clearTimers() {
    for (const [timer, resolve] of timers) {
      clearTimeout(timer)
      resolve()
    }
    timers.clear()
  }

  /** 可被 dispose/cancel 立即唤醒的 sleep（不清掉会泄漏定时器）。 */
  function sleep(ms) {
    if (!(ms > 0)) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        resolve()
      }, ms)
      timers.set(timer, resolve)
    })
  }

  /** 按配置分片；maxCharsPerMessage 是 QQ 单条长度保险丝（正常 20 tokens 远达不到）。 */
  function splitForSend(plain, cfg) {
    let pieces = splitByTokens(plain, cfg.maxTokens, cfg.maxParts)
    if (cfg.maxCharsPerMessage > 0) {
      const capped = []
      for (const piece of pieces) {
        if (piece.length <= cfg.maxCharsPerMessage) {
          capped.push(piece)
          continue
        }
        for (let offset = 0; offset < piece.length; offset += cfg.maxCharsPerMessage) {
          capped.push(piece.slice(offset, offset + cfg.maxCharsPerMessage))
        }
      }
      pieces = capped
    }
    return pieces
  }

  /**
   * 发一整段回复。
   *
   * @param {object} message 归一化消息（决定发给谁、引用谁）
   * @param {string} text 模型终稿（Markdown 也行，会先降级）
   * @param {{quote?: boolean}} [options]
   * @returns {Promise<{sent: number, total: number, cancelled: boolean}>}
   */
  async function send(message, text, options = {}) {
    if (disposed) {
      warn('节奏发送器已 dispose，忽略这次发送')
      return { sent: 0, total: 0, cancelled: true }
    }

    const myGeneration = ++generation // 新消息抢占：上一批自动作废
    const cfg = config()
    const raw = String(text ?? '')
    let plain = raw
    if (typeof outbox?.plain === 'function') {
      try {
        plain = String(outbox.plain(raw) ?? '')
      } catch (error) {
        warn(`Markdown 降级失败，按原文发：${error?.message ?? error}`)
        plain = raw
      }
    }

    const pieces = splitForSend(plain, cfg)
    if (pieces.length === 0) return { sent: 0, total: 0, cancelled: false }

    sending += 1
    debug(`节奏发送：共 ${pieces.length} 片，间隔 ${cfg.minGapMs}~${cfg.maxGapMs}ms`)
    let sent = 0
    let lastSentAt = 0

    try {
      for (let index = 0; index < pieces.length; index += 1) {
        if (myGeneration !== generation) {
          debug(`节奏发送被打断：已发 ${sent}/${pieces.length}`)
          return { sent, total: pieces.length, cancelled: true }
        }

        if (index > 0) {
          const gap = gapMs({ minMs: cfg.minGapMs, maxMs: cfg.maxGapMs }, rng)
          const elapsed = Math.max(0, numberOr(typeof now === 'function' ? now() : Date.now, 0) - lastSentAt)
          await sleep(Math.max(0, gap - elapsed))
          if (myGeneration !== generation) {
            debug(`节奏发送被打断（等待中）：已发 ${sent}/${pieces.length}`)
            return { sent, total: pieces.length, cancelled: true }
          }
        }

        let ok = false
        try {
          ok = Boolean(await outbox.sendPiece(message, pieces[index], {
            quote: Boolean(options.quote) && index === 0,
          }))
        } catch (error) {
          // 一条发不出去不能拖垮整轮：记日志，继续后面的片
          warn(`第 ${index + 1}/${pieces.length} 片发送异常：${error?.message ?? error}`)
          ok = false
        }
        lastSentAt = numberOr(typeof now === 'function' ? now() : Date.now, 0)
        if (ok) sent += 1
        else warn(`第 ${index + 1}/${pieces.length} 片没发出去，继续发后面的`)
      }
    } finally {
      sending = Math.max(0, sending - 1)
    }

    return { sent, total: pieces.length, cancelled: false }
  }

  /** 中途打断：清掉等待、作废当前批次；返回是否真的有批次被打断。 */
  function cancel(reason = '') {
    const wasSending = sending > 0
    generation += 1
    clearTimers()
    if (wasSending) debug(`节奏发送已取消${reason ? `：${reason}` : ''}`)
    return wasSending
  }

  /** 清干净：取消在途批次 + 清掉所有定时器。可重复调用。 */
  function dispose() {
    if (disposed) return
    disposed = true
    cancel('dispose')
    clearTimers()
  }

  return {
    send,
    cancel,
    dispose,
    get disposed() {
      return disposed
    },
    get sending() {
      return sending
    },
    get pendingTimers() {
      return timers.size
    },
    status() {
      return { disposed, sending, pendingTimers: timers.size, generation }
    },
  }
}
