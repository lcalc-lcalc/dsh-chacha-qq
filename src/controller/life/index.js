/**
 * life 模块出口（v3.1 PLAN §3）。
 *
 * 两个文件的分工：
 *   · schedule.js —— 她今天的日程（谁生成、什么时候生成、校验、落盘、work 闸门）
 *   · state.js    —— 当日状态（condition 合成视图）+ 组合出注入给 Mind 的那句话
 *
 * 上层一般只要 `LifeState` 一个实例：
 *
 *   import { LifeState } from './src/controller/life/index.js'
 *   import { buildSchedulePrompt, parseScheduleOutput } from './src/controller/life/index.js'
 *
 *   const life = new LifeState({
 *     dataDir,
 *     config: () => store.get(),      // ⚠️ 整份 config（要读 modes）；只给 life 段也能跑，但模式信息会缺
 *     log,
 *     generate: async ({ count, date }) => {
 *       const reply = await mind.ask({ sessionId: 'qq-life', text: buildSchedulePrompt({ count, date }) })
 *       return parseScheduleOutput(reply.text)
 *     },
 *   })
 *
 *   // 每轮投喂 Mind 之前：
 *   await life.ensureToday({ peerKey })       // 会跨天结算；work 时直接返回，不花一分钱
 *   // buildDynamicContext 里（同步）：
 *   const line = life.renderForMind({ mode, peerKey })   // work → ''
 */

export {
  // 常量 / 默认配置
  SCHEDULE_DEFAULTS,
  SCHEDULE_SEGMENT_MIN,
  SCHEDULE_SEGMENT_MAX,
  MIN_VALID_SEGMENTS,
  SAFE_SCHEDULE,
  // 纯函数
  safeSchedule,
  normalizeSegments,
  parseScheduleOutput,
  buildSchedulePrompt,
  dayStamp,
  minutesOfDay,
  parseClock,
  formatClock,
  // 配置 / 模式
  readRootConfig,
  readLifeSegment,
  readModes,
  lifeEnabled,
  scheduleOnFor,
  hasCompanionSession,
  resolveScheduleConfig,
  // 存储 / 日程簿
  writeJsonAtomic,
  ScheduleBook,
} from './schedule.js'

export {
  // 常量 / 默认配置
  CONDITION_KINDS,
  ENERGY_MIN,
  ENERGY_MAX,
  STATE_DEFAULTS,
  LIFE_DEFAULTS,
  // 纯函数
  buildNote,
  normalizeInjectMode,
  resolveStateConfig,
  resolveLifeConfig,
  // 组合视图
  LifeState,
} from './state.js'
