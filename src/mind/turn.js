/**
 * The Mind 的心脏：把「一条 QQ 会话」接成「一个砍过的 DSH agent」。
 *
 * 这个文件里每一条奇怪的写法都有出处，来自旧版 30 条实测踩坑记录。
 * 改之前先读注释，别以为是为了好看。
 *
 * 三条最狠的：
 *   1. `agent.whenIdle()` **不能**用 —— 它在微任务里空转，会把整个 DSH 主进程饿死
 *      （症状：日志停在半句话、心跳也停）。只能轮询 status + seq。
 *   2. 直接读 `ctx.agents` / `ctx.sessions` 在没 inject 时是**抛异常**，不是 undefined。
 *      必须 `service()` 包一层 try/catch，否则错误被外层 catch 吞掉，
 *      表现成「会话文件里只有一条头事件」，极难查。
 *   3. `ctx.agents.create()` 必须给 provider + model，否则模型请求 NO_ADAPTER，
 *      症状是 342ms 就结束、终稿 0 字、reason 是个对象。
 */
import { randomUUID } from 'node:crypto'

import { buildMindPersona, renderTagLine, resolveToolAllow, MIND_TOOL_ALLOW } from './preset.js'
import { isOn } from '../modes.js'

/**
 * 自己造一条 UserMessage。
 * 不 import DSH 的 `createUserMessage`：那个在 `@deepseek-ai/dsh-llm` 里，
 * 插件的 node_modules 未必解析得到 DSH 自己的包。字段对齐即可。
 */
export function makeUserMessage(text, extra = []) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }, ...extra],
    source: { kind: 'user' },
    time: Date.now(),
  }
}

/**
 * 安全取服务。
 * ⚠️ cordis 里直接读未注入的服务是**抛错**，不是 undefined，`?.` 救不了。
 */
export function service(ctx, name) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const got = ctx.get(name)
      if (got !== undefined && got !== null) return got
    }
  } catch {
    // ctx.get 在某些上下文里也会抛，继续退回属性访问
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * 从 `todo_write` 的参数里抠出 todo 列表。
 *
 * 参数可能是字符串（模型流式给的是 JSON 文本）也可能是对象，两种都要认。
 * 认不出就返回空数组 —— 宁可没有「计划」那一行，也不能因为解析失败把轨迹搞崩。
 */
export function parseTodoPayload(args) {
  let payload = args
  try {
    if (typeof payload === 'string') payload = JSON.parse(payload)
  } catch {
    return []
  }
  const list = payload?.todos ?? payload?.items ?? payload?.list
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (!item) continue
    const content = String(item.content ?? item.text ?? item.title ?? '').trim()
    if (!content) continue
    out.push({
      content,
      status: String(item.status ?? 'pending'),
    })
  }
  return out
}

export class Mind {
  /**
   * @param {object} options
   * @param {object} options.ctx          cordis Context
   * @param {{get:()=>object}} options.store
   * @param {object} options.log
   * @param {object} [options.memory]     { buildContext({role, peerId}) }
   * @param {object} [options.emotion]    { renderForMind() }
   * @param {object} [options.qqTools]    { register(agentCtx, sessionId, role) }
   */
  constructor({ ctx, store, log, memory, emotion, life, meme, qqTools, eggs }) {
    this.ctx = ctx
    this.store = store
    this.log = log
    this.memory = memory
    this.emotion = emotion
    /** 日程 + 当日状态（她说"我现在在咖啡厅"要有来处） */
    this.life = life
    /** 表情包系统（提供「有哪些类别、什么时候用」的说明） */
    this.meme = meme
    this.qqTools = qqTools
    /** 🥚 彩蛋模块（深夜关怀等）。没加载也能跑 —— 所有调用都走 ?. */
    this.eggs = eggs ?? null

    /** sessionId -> { handle, role, mode, provider, model, tags, queue, startedAt } */
    this.live = new Map()
    /** agentId -> 流式回调 */
    this.streams = new Map()
    /** 上次用的模型（面板显示用） */
    this.lastModel = null

    this.streamBound = false
    this.approvalBound = false
    this.bindStream()
    this.bindApproval()
  }

  get agents() {
    return service(this.ctx, 'agents')
  }

  get available() {
    const agents = this.agents
    return Boolean(agents && typeof agents.create === 'function')
  }

  /**
   * 全局只挂一次流式监听，再按 agent 分发。
   * `agent/assistant-stream` 是呈现数据，不能当回放来源（回放必须读 session log）。
   */
  bindStream() {
    if (this.streamBound || typeof this.ctx?.on !== 'function') return
    this.streamBound = true
    try {
      this.ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
        const sink = this.streams.get(subject?.id)
        if (!sink) return
        if (frame?.type !== 'chunk') return
        const chunk = frame.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          try {
            sink(chunk.text)
          } catch (error) {
            this.log.warn('流式回调抛错（已忽略）：', error)
          }
        }
      })
    } catch (error) {
      this.log.warn('流式监听挂载失败（将退回整段发送）：', error)
    }
  }

  /**
   * 审批桥。
   *
   * ⚠️ 不接管的话请求会一直挂着 —— 表现是「agent 就绪了、但一句话都不回」，
   * 因为 agent 永远卡在 running 等答复。这是最阴的一个坑。
   *
   * 策略：主人的会话 → allowed-once（他要的就是能操作电脑）；其他人 → rejected。
   * 优先用 approval.setPolicy（更稳），挂不上再退回事件拦截。
   */
  bindApproval() {
    if (this.approvalBound || typeof this.ctx?.on !== 'function') return
    this.approvalBound = true
    const handler = async (req) => {
      const agentId = req?.agent?.id
      const role = this.roleOfAgent(agentId)
      const decision = role === 'owner' ? 'allowed-once' : 'rejected'
      this.log.debug(`审批：${req?.toolName ?? '?'}（${role}）→ ${decision}`)
      return decision
    }
    try {
      this.ctx.on('approval/request', handler, { prepend: true })
    } catch {
      try {
        this.ctx.on('approval/request', handler)
      } catch (error) {
        this.log.warn('审批桥挂载失败（危险操作将无人应答）：', error)
      }
    }
  }

  /** 从 agent id 反查角色。 */
  roleOfAgent(agentId) {
    if (!agentId) return 'guest'
    for (const [, entry] of this.live) {
      if (entry.handle?.agent?.id === agentId) return entry.role
    }
    return 'guest'
  }

  /**
   * 解析这一轮该用哪个模型。
   * 优先级：配置 mind.provider/model > DSH 默认模型服务。
   */
  resolveModel() {
    const cfg = this.store.get()?.mind ?? {}
    const fallback = service(this.ctx, 'agentDefaultModel')?.currentSelection?.()
    const provider = cfg.provider || fallback?.provider || ''
    const model = cfg.model || fallback?.model || ''
    const effort = cfg.reasoningEffort || fallback?.reasoningEffort || ''

    this.lastModel = {
      provider,
      model,
      effort,
      source: cfg.model ? 'config' : 'dsh-default',
      at: Date.now(),
    }
    return { provider, model, effort, maxTokens: Number(cfg.maxTokens) || 0 }
  }

  /**
   * 取或建一个 agent。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.role     owner | guest
   * @param {string} options.mode     read-only | workspace-write | danger-full-access
   * @param {string[]} [options.tags]
   * @param {string} [options.peerId] 记忆分片用
   */
  async ensure({ sessionId, role, mode, tags = [], peerId = '', peerKey = '' }) {
    const agents = this.agents
    if (!agents) throw new Error('ctx.agents 不可用（agent-loop 没挂载？）')

    const cfg = this.store.get() ?? {}
    const mindCfg = cfg.mind ?? {}
    const { provider, model, effort, maxTokens } = this.resolveModel()

    const existing = this.live.get(sessionId)
    if (existing) {
      // 权限档、角色、模型变了 → 重建，避免「面板改了还是老设定」
      const same = existing.mode === mode && existing.role === role &&
        existing.provider === provider && existing.model === model
      if (same) return existing
      this.log.info(
        `会话 ${sessionId} 设定变了（${existing.role}/${existing.mode} → ${role}/${mode}），重建 agent`,
      )
      await this.dispose(sessionId)
    }

    if (!provider || !model) {
      this.log.warn('没拿到 provider/model（面板没配、agentDefaultModel 也不可用），模型请求会失败')
    }

    const agentOptions = {}
    if (provider) agentOptions.provider = provider
    if (model) agentOptions.model = model
    if (effort) agentOptions.reasoningEffort = effort
    if (maxTokens > 0) agentOptions.maxTokens = maxTokens

    // 人格是**静态**的（section），所以里面只放不随对话变的东西。
    // ⚠️ 标签千万别拼进来：标签每轮都可能变（新人 / 话痨），
    //    拼进 section 的话 agent 不重建就永远显示旧标签。标签走下面的 context。
    const personaText = buildMindPersona({
      role,
      custom: String(mindCfg.personaOverride ?? ''),
    })
    const allow = resolveToolAllow(mindCfg.toolAllow)
    /** 可变引用：context 每轮重新求值时读它，ask() 里更新它 */
    const tagRef = { current: Array.isArray(tags) ? tags : [] }
    /**
     * 日程要的是「会话 key」（group-123-owner / private-123），
     * 不是 QQ 号。而且它内部按这个 key 查 modes 判 work/companion，
     * 所以**别把沙箱档位 mode 传进去**（两个 mode 是不同概念，容易混）。
     */
    const peerKeyRef = { current: String(peerKey || '') }

    // 记忆的「规矩」：哪段能写、哪段只读、群友只看得到公用那段。
    // 不告诉她这些，她就算有记忆工具也不知道往哪写。规矩很少变，放静态 section 就够。
    let memoryGuide = ''
    try {
      memoryGuide = String(this.memory?.renderGuide?.({ role }) ?? '').trim()
    } catch (error) {
      this.log.debug('取记忆规矩失败（跳过）：', error?.message ?? error)
    }
    const finalPersona = memoryGuide ? `${personaText}\n\n${memoryGuide}` : personaText

    const setup = async (agentCtx) => {
      // ⓪ 挂载 agent preset —— **这一步不做，agent 里一个工具都没有**。
      //    旧版踩过：她回「我手上只有一个切目录的工具」。
      //    注意 `meta.agentPreset` 只是标签，不会挂载任何东西。
      try {
        const presets = service(this.ctx, 'agentPresets')
        if (presets?.mount) {
          const mounted = await presets.mount(agentCtx)
          this.log.info(`已挂载 agent preset：${mounted?.id ?? '(默认)'}`)
        } else {
          this.log.warn('agentPresets 服务不可用，agent 很可能没有工具')
        }
      } catch (error) {
        this.log.error('挂载 agent preset 失败（会导致她没有任何工具）：', error)
      }

      // ① 人格：注册成该 agent 作用域的提示词段。
      //    interpolate:false —— 人格里可能出现 {{ }}，不能被模板引擎解释。
      try {
        const prompt = service(agentCtx, 'systemPrompt')
        if (prompt?.section) {
          prompt.section({
            name: 'chacha:persona',
            order: 50,
            interpolate: false,
            text: finalPersona,
          })
        } else {
          this.log.warn('systemPrompt 不可用，人格没挂上')
        }
      } catch (error) {
        this.log.error('注册人格失败：', error)
      }

      // ② 记忆 / 情绪 / 标签：放 context 而不是 section。
      //    context 每轮重新求值、不追加进历史 —— 前缀缓存还能命中，内容又是最新的。
      //    （「鱼的心」插件用的是同一招，README 里明确说这是为了不破坏前缀缓存。）
      try {
        const prompt = service(agentCtx, 'systemPrompt')
        if (prompt?.context) {
          prompt.context({
            name: 'chacha:memory',
            order: 60,
            interpolate: false,
            text: () => this.buildDynamicContext({ role, peerId, tagRef, peerKeyRef }),
          })
        }
      } catch (error) {
        this.log.warn('注册记忆上下文失败（不影响聊天）：', error)
      }

      // ③ 砍工具：只留下「计划 / 子Agent / 上网」。
      //    必须在 scoped ctx 里调；在外层调会抛
      //    「a context-global restriction would mask every agent」。
      try {
        const toolCtx = service(agentCtx, 'tools')
        if (toolCtx?.restrict) {
          toolCtx.restrict({ allow: allow })
          this.log.info(`已砍工具：只留 ${allow.length} 个（${allow.join(', ')}）`)
        } else {
          this.log.warn('tools.restrict 不可用，这一刀没砍下去')
        }
      } catch (error) {
        this.log.error('砍工具失败（这条很重要，请检查）：', error)
      }

      // ④ QQ 工具：只有主人拿得到。
      //    ⚠️ 非主人是**不注册**，不是「注册了再限制」——
      //    `tools.restrict()` 管不住作用域内注册的工具（旧版踩坑第 11 条）。
      if (role === 'owner' && this.qqTools) {
        try {
          this.qqTools.register(agentCtx, sessionId, role)
        } catch (error) {
          this.log.error('注册 QQ 工具失败：', error)
        }
      }
    }

    let handle
    try {
      handle = await agents.create({ sessionId, agentOptions, setup })
    } catch (error) {
      // 已经存在的会话要 resume 而不是 create
      this.log.debug(`create 失败（${error?.message ?? error}），尝试 resume`)
      handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    }

    // 沙箱档位：直接往会话日志写一条，先于第一轮就生效
    try {
      handle?.agent?.session?.append?.('sandbox/mode', { mode })
    } catch (error) {
      this.log.warn('设置沙箱档位失败：', error)
    }

    const entry = {
      handle,
      role,
      mode,
      tagRef,
      tags: tagRef.current,
      peerKeyRef,
      peerKey: peerKeyRef.current,
      peerId,
      provider,
      model,
      queue: Promise.resolve(),
      startedAt: Date.now(),
    }
    this.live.set(sessionId, entry)
    this.log.info(`agent 就绪：${sessionId}（${role}/${mode}/${model || '默认模型'}）`)
    return entry
  }

  /** 拼这一轮要注入的动态上下文：标签 + 记忆 + 日程 + 情绪。 */
  buildDynamicContext({ role, peerId, tagRef, peerKeyRef }) {
    const parts = []
    try {
      const tagLine = renderTagLine(tagRef?.current ?? [])
      if (tagLine) parts.push(tagLine)
    } catch (error) {
      this.log.warn('渲染标签失败（跳过）：', error)
    }
    try {
      const memoryText = isOn('memory', peerKeyRef?.current ?? '', this.store.get())
        ? this.memory?.buildContext?.({ role, peerId })
        : ''
      if (memoryText) parts.push(memoryText)
    } catch (error) {
      this.log.warn('取记忆失败（跳过）：', error)
    }
    // 日程 + 当日状态：她说「我现在在咖啡厅」要有来处。
    // ⚠️ 同步读缓存、不 await、不触发模型（生成由 pipeline 的 ensureToday 负责）。
    //    work 模式它自己会返回空串，这里不用判。
    try {
      const lifeText = isOn('life', peerKeyRef?.current ?? '', this.store.get())
        ? this.life?.renderForMind?.({ peerKey: peerKeyRef?.current ?? '' })
        : ''
      if (lifeText) parts.push(lifeText)
    } catch (error) {
      this.log.warn('取日程/状态失败（跳过）：', error)
    }
    try {
      // ⚠️ EmotionState 没有 renderForMind 方法 —— renderForMind 是模块级纯函数。
      //    实例这一侧要的是 takeInjection()：它内部保证「同一次变化只说一次」，
      //    并且 confidence 不够时只记账不进嘴。别绕过它直接读 state。
      const moodText = isOn('emotion', peerKeyRef?.current ?? '', this.store.get())
        ? this.emotion?.takeInjection?.()
        : ''
      if (moodText) parts.push(moodText)
    } catch (error) {
      this.log.warn('取情绪失败（跳过）：', error)
    }
    // 表情包：告诉她有哪些类别、每个「什么时候用」、单条能发几张。
    // 放动态 context（图库变了提示跟着变），不放静态 section（那要重建 agent 才生效）。
    try {
      const memeText = isOn('meme', peerKeyRef?.current ?? '', this.store.get())
        ? this.meme?.renderGuide?.()
        : ''
      if (memeText) parts.push(memeText)
    } catch (error) {
      this.log.warn('取表情包说明失败（跳过）：', error)
    }

    // 🥚 深夜关怀：凌晨 2~5 点、概率 8% 才说一句。
    //    为什么放在动态 context 而不是替模型写回复：
    //    这样她「知道现在很晚了」，怎么表达由她自己决定。
    //    每次都强行塞一句关心的话，就变成唠叨了，不是彩蛋。
    try {
      const eggs = this.eggs ?? null
      if (eggs?.maybeNightCare) {
        const store = this.store.get()
        const care = eggs.maybeNightCare({
          enabled: eggs.eggsEnabled ? eggs.eggsEnabled(store) : true,
          probability: Number(store?.fun?.nightCareProbability ?? 0.08),
        })
        if (care) {
          parts.push(`（现在很晚了。你心里冒出一句「${care}」—— 想说的话就顺口说出来，不想说就算了。）`)
          this.log.debug(`深夜关怀触发：${care}`)
        }
      }
    } catch (error) {
      this.log.debug('彩蛋跳过：', error?.message ?? error)
    }

    return parts.join('\n\n')
  }

  /**
   * 跑一轮：投递 → 收流式 → 等停稳 → 取终稿 → 采轨迹。
   *
   * @returns {Promise<{text:string, reason:string, elapsedMs:number, trace:Array}>}
   */
  async ask({ sessionId, role, mode, tags, peerId, peerKey, text, onDelta, timeoutMs }) {
    const entry = await this.ensure({ sessionId, role, mode, tags, peerId, peerKey })
    // 标签 / 会话 key 每轮都可能变 —— 刷新可变引用，下一轮 context 求值就是新的。
    // （不重建 agent：重建要丢掉上下文，这些不值得那个代价。）
    if (entry.tagRef && Array.isArray(tags)) entry.tagRef.current = tags
    if (entry.peerKeyRef && peerKey) entry.peerKeyRef.current = String(peerKey)
    const agent = entry.handle.agent
    const cfg = this.store.get()?.mind ?? {}
    // ⚠️ `??` 和 `||` 不能裸混用（要括号），否则直接语法错误、整个模块 import 失败。
    const limit = timeoutMs ?? (Number(cfg.turnTimeoutMs) || 180000)

    // 同一个会话串行：两轮同时跑会串上下文
    const run = async () => {
      const startedAt = Date.now()
      const firstSeq = Number(agent.session?.seq ?? 0)

      if (onDelta) this.streams.set(agent.id, onDelta)
      const timer = setTimeout(() => {
        try {
          agent.cancel({ kind: 'hook', reason: 'qq-turn-timeout' })
        } catch {
          // ignore
        }
      }, limit)
      timer.unref?.()

      try {
        agent.followup(makeUserMessage(text))
        this.log.debug(`已投递本轮输入（${text.length} 字），等模型…`)
        await this.waitSettled(agent, limit)
        await this.flush(agent)

        const outcome = this.summarize(agent, firstSeq)
        const trace = this.collectTrace(agent, firstSeq)
        this.log.info(
          `本轮停稳：${Date.now() - startedAt}ms，终稿 ${outcome.text.length} 字，` +
          `轨迹 ${trace.length} 条（思考 ${trace.filter((t) => t.kind === 'reasoning').length} / ` +
          `工具 ${trace.filter((t) => t.kind === 'tool').length}）`,
        )
        return { ...outcome, trace, elapsedMs: Date.now() - startedAt }
      } finally {
        clearTimeout(timer)
        this.streams.delete(agent.id)
      }
    }

    entry.queue = entry.queue.then(run, run)
    return entry.queue
  }

  /**
   * 等这一轮真的结束。
   *
   * ⚠️ **绝对不要用 `agent.whenIdle()`**：它的实现是
   *   `do await (a = this.activityDone); while (a !== this.activityDone)`
   * 多批输入/有子任务时会在**微任务**里一直空转，`activityDone` 每次都在变、
   * 永远追不上。微任务队列不空 ⇒ 宏任务（setTimeout、IO、日志）全部饿死
   * ⇒ 整个 DSH 主进程假死。Promose.race 也救不了。
   *
   * 这里只用 setTimeout（宏任务），彻底避开。
   */
  async waitSettled(agent, timeoutMs) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // ① 先等它真的动起来（最多 5 秒）
    const startDeadline = Date.now() + 5000
    while (String(agent.status ?? 'idle') !== 'running' && Date.now() < startDeadline) {
      await sleep(50)
    }
    if (String(agent.status ?? 'idle') !== 'running') {
      this.log.debug('投递后 5 秒内没进入 running（可能已瞬间完成），直接取结果')
    }

    // ② 等它停下来：status 不再是 running，且 seq 连续两次采样不变
    const deadline = Date.now() + timeoutMs
    let lastSeq = -1
    let quietTicks = 0
    let ticks = 0

    while (Date.now() < deadline) {
      const seq = Number(agent.session?.seq ?? 0)
      const status = String(agent.status ?? '?')

      if (status !== 'running' && seq === lastSeq) {
        quietTicks++
        if (quietTicks >= 2) return
      } else {
        quietTicks = 0
        lastSeq = seq
      }

      ticks++
      if (ticks % 100 === 0) {
        this.log.debug(`等待中：status=${status} seq=${seq}`)
      }
      await sleep(100)
    }
    this.log.warn(`等待本轮结束超时（${timeoutMs}ms），按当前状态收尾`)
  }

  /** 落盘（有 persistence 才有效）。 */
  async flush(agent) {
    try {
      const sessions = service(this.ctx, 'sessions')
      if (!sessions?.flush) return
      await sessions.flush(agent.session)
    } catch (error) {
      this.log.warn('会话 flush 失败：', error)
    }
  }

  /**
   * 从 session log 里取这一轮的终稿。
   * 只看 `turn/start` 之后的 `assistant/message` 的 text 块。
   */
  summarize(agent, firstSeq) {
    const session = agent.session
    let text = ''
    let reason = ''
    let started = false
    const length = Number(session?.seq ?? 0)
    const types = []

    for (let seq = firstSeq; seq < length; seq++) {
      let event
      try {
        event = session.eventAt(seq)
      } catch {
        continue
      }
      if (!event) continue
      types.push(event.type)

      if (event.type === 'turn/start') {
        started = true
        continue
      }
      if (!started) continue

      if (event.type === 'assistant/message') {
        const blocks = event.data?.message?.content ?? []
        const joined = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (joined !== '') text = joined
      }
      if (event.type === 'turn/end') {
        const r = event.data?.reason
        reason = typeof r === 'string' ? r : JSON.stringify(r ?? '')
      }
    }

    if (types.length === 0) {
      this.log.warn(`本轮没有新事件（seq ${firstSeq} → ${length}），消息可能没被接纳`)
    } else {
      this.log.debug(`本轮事件流（${types.length} 条）：${types.join(' → ')}`)
    }

    return { text, reason }
  }

  /**
   * 采这一轮的完整轨迹：用户 / 思维链 / 工具调用 / 工具结果 / 回复。
   * 顺 seq 走一遍 session log 就能还原，不用另记一套。
   */
  collectTrace(agent, firstSeq) {
    const session = agent.session
    const trace = []
    const length = Number(session?.seq ?? 0)
    /** callId → trace 里那条 tool 条目，用来回填结果 */
    const pending = new Map()

    const pushText = (kind, text) => {
      const value = String(text ?? '').trim()
      if (value) trace.push({ kind, at: Date.now(), text: value })
    }

    const blocksToText = (content) => {
      if (!Array.isArray(content)) return ''
      return content
        .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
        .join('')
    }

    for (let seq = firstSeq; seq < length; seq++) {
      let event
      try {
        event = session.eventAt(seq)
      } catch {
        continue
      }
      if (!event) continue

      if (event.type === 'user/message') {
        // 只记真正来自外部的，跳过我们自己注入的运行时上下文
        const source = event.data?.message?.source
        if (source?.kind && source.kind !== 'user') continue
        pushText('user', blocksToText(event.data?.message?.content))
        continue
      }

      if (event.type === 'assistant/message') {
        // token 用量：主人要「像 DSH 那样」看到这一轮花了多少。
        // 这是 DSH 自己写在会话日志里的 usage，不用另外统计。
        const usage = event.data?.usage
        if (usage && (Number(usage.inputTokens) > 0 || Number(usage.outputTokens) > 0)) {
          const input = Number(usage.inputTokens) || 0
          const output = Number(usage.outputTokens) || 0
          trace.push({
            kind: 'usage',
            at: Date.now(),
            tokens: {
              input,
              output,
              total: Number(usage.totalTokens) || input + output,
              cacheRead: Number(usage.cacheReadTokens) || 0,
            },
          })
        }

        const content = event.data?.message?.content ?? []
        for (const block of content) {
          if (!block) continue
          if (block.type === 'reasoning') {
            pushText('reasoning', block.text)
          } else if (block.type === 'text') {
            pushText('reply', block.text)
          } else if (block.type === 'tool-call') {
            const item = {
              kind: 'tool',
              at: Date.now(),
              name: String(block.name ?? '?'),
              args: block.arguments ?? null,
              result: '',
            }
            trace.push(item)
            if (block.id) pending.set(String(block.id), item)

            // 「计划」单独拎出来：主人要看的是 todo 列表，不是那段 JSON 参数
            if (item.name === 'todo_write') {
              const plan = parseTodoPayload(item.args)
              if (plan.length > 0) trace.push({ kind: 'plan', at: Date.now(), plan })
            }
          }
        }
        continue
      }

      if (event.type === 'tool/result') {
        const data = event.data ?? {}
        const id = String(data.callId ?? data.id ?? data.toolCallId ?? '')
        const item = id ? pending.get(id) : null
        const text = blocksToText(data.content) || (typeof data.result === 'string' ? data.result : '')
        if (item) {
          item.result = String(text ?? '').slice(0, 2000)
          if (data.error) item.error = true
        } else if (text) {
          trace.push({ kind: 'tool-result', at: Date.now(), text: String(text).slice(0, 2000) })
        }
      }
    }

    return trace
  }

  /**
   * 上下文**压缩**与**限制**。
   *
   * 这是两件事，必须分开做 —— 混在一起就会出现「压缩不生效、又没有兜底」的灾难：
   *
   *   ① **压缩**：把旧历史压成一条摘要，保留信息、省 token。走内核原生 compaction。
   *   ② **限制**：压缩是尽力而为 —— 内核可能因为「没有安全的可压段落」
   *      「单个 tool 结果本身就超预算」直接拒绝。这时候必须有硬上限，
   *      否则事件数一路涨，最后 API 报 context overflow、消息直接发不出去。
   *
   * 三档（从轻到重）：
   *   used <  compactAtEventCount            → 什么都不做
   *   used ≥  compactAtEventCount            → 试一次 compactIfNeeded('pressure')
   *   压不动 且 used ≥ hardResetEventCount   → needReset=true，交给上层换代次
   *
   * ⚠️ 内核契约（踩过：参数传错会静默失败，要么抛错被吞、要么永远返回 null）：
   *   compactIfNeeded(agent: CompactionAgentContext, trigger, signal)
   *     - 第一个参数是 `{ session, options: {provider, model} }`，**不是 Agent 本身**
   *     - trigger 是 `'pressure' | 'context-overflow'` 的字面量，**不是对象**
   *
   * @param {object} agent
   * @param {{provider?:string, model?:string}} [options]
   * @returns {Promise<{compacted:boolean, needReset:boolean, reason:string, used:number, pressure:number}>}
   */
  async maybeCompact(agent, { provider = '', model = '' } = {}) {
    const cfg = this.store.get()?.mind ?? {}
    const softLimit = Number(cfg.compactAtEventCount) || 0
    const hardLimit = Number(cfg.hardResetEventCount) || 0
    const used = Number(agent?.session?.seq ?? 0)

    const result = { compacted: false, needReset: false, reason: 'idle', used, pressure: 0 }

    if (softLimit <= 0 && hardLimit <= 0) {
      result.reason = 'disabled'
      return result
    }

    // 压力 0~1：有 tokenMeter 就用真实测量，没有就退回「事件数 / 软上限」
    result.pressure = this.pressureOf(agent, used, softLimit)

    const overSoft = softLimit > 0 && used >= softLimit
    const overHard = hardLimit > 0 && used >= hardLimit

    if (!overSoft) {
      result.reason = overHard ? 'over-hard-only' : 'below-soft-limit'
      // 没到软上限、也没到硬上限 → 收工
      if (!overHard) return result
    }

    // ① 先试着压缩
    const attempt = await this.tryCompact(agent, { provider, model })
    result.compacted = attempt.ok
    result.reason = attempt.reason

    if (attempt.ok) {
      this.log.info(
        `上下文已压缩：${used} 条事件（压力 ${Math.round(result.pressure * 100)}%）→ ` +
        `替掉 ${attempt.result?.shadowedSeqs?.length ?? '?'} 个节点、` +
        `省 ${attempt.result?.shadowedTokenCount ?? '?'} token`,
      )
      return result
    }

    // ② 压不动 → 看有没有到硬上限
    if (overHard) {
      result.needReset = true
      this.log.warn(`上下文压不动（${attempt.reason}）且已到硬上限 ${hardLimit}，需要换代次`)
    } else {
      this.log.debug(`上下文暂时压不动（${attempt.reason}），还没到硬上限 ${hardLimit}，下一轮再试`)
    }
    return result
  }

  /**
   * 压力 0~1。优先用内核的 tokenMeter 真实测量；
   * 拿不到就退回「事件数 / 软上限」这个粗糙但够用的近似。
   */
  pressureOf(agent, used, softLimit) {
    try {
      const meter = service(this.ctx, 'tokenMeter')
      const pressure = meter?.contextPressure?.(agent?.session)
      const window = Number(pressure?.contextWindow) || 0
      const tokens = Number(pressure?.pressureTokens) || 0
      if (window > 0) return Math.min(1, tokens / window)
    } catch {
      // tokenMeter 不可用，退回事件数
    }
    return softLimit > 0 ? Math.min(1, used / softLimit) : 0
  }

  /** 真正调 compaction。参数严格按契约来，见上面注释。 */
  async tryCompact(agent, { provider = '', model = '' } = {}) {
    let compaction
    try {
      compaction = service(this.ctx, 'compaction')
    } catch {
      compaction = undefined
    }
    if (!compaction?.compactIfNeeded) return { ok: false, reason: 'unavailable' }

    try {
      const controller = new AbortController()
      const agentCtx = { session: agent.session, options: { provider, model } }
      const out = await compaction.compactIfNeeded(agentCtx, 'pressure', controller.signal)
      return out
        ? { ok: true, reason: 'native', result: out }
        : { ok: false, reason: 'native-declined' }
    } catch (error) {
      return { ok: false, reason: `error:${error?.message ?? error}` }
    }
  }

  /** 面板用：现在用的是哪个模型。 */
  modelInfo() {
    return this.lastModel
  }

  /** 面板用：活着的会话。 */
  listSessions() {
    const out = []
    const threshold = Number(this.store.get()?.mind?.compactAtEventCount) || 0
    for (const [sessionId, entry] of this.live) {
      const events = Number(entry?.handle?.agent?.session?.seq ?? 0)
      out.push({
        sessionId,
        role: entry.role,
        mode: entry.mode,
        provider: entry.provider ?? '',
        model: entry.model ?? '',
        tags: entry.tags ?? [],
        startedAt: entry.startedAt ?? 0,
        events,
        compactAt: threshold,
        pressure: threshold > 0 ? Math.min(1, events / threshold) : 0,
      })
    }
    return out
  }

  /** 拆掉一个会话的 agent。 */
  async dispose(sessionId) {
    const entry = this.live.get(sessionId)
    if (!entry) return
    this.live.delete(sessionId)
    try {
      await entry.handle.dispose()
    } catch (error) {
      this.log.warn(`dispose ${sessionId} 失败：`, error)
    }
  }

  /** 插件卸载时全拆。 */
  async disposeAll() {
    const ids = [...this.live.keys()]
    await Promise.allSettled(ids.map((id) => this.dispose(id)))
  }
}

export { MIND_TOOL_ALLOW }
