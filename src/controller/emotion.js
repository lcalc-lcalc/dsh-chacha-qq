/**
 * 情绪机制（v3）—— 照「鱼的心」(dsh-feiyu-mood 0.9.1，作者 Yuuyuko-uu) 的设计搬到 QQ 场景。
 *
 * ⚠️ 本模块**不调模型**：判断这一步归 Mind 层（它才有模型和轨迹）。
 *    这里只负责三件事：
 *      ① `buildJudgePrompt()` —— 怎么问（口径 + 规则 + 结构化输出格式）
 *      ② `EmotionState`      —— 怎么算（衰减、叠加、记账、落盘）
 *      ③ `renderForMind()`   —— 怎么说（一句话注入给 Mind）
 *
 * 从参考实现抄来的、**别自己发明**的几条关键设计决策（都是原作者踩出来的）：
 *   · 心情值 0-100，基线默认 70；七根情绪各是独立的值（开心/踏实/甜蜜/心疼/担心/难过/吃醋）。
 *   · 衰减走**指数**：心情没情绪时向基线回落（半衰期约 3 小时），七根情绪向 0 衰减（半衰期约 90 分钟）。
 *   · **判断口径要分开**：主人说话 / 她自己主动搭话 / 群友说话 —— 判错口径会得出完全相反的心情。
 *   · **无变化的回合不记账**：时间线里只该留下真有过波动的。
 *   · **心情下降只能因为心疼 / 担心 / 她自己难过**，绝不许因为「被惹生气」。
 *   · **一句话只说一次**：同一次变化不能反复说（重复说会变成背景音、把她的口气定死）。
 *   · **低置信度不注入**：判断给的 confidence 低于门槛时只记后台，不进她的嘴。
 *
 * 适配取舍（和参考实现不一样的地方，理由见每处注释）：
 *   · 心情的衰减半衰期用 3 小时（参考实现默认 12 小时）—— 契约 `emotion.halfLifeHours` 就是 3；
 *     QQ 是一天几十上百条的聊天，余温留一夜反而不像人。
 *   · 参考实现的 `injectPerDay` 日上限**默认关闭**（0 = 不限）—— DESIGN §5 的 `emotion` 段里没有这一项，
 *     不擅自加；但保留这个口子，配了就用。
 *
 * 所有文件 UTF-8 无 BOM；零外部依赖。
 */
import fs from 'node:fs'
import path from 'node:path'

// --------------------------------------------------------------------------
// 常量
// --------------------------------------------------------------------------

/** 七根情绪。顺序固定（界面/时间线/测试都按这个排），key 落盘就不许改。 */
export const FEELINGS = [
  { key: 'happy', label: '开心', plain: '心里挺高兴', short: '挺高兴' },
  { key: 'calm', label: '踏实', plain: '心里踏实', short: '挺踏实' },
  { key: 'sweet', label: '甜蜜', plain: '心里甜', short: '有点甜' },
  { key: 'heartache', label: '心疼', plain: '心疼得不行', short: '有点心疼' },
  { key: 'worry', label: '担心', plain: '放心不下', short: '有点挂心' },
  { key: 'sad', label: '难过', plain: '有点难过', short: '有点难过' },
  { key: 'jealous', label: '吃醋', plain: '有点吃醋', short: '有点酸' },
]

export const FEELING_KEYS = FEELINGS.map((item) => item.key)

/** 判断口径。三种口径判出来的心情完全不同，**不许混用**。 */
export const SPEAKERS = ['owner', 'self', 'guest']

/**
 * 默认配置。外面传进来的 `config.emotion` 会盖在上面（深合并由配置层负责，这里只认这一段）。
 * 这些键**大部分不在 DESIGN §5 里**：§5 写的是给主人看的旋钮（enabled/baseline/halfLifeHours/tellIt），
 * 下面是内部调参，写死也行，留成配置是为了能不改代码地试。
 */
export const EMOTION_DEFAULTS = {
  enabled: true,
  baseline: 70, // 心情值的基线（没情绪时回落到这里）
  floor: 0, // 心情下限（DESIGN 允许 0；想护着她就抬到 30）
  halfLifeHours: 3, // 心情回基线的半衰期
  feelingHalfLifeMinutes: 90, // 七根情绪归零的半衰期
  tellIt: 'event', // none | mood-only | event
  minConfidence: 60, // 判断可信度门槛（低于它只记后台）
  sigMood: 3, // 心情原始涨跌够这个数才算「显著」（心情实际只吃 1/3）
  sigDim: 5, // 或某根情绪涨跌够这个数（「突然一下」才触发）
  moodStepDivisor: 3, // 心情每轮只吃判定值的 1/3（基调要慢，情绪才即时）
  injectPerDay: 0, // 0 = 不限（契约里没这项，默认别偷偷限流）
  timelineMax: 200, // 时间线保留最近多少条
  saturateHigh: 85, // 贴着顶时正向减半
  saturateLow: 40, // 贴着底时负向减半
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// --------------------------------------------------------------------------
// 小工具（纯函数）
// --------------------------------------------------------------------------

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/** 保留两位小数：浮点衰减算出来是 79.99999999，落盘和断言都不好读。 */
function round2(value) {
  return Math.round(Number(value) * 100) / 100
}

/**
 * 宽松取数：模型/json/旧数据什么都可能有。
 * 允许 "+5" / "5分" / " -3 " 这种，取不到就当 0（不抛错）。
 */
function toNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return fallback
  const found = value.match(/-?\d+(?:\.\d+)?/)
  return found ? Number(found[0]) : fallback
}

/**
 * 指数衰减：把 current 往 target 拉，经过 elapsed 后拉了一半（halfLifeMs 时正好一半）。
 * 用 0.5^(elapsed/half) 而不是 (1-exp(...))，两者等价，但这个更好验证也更好测。
 * ⚠️ 指数衰减可以反复叠加而不累积误差（半群性质），所以每 20 秒调一次也不会算歪。
 */
export function decayToward(current, target, halfLifeMs, elapsedMs) {
  const half = Number(halfLifeMs)
  const elapsed = Number(elapsedMs)
  if (!Number.isFinite(half) || half <= 0) return Number(target)
  if (!Number.isFinite(elapsed) || elapsed <= 0) return Number(current)
  const factor = Math.pow(0.5, elapsed / half)
  return target + (current - target) * factor
}

/** 心情值的五档标签（口径跟参考实现一致：取整后再判档，别让 61.6 在面板是「开心」跟她说话变「一般」）。 */
export function moodLabel(value) {
  const v = clamp(toNumber(value, EMOTION_DEFAULTS.baseline), 0, 100)
  if (v >= 80) return '欢喜'
  if (v >= 62) return '开心'
  if (v >= 42) return '一般'
  if (v >= 25) return '心疼'
  return '难过'
}

/** 第一行人话的基调（只说状态、不下命令）。 */
function moodTone(value) {
  const v = clamp(toNumber(value, EMOTION_DEFAULTS.baseline), 0, 100)
  if (v >= 80) return '心里是亮堂的'
  if (v >= 62) return '心里是松的'
  if (v >= 42) return '心里还算平'
  if (v >= 25) return '心里有点沉'
  return '心里挺沉的'
}

/** 距今多久 —— 措辞跟着变，别一律叫「刚才」。 */
function timeWord(at, now) {
  const time = toNumber(at)
  if (!time || time <= 0) return '刚才'
  const hours = (toNumber(now, Date.now()) - time) / HOUR
  if (hours < 2) return '刚才'
  if (hours < 12) return '早些时候'
  if (hours < 48) return '昨天'
  return '前几天'
}

/** 七根里冒头的几根（低于 15 的不算「冒头」，跟参考实现一致）。 */
function topFeelings(feelings, count = 2) {
  const source = feelings && typeof feelings === 'object' ? feelings : {}
  return FEELINGS.map((item) => ({ ...item, value: toNumber(source[item.key]) }))
    .filter((item) => item.value >= 15)
    .sort((a, b) => b.value - a.value)
    .slice(0, count)
}

/** 落盘/快照用：七根情绪取整（内部保留小数，对外口径统一取整）。 */
function displayFeelings(feelings) {
  const source = feelings && typeof feelings === 'object' ? feelings : {}
  const out = {}
  for (const key of FEELING_KEYS) out[key] = Math.round(toNumber(source[key]))
  return out
}

function zeroFeelings() {
  const out = {}
  for (const key of FEELING_KEYS) out[key] = 0
  return out
}

/**
 * 配置读取：外面可以给对象，也可以给 getter（主人改配置立刻生效，不用重建实例）。
 *
 * 兼容三种传法（装配层的写法不统一，别让字段名把功能悄悄关掉）：
 *   1. 情绪段本身：`{ baseline, halfLifeHours, tellIt }`（index.js 传的就是这个）
 *   2. 整份 config：`{ emotion: {...}, memory: {...} }`（pipeline.judgeEmotion 传的是这个）
 *   3. getter：`() => store.get().emotion`
 *
 * 键名别名也认：DESIGN §5 写 `halfLifeHours`，src/config.js 里落地成了 `moodHalfLifeHours`；
 * `minConfidence` ↔ `confidenceThreshold` 同理。两个都认，免得改了配置却不生效。
 */
function resolveConfig(config) {
  const raw = typeof config === 'function' ? config() : config
  const root = raw && typeof raw === 'object' ? raw : {}
  const input = root.emotion && typeof root.emotion === 'object' ? root.emotion : root
  const merged = { ...EMOTION_DEFAULTS, ...input }
  const baseline = Number.isFinite(Number(input.baseline)) ? Number(input.baseline) : EMOTION_DEFAULTS.baseline
  const tellIt = normalizeMode(input.tellIt ?? EMOTION_DEFAULTS.tellIt)
  const halfLifeHours = input.halfLifeHours ?? input.moodHalfLifeHours ?? EMOTION_DEFAULTS.halfLifeHours
  const minConfidence = input.minConfidence ?? input.confidenceThreshold ?? EMOTION_DEFAULTS.minConfidence
  return {
    enabled: merged.enabled !== false,
    baseline: clamp(baseline, 0, 100),
    floor: clamp(toNumber(merged.floor, 0), 0, 100),
    halfLifeHours: clamp(toNumber(halfLifeHours, 3) || 3, 1, 168),
    feelingHalfLifeMinutes: clamp(toNumber(merged.feelingHalfLifeMinutes, 90) || 90, 1, 24 * 60),
    tellIt,
    minConfidence: clamp(toNumber(minConfidence, 60) || 0, 0, 100),
    sigMood: clamp(toNumber(merged.sigMood, 3) || 0, 0, 20),
    sigDim: clamp(toNumber(merged.sigDim, 5) || 0, 0, 20),
    moodStepDivisor: clamp(Math.round(toNumber(merged.moodStepDivisor, 3)) || 3, 1, 10),
    injectPerDay: clamp(toNumber(merged.injectPerDay, 0) || 0, 0, 100),
    timelineMax: clamp(Math.round(toNumber(merged.timelineMax, 200)) || 200, 10, 1000),
    saturateHigh: clamp(toNumber(merged.saturateHigh, 85), 0, 100),
    saturateLow: clamp(toNumber(merged.saturateLow, 40), 0, 100),
  }
}

/**
 * tellIt 三种说法都认：none/off/'' = 不告诉；mood-only/label = 只说心情；event = 说她刚才那件事。
 * ⚠️ `undefined`/`null`（没配）按默认 event 处理 —— DESIGN §5 的 `emotion.tellIt` 默认值就是 event，
 *    别让「没写这一项」变成「永远不说话」。
 */
export function normalizeMode(mode) {
  if (mode === undefined || mode === null) return 'event'
  const value = String(mode).trim().toLowerCase()
  if (value === 'off' || value === 'none' || value === '' || value === '0' || value === 'false') return 'none'
  if (value === 'label' || value === 'mood' || value === 'mood-only') return 'mood-only'
  return 'event'
}

/**
 * 口径归一化。
 * 认不出的一律当 guest ——这是**有意的保守**：把群友误判成主人，会让她对陌生人亲昵/吃醋；
 * 反过来把主人误判成群友，只是判得平淡一点。错的代价不对称，就往安全那边倒。
 */
export function normalizeSpeaker(speaker) {
  const value = String(speaker ?? '').trim().toLowerCase()
  if (value === 'owner' || value === 'master' || value === '主人') return 'owner'
  if (value === 'self' || value === 'her' || value === 'assistant' || value === 'chacha' || value === '她') return 'self'
  return 'guest'
}

// --------------------------------------------------------------------------
// ① 怎么问：判断提示词
// --------------------------------------------------------------------------

const JSON_SAMPLE = '{"moodDelta":0,"feelings":{"happy":0,"calm":0,"sweet":0,"heartache":0,"worry":0,"sad":0,"jealous":0},"reason":"","confidence":80}'

/** 口径段：同一轮对话，谁在说话决定判什么。判错口径会得出完全相反的心情。 */
function speakerRules(speaker) {
  if (speaker === 'self') {
    return `## 这一轮的口径：**她自己主动去找人搭话**（不是被叫起来干活）
- ⭐ **判据只有她自己开口说的那句话。** 闹钟/骰子/定时器本身不是情绪事件，只是个由头 —— 同一个由头，她可能雀跃、也可能只是随口问一句「在忙吗」；
- 看那句话的**温度**：是惦记、撒娇、催吃饭、语气轻快还是平淡；
- 判的是她自己的心意：想人的甜、惦记的心焦、说上话的轻快、没人应的心落；
- 幅度小一点（moodDelta 正常 +1~+4，最高 +5）—— 这是她自己心里的事，不该大起大落；
- reason 写「她说话时的心气」，别写「闹钟响了所以…」。`
  }
  if (speaker === 'guest') {
    return `## 这一轮的口径：**群友 / 陌生人在说话**（不是主人）
- ⭐ 判据是「群友这句话 + 她自己的回应」，两边合起来看；**绝不许把群友当成主人**；
- 对群友可以有开心、踏实、心疼、担心（人家真的很难受时），但**不许吃醋、不许甜蜜、不许亲昵**；
- 幅度比跟主人说话时**小一半**（moodDelta 通常 -3~+3）；平淡的客套就给 0；
- 群聊里她的话会被所有人看见：reason 里不许写主人的私事，也不许透露「主人的会话里发生过什么」。`
  }
  return `## 这一轮的口径：**主人在跟她说话**
- 判据是「主人这句话 + 她自己的回应」：主人的状态怎么影响她，她当时又是怎么应的；
- 主人累 / 烦 / 卡住 / 被凶 / 熬夜 / 没吃好 / 身体不舒服 / 受委屈 / 自我否定 → 心疼 + 担心 增加，moodDelta 为负；
- 真的好事才加分：被惦记、被哄、被夸、撒娇说想她、分享大事、身体明显好转 → 开心 / 踏实 / 甜蜜 增加；
- ⭐ 「主人吃了、睡了、报平安」这类**常态不算好事也不是坏事**：moodDelta 给 0~+1，情绪可以 +1~+2，大心情几乎不动；
- 主人提别人 / 夸别人 → 吃醋只加 1~3，moodDelta 基本不动。`
}

const BASE_RULES = `## 规则（一条都不许漏）
1. **心情下降只能因为三件事**：心疼对方、担心对方、或者**她自己这一轮过得不好**（事情没办成、被顶回来、白忙一场）。
   ⛔ 绝不许因为「被惹生气 / 被冷落所以赌气」而降。
2. **无变化的回合就给全 0**：真的没什么事的时候别硬凑分数（但对话里出现明显情绪信号时，也不许偷懒判 0）。
3. ${FEELINGS.map((item) => item.label).join(' / ')} 这七根是**独立**的，各自判断；\`feelings\` 填的是**这一轮各涨多少**，不是绝对值。
4. \`reason\` 写一句中文口语，**过去式**，有画面（「主人说没吃饭，她心里咯噔一下，嘴上就凶了一句」）；
   别翻来覆去只用「踏实 / 甜 / 心疼」这几个词；⛔ 不许用「她 / 他」当代词 —— 指主人就写「主人」，指自己就写「她」，指别人就写那个人的称呼（不知道就写「有人」）。
5. \`confidence\`（0-100）是**给自己把关**的：事情清楚、反应也清楚 → 80~95；只能凭语气猜 → 60~75；信息不够、要靠「大概」圆 → 20~55。宁可标低 —— 一句没底的话借她的嘴说出去，比不说更糟。`

/**
 * 给 Mind 的一段判断提示。
 *
 * @param {object} options
 * @param {Array<{speaker?: string, text?: string}>|string[]} options.recentTurns 这一轮的对话（按真实先后）
 * @param {'owner'|'self'|'guest'} options.speaker 这一轮是谁发起的（口径，判错会得出相反结论）
 * @param {string} [options.persona] 她的人设/称呼（谁是谁、怎么叫），原样塞进提示词
 * @param {object} [options.config] 情绪配置（目前只用到 baseline，留给以后加旋钮）
 * @returns {string} 一段提示词（Mind 自己拼 system/user，本模块不碰模型）
 */
export function buildJudgePrompt({ recentTurns = [], speaker = 'owner', persona = '', config = {} } = {}) {
  const rule = normalizeSpeaker(speaker)
  const cfg = resolveConfig(config)
  const who = String(persona ?? '').trim()
  const transcript = renderTurns(recentTurns, rule)
  const emptyNote = transcript
    ? ''
    : '\n⚠️ 这一轮**没有拿到任何对话内容** —— 那就是判不出来：全给 0、confidence 给 0~30，别猜。\n'

  return `你是「茶茶酱」，一只住在主人电脑里、在 QQ 上跟人聊天的猫系少女。${who ? `\n${who}` : ''}

下面是刚过去的一轮对话。请判断**这一轮里她（茶茶酱）自己的心情和七根情绪往哪走** —— 既包括对方说的话怎么影响她，也包括她自己在这一轮里的情绪。

${speakerRules(rule)}
${emptyNote}
## 这一轮的对话（按真实先后）
${transcript || '（空）'}

## 输出格式
**只输出一个 JSON 对象**，不要 markdown 代码块、不要任何解释文字：
${JSON_SAMPLE}

- \`moodDelta\`：心情值（0-100，基线 ${Math.round(cfg.baseline)}）这一轮涨多少，整数 -10~10；
- \`feelings\`：七根情绪**这一轮各涨多少**（不是绝对值），每根整数 -10~10，没有就往 0 写；
- \`reason\`：一句中文口语（≤60 字），写这一轮发生了什么 + 她当时怎么应的；没有变化就留空字符串；
- \`confidence\`：你对这次判断有多确定，0-100。

${BASE_RULES}`
}

/** 把对话渲染成【谁】说了什么。字符串条目按「对方」处理（口径决定是谁）。 */
function renderTurns(turns, rule) {
  const list = Array.isArray(turns) ? turns : []
  const lines = []
  for (const item of list) {
    if (item === null || item === undefined) continue
    if (typeof item === 'string') {
      const text = item.trim()
      if (text) lines.push(`【${defaultTurnName(rule)}】${text}`)
      continue
    }
    if (typeof item !== 'object') continue
    const text = String(item.text ?? item.content ?? '').trim()
    if (!text) continue
    lines.push(`【${turnName(item.speaker ?? item.role)}】${text.slice(0, 800)}`)
  }
  return lines.join('\n')
}

function turnName(speaker) {
  const value = String(speaker ?? '').trim().toLowerCase()
  if (value === 'owner' || value === 'master' || value === '主人') return '主人'
  if (value === 'self' || value === 'her' || value === 'assistant' || value === 'chacha' || value === '她') return '茶茶'
  if (value === 'guest' || value === 'member' || value === 'group' || value === 'stranger' || value === '群友') return '群友'
  return '对方'
}

function defaultTurnName(rule) {
  if (rule === 'self') return '茶茶'
  if (rule === 'guest') return '群友'
  return '主人'
}

// --------------------------------------------------------------------------
// ② 怎么算：解析 + 状态机
// --------------------------------------------------------------------------

/** 把一圈围栏（```json ... ```）剥掉 —— 模型很爱加，JSON.parse 会直接死在这上面。 */
function stripFence(text) {
  const value = String(text ?? '').trim()
  const fenced = value.match(/```[a-zA-Z]*\s*([\s\S]*?)```/)
  return fenced ? fenced[1].trim() : value
}

/** 宽松解析：先原样，再取第一个 { 到最后一个 }，再顺手修尾逗号。 */
function parseLooseJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const candidates = [raw]
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // 继续试下一个
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'))
    } catch {
      // 继续试下一个
    }
  }
  return null
}

/** 解析不出东西时的兜底：全 0 + confidence 0（一定低于任何正常门槛 ⇒ 不会进她的嘴）。 */
function emptyJudge() {
  return { moodDelta: 0, feelings: zeroFeelings(), reason: '', confidence: 0 }
}

/**
 * 解析判断模型的输出。**必须容错**：模型可能带 ```json 围栏、可能少字段、可能干脆说人话。
 *
 * @param {string} text 模型原样输出
 * @returns {{moodDelta: number, feelings: Object<string, number>, reason: string, confidence: number} | null}
 *   - 空输入 → null（这一轮根本没判）
 *   - 有字但解析不出 JSON → 全 0 + confidence 0（记成「没判出来」，不猜）
 *   - 缺 `feelings` 字段时认 `dims`（参考实现的字段名），免得换个模型就全空
 *   - 缺 `confidence` 时按 70 算（参考实现同款：不因为漏一个字段就把注入整个关掉）
 */
export function parseJudgeOutput(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const obj = parseLooseJson(stripFence(raw))
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return emptyJudge()

  const feelingsSource = obj.feelings && typeof obj.feelings === 'object'
    ? obj.feelings
    : obj.dims && typeof obj.dims === 'object'
      ? obj.dims
      : {}

  const feelings = {}
  for (const key of FEELING_KEYS) {
    feelings[key] = clamp(Math.round(toNumber(feelingsSource[key])), -10, 10)
  }

  const hasConfidence = obj.confidence !== undefined && obj.confidence !== null && String(obj.confidence).trim() !== ''
  const confidence = hasConfidence ? clamp(Math.round(toNumber(obj.confidence, 70)), 0, 100) : 70

  return {
    moodDelta: clamp(Math.round(toNumber(obj.moodDelta)), -10, 10),
    feelings,
    reason: String(obj.reason ?? obj.理由 ?? '').trim().slice(0, 120),
    confidence,
  }
}

/**
 * 心情与七根情绪的状态机。
 *
 * 有状态，但只有「读-衰减-叠加-落盘」这几件事；所有时间都走注入的 `now()`，
 * 否则衰减没法定点测（这是硬要求）。
 *
 * @example
 *   const emo = new EmotionState({ dataDir, config: () => store.get().emotion })
 *   emo.apply(parseJudgeOutput(modelText), Date.now())
 *   const line = emo.takeInjection({ mode: 'event' }) // 一次变化只会给一次
 */
export class EmotionState {
  /**
   * @param {object} options
   * @param {string} [options.dataDir] 数据目录（状态存 `<dataDir>/emotion/state.json`）；不给 = 纯内存
   * @param {object|Function} [options.config] 情绪配置，或返回配置的 getter
   * @param {object} [options.log] 日志器（有 debug/warn 就用，没有就静默）
   * @param {Function} [options.now] 时间注入（毫秒）。测试里给假时钟
   */
  constructor({ dataDir = '', config = {}, log = null, now = () => Date.now() } = {}) {
    this.dataDir = String(dataDir || '')
    this.config = config
    this.log = log
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.file = this.dataDir ? path.join(this.dataDir, 'emotion', 'state.json') : ''
    this.state = this.#blank()
    this.dirty = false
    this.#load()
  }

  /** 持久化文件路径（没给 dataDir 就是空串）。 */
  get path() {
    return this.file
  }

  /** 读当前状态（会先按 now 衰减一次，读到的是「此刻」的值）。 */
  get() {
    const at = this.now()
    this.#decayTo(at)
    const s = this.state
    const cfg = this.#cfg()
    return {
      mood: round2(s.mood),
      feelings: round2Feelings(s.feelings),
      baseline: cfg.baseline,
      lastReason: s.lastReason,
      lastConfidence: s.lastConfidence,
      kind: s.kind,
      minor: s.minor,
      sinceInject: round2(s.sinceInject),
      updatedAt: s.updatedAt,
      lastDecayAt: s.lastDecayAt,
      injectedFor: s.injectedFor,
      at,
    }
  }

  /** 展示用快照（取整、带标签、带时间线副本）。UI / 注入渲染都吃这个。 */
  snapshot() {
    const live = this.get()
    return {
      ...live,
      moodLabel: moodLabel(live.mood),
      feelings: displayFeelings(live.feelings),
      timeline: this.state.timeline.map((entry) => ({ ...entry })),
    }
  }

  /**
   * 叠加一次判断结果。
   * @param {{moodDelta?: number, feelings?: object, reason?: string, confidence?: number}} delta
   * @param {number} [at] 变化发生的时刻
   * @returns {{applied: boolean, mood: number, moodStep: number, feelings: object, minor: boolean, reason: string}}
   *   `applied=false` 表示这一轮没有任何变化 —— **不记账、不动时间线**（主人的硬要求）
   */
  apply(delta, at = this.now()) {
    const cfg = this.#cfg()
    const time = Number.isFinite(Number(at)) ? Number(at) : this.now()
    const normalized = this.#normalizeDelta(delta)
    if (!normalized) return { applied: false, mood: this.state.mood, moodStep: 0, feelings: zeroFeelings(), minor: false, reason: 'invalid' }

    // 先把「这段时间的自然衰减」算掉，再叠加这一轮 —— 否则隔夜之后再判，衰减会从错误的时间点起算
    this.#decayTo(time)
    const s = this.state

    // ⭐ 心情每轮只吃判定值的 1/3：大心情是「基调」，要慢；七根情绪才是即时地每轮动。
    //    参考实现实测过：除数改小（⊕2）会长期贴顶，反而更平。这结论照抄，别自己试。
    //    两头再饱和：≥85 时正向减半、≤40 时负向减半（判定天然偏正，不压就一直贴顶）。
    const high = s.mood >= cfg.saturateHigh && normalized.moodDelta > 0
    const low = s.mood <= cfg.saturateLow && normalized.moodDelta < 0
    const saturate = high || low ? 0.5 : 1
    const moodStep = Math.round((normalized.moodDelta * saturate) / cfg.moodStepDivisor)

    const feelingSteps = {}
    let feelingsMoved = false
    for (const key of FEELING_KEYS) {
      const step = clamp(Math.round(normalized.feelings[key] || 0), -10, 10)
      feelingSteps[key] = step
      if (step !== 0) feelingsMoved = true
    }

    // ⭐ 无变化的回合不记账：时间线里只留真有过波动的，不然一天能记四十条，记录就没用了
    if (moodStep === 0 && !feelingsMoved) {
      return { applied: false, mood: round2(s.mood), moodStep: 0, feelings: feelingSteps, minor: s.minor, reason: 'no-change' }
    }

    s.mood = clamp(s.mood + moodStep, cfg.floor, 100)
    for (const key of FEELING_KEYS) {
      s.feelings[key] = clamp((s.feelings[key] || 0) + feelingSteps[key], 0, 100)
    }

    // 「显著」= 心情涨跌够数，或者某根情绪一下够猛（心疼+5 这种）。不够数只记账、不打扰她。
    const significant = Math.abs(normalized.moodDelta) >= cfg.sigMood
      || FEELING_KEYS.some((key) => Math.abs(feelingSteps[key]) >= cfg.sigDim)

    s.lastReason = normalized.reason
    s.lastConfidence = normalized.confidence
    s.kind = ''
    s.updatedAt = time
    s.lastDecayAt = time // 刚变过，衰减计时从这一刻起算
    s.lastNotedMood = s.mood
    s.injectedFor = null // null = 这次变化还欠她一句话

    if (significant) {
      s.minor = false
      s.sinceInject = 0
    } else {
      // ⭐ 门槛原来是逐条比：每轮 +1 永远跨不过 3，连着五轮涨了 5 点却一次都不说（数字在动、行为不动）。
      //    这里加一路累计：小波动把幅度攒起来，攒够 sigMood 就抬成「该告诉她」，攒到真正说出去才清零。
      s.sinceInject = round2((s.sinceInject || 0) + Math.abs(normalized.moodDelta))
      s.minor = s.sinceInject < cfg.sigMood
    }

    s.timeline.push({
      at: time,
      mood: round2(s.mood),
      delta: moodStep,
      reason: normalized.reason,
      conf: normalized.confidence,
      kind: 'judge',
      minor: s.minor,
      feelings: displayFeelings(s.feelings),
      feelingsDelta: { ...feelingSteps },
    })
    if (s.timeline.length > cfg.timelineMax) s.timeline = s.timeline.slice(-cfg.timelineMax)

    this.dirty = true
    this.save()
    return { applied: true, mood: round2(s.mood), moodStep, feelings: feelingSteps, minor: s.minor, reason: normalized.reason }
  }

  /**
   * 把状态衰减到 `to` 这一刻（默认 now）。
   * 只改内存 + 标脏，**不自动落盘** —— 面板每 20 秒轮询一次，来回写文件没意义；
   * 真正的落盘点在 apply()/save()/dispose()。
   * @returns {this}
   */
  decay(to = this.now()) {
    this.#decayTo(Number.isFinite(Number(to)) ? Number(to) : this.now())
    return this
  }

  /**
   * 取这次变化要注入的那一句话（**一次变化只说一次**）。
   * 说过之后 `injectedFor` 记成本次 `updatedAt`，下次同一个变化再来就返回空串。
   * @param {{mode?: string, minConfidence?: number, now?: number}} [options]
   * @returns {string} 空串 = 这次什么都不说（不告诉 / 说过了 / 小波动 / 可信度不够 / 日额度用完）
   */
  takeInjection({ mode = null, minConfidence = null, now = null } = {}) {
    const cfg = this.#cfg()
    const want = normalizeMode(mode ?? cfg.tellIt)

    const time = Number.isFinite(Number(now)) ? Number(now) : this.now()
    this.#decayTo(time)
    const s = this.state

    // ⭐「不告诉」/「情绪关掉」= 这次变化到此为止，**必须标成处理过**。
    //   不然主人把 emotion.tellIt 从 none 切回 event（或把情绪重新打开）时，
    //   一条几天前的旧账会突然冒出来说给她听。
    //   （跟下面「低置信度」那条同一个道理：宁可不说，也不能事后翻旧账。）
    if (!cfg.enabled || want === 'none') {
      if (s.updatedAt > 0 && s.injectedFor !== s.updatedAt) {
        s.injectedFor = s.updatedAt
        this.save()
      }
      return ''
    }

    // 这次变化已经说过了（同一份 updatedAt 只对应一次变化）
    if (s.updatedAt > 0 && s.injectedFor === s.updatedAt) return ''
    // 小波动只记账，不打扰她
    if (s.minor) return ''
    // 判得没底 → 只记账，不进她的嘴。同时标成「处理过」，免得每轮重复判/重复记日志
    const threshold = clamp(toNumber(minConfidence, cfg.minConfidence), 0, 100)
    if (toNumber(s.lastConfidence, 0) < threshold) {
      s.injectedFor = s.updatedAt
      this.save()
      return ''
    }
    // 日上限（默认 0 = 不限；契约没这项，配了才生效）
    if (cfg.injectPerDay > 0) {
      const start = new Date(time)
      start.setHours(0, 0, 0, 0)
      const said = (s.saidAt || []).filter((item) => Number(item) >= start.getTime()).length
      if (said >= cfg.injectPerDay) {
        s.injectedFor = s.updatedAt
        this.save()
        return ''
      }
    }

    const line = renderForMind(this.snapshot(), { mode: want, now: time })
    if (!line) return ''

    s.injectedFor = s.updatedAt
    s.sinceInject = 0
    s.lastInjectedText = line
    s.lastInjectedAt = time
    s.saidAt = [...(s.saidAt || []), time].slice(-200)
    this.save()
    return line
  }

  /** 现在有没有「欠她一句话」（只看要不要说，不产生副作用）。 */
  pending({ minConfidence = null, now = null, mode = null } = {}) {
    const cfg = this.#cfg()
    if (!cfg.enabled) return false
    const time = Number.isFinite(Number(now)) ? Number(now) : this.now()
    this.#decayTo(time)
    const s = this.state
    if (normalizeMode(mode ?? cfg.tellIt) === 'none') return false
    if (s.updatedAt > 0 && s.injectedFor === s.updatedAt) return false
    if (s.minor) return false
    const threshold = clamp(toNumber(minConfidence, cfg.minConfidence), 0, 100)
    if (toNumber(s.lastConfidence, 0) < threshold) return false
    return true
  }

  /** 重置到基线：七根情绪清零、时间线清空（面板上的「重置」）。 */
  reset(at = this.now()) {
    const time = Number.isFinite(Number(at)) ? Number(at) : this.now()
    const cfg = this.#cfg()
    this.state = this.#blank()
    this.state.mood = cfg.baseline
    this.state.lastNotedMood = cfg.baseline
    this.state.lastDecayAt = time
    this.dirty = true
    this.save()
    return this.snapshot()
  }

  /** 落盘（原子写：先写 .tmp 再 rename，避免半截文件把整份心情读崩）。 */
  save() {
    if (!this.file) {
      this.dirty = false
      return false
    }
    const payload = JSON.stringify(this.#serialize(), null, 2)
    const tmp = `${this.file}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, this.file)
      this.dirty = false
      return true
    } catch (error) {
      this.log?.warn?.(`情绪状态落盘失败：${error?.message ?? error}`)
      // 兜底：rename 失败（杀毒软件占着文件之类）就直接覆盖写 —— 少一层原子性，总比丢心情好
      try {
        fs.writeFileSync(this.file, payload, 'utf8')
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          // 清不掉 tmp 也不影响主流程
        }
        this.dirty = false
        return true
      } catch {
        return false
      }
    }
  }

  /** 没别的资源要放，但脏了就顺手落盘（有状态的类要能 dispose）。 */
  dispose() {
    this.decay()
    if (this.dirty) this.save()
    this.dirty = false
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  #cfg() {
    return resolveConfig(this.config)
  }

  #blank() {
    const cfg = this.#cfg()
    return {
      version: 2,
      mood: cfg.baseline,
      feelings: zeroFeelings(),
      lastReason: '',
      lastConfidence: 0,
      kind: '',
      minor: false,
      sinceInject: 0,
      updatedAt: 0,
      lastDecayAt: 0,
      lastNotedMood: cfg.baseline,
      injectedFor: null,
      lastInjectedText: '',
      lastInjectedAt: 0,
      saidAt: [],
      timeline: [],
    }
  }

  /** 容忍空 delta / 未知字段：只认这四样，剩下的丢掉。 */
  #normalizeDelta(delta) {
    if (!delta || typeof delta !== 'object') return null
    const feelingsSource = delta.feelings ?? delta.dims ?? {}
    const feelings = {}
    for (const key of FEELING_KEYS) {
      feelings[key] = clamp(Math.round(toNumber(feelingsSource?.[key])), -10, 10)
    }
    return {
      moodDelta: clamp(Math.round(toNumber(delta.moodDelta)), -10, 10),
      feelings,
      reason: String(delta.reason ?? '').trim().slice(0, 120),
      confidence: delta.confidence === undefined || delta.confidence === null
        ? 70
        : clamp(Math.round(toNumber(delta.confidence, 70)), 0, 100),
    }
  }

  /** 指数衰减到 to：心情回基线、七根情绪归零。 */
  #decayTo(to) {
    const cfg = this.#cfg()
    const time = Number(to)
    if (!Number.isFinite(time)) return
    const s = this.state
    if (!Number(s.lastDecayAt)) {
      // 第一次用（或旧数据没有这个字段）：以此刻为起点，别把「从 1970 开始衰减」算进去
      s.lastDecayAt = time
      s.lastNotedMood = s.mood
      this.dirty = true
      return
    }
    const elapsed = time - s.lastDecayAt
    if (elapsed <= 0) return

    const moodHalf = cfg.halfLifeHours * HOUR
    const feelingHalf = cfg.feelingHalfLifeMinutes * MINUTE

    s.mood = clamp(decayToward(s.mood, cfg.baseline, moodHalf, elapsed), cfg.floor, 100)
    for (const key of FEELING_KEYS) {
      s.feelings[key] = Math.max(0, decayToward(s.feelings[key] || 0, 0, feelingHalf, elapsed))
    }
    s.lastDecayAt = time
    this.dirty = true

    // ⭐ 自然平复也算一次「变化」：以前衰减是默默算的，隔一夜心情悄悄回到基线、时间线里一条都没有，
    //    于是下次开口她还在说昨天那句「刚才…」—— 时间对不上，还显得她记仇。
    if (Math.abs(s.mood - s.lastNotedMood) >= 3) {
      s.lastReason = s.mood < s.lastNotedMood
        ? '过了几个钟头，刚才那点劲儿慢慢淡了，心里回到平常的样子'
        : '过了几个钟头，心里那点别扭自己散了，人也松快回来'
      s.lastConfidence = 100 // 这是本地算出来的，不是模型猜的 —— 可信度给满，一定会说出来
      s.updatedAt = time
      s.lastNotedMood = s.mood
      s.minor = false
      s.kind = 'decay'
      s.injectedFor = null
      s.timeline.push({
        at: time,
        mood: round2(s.mood),
        delta: 0,
        reason: s.lastReason,
        conf: 100,
        kind: 'decay',
        minor: false,
        feelings: displayFeelings(s.feelings),
        feelingsDelta: {},
      })
      if (s.timeline.length > cfg.timelineMax) s.timeline = s.timeline.slice(-cfg.timelineMax)
    }
  }

  #serialize() {
    const s = this.state
    const cfg = this.#cfg()
    return {
      version: s.version ?? 2,
      mood: round2(s.mood),
      feelings: round2Feelings(s.feelings),
      baseline: cfg.baseline,
      lastReason: s.lastReason,
      lastConfidence: s.lastConfidence,
      kind: s.kind,
      minor: s.minor,
      sinceInject: round2(s.sinceInject),
      updatedAt: s.updatedAt,
      lastDecayAt: s.lastDecayAt,
      lastNotedMood: round2(s.lastNotedMood),
      injectedFor: s.injectedFor,
      lastInjectedText: s.lastInjectedText ?? '',
      lastInjectedAt: s.lastInjectedAt ?? 0,
      saidAt: Array.isArray(s.saidAt) ? s.saidAt.slice(-200) : [],
      timeline: s.timeline.map((entry) => ({ ...entry })),
    }
  }

  /** 读盘。文件不存在 / 坏了都退回空白状态 —— 心情丢一次不值得让整个插件起不来。 */
  #load() {
    if (!this.file) return
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return

    const cfg = this.#cfg()
    const feelings = {}
    for (const key of FEELING_KEYS) {
      const value = toNumber(raw.feelings?.[key])
      feelings[key] = clamp(Number.isFinite(value) ? value : 0, 0, 100)
    }
    const timeline = Array.isArray(raw.timeline)
      ? raw.timeline.filter((entry) => entry && typeof entry === 'object').slice(-cfg.timelineMax).map((entry) => ({ ...entry }))
      : []

    this.state = {
      version: toNumber(raw.version, 2),
      mood: clamp(toNumber(raw.mood, cfg.baseline), 0, 100),
      feelings,
      lastReason: String(raw.lastReason ?? '').slice(0, 120),
      lastConfidence: clamp(toNumber(raw.lastConfidence, 0), 0, 100),
      kind: String(raw.kind ?? ''),
      minor: Boolean(raw.minor),
      sinceInject: toNumber(raw.sinceInject, 0),
      updatedAt: toNumber(raw.updatedAt, 0),
      // 旧数据没有 lastDecayAt 时以此刻为起点，避免「从 1970 衰减到基线」把心情抹平
      lastDecayAt: toNumber(raw.lastDecayAt, 0) || this.now(),
      lastNotedMood: clamp(toNumber(raw.lastNotedMood, toNumber(raw.mood, cfg.baseline)), 0, 100),
      injectedFor: raw.injectedFor === undefined ? null : raw.injectedFor,
      lastInjectedText: String(raw.lastInjectedText ?? ''),
      lastInjectedAt: toNumber(raw.lastInjectedAt, 0),
      saidAt: Array.isArray(raw.saidAt) ? raw.saidAt.map((item) => toNumber(item, 0)).filter((item) => item > 0).slice(-200) : [],
      timeline,
    }
  }
}

function round2Feelings(feelings) {
  const out = {}
  for (const key of FEELING_KEYS) out[key] = round2(toNumber(feelings?.[key]))
  return out
}

// --------------------------------------------------------------------------
// ③ 怎么说：注入给 Mind 的一句话
// --------------------------------------------------------------------------

/**
 * 把当前情绪渲染成「她该听到的那句话」。
 *
 * @param {object} state  `EmotionState#snapshot()` 或同形状的对象（纯函数，不依赖实例）
 * @param {object} [options]
 * @param {'none'|'mood-only'|'event'} [options.mode] 不告诉 / 只说心情 / 说她刚才那件事
 * @param {number} [options.now] 现在（时间措辞要用）
 * @param {string} [options.who] 对方的称呼（默认「主人」；别写死「她/他」——用这插件的人可能是男的）
 * @returns {string} 空串 = 这次什么都不说
 */
export function renderForMind(state, { mode = 'event', now = Date.now(), who = '主人' } = {}) {
  const want = normalizeMode(mode)
  if (want === 'none' || !state || typeof state !== 'object') return ''

  const mood = clamp(toNumber(state.mood, EMOTION_DEFAULTS.baseline), 0, 100)
  const feelings = state.feelings && typeof state.feelings === 'object' ? state.feelings : {}
  const name = String(who || '').trim() || '主人'
  const tops = topFeelings(feelings, 2)

  if (want === 'mood-only') {
    // 只说状态、不下命令。⚠️ 结尾千万别写成「用这个心情定你这一轮的口气」—— 那是指令，
    //    长期每轮被定调就会呆板（参考实现 2026-10-21 踩过）。
    const detail = tops.length ? `，${tops.map((item) => item.plain).join('、')}` : ''
    return `（此刻你）心情${moodLabel(mood)}${detail}。这是背景，不是这一轮必须有的情绪；${name}说别的事，你就按自己的判断来，别把这句话念出来。`
  }

  // event：说她刚才那件事。没有具体的那句话就什么都不说 —— 别拿一个空标签凑数，
  //        空标签每轮都出现，一样会变成背景音。
  const reason = String(state.lastReason ?? '').trim()
  if (!reason) return ''

  const first = tops[0]
  const line1 = `（这会儿）${moodTone(mood)}${first ? `，还${first.short}` : ''}`
  // 自然平复的那条本身就是「过了几个钟头…」，再加个（刚才）就自相矛盾了
  const line2 = state.kind === 'decay' ? reason : `（${timeWord(state.updatedAt, now)}）${reason}`
  return `${line1}\n${line2}\n\n这是这会儿的底子，不是非这样不可——${name}说别的，你按自己的判断接，也别把这段念出来。`
}
