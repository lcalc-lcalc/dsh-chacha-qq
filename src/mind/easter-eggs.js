/**
 * 🥚 彩蛋集中营。
 *
 * 设计原则（很重要，不然彩蛋会变成 bug）：
 *   1. **只加味道，不加逻辑** —— 彩蛋永远不改变「回不回」「发给谁」这类判断，
 *      最坏情况是她说了一句有点奇怪的话，而不是丢消息或发错人。
 *   2. **概率要低** —— 每 5 次就出现一次的叫噪音，不叫彩蛋。
 *   3. **只在日志和文案里** —— 不往 QQ 里塞无意义的东西。
 *   4. **可关闭** —— `config.fun.easterEggs: false` 就全静音。
 *
 * 为什么单独一个文件而不是散在各处：彩蛋是「可以被删掉的东西」，
 * 集中放才好一次性关掉/摘掉，不用在 pipeline 里翻找。
 */

/** 启动时随机说一句。每次重启不一样，看日志的时候会心一笑。 */
export const STARTUP_LINES = [
  '尾巴翘起来了',
  '今天也要好好说话',
  '（伸懒腰）',
  '猫猫已就位，随时可以摸',
  '泡了杯茶，开始上班',
  '枕头上还有昨天的口水印',
  '昨天梦到自己在吃鱼',
  '刚从床上爬起来，头发乱糟糟的',
  '这次一定会记得关灯',
  '把尾巴盘好了，开始工作',
]

/** 收拾行李/下线时说的。 */
export const SHUTDOWN_LINES = [
  '去睡了',
  '尾巴一甩，走了',
  '（打了个哈欠）',
  '先把爪子收起来',
]

/**
 * 深夜关怀。
 *
 * 凌晨还在聊的人，其实不需要「你好厉害」这种话，
 * 需要的是有人注意到「已经很晚了」。
 *
 * **只在 2:00~5:00 触发，且概率只有 8%** —— 每晚聊十句顶多撞上一次。
 * 每次都提醒的话，就是在教训人，不是在关心人。
 */
export const NIGHT_CARE_LINES = [
  '这个点了还没睡？',
  '你再不睡，明天又要骂自己了',
  '（趴在键盘上）你不困吗',
  '夜里的时间过得特别快，你知道的吧',
  '明天还有事的话，现在睡还来得及',
  '我陪你，但你眼睛该休息了',
]

/**
 * 「她被人当成机器人」时的狡辩。
 *
 * 为什么会单独准备这个：模型被直接问「你是 AI 吗」的时候，
 * 往往会一本正经地解释自己的本质，非常出戏。
 * 这里给几条更「像人」的应对，让她有台阶下。
 */
export const NOT_A_ROBOT_LINES = [
  '你才是机器人呢',
  '问这种问题，是不是觉得我回得太快了',
  '……你猜',
  '我是猫，谢谢',
  '我要是机器人，现在就把你拉黑',
]

/**
 * 从数组里挑一条。用 `Math.random` 而不是种子随机 ——
 * 彩蛋不需要可复现，可复现的彩蛋反而无聊。
 */
export function pickOne(lines, random = Math.random) {
  if (!Array.isArray(lines) || lines.length === 0) return ''
  const index = Math.floor(random() * lines.length) % lines.length
  return String(lines[index] ?? '')
}

/**
 * 现在是不是「深夜」。
 *
 * @param {Date|number} [now]
 * @returns {boolean} 2:00 ~ 5:00 之间（含 2 点，不含 5 点）
 */
export function isLateNight(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  const hour = date.getHours()
  return hour >= 2 && hour < 5
}

/**
 * 要不要说那句深夜关怀。
 *
 * @param {object} options
 * @param {Date|number} [options.now]
 * @param {number} [options.probability] 默认 0.08
 * @param {Function} [options.random]
 * @returns {string} 该说的话，空串 = 不说
 */
export function maybeNightCare({ now = new Date(), probability = 0.08, random = Math.random, enabled = true } = {}) {
  if (!enabled) return ''
  if (!isLateNight(now)) return ''
  if (random() >= probability) return ''
  return pickOne(NIGHT_CARE_LINES, random)
}

/**
 * 彩蛋总开关。
 *
 * `config.fun.easterEggs === false` 就全静音。
 * 默认开启 —— 但每条都设计成「关掉也不影响功能」。
 */
export function eggsEnabled(config = {}) {
  return config?.fun?.easterEggs !== false
}
