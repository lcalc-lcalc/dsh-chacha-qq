/**
 * meme/render.js · 把 `&&happy&&` 换成图（纯函数，零 IO）
 *
 * 她要发：  "主人早安呀 &&happy&& 今天也要开心哦"
 * 这里产出：[
 *             { type: 'text',  data: { text: '主人早安呀' } },
 *             { type: 'image', data: { path: '<dataDir>/memes/happy/眯眼笑_竖大拇指.gif' } },
 *             { type: 'text',  data: { text: '今天也要开心哦' } },
 *           ]
 * `path` 是本机绝对路径 —— 由 L1 的 api 读成 `base64://` 再发给 NapCat
 * （本地路径直接塞 OneBot 是发不出去的，见 src/napcat/api.js 的 toFileRef 注释）。
 *
 * 三个坑（都是别人踩过的）：
 *   ① `<thinking>` 区里提到 `&&happy&&` 不能真发图 —— 她思考时爱拿标记举例子；
 *   ② 标记格式必须**严格**：meme_manager 那套 5 级容错是给「不肯听指令的模型」兜底的，
 *      对能听指令的模型只会变成误报源（把正文里的 `&&` 吃掉）；
 *   ③ 任何路径都不能让 `&&` 出现在最终消息里 —— stripResidualMarkers 是最后一道闸。
 *
 * 纯函数：只读 store（它的 pick 是同步的），不碰网络、不写盘，所以能单测。
 */

/* ========================================================================== *
 * ① 思考区隔离
 * ========================================================================== */

/**
 * 把 `<thinking>…</thinking>` 和正文分开。
 *
 * 为什么要单独抽出来：她思考时经常写「这里可以用 &&happy&& 举例」——
 * 如果直接对整段终稿扫标记，思考内容里的标记会被当真，主人就会收到莫名其妙的图。
 *
 * 流式输出还可能出现「只有 `<thinking>` 没闭合」的半截：那种情况把开标签之后的
 * 全部内容当思考（宁可少发图，也不能把思考文本/标记发出去）。
 *
 * @param {unknown} text
 * @returns {{body: string, thinking: string[], hadThinking: boolean}}
 *          body = 正文（可以扫标记、可以发）；thinking = 被切掉的思考片段（排错用）
 */
export function splitThinking(text) {
  const source = String(text ?? '')
  if (!source) return { body: '', thinking: [], hadThinking: false }

  const thinking = []
  // 每次调用新建正则，避免 global 正则的 lastIndex 在多次调用间串味
  const body = source.replace(/<think(?:ing)?(?:\s[^>]*)?>[\s\S]*?<\/think(?:ing)?>/gi, (match) => {
    thinking.push(match)
    return ''
  })

  // 没闭合的开标签：之后的一律算思考（流式截断时会出现）
  const open = /<think(?:ing)?(?:\s[^>]*)?>/i.exec(body)
  let cleanedBody = body
  if (open) {
    thinking.push(body.slice(open.index))
    cleanedBody = body.slice(0, open.index)
  }

  return { body: cleanedBody, thinking, hadThinking: thinking.length > 0 }
}

/* ========================================================================== *
 * ② 抽标记
 * ========================================================================== */

/**
 * 标记的「宽松形状」：`&&…&&`，中间最多 40 个非 & 字符、不跨行。
 *
 * 宽松只用于**清理**：长成这样的一律从正文里删掉（模型写坏了也不能让主人看到）。
 */
const TAG_PATTERN = /&&([^&\n\r]{0,40}?)&&/g

/**
 * 标记的「严格形状」：类别只能是 `[a-z0-9_-]`（大小写不敏感），最长 24。
 *
 * 宽松清理 + 严格识别，是这里唯一的分寸：清理不能漏（漏了用户看到 &&），
 * 识别不能猜（猜了会把正常文字吃掉）。
 */
const STRICT_CATEGORY = /^[a-z0-9_][a-z0-9_-]{0,23}$/i

/**
 * 从终稿里抽出表情类别，并给出「清洗后的正文」。
 *
 * 规则：
 *   · 只认 `&&类别&&`，类别必须在 validCategories 里（大小写不敏感，统一转小写）；
 *   · 超出 maxTags 的丢弃（标记本身照样从正文里删掉）；
 *   · `<thinking>` 区里的标记不算（splitThinking 先切开）。
 *
 * 额外返回的 `positions` 是**已清洗正文里的插入位置**（给 buildSegments 用，
 * 这样图能插在她标记的原文位置，而不是随便塞）。契约只要求 `{ tags, cleaned }`，
 * 这是纯增量字段，旧调用方不用也完全没问题。
 *
 * @param {unknown} text
 * @param {{maxTags?: number, validCategories?: string[]}} [options]
 * @returns {{tags: string[], cleaned: string, positions: number[], thinking: string[], hadThinking: boolean}}
 */
export function extractTags(text, { maxTags = 2, validCategories = [] } = {}) {
  const { body, thinking, hadThinking } = splitThinking(text)
  const limit = Math.max(0, Math.floor(Number(maxTags) || 0))
  const allowed = new Set(
    (Array.isArray(validCategories) ? validCategories : [])
      .map((item) => String(item ?? '').trim().toLowerCase())
      .filter(Boolean),
  )

  const tags = []
  const positions = []
  let cleaned = ''
  let cursor = 0
  const pattern = new RegExp(TAG_PATTERN.source, 'g')
  let match = pattern.exec(body)
  while (match !== null) {
    // 标记前面的正文先落到 cleaned
    cleaned += body.slice(cursor, match.index)
    const raw = match[1]
    const key = raw.trim().toLowerCase()
    // 严格识别：中间不能有空格、不能有其它符号；validCategories 为空 = 不限类别
    const valid = STRICT_CATEGORY.test(raw) && (allowed.size === 0 || allowed.has(key))
    if (valid && tags.length < limit) {
      tags.push(key)
      positions.push(cleaned.length) // 图就插在这个位置（标记被删掉后的坐标）
    }
    cursor = match.index + match[0].length
    match = pattern.exec(body)
  }
  cleaned += body.slice(cursor)

  return { tags, cleaned, positions, thinking, hadThinking }
}

/* ========================================================================== *
 * ③ 兜底清理
 * ========================================================================== */

/**
 * 最后一道闸：任何情况下都不让标记漏给用户。
 *
 * 比 extractTags 更狠 —— 不看格式、不管类别、不要求配对：
 *   · 成对的 `&&…&&` 直接删；
 *   · 落单的 `&&` 也删（半截标记比内容消失更难看）；
 *   · 中间夹空白的 `& &` 也删（模型偶尔会拆开写）；
 *   · 收尾：合并多余空格、去掉标点前的空格、压缩空行、整体 trim。
 *
 * 注意：单个 `&`（如 `A & B`）不动 —— 那是正常文字。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function stripResidualMarkers(text) {
  let out = String(text ?? '')

  out = out.replace(/&&[^&\n\r]{0,40}?&&/g, '') // 成对标记（含非法类别）
  out = out.replace(/&&/g, '') // 落单的 &&
  out = out.replace(/&[ \t]*&/g, '') // & &（中间夹空白）
  out = out.replace(/[ \t]{2,}/g, ' ') // 标记删掉后留下的双空格
  out = out.replace(/[ \t]+([，。！？；：、,.!?;:])/g, '$1') // 标点前的空格
  out = out.replace(/[ \t]+\n/g, '\n')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/* ========================================================================== *
 * ④ 排段（图文混排）
 * ========================================================================== */

function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

function textSegment(value) {
  return { type: 'text', data: { text: value } }
}

function imageSegment(pick, trailing) {
  const segment = { type: 'image', data: { path: String(pick.path) } }
  // `trailing` 是给调用方的信号：这一张不是在文字中间，而是「文字发完再单独发」
  if (trailing) segment.trailing = true
  return segment
}

/** 切点落在句末标点之后（。！？；\n …）。 */
const SENTENCE_PUNCT = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n'])
/** 次级切点：逗号。 */
const COMMA_PUNCT = new Set(['，', ',', '、'])
/** 兜底切点：空白（英文句子用）。 */
const WHITESPACE = new Set([' ', '\t'])

/**
 * 在 target 附近找一个「切完读起来不别扭」的位置。
 *
 * 从近到远两向搜索：切点落在标点/空白**之后**（`slice(0, cut)` 以标点结尾）。
 *
 * @param {string} text
 * @param {number} target 目标下标
 * @param {number} window 搜索半径
 * @param {Set<string>} chars 可接受的切点前一个字符
 * @returns {number} 切点；找不到返回 -1
 */
function nearestCut(text, target, window, chars) {
  for (let distance = 0; distance <= window; distance += 1) {
    const after = target + distance
    if (after > 0 && after < text.length && chars.has(text[after - 1])) return after
    const before = target - distance
    if (before > 0 && before < text.length && chars.has(text[before - 1])) return before
  }
  return -1
}

/** 不劈开 emoji 代理对的最小硬切点。 */
function safeHardCut(text, target) {
  let cut = Math.min(Math.max(1, Math.round(target)), text.length - 1)
  // 切点正好落在代理对中间（前一个是高代理、后一个是低代理）→ 往前退一格
  if (cut > 0 && cut < text.length) {
    const previous = text.charCodeAt(cut - 1)
    const next = text.charCodeAt(cut)
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1
  }
  return cut > 0 ? cut : 1
}

/**
 * 把文本按「自然边界」切成 count 段（给混排找图的位置）。
 *
 * 找不到边界（一整句、没有标点）就不切 —— 宁可少一段，也不要做「主人早安呀 今天也 / 要开心」这种劈半句。
 * 每段至少 2 个字符，短文本因此不会被切成单字。
 *
 * @param {string} text
 * @param {number} count
 * @returns {string[]}
 */
function splitTextForMeme(text, count) {
  const source = String(text ?? '')
  if (!source) return []
  const want = Math.max(1, Math.floor(Number(count) || 1))
  if (want <= 1) return [source]

  const pieces = []
  let rest = source
  let remaining = want
  while (remaining > 1) {
    // 每段至少 2 字符（中文场景下切成单字很难看）
    if (rest.length < remaining * 2) break
    const target = Math.max(1, Math.round(rest.length / remaining))
    const window = Math.max(3, Math.round(rest.length * 0.4))
    let cut = nearestCut(rest, target, window, SENTENCE_PUNCT)
    if (cut < 0) cut = nearestCut(rest, target, window, COMMA_PUNCT)
    if (cut < 0) cut = nearestCut(rest, target, window, WHITESPACE)
    if (cut < 0) cut = safeHardCut(rest, target)
    if (cut <= 0 || cut >= rest.length) break
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
    remaining -= 1
  }
  if (rest) pieces.push(rest)
  return pieces
}

/** 校验提取出来的 positions 是不是「在正文范围内、单调不减」的合法下标。 */
function validPositions(positions, max) {
  if (!Array.isArray(positions) || positions.length === 0) return null
  const out = []
  for (const value of positions) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) return null
    const index = Math.min(Math.floor(parsed), max)
    if (out.length > 0 && index < out[out.length - 1]) return null
    out.push(index)
  }
  return out
}

/**
 * 把「清洗后的正文 + 类别列表」排成消息段。
 *
 * 段形状（契约）：
 *   { type: 'text',  data: { text } }
 *   { type: 'image', data: { path } }   // path 是本机绝对路径，L1 转 base64
 *
 * 混排规则：
 *   · rng < inlineProbability → 图夹在文字里：每个文本段后面跟一张图
 *     （有 positions 时按她原来标记的位置切，没有时按句末/逗号/空白自然边界切）；
 *   · 否则 → 文字整段在前，图全部放到最后，并且每张图带 `trailing: true`
 *     交给调用方「文字发完再单独发」。
 *
 * 兜底：
 *   · 抽不到图（类别空 / 文件被删 / store 没给）→ 退回纯文本，**永不把 && 漏出去**；
 *   · 图比文本段多 → 多出来的图接在最后，不丢；
 *   · 正文只有标记 → 返回纯图段（调用方照常发图）。
 *
 * rng 调用顺序固定：先掷混排率，再按 tags 顺序给每次 pick 用 —— 测试可复现。
 *
 * @param {string} text 清洗后的正文（也容忍带标记的原文：这里会再清一遍）
 * @param {string[]} tags 类别列表（顺序 = 抽图顺序）
 * @param {{pick: Function}} store 表情库（只需要 pick(category, { rng })）
 * @param {{inlineProbability?: number, rng?: () => number, positions?: number[]}} [options]
 * @returns {Array<{type: 'text'|'image', data: {text?: string, path?: string}, trailing?: boolean}>}
 */
export function buildSegments(text, tags, store, options = {}) {
  const { inlineProbability = 0.5, rng = Math.random } = options
  const raw = String(text ?? '')
  // 防御：调用方如果直接把带标记的原文递进来，这里也得把标记清掉（任何路径不漏 &&）
  const hasMarkers = raw.includes('&&')
  const source = hasMarkers ? stripResidualMarkers(raw) : raw

  // positions 的坐标系是「已清洗正文」；原文里还有标记时位置不可信，直接不用
  const positions = hasMarkers ? null : validPositions(options.positions, source.length)
  const categories = (Array.isArray(tags) ? tags : [])
    .map((item) => String(item ?? '').trim().toLowerCase())
    .filter(Boolean)

  // ① 先掷混排率（rng 第一步，顺序固定好测试）
  const roll = typeof rng === 'function' ? Number(rng()) : 0.5
  const ratio = Number.isFinite(roll) ? clamp01(roll) : 0.5
  const inline = ratio < clamp01(inlineProbability)

  // ② 抽图（抽不到的类别跳过，不拿别的类别顶替 —— 那会让她发的情绪对不上）
  const picks = []
  for (let index = 0; index < categories.length; index += 1) {
    let picked = null
    try {
      picked = store && typeof store.pick === 'function' ? store.pick(categories[index], { rng }) : null
    } catch {
      picked = null // 图库出问题不能把整条回复搞崩
    }
    if (picked && picked.path) {
      picks.push({ category: categories[index], path: String(picked.path), name: String(picked.name ?? '') })
      picks[picks.length - 1].tagIndex = index
    }
  }

  // ③ 抽不到图 → 退回纯文本
  if (picks.length === 0) {
    const plain = stripResidualMarkers(source)
    return plain ? [textSegment(plain)] : []
  }

  const segments = []
  if (!inline) {
    const plain = stripResidualMarkers(source)
    if (plain) segments.push(textSegment(plain))
    for (const pick of picks) segments.push(imageSegment(pick, true))
    return segments
  }

  // ④ 混排：有标记位置就按位置切（最忠实于她原来那句）
  if (positions && positions.length === categories.length) {
    let cursor = 0
    for (const pick of picks) {
      const cut = Math.max(cursor, Math.min(positions[pick.tagIndex] ?? cursor, source.length))
      const piece = stripResidualMarkers(source.slice(cursor, cut))
      if (piece) segments.push(textSegment(piece))
      segments.push(imageSegment(pick, false))
      cursor = cut
    }
    const tail = stripResidualMarkers(source.slice(cursor))
    if (tail) segments.push(textSegment(tail))
    return segments
  }

  // ⑤ 混排：没有位置信息 → 按自然边界把正文切成「图数 + 1」段，图插在段与段之间
  const pieces = splitTextForMeme(source, picks.length + 1)
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = stripResidualMarkers(pieces[index])
    if (piece) segments.push(textSegment(piece))
    if (index < picks.length) segments.push(imageSegment(picks[index], false))
  }
  // 文本段比图少（正文很短/只有标点）：多出来的图接在最后，一张都不丢
  for (let index = pieces.length; index < picks.length; index += 1) {
    segments.push(imageSegment(picks[index], false))
  }
  return segments
}

/**
 * 把 buildSegments 的结果拆成「文字段」和「图段」，方便调用方决定怎么发。
 *
 * @param {Array<object>} segments
 * @returns {{texts: Array<object>, images: Array<object>, hasTrailing: boolean}}
 */
export function splitSegmentPlan(segments) {
  const list = Array.isArray(segments) ? segments.filter(Boolean) : []
  return {
    texts: list.filter((segment) => segment.type === 'text' && String(segment.data?.text ?? '')),
    images: list.filter((segment) => segment.type === 'image'),
    hasTrailing: list.some((segment) => segment.trailing === true),
  }
}
