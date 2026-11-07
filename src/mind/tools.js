/**
 * QQ 工具（跨群版）—— The Mind 的手。
 *
 * 设计要点（沿用旧版的结论，全部有实测依据）：
 *  1. **不绑定当前会话**：每个群管工具都显式收 `group_id` / `qq` 参数，
 *     所以主人半夜在私聊里说「去群里把某某禁言了」也能办到。
 *  2. **只有主人能拿到**：非主人的 agent 一个 QQ 工具都不注册
 *     （`tools.restrict()` 管不住作用域内注册的工具，所以必须不注册，而不是注册了再限）。
 *  3. **每个动作都自己校验身份**：调之前先 `get_group_member_info`，
 *     群主/管理员/自己永远不动 —— 不靠模型的自觉。
 *  4. **工具数量克制**：每个工具的 schema 都要随每次请求发给模型，
 *     多一个就多烧一份 token，所以只留真正需要模型决策的。
 *
 * v3 的改动：
 *  - 依赖从「一个 gateway」变成「gateway + outbox + store + memory」，由 index.js 装配；
 *  - `qq_remember` 改走 `memory.appendMemory()`，不再手拼文件路径。
 */

/**
 * 从 sessionId 反解出当前会话的 QQ 目标（用于"默认发到哪"）。
 *
 * 支持的形状：
 *   qq-private-1111111111
 *   qq-group-999-owner
 *   qq-group-999-guest
 *   qq-group-999            （旧格式，兼容）
 */
export function targetOfSession(sessionId) {
  const text = String(sessionId ?? '')
  let match = /^qq-(private|group)-(\d+)(?:-(owner|guest))?$/.exec(text)
  if (!match) {
    // 兜底：群号/QQ 号不一定全是数字（理论上不会，但别因为格式把人整死）
    match = /^qq-(private|group)-(.+)$/.exec(text)
    if (!match) return null
    const tail = match[2].replace(/-(owner|guest)$/, '')
    return { scene: match[1], peerId: tail }
  }
  return { scene: match[1], peerId: match[2] }
}

/** 统一构造一个工具定义。 */
function defineTool({ name, summary, description, properties, required = [], run, self }) {
  return {
    name,
    description: [summary, ...description].join('\n'),
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.ok ? String(value.message ?? 'ok') : `失败：${value?.message ?? 'unknown'}`,
      }],
    },
    async execute(args, exec) {
      // ⚠️ 必须用箭头函数绑住 this。写成 `run(args, exec)` 的话，
      //    run 内部的 `this.gateway` 会变成 undefined（报 "Cannot read properties of undefined"）。
      try {
        return await run.call(self, args ?? {}, exec)
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    },
  }
}

export class QqTools {
  constructor({ gateway, outbox, store, log, memory, recall, pendingRequests }) {
    this.gateway = gateway
    this.outbox = outbox
    this.store = store
    this.log = log
    this.memory = memory
    /** 跨会话回忆（派子 Agent 复盘别的对话）。可以是实例也可以是 getter */
    this.recall = recall
    this.pendingRequests = pendingRequests ?? new Map()
  }

  /**
   * 往一个 agent 的作用域里注册 QQ 工具。
   * @param {object} agentCtx setup 回调给的 scoped ctx
   * @param {string} sessionId 当前会话（决定"默认发到哪"）
   * @param {string} role owner | guest
   * @returns {number} 注册成功的数量
   */
  register(agentCtx, sessionId, role) {
    // 非主人：一个都不给。跨群能力只属于主人。
    if (role !== 'owner') return 0

    const here = targetOfSession(sessionId)
    if (!here) {
      this.log.warn(`sessionId 反解不出 QQ 目标：${sessionId}`)
      return 0
    }
    const tools = agentCtx?.tools
    if (!tools?.register) {
      this.log.warn('agentCtx.tools 不可用，QQ 工具没注册上')
      return 0
    }

    const defs = this.buildDefinitions(here, sessionId)
    const disposers = []
    for (const def of defs) {
      try {
        const dispose = tools.register(def)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        this.log.error(`注册工具 ${def.name} 失败：`, error)
      }
    }

    try {
      agentCtx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // ignore
          }
        }
      })
    } catch {
      // effect 不可用时，agent 释放会连带回收 scoped ctx
    }

    this.log.info(`已为 ${sessionId} 注册 ${disposers.length} 个 QQ 工具`)
    return disposers.length
  }

  /** 组装工具定义。 */
  buildDefinitions(here, sessionId = '') {
    const defs = []

    /**
     * 群管前置校验：查身份，群主/管理员/自己永不动。
     * @returns {Promise<string|null>} 失败原因；null = 可以动手
     */
    const guardTarget = async (groupId, userId) => {
      if (!groupId) return '缺少 group_id'
      if (!userId) return '缺少 qq 号'
      if (userId === String(this.gateway.selfId)) return '不能对自己动手'
      try {
        const member = await this.gateway.call('get_group_member_info', {
          group_id: groupId,
          user_id: userId,
        })
        const roleName = String(member?.role ?? 'member')
        if (roleName === 'owner') return `${userId} 是群主，动不了`
        if (roleName === 'admin') return `${userId} 是管理员，动不了`
      } catch (error) {
        this.log.warn(`查 ${userId} 在群 ${groupId} 的身份失败：`, error.message)
      }
      return null
    }

    /** 确认茶茶自己在某个群里是什么身份。 */
    const myRoleIn = async (groupId) => {
      try {
        const info = await this.gateway.call('get_group_member_info', {
          group_id: groupId,
          user_id: this.gateway.selfId,
        })
        return String(info?.role ?? 'member')
      } catch {
        return 'unknown'
      }
    }

    // ── 1. 列出她所在的群 ────────────────────────────────────────
    defs.push(defineTool({ self: this, 
      name: 'qq_list_groups',
      summary: '列出茶茶酱在的所有 QQ 群（群号、群名、人数、她自己的身份）。',
      description: [
        '想知道"我在哪些群""某个群号是哪"时用它。',
        '结果里 role 是她在那个群的身份：owner 群主 / admin 管理员 / member 普通成员。',
      ],
      properties: {
        keyword: { type: 'string', description: '可选：按群名筛选。' },
      },
      async run({ keyword }) {
        const groups = await this.gateway.call('get_group_list')
        const list = (Array.isArray(groups) ? groups : [])
          .filter((item) => !keyword || String(item.group_name ?? '').includes(String(keyword)))
          .slice(0, 100)
          .map((item) => ({
            group_id: String(item.group_id),
            name: String(item.group_name ?? ''),
            members: Number(item.member_count ?? 0),
            max: Number(item.max_member_count ?? 0),
          }))

        // 并发查自己在每个群的身份（最多 20 个，避免打爆网关）
        const withRole = await Promise.all(list.slice(0, 20).map(async (item) => ({
          ...item,
          role: await myRoleIn(item.group_id),
        })))

        const lines = withRole.map((item) => `${item.group_id}  ${item.name}（${item.members}人，我是${roleLabel(item.role)}）`)
        return { ok: true, message: lines.join('\n') || '（不在任何群）', groups: withRole }
      },
    }))

    // ── 2. 看某个群的成员 ────────────────────────────────────────
    defs.push(defineTool({ self: this, 
      name: 'qq_group_members',
      summary: '查看某个群的成员名单。',
      description: [
        '一次最多返回 100 人（QQ 大群可能有几千人，用 keyword 筛）。',
        '结果里的 role：owner 群主 / admin 管理员 / member 普通成员。',
        '注意：不是所有群都能拿到完整成员列表，拿不到时返回人数信息。',
      ],
      properties: {
        group_id: { type: 'string', description: '群号。' },
        keyword: { type: 'string', description: '可选：按群名片或昵称筛选。' },
        limit: { type: 'number', description: '返回多少条（默认 50，最多 100）。' },
      },
      required: ['group_id'],
      async run({ group_id, keyword, limit }) {
        const groupId = String(group_id ?? '')
        if (!groupId) return { ok: false, message: '缺少 group_id' }
        const cap = Math.max(1, Math.min(100, Math.round(Number(limit) || 50)))

        const members = await this.gateway.call('get_group_member_list', { group_id: groupId }, 30000)
        const list = Array.isArray(members) ? members : []
        const filtered = keyword
          ? list.filter((item) => String(item.card ?? '').includes(String(keyword)) ||
            String(item.nickname ?? '').includes(String(keyword)))
          : list

        const picked = filtered.slice(0, cap).map((item) => ({
          qq: String(item.user_id),
          name: String(item.card || item.nickname || ''),
          role: String(item.role ?? 'member'),
        }))
        const lines = picked.map((item) => `${item.qq}  ${item.name || '(无名)'}  [${roleLabel(item.role)}]`)
        return {
          ok: true,
          message: lines.join('\n') || '（没有匹配的成员）',
          total: list.length,
          shown: picked.length,
          note: list.length > cap ? `共 ${list.length} 人，只显示前 ${cap} 个，可以用 keyword 筛` : '',
        }
      },
    }))

    // ── 3. 禁言 ──────────────────────────────────────────────────
    defs.push(defineTool({ self: this, 
      name: 'qq_ban_member',
      summary: '在**任意一个群**里禁言某个成员（minutes=0 表示解除禁言）。',
      description: [
        '茶茶酱必须是那个群的管理员或群主才能禁言。',
        '群主、管理员和你自己永远动不了 —— 工具会先查身份，不满足会直接拒绝。',
        '做完之后记得告诉主人你动了谁、动了多久。',
      ],
      properties: {
        group_id: { type: 'string', description: '群号。' },
        qq: { type: 'string', description: '被禁言成员的 QQ 号。' },
        minutes: { type: 'number', description: '禁言分钟数；0 = 解除禁言。' },
        reason: { type: 'string', description: '可选：原因（会写进日志）。' },
      },
      required: ['group_id', 'qq', 'minutes'],
      async run({ group_id, qq, minutes, reason }) {
        const groupId = String(group_id ?? '')
        const userId = String(qq ?? '')
        const blocked = await guardTarget(groupId, userId)
        if (blocked) return { ok: false, message: blocked }

        const myRole = await myRoleIn(groupId)
        if (!['admin', 'owner'].includes(myRole)) {
          return { ok: false, message: `茶茶酱在群 ${groupId} 的身份是${roleLabel(myRole)}，没有禁言权限` }
        }

        const raw = Number(minutes)
        if (!Number.isFinite(raw) || raw < 0) return { ok: false, message: 'minutes 不合法' }
        const seconds = Math.min(30 * 24 * 60, Math.round(raw * 60))

        await this.gateway.call('set_group_ban', {
          group_id: groupId,
          user_id: userId,
          duration: seconds,
        })
        this.log.info(`禁言：群 ${groupId} 的 ${userId} ${raw} 分钟（${reason ?? '无理由'}）`)
        return {
          ok: true,
          message: seconds === 0
            ? `已解除 ${userId} 在群 ${groupId} 的禁言`
            : `已禁言 ${userId} 在群 ${groupId} 共 ${raw} 分钟（${reason ?? '没写原因'}）`,
        }
      },
    }))

    // ── 4. 踢人 ──────────────────────────────────────────────────
    defs.push(defineTool({ self: this, 
      name: 'qq_kick_member',
      summary: '在**任意一个群**里把某个成员移出群。',
      description: [
        '茶茶酱必须是那个群的管理员或群主。',
        'reject_add=true 表示同时拒绝他再次加群。',
        '群主、管理员和你自己永远动不了。',
        '这是不可逆操作，做之前想清楚，做完一定告诉主人。',
      ],
      properties: {
        group_id: { type: 'string', description: '群号。' },
        qq: { type: 'string', description: '要移出的成员 QQ 号。' },
        reject_add: { type: 'boolean', description: '是否同时拒绝再次加群（默认 false）。' },
        reason: { type: 'string', description: '可选：原因。' },
      },
      required: ['group_id', 'qq'],
      async run({ group_id, qq, reject_add, reason }) {
        const groupId = String(group_id ?? '')
        const userId = String(qq ?? '')
        const blocked = await guardTarget(groupId, userId)
        if (blocked) return { ok: false, message: blocked }

        const myRole = await myRoleIn(groupId)
        if (!['admin', 'owner'].includes(myRole)) {
          return { ok: false, message: `茶茶酱在群 ${groupId} 的身份是${roleLabel(myRole)}，没有踢人权限` }
        }

        await this.gateway.call('set_group_kick', {
          group_id: groupId,
          user_id: userId,
          reject_add_request: Boolean(reject_add),
        })
        this.log.info(`踢人：群 ${groupId} 移除 ${userId}（${reason ?? '无理由'}）`)
        return { ok: true, message: `已把 ${userId} 移出群 ${groupId}${reject_add ? '（并拒绝再次加群）' : ''}` }
      },
    }))

    // ── 5. 撤回 ──────────────────────────────────────────────────
    defs.push(defineTool({ self: this, 
      name: 'qq_recall',
      summary: '撤回一条消息。',
      description: [
        'QQ 只允许撤回 2 分钟内的消息，更早的会失败。',
        'message_id 可以从群上下文或历史里拿到。',
      ],
      properties: {
        message_id: { type: 'string', description: '要撤回的消息 id。' },
      },
      required: ['message_id'],
      async run({ message_id }) {
        const id = String(message_id ?? '')
        if (!id) return { ok: false, message: '缺少 message_id' }
        await this.gateway.call('delete_msg', { message_id: id })
        return { ok: true, message: `已撤回 ${id}` }
      },
    }))

    // ── 6. 看某个群最近的聊天 ────────────────────────────────────
    defs.push(defineTool({ self: this,
      name: 'qq_group_history',
      summary: '查看**任意一个群**最近的聊天记录（带 QQ 号和消息 id）。',
      description: [
        '用来补上下文：某个群刚才在聊什么、谁说了什么。',
        '返回格式是「昵称(QQ号) [#消息id]: 内容」——要禁言/撤回可以直接用这些号。',
        '当前所在群的上下文会自动带上，不需要再调这个工具；',
        '只有要看"别的群"的时候才用。',
      ],
      properties: {
        group_id: { type: 'string', description: '群号。' },
        count: { type: 'number', description: '要多少条（1~50，默认 20）。' },
      },
      required: ['group_id'],
      async run({ group_id, count }) {
        const groupId = String(group_id ?? '')
        const n = Math.max(1, Math.min(50, Math.round(Number(count) || 20)))
        const data = await this.gateway.call('get_group_msg_history', {
          group_id: groupId,
          count: n,
        }, 30000)
        const list = (data?.messages ?? []).slice(-n)
        const lines = list.map((item) => {
          const name = item?.sender?.card || item?.sender?.nickname || '某人'
          const qq = String(item?.sender?.user_id ?? item?.user_id ?? '?')
          const msgId = item?.message_id ? ` [#${item.message_id}]` : ''
          const text = (item?.message ?? [])
            .map((seg) => (seg?.type === 'text' ? seg.data?.text : `[${seg?.type}]`))
            .join('')
          return `${name}(${qq})${msgId}: ${text}`
        })
        return {
          ok: true,
          message: lines.join('\n') || '（没有历史消息）',
          count: list.length,
          hint: '昵称后面括号里是 QQ 号，方括号里是消息 id',
        }
      },
    }))

    // ── 7. 发消息到任意地方 ──────────────────────────────────────
    defs.push(defineTool({ self: this, 
      name: 'qq_send_to',
      summary: '把一条消息发到**指定的群或好友**（不一定是当前会话）。',
      description: [
        '当前会话的回复会自动发出去，不需要这个工具；',
        '只有在你要"顺手通知别的地方"时才用，比如通知另一个群。',
        'target_type：group 发到群 / private 发给好友。',
      ],
      properties: {
        target_type: { type: 'string', enum: ['group', 'private'], description: '发到群还是私聊。' },
        target_id: { type: 'string', description: '群号或 QQ 号。' },
        text: { type: 'string', description: '要发送的文本。' },
      },
      required: ['target_type', 'target_id', 'text'],
      async run({ target_type, target_id, text }) {
        const content = String(text ?? '').trim()
        if (!content) return { ok: false, message: '内容为空' }
        // ⚠️ outbox 可能还没就绪（它依赖 Controller，而 Controller 是后建的）。
        //    回填在 index.js 里做；这里再兜一层，给个能看懂的错误而不是抛 TypeError。
        if (!this.outbox || typeof this.outbox.push !== 'function') {
          return { ok: false, message: '出站还没就绪（Controller 没建好），这次发不出去' }
        }
        const result = await this.outbox.push(
          { scene: target_type === 'group' ? 'group' : 'private', peerId: String(target_id), userId: String(target_id) },
          content,
        )
        return { ok: true, message: `已发送 ${result.sent}/${result.total} 条`, sent: result.sent }
      },
    }))

    // ── 8. 发文件到任意地方 ──────────────────────────────────────
    defs.push(defineTool({ self: this, 
      name: 'qq_send_file',
      summary: '把本机的文件或图片发到指定的群或好友。**发文件/图片只能用它**。',
      description: [
        '图片（.png/.jpg/.gif/.webp）按图片发送，其他按文件发送。',
        '路径必须是本机绝对路径，并且文件要真实存在。',
        '⚠️ 这是发文件的唯一正确方式：不要自己拼 OneBot 调用、不要用 file:/// 或 URL 参数，',
        '   直接给本机路径，剩下的工具会处理（图片走 base64 内联）。',
        '截图类任务：先用命令工具把图存成文件，再把路径交给本工具。',
      ],
      properties: {
        path: { type: 'string', description: '本机上文件的绝对路径。' },
        name: { type: 'string', description: '可选：显示给对方的名字。' },
        target_type: { type: 'string', enum: ['group', 'private', 'here'], description: '发到哪：group / private / here（当前会话，默认）。' },
        target_id: { type: 'string', description: '群号或 QQ 号（target_type 是 here 时不用填）。' },
      },
      required: ['path'],
      async run({ path: filePath, name, target_type, target_id }) {
        const { statSync, readFileSync } = await import('node:fs')
        const { basename } = await import('node:path')

        let stat
        try {
          stat = statSync(filePath)
        } catch {
          return { ok: false, message: `文件不存在：${filePath}` }
        }
        if (!stat.isFile()) return { ok: false, message: `不是一个文件：${filePath}` }

        const display = String(name || basename(filePath))
        const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(filePath)

        // 目标：默认当前会话
        let scene = here.scene
        let peerId = here.peerId
        if (target_type === 'group') {
          scene = 'group'
          peerId = String(target_id ?? '')
        } else if (target_type === 'private') {
          scene = 'private'
          peerId = String(target_id ?? '')
        }
        if (!peerId) return { ok: false, message: '缺少目标 id' }

        const key = scene === 'group' ? 'group_id' : 'user_id'

        if (isImage) {
          const maxBytes = 6 * 1024 * 1024
          if (stat.size > maxBytes) {
            return { ok: false, message: `图片太大（${Math.round(stat.size / 1024 / 1024)}MB > 6MB），先压缩一下` }
          }
          let buffer
          try {
            buffer = readFileSync(filePath)
          } catch (error) {
            return { ok: false, message: `读不了这个文件：${error.message}` }
          }
          this.log.info(`发送图片 ${display}（${Math.round(buffer.length / 1024)}KB）→ ${scene}:${peerId}`)
          try {
            await this.gateway.call('send_msg', {
              [key]: peerId,
              message: [{ type: 'image', data: { file: `base64://${buffer.toString('base64')}` } }],
            }, 60000)
            return { ok: true, message: `已发送图片 ${display}（${Math.round(buffer.length / 1024)}KB）` }
          } catch (error) {
            this.log.warn('图片发送失败：', error.message)
            return { ok: false, message: `图片发送失败：${error.message}` }
          }
        }

        const action = scene === 'group' ? 'upload_group_file' : 'upload_private_file'
        this.log.info(`发送文件 ${display}（${Math.round(stat.size / 1024)}KB）→ ${scene}:${peerId}`)
        await this.gateway.call(action, { [key]: peerId, file: filePath, name: display }, 120000)
        return { ok: true, message: `已发送文件 ${display}` }
      },
    }))

    // ── 9. 记住一件事 ────────────────────────────────────────────
    defs.push(defineTool({ self: this, 
      name: 'qq_remember',
      summary: '把一件值得长期记住的事写进记忆（以后的对话里会出现）。',
      description: [
        '适合记：主人的偏好、重要约定、正在做的项目、某个群/某人的情况。',
        '不适合记：一次性的闲聊、能从上下文直接推出来的东西。',
        '写短一点，一句话一条。core=true 会进「永远记住」那一份。',
      ],
      properties: {
        text: { type: 'string', description: '要记住的一句话。' },
        core: { type: 'boolean', description: '是否进「永远记住」的核心记忆（默认 false）。' },
      },
      required: ['text'],
      async run({ text, core }) {
        const content = String(text ?? '').trim()
        if (!content) return { ok: false, message: '内容为空' }
        if (!this.memory) return { ok: false, message: '记忆模块没启用' }
        // core=true 进「永远记住」那份，其余进当天。
        // ⚠️ v3 统一走 appendMemory，**不要**像旧版那样直接拼 corePath ——
        //    记忆层一改目录结构，写死路径的工具就会静默写到一个没人读的地方。
        const result = this.memory.appendMemory(content, { shared: Boolean(core) })
        return {
          ok: true,
          message: core ? `已记入核心记忆：${content}` : `已记：${content}`,
          ...(result ?? {}),
        }
      },
    }))

    // ── 10. 回忆别的对话 ────────────────────────────────────────
    // 主人的架构原话：「上下文放在同一文件夹，当需要回忆时，指派子Agent复盘其他对话，
    // 达到节省Token的统一上下文效果。」
    // 所以平时不把别的对话塞进上下文，需要的时候派子 Agent 去翻、只带结论回来。
    defs.push(defineTool({ self: this,
      name: 'qq_recall_memory',
      summary: '回忆：翻别的对话（别的群、以前聊过的）和记忆文件，把结论带回来。',
      description: [
        '什么时候用：主人问「上周说的那个事」「昨天群里怎么说的」「你不是记得吗」。',
        '什么时候别用：当前对话里刚刚说过的，直接看上下文就行，不用回忆（回忆要花一次子 Agent）。',
        '它会去翻历史对话和记忆笔记，只把相关的那几段总结回来，不会把整段历史塞进来。',
        '问得越具体越准（「关于搬家的事」比「以前的事」好）。',
      ],
      properties: {
        question: { type: 'string', description: '要找什么，一句话说清楚。' },
      },
      required: ['question'],
      async run({ question }) {
        const ask = String(question ?? '').trim()
        if (!ask) return { ok: false, message: '没说要找什么' }
        const recall = this.recall
        if (!recall || typeof recall.recall !== 'function') {
          return { ok: false, message: '回忆功能没启用（或者还不可用）' }
        }
        const found = await recall.recall({
          question: ask,
          // 排掉当前这条会话：当前对话已经在上下文里了，不用再翻
          excludeSessionId: String(sessionId || ''),
        })
        const text = String(found ?? '').trim()
        if (!text) return { ok: true, message: '翻了一遍，没找到相关的东西。' }
        return { ok: true, message: text }
      },
    }))

    // ── 11. 主动拉黑 ─────────────────────────────────────────────
    defs.push(defineTool({ self: this,
      name: 'qq_block_user',
      summary: '把一个人加入黑名单（限制他在群里/私聊里的行为）。',
      description: [
        '档位：no-at 不可艾特（@ 也不理）/ chat-only 仅聊天（不主动、不给工具）/ block 完全拒绝。',
        '给 group_id 就**只在这个群生效**；不填就是全局拉黑（私聊也会拒）。',
        '主人和你自己永远拉黑不了，工具会直接拒绝。',
        '做完简短告诉主人：你拉黑了谁、为什么、哪个范围。',
      ],
      properties: {
        qq: { type: 'string', description: '要拉黑的人的 QQ 号。' },
        level: { type: 'string', enum: ['no-at', 'chat-only', 'block'], description: '档位，默认 block。' },
        reason: { type: 'string', description: '可选：为什么拉黑（会记下来）。' },
        group_id: { type: 'string', description: '可选：只在这个群生效。' },
      },
      required: ['qq'],
      async run({ qq, level, reason, group_id }) {
        const userId = String(qq ?? '').trim()
        if (!/^\d+$/.test(userId)) return { ok: false, message: 'QQ 号不合法' }
        const cfg = this.store.get()
        const ownerQq = String(cfg.owner?.qq ?? '')
        if (userId === ownerQq) return { ok: false, message: '不能拉黑主人' }
        if (userId === String(this.gateway.selfId)) return { ok: false, message: '不能拉黑自己' }

        const lvl = ['no-at', 'chat-only', 'block'].includes(String(level)) ? String(level) : 'block'

        // 只在这个群生效
        if (group_id) {
          const groupId = String(group_id)
          const profiles = { ...(cfg.group?.profiles ?? {}) }
          const cur = profiles[groupId] ?? {}
          const list = Array.isArray(cur.blockedUsers) ? [...cur.blockedUsers].map(String) : []
          if (!list.includes(userId)) list.push(userId)
          profiles[groupId] = { ...cur, blockedUsers: list }
          this.store.patch({ group: { profiles } })
          this.log.info(`群内拉黑：${groupId} ← ${userId}（${lvl}）${reason ? ` — ${reason}` : ''}`)
          return { ok: true, message: `已在群 ${groupId} 拉黑 ${userId}（${lvl}）${reason ? `，原因：${reason}` : ''}` }
        }

        // 全局
        const list = Array.isArray(cfg.access?.blocklist) ? [...cfg.access.blocklist] : []
        const rest = list.filter((item) => String(item?.qq ?? '') !== userId)
        rest.push({ qq: userId, level: lvl, reason: String(reason ?? '') })
        this.store.patch({ access: { blocklist: rest } })
        this.log.info(`全局拉黑：${userId}（${lvl}）${reason ? ` — ${reason}` : ''}`)
        return { ok: true, message: `已全局拉黑 ${userId}（${lvl}）${reason ? `，原因：${reason}` : ''}` }
      },
    }))

    // ── 11. 撤销拉黑 ─────────────────────────────────────────────
    defs.push(defineTool({ self: this,
      name: 'qq_unblock_user',
      summary: '把一个人从黑名单里移出来（撤销拉黑）。',
      description: [
        '给 group_id 就只从那个群的黑名单移除；不填就从全局黑名单移除。',
        '两个都要清就调两次。',
      ],
      properties: {
        qq: { type: 'string', description: '要解除的 QQ 号。' },
        group_id: { type: 'string', description: '可选：只从这个群解除。' },
      },
      required: ['qq'],
      async run({ qq, group_id }) {
        const userId = String(qq ?? '').trim()
        if (!/^\d+$/.test(userId)) return { ok: false, message: 'QQ 号不合法' }
        const cfg = this.store.get()

        if (group_id) {
          const groupId = String(group_id)
          const profiles = { ...(cfg.group?.profiles ?? {}) }
          const cur = profiles[groupId]
          if (!cur) return { ok: true, message: `群 ${groupId} 本来就没单独配黑名单` }
          const list = (Array.isArray(cur.blockedUsers) ? cur.blockedUsers : []).map(String).filter((id) => id !== userId)
          profiles[groupId] = { ...cur, blockedUsers: list }
          this.store.patch({ group: { profiles } })
          return { ok: true, message: `已把 ${userId} 从群 ${groupId} 的黑名单移除` }
        }

        const list = Array.isArray(cfg.access?.blocklist) ? cfg.access.blocklist : []
        const rest = list.filter((item) => String(item?.qq ?? '') !== userId)
        if (rest.length === list.length) return { ok: true, message: `${userId} 本来就不在全局黑名单里` }
        this.store.patch({ access: { blocklist: rest } })
        return { ok: true, message: `已把 ${userId} 从全局黑名单移除` }
      },
    }))

    // ── 12. 删好友（暴力手段，不可逆）──────────────────────────────
    defs.push(defineTool({ self: this,
      name: 'qq_delete_friend',
      summary: '把一个好友从好友列表里删掉（不可逆）。',
      description: [
        '⚠️ 这是不可逆操作：删掉之后聊天记录和好友关系都没了，对方要重新加你。',
        '删了之后对方**发不了私聊**（发出去也收不到），这就是最接近"拉黑"的做法。',
        '主人和你自己永远删不了。',
        '只有在明确被骚扰、主人让你删的时候才用。做完务必告诉主人。',
      ],
      properties: {
        qq: { type: 'string', description: '要删掉的好友 QQ 号。' },
        reason: { type: 'string', description: '可选：为什么删（会记进日志）。' },
      },
      required: ['qq'],
      async run({ qq, reason }) {
        const userId = String(qq ?? '').trim()
        if (!/^\d+$/.test(userId)) return { ok: false, message: 'QQ 号不合法' }
        const cfg = this.store.get()
        if (userId === String(cfg.owner?.qq ?? '')) return { ok: false, message: '不能删掉主人' }
        if (userId === String(this.gateway.selfId)) return { ok: false, message: '不能删掉自己' }

        // 先确认是不是好友，避免对陌生人瞎调用
        let isFriend = false
        try {
          const friends = await this.gateway.call('get_friend_list')
          isFriend = Array.isArray(friends) && friends.some((item) => String(item.user_id) === userId)
        } catch {
          // 查不到就按"试一下"处理
          isFriend = true
        }
        if (!isFriend) return { ok: false, message: `${userId} 不是好友，不需要删` }

        await this.gateway.call('delete_friend', { user_id: userId })
        this.log.info(`已删除好友：${userId}${reason ? `（${reason}）` : ''}`)
        return { ok: true, message: `已删除好友 ${userId}${reason ? `，原因：${reason}` : ''}（不可逆）` }
      },
    }))

    // ── 13. 看待处理的加好友/加群请求 ─────────────────────────────
    defs.push(defineTool({ self: this,
      name: 'qq_pending_requests',
      summary: '列出待处理的加好友 / 加群请求。',
      description: [
        '返回每条的 flag、谁申请的、哪个群、附言。',
        '处理要用 qq_handle_request，把 flag 传回去。',
      ],
      properties: {},
      async run() {
        const list = [...this.pendingRequests.values()]
        if (list.length === 0) return { ok: true, message: '（没有待处理的请求）', count: 0 }
        const lines = list.map((item) => {
          const kind = item.type === 'friend' ? '加好友' : '加群'
          const where = item.groupId ? ` → 群 ${item.groupId}` : ''
          const note = item.comment ? `　附言：${item.comment}` : ''
          return `[${item.flag}] ${kind} ${item.userId}${where}${note}`
        })
        return { ok: true, message: lines.join('\n'), count: list.length }
      },
    }))

    // ── 14. 同意 / 拒绝请求 ──────────────────────────────────────
    defs.push(defineTool({ self: this,
      name: 'qq_handle_request',
      summary: '同意或拒绝一个加好友 / 加群请求。',
      description: [
        'flag 从 qq_pending_requests 里拿。',
        'approve=true 同意，false 拒绝。',
        '拒绝时可以带一句理由（对方能看到）。',
      ],
      properties: {
        flag: { type: 'string', description: '请求的 flag。' },
        approve: { type: 'boolean', description: 'true 同意 / false 拒绝。' },
        reason: { type: 'string', description: '可选：拒绝理由。' },
      },
      required: ['flag', 'approve'],
      async run({ flag, approve, reason }) {
        const key = String(flag ?? '').trim()
        const entry = this.pendingRequests.get(key)
        if (!entry) return { ok: false, message: '找不到这个请求（可能已经处理过或过期了）' }

        const action = entry.type === 'friend' ? 'set_friend_add_request' : 'set_group_add_request'
        const params = { flag: key, approve: Boolean(approve) }
        if (entry.type === 'group' && reason) params.reason = String(reason)

        await this.gateway.call(action, params)
        this.pendingRequests.delete(key)
        this.log.info(
          `${approve ? '同意' : '拒绝'}了 ${entry.type === 'friend' ? '加好友' : '加群'}请求：${entry.userId}`,
        )
        return {
          ok: true,
          message: `已${approve ? '同意' : '拒绝'} ${entry.userId} 的${entry.type === 'friend' ? '加好友' : '加群'}请求` +
            `${!approve && reason ? `（理由：${reason}）` : ''}`,
        }
      },
    }))

    return defs
  }
}

/** 角色中文名。 */
function roleLabel(role) {
  switch (String(role)) {
    case 'owner':
      return '群主'
    case 'admin':
      return '管理员'
    case 'member':
      return '成员'
    default:
      return String(role ?? '未知')
  }
}
