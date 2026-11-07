/**
 * 一对一会话管理。
 *
 * 主人的要求：
 *   「实行"一对一"制。小DSH中，一个对话对应一个群聊/用户」
 *
 * 所以：
 *   私聊  → `qq-private-<QQ号>`
 *   群聊  → `qq-group-<群号>-<角色>`   ← 主人在群里和群友在群里必须是两条会话
 *
 * ⚠️ 为什么群聊要按角色再拆一条：
 *   同一条会话里，主人在的时候她有工具、群友在的时候她没工具，
 *   角色每句话跳一次，agent 就得拆建一次（旧版实测：每句都重建，慢到没法用）。
 *   拆开之后两条会话各过各的，权限不会串。
 *
 * ⚠️ 重置会话靠**换代次**，不是 dispose：
 *   DSH 的会话按 sessionId 持久化，dispose 之后原地重建会把旧历史 resume 回来。
 *   只有换一个新 sessionId（`-g1`、`-g2`…）才等于真的从头开始。
 */
export class MindSessions {
  /**
   * @param {object} options
   * @param {{get:()=>object, patch:(p:object)=>any}} options.store
   * @param {object} options.log
   * @param {string} [options.prefix]
   */
  constructor({ store, log, prefix = 'qq' }) {
    this.store = store
    this.log = log
    this.prefix = prefix
  }

  /**
   * 会话 key（不含前缀和代次）。
   * @param {{scene:string, peerId:string, groupId?:string, role:string}} message
   * @returns {string}
   */
  keyOf({ scene, peerId, groupId, role }) {
    if (scene === 'group') {
      const gid = String(groupId || peerId || '')
      return `group-${gid}-${role === 'owner' ? 'owner' : 'guest'}`
    }
    return `private-${String(peerId)}`
  }

  /** 这个 key 重置过几次。 */
  generationOf(key) {
    const generations = this.store.get()?.sessions?.generations ?? {}
    return Number(generations[key]) || 0
  }

  /**
   * 开新的一代：旧上下文作废，但记录不删（面板还能看历史）。
   * @returns {number} 新的代次
   */
  reset(key) {
    const generations = { ...(this.store.get()?.sessions?.generations ?? {}) }
    const next = (Number(generations[key]) || 0) + 1
    generations[key] = next
    this.store.patch({ sessions: { generations } })
    this.log?.info?.(`会话 ${key} 已重置到第 ${next} 代`)
    return next
  }

  /**
   * 完整的 sessionId。
   * @param {string} key
   * @returns {string}
   */
  idOf(key) {
    const generation = this.generationOf(key)
    const base = `${this.prefix}-${key}`
    return generation > 0 ? `${base}-g${generation}` : base
  }

  /** 面板用：所有会话的代次快照。 */
  snapshot() {
    const generations = this.store.get()?.sessions?.generations ?? {}
    return Object.entries(generations).map(([key, generation]) => ({
      key,
      generation: Number(generation) || 0,
      sessionId: `${this.prefix}-${key}${Number(generation) > 0 ? `-g${generation}` : ''}`,
    }))
  }
}
