/**
 * dsh-chacha-qq v3 — host 半边入口。
 *
 * 这一层**只做装配**：解析数据目录 → 载配置 → 起日志 → 装各层 → 起 Controller。
 * 业务逻辑全部在 src/ 里，index.js 保持「读起来像目录」。
 *
 * 装配策略：**每个模块都动态加载、单独兜底**。
 * 旧版最惨的一次故障是「插件在配置树里、DSH 没报错、日志一个字都没有」——
 * 一个 import 失败把整个模块链拖死。这里任何一个模块加载失败都只让那一块降级，
 * 网关照连、日志照写，问题一眼就能看见。
 */
import fs from 'node:fs'
import path from 'node:path'

import { ConfigStore, resolveDataDir } from './src/config.js'
import { createLogger } from './src/log.js'

export const name = 'dsh-chacha-qq'

/**
 * 故意**不声明** `inject`。
 *
 * 教训：声明 `inject: ['agents']` 之后，只要 agents 没就绪，cordis 就一直不 apply 本插件 ——
 * 表现是「插件在配置树里、DSH 没报错、日志一个字都没有」，极难排查。
 * 改成自己按需取：拿不到就一直不接大脑，但网关照跑、日志照写。
 */

/** 尝试动态加载一个模块，失败返回 null 并记日志。 */
async function softImport(specifier, log, label) {
  try {
    return await import(specifier)
  } catch (error) {
    log.warn(`模块加载失败，将降级：${label ?? specifier} —— ${error?.message ?? error}`)
    return null
  }
}

class Runtime {
  constructor({ ctx, config }) {
    this.ctx = ctx
    this.bootConfig = config ?? {}
    this.dataDir = resolveDataDir(this.bootConfig)
    fs.mkdirSync(this.dataDir, { recursive: true })

    this.store = new ConfigStore(path.join(this.dataDir, 'config.json'))
    this.store.load()
    this.startedAt = Date.now()

    const cfg = this.store.get()
    this.log = createLogger({
      file: path.join(this.dataDir, 'logs', 'chacha-qq.log'),
      level: cfg.log?.level ?? 'info',
      maxFileBytes: cfg.log?.maxFileBytes ?? 4 * 1024 * 1024,
    })
    this.log.info(`数据目录 ${this.dataDir}`)

    /** 装配好的零件 */
    this.gateway = null
    this.controller = null
    this.mind = null
    this.parts = {}
    this.disposers = []
    this.disposed = false
    /** Controller 还没建出来之前，请求事件先落这儿（随后被 Controller 的 Map 接管） */
    this.orphanRequests = new Map()
  }

  /** 异步装配三层。任何一块失败都不影响其他块。 */
  async start() {
    const self = this
    const log = this.log
    const cfg0 = this.store.get()

    // 🥚 彩蛋模块最先加载：L1 的 gateway 'login' 事件要用它（上线语）。
    //    放在这里而不是 L3，是因为 NapCat 可能比 Mind 装配得更快 ——
    //    那种情况下 `this.eggsModule` 会是 undefined，彩蛋就静默消失了。
    this.eggsModule = await softImport('./src/mind/easter-eggs.js', log, 'mind/easter-eggs')

    // ── L1 NapCat ─────────────────────────────────────────────
    const gatewayMod = await softImport('./src/napcat/gateway.js', log, 'napcat/gateway')
    if (gatewayMod?.OneBotGateway) {
      try {
        this.gateway = new gatewayMod.OneBotGateway({
          wsUrl: cfg0.qq?.wsUrl ?? 'ws://127.0.0.1:3001',
          token: cfg0.qq?.token ?? '',
          log,
          reconnect: cfg0.qq?.reconnect,
          silenceWarnMs: cfg0.qq?.silenceWarnMs,
        })
        this.gateway.on?.('open', () => log.info('NapCat 已连接'))
        // 🥚 上线语每次重启换一句（见 src/mind/easter-eggs.js）
        this.gateway.on?.('login', ({ user_id }) => {
          const tail = this.eggsModule?.pickOne?.(this.eggsModule.STARTUP_LINES) ?? ''
          log.info(`茶茶酱上线：${user_id}${tail ? `（${tail}）` : ''}`)
        })
        this.gateway.on?.('stale', (ms) => log.warn(`上游静默 ${Math.round(ms / 1000)} 秒`))
        this.parts.gateway = true
      } catch (error) {
        log.error('网关构造失败：', error)
      }
    }

    const apiMod = await softImport('./src/napcat/api.js', log, 'napcat/api')
    const api = this.gateway && apiMod?.createQqApi ? apiMod.createQqApi(this.gateway) : null
    this.parts.api = Boolean(api)

    // ── L2 Controller 各子系统（全部可选） ─────────────────────
    const [routeMod, observeMod, interestMod, tagsMod, securityMod, rhythmMod, moderationMod] =
      await Promise.all([
        softImport('./src/controller/route.js', log, 'controller/route'),
        softImport('./src/controller/observe.js', log, 'controller/observe'),
        softImport('./src/controller/interest.js', log, 'controller/interest'),
        softImport('./src/controller/tags.js', log, 'controller/tags'),
        softImport('./src/controller/security.js', log, 'controller/security'),
        softImport('./src/controller/rhythm.js', log, 'controller/rhythm'),
        softImport('./src/controller/moderation.js', log, 'controller/moderation'),
      ])

    const [emotionMod, memoryStoreMod, memoryRecallMod] = await Promise.all([
      softImport('./src/controller/emotion.js', log, 'controller/emotion'),
      softImport('./src/controller/memory/index.js', log, 'controller/memory'),
      softImport('./src/controller/memory/recall.js', log, 'controller/memory/recall'),
    ])

    // 日程 / 关系 / 表情包（v3.1 新加的三个子系统）
    const [lifeMod, relationMod, memeMod] = await Promise.all([
      softImport('./src/controller/life/index.js', log, 'controller/life'),
      softImport('./src/controller/relation.js', log, 'controller/relation'),
      softImport('./src/controller/meme/index.js', log, 'controller/meme'),
    ])

    // 情绪 / 记忆 / 回忆
    // ⚠️ 这三个模块的 config 接受「对象或 getter」。一定要传 getter：
    //    传快照的话，面板改了设置要重启才生效。
    let emotion = null
    if (emotionMod?.EmotionState) {
      try {
        emotion = new emotionMod.EmotionState({
          dataDir: this.dataDir,
          config: () => self.store.get().emotion ?? {},
          log: log.child('emotion'),
        })
        this.parts.emotion = true
      } catch (error) {
        log.warn('情绪模块初始化失败：', error)
      }
    }

    let memory = null
    if (memoryStoreMod?.MemoryStore) {
      try {
        memory = new memoryStoreMod.MemoryStore({
          dataDir: this.dataDir,
          // ⚠️ 传整份配置的 getter：memory 模块要读 memory.* 和 modes（work 模式下要不要记事）
          config: () => self.store.get(),
          log: log.child('memory'),
        })
        this.parts.memory = true
      } catch (error) {
        log.warn('记忆模块初始化失败：', error)
      }
    }

    // 自动总结：有了它，主人说「我喜欢吃辣」才会**自动**记住，
    // 而不是等她主动想到调 qq_remember（那是旧实现最大的洞）。
    let summarizer = null
    if (memoryStoreMod?.Summarizer && memory) {
      try {
        summarizer = new memoryStoreMod.Summarizer({
          store: memory,
          config: () => self.store.get(),
          log: log.child('summarize'),
          // 用**独立会话**总结，别污染任何真实对话的 history
          runModel: async (prompt) => {
            if (!this.mind?.available) throw new Error('Mind 不可用，总结不了')
            const reply = await this.mind.ask({
              sessionId: `${cfg0.mind?.sessionPrefix ?? 'qq'}-summarize`,
              role: 'owner',
              mode: 'read-only',
              tags: [],
              peerId: 'summarize',
              text: prompt,
              timeoutMs: 90000,
            })
            return reply?.text ?? ''
          },
        })
        this.parts.summarizer = true
      } catch (error) {
        log.warn('自动总结初始化失败（记忆会退化成只能靠 qq_remember）：', error)
      }
    }

    // ── 日程 / 关系 / 表情包 ──────────────────────────────────
    // ⚠️ 这三个的 config 都必须传**整份配置的 getter**：
    //    - 日程/关系要读 modes（work 模式判定）
    //    - 关系还要读 owner（主人分数地板）
    //    只传子段（比如 () => cfg.life）会让 work 模式和主人地板同时失效，
    //    而且**不会报错**，退化成"全世界都是 companion、没有主人"。

    /** 日程生成：跑一次独立的 Mind 会话（不污染任何真实对话的 history） */
    const generateSchedule = async ({ count, date } = {}) => {
      if (!this.mind?.available) throw new Error('Mind 不可用，暂时生成不了日程')
      const prompt = lifeMod.buildSchedulePrompt
        ? lifeMod.buildSchedulePrompt({ count, date })
        : `生成今天的日程，${count ?? 6} 段。`
      const reply = await this.mind.ask({
        sessionId: `${cfg0.mind?.sessionPrefix ?? 'qq'}-life`,
        role: 'owner',
        mode: 'read-only',
        tags: [],
        peerId: 'life',
        text: prompt,
        timeoutMs: 60000,
      })
      return lifeMod.parseScheduleOutput
        ? lifeMod.parseScheduleOutput(reply?.text ?? '')
        : []
    }

    let life = null
    if (lifeMod?.LifeState) {
      try {
        life = new lifeMod.LifeState({
          dataDir: this.dataDir,
          config: () => self.store.get(),
          log: log.child('life'),
          generate: generateSchedule,
        })
        this.parts.life = true
      } catch (error) {
        log.warn('日程模块初始化失败（她会没有自己的生活）：', error)
      }
    }

    let relation = null
    if (relationMod?.RelationStore) {
      try {
        relation = new relationMod.RelationStore({
          dataDir: this.dataDir,
          config: () => self.store.get(),
          log: log.child('relation'),
        })
        this.parts.relation = true
      } catch (error) {
        log.warn('关系模块初始化失败：', error)
      }
    }

    // 表情包：MemeSystem 是门面，内含 store（图库）+ stealGate（盗图）+ 发送编排。
    // vision 用一次**独立会话**看图 —— 不污染任何真实对话的 history。
    let meme = null
    if (memeMod?.MemeSystem) {
      try {
        meme = new memeMod.MemeSystem({
          dataDir: this.dataDir,
          config: () => self.store.get(),
          log: log.child('meme'),
          vision: async (filePath) => {
            const miss = { ok: false, isMeme: false, description: '', category: '' }
            if (!this.mind?.available) return miss
            let raw = ''
            try {
              const reply = await this.mind.ask({
                sessionId: `${cfg0.mind?.sessionPrefix ?? 'qq'}-vision`,
                role: 'owner',
                mode: 'read-only',
                tags: [],
                peerId: 'vision',
                text:
                  '看这张图，判断它适不适合当表情包用。只输出一个 JSON：' +
                  '{"isMeme":true/false,"description":"一句话描述画面（中文，越短越好）",' +
                  '"category":"happy|sad|angry|shocked|speechless|hug 里选一个"}\n' +
                  `图片路径：${filePath}`,
                timeoutMs: 45000,
              })
              raw = String(reply?.text ?? '')
            } catch (error) {
              log.debug('盗图：视觉判断失败，跳过这张', error?.message ?? error)
              return miss
            }
            // 模型可能带 ```json 围栏或前言，抠出第一个 JSON 对象就够
            const match = /\{[\s\S]*\}/.exec(raw)
            if (!match) return miss
            try {
              const obj = JSON.parse(match[0])
              const isMeme = Boolean(obj?.isMeme)
              return {
                ok: isMeme,
                isMeme,
                description: String(obj?.description ?? '').slice(0, 40),
                category: String(obj?.category ?? ''),
              }
            } catch {
              // 解析不出来当「不认识」—— 宁可漏收，也不收垃圾图
              return miss
            }
          },
        })
        // 骨架目录（类别 + _catalog.json）：启动建一次，失败不影响发图
        await meme.ensureDirs?.()
        this.parts.meme = true
      } catch (error) {
        log.warn('表情包模块初始化失败（她只会打字了）：', error)
      }
    }

    // ── L3 The Mind ───────────────────────────────────────────
    const [turnMod, sessionMod, toolsMod, presetMod] = await Promise.all([
      softImport('./src/mind/turn.js', log, 'mind/turn'),
      softImport('./src/mind/session.js', log, 'mind/session'),
      softImport('./src/mind/tools.js', log, 'mind/tools'),
      softImport('./src/mind/preset.js', log, 'mind/preset'),
    ])

    const sessions = sessionMod?.MindSessions
      ? new sessionMod.MindSessions({ store: this.store, log: log.child('session'), prefix: cfg0.mind?.sessionPrefix ?? 'qq' })
      : null
    this.sessions = sessions

    // QQ 工具需要 gateway + outbox + store + memory；outbox 由 controller 建，
    // 但工具在 Mind 的 setup 里才用到，所以这里先给一个懒引用。
    let qqTools = null
    if (toolsMod?.QqTools && this.gateway) {
      try {
        qqTools = new toolsMod.QqTools({
          gateway: this.gateway,
          // ⚠️ outbox 和 pendingRequests 都在 Controller 里才建出来，
          //    而 Controller 又要等 Mind 就绪 —— 所以这里必须用 getter 懒取，
          //    不能传快照（传快照的话 qq_send_to 会永远拿到 null）。
          get outbox() {
            return self.controller?.outbox ?? null
          },
          store: this.store,
          log: log.child('tools'),
          memory,
          // 回忆实例建得比 qqTools 晚（它要先用 Mind 跑子 Agent），所以也走 getter
          get recall() {
            return self.recall ?? null
          },
          get pendingRequests() {
            return self.controller?.pendingRequests ?? self.orphanRequests
          },
        })
        this.parts.qqTools = true
      } catch (error) {
        log.warn('QQ 工具初始化失败（主人将拿不到跨群能力）：', error)
      }
    }

    if (turnMod?.Mind) {
      try {
        this.mind = new turnMod.Mind({
          ctx: this.ctx,
          store: this.store,
          log: log.child('mind'),
          memory,
          emotion,
          life,
          meme,
          qqTools,
          // 🥚 彩蛋（深夜关怀）。传 null 也能跑 —— 所有调用都是 ?.
          eggs: this.eggsModule ?? null,
        })
        this.parts.mind = this.mind.available
        if (!this.mind.available) log.warn('ctx.agents 不可用，Mind 处于离线状态（只记录不回复）')
      } catch (error) {
        log.error('Mind 构造失败：', error)
      }
    }

    // 回忆：需要 Mind 提供 runSubagent
    let recall = null
    if (memoryRecallMod?.Recall) {
      try {
        recall = new memoryRecallMod.Recall({
          dataDir: this.dataDir,
          config: () => self.store.get().memory ?? {},
          log: log.child('recall'),
          runSubagent: async (prompt) => {
            if (!this.mind?.available) throw new Error('Mind 不可用，无法派子 Agent')
            const reply = await this.mind.ask({
              sessionId: `${cfg0.mind?.sessionPrefix ?? 'qq'}-recall`,
              role: 'owner',
              mode: 'read-only',
              tags: ['回忆'],
              peerId: 'recall',
              text: prompt,
              timeoutMs: 90000,
            })
            return reply?.text ?? ''
          },
        })
        // 交给 QQ 工具懒取：qq_recall_memory 靠它
        this.recall = recall
        this.parts.recall = true
      } catch (error) {
        log.warn('回忆模块初始化失败：', error)
      }
    }

    // ── 观望窗口 ─────────────────────────────────────────────
    let observe = null
    if (observeMod?.ObservationWindow) {
      try {
        observe = new observeMod.ObservationWindow({
          log: log.child('observe'),
          onSettle: (batchKey, messages) => this.controller?.onSettle(batchKey, messages),
        })
        this.parts.observe = true
      } catch (error) {
        log.warn('观望窗口初始化失败（将直接处理每条消息）：', error)
      }
    }

    // ── Controller ───────────────────────────────────────────
    const pipelineMod = await softImport('./src/controller/pipeline.js', log, 'controller/pipeline')
    if (pipelineMod?.Controller && this.gateway) {
      try {
        this.controller = new pipelineMod.Controller({
          ctx: this.ctx,
          store: this.store,
          log: log.child('controller'),
          gateway: this.gateway,
          mind: this.mind,
          observe,
          interest: interestMod ?? null,
          tags: tagsMod ?? null,
          security: securityMod ?? null,
          emotion,
          memory,
          summarizer,
          life,
          relation,
          meme,
          moderation: moderationMod ?? null,
          rhythm: rhythmMod ?? null,
          dataDir: this.dataDir,
        })
        this.parts.controller = true
      } catch (error) {
        log.error('Controller 构造失败：', error)
      }
    } else if (!this.gateway) {
      log.warn('没有网关，Controller 不启动（NapCat 层没加载成功）')
    }

    /**
     * ⚠️ **回填**：QqTools 是在 Controller 之前建的（因为 Mind 要它），
     * 而它的构造参数里写的是 `get outbox() { return self.controller?.outbox }`。
     *
     * 坑：**对象字面量里的 getter 传给构造函数、被参数解构时会被立即求值** ——
     * `constructor({ outbox }) { this.outbox = outbox }` 拿到的是当时的快照。
     * 那时 Controller 还没建出来，于是 `this.outbox` 永远是 `null`。
     * 表现：`qq_send_to` / `qq_send_file` / `qq_recall_memory` 全部报
     * `Cannot read properties of null (reading 'push')`。
     * （`qq_remember` 没受影响，因为它走的是 memory。）
     *
     * 所以 Controller / Recall 建好之后必须把这几样**再赋一次**。
     */
    if (qqTools) {
      try {
        qqTools.outbox = this.controller?.outbox ?? null
        qqTools.pendingRequests = this.controller?.pendingRequests ?? this.orphanRequests
        qqTools.recall = recall ?? null
        log.debug(
          `QQ 工具依赖回填：outbox=${Boolean(qqTools.outbox)} ` +
          `pendingRequests=${Boolean(qqTools.pendingRequests)} recall=${Boolean(qqTools.recall)}`,
        )
      } catch (error) {
        log.warn('QQ 工具依赖回填失败（跨群发送/回忆会不可用）：', error)
      }
    }

    // ── 面板端点 ─────────────────────────────────────────────
    // 真正的实现在 src/panel/api.js（6 个端点、回环校验、node/fetch 双 handler 形态都在那儿）。
    // 这里只是装配点：panel 模块可能没加载成功 —— 那只是「面板看不见」，QQ 功能一点不受影响。
    this.panelMod = (await softImport('./src/panel/api.js', log, 'panel/api')) ?? null
    this.registerHttp()

    // ── 起 ───────────────────────────────────────────────────
    if (this.controller) {
      try {
        this.controller.start()
      } catch (error) {
        log.error('Controller 启动失败：', error)
      }
    } else {
      log.warn('Controller 未就绪，QQ 消息不会被处理')
    }

    this.log.info(
      `装配完成：${Object.entries(this.parts).filter(([, v]) => v).map(([k]) => k).join(' / ') || '(空)'}`,
    )
    this.log.rotate()
  }

  /**
   * 面板 HTTP 端点（装配点）。
   *
   * 具体实现在 `src/panel/api.js`：六个端点、回环校验、深合并、
   * `node(req,res)` / `fetch(Request)` 两种 handler 形态的双兼容都在那儿。
   *
   * ⚠️ 旧版本这里自己注册过一个 `/chacha-qq/state`，而且 handler 签名用错了
   * （DSH 这一版的 `webServer.register` 给的是 Node 原生 `(req, res)`，
   * 不是 Web 标准的 `Request → Response`）。那个实现已经删掉，
   * **绝不能两个都注册同一个路径** —— 会直接 throw，把整块面板带黑（v2 坑 21）。
   */
  registerHttp() {
    const log = this.log
    const mod = this.panelMod
    if (!mod?.registerPanel) {
      log.warn('面板模块不可用，面板端点没注册（QQ 功能不受影响）')
      return
    }
    try {
      const disposers = mod.registerPanel({ ctx: this.ctx, runtime: this, log: log.child('panel') })
      if (Array.isArray(disposers)) this.disposers.push(...disposers)
      this.parts.panel = true
    } catch (error) {
      log.warn('面板端点注册失败（不影响 QQ 功能）：', error)
    }
  }

  /** 配置热更新：连接参数变了就重连。 */
  applyConfig(cfg) {
    try {
      this.gateway?.update?.({
        wsUrl: cfg.qq?.wsUrl,
        token: cfg.qq?.token,
        reconnect: cfg.qq?.reconnect,
        silenceWarnMs: cfg.qq?.silenceWarnMs,
      })
    } catch (error) {
      this.log.warn('应用配置失败：', error)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.log.info('插件卸载中')
    try {
      this.controller?.stop?.()
    } catch {
      // ignore
    }
    try {
      this.gateway?.close?.()
    } catch {
      // ignore
    }
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
    void this.mind?.disposeAll?.().catch?.(() => {})
    if (globalThis[SINGLETON_KEY] === this) globalThis[SINGLETON_KEY] = null
  }
}

/**
 * 进程级单例键。
 *
 * 为什么需要：DSH 的 HMR / cordis 重试会让插件**反复 apply**（旧版实测一次会话里
 * 「数据目录」这行出现过 24 次）。每次 apply 都新建一个 Runtime、各连一条 WebSocket，
 * 结果就是「日志说连上了、面板说没连」—— 因为活着的那个和写日志的不是同一个。
 */
const SINGLETON_KEY = Symbol.for('dsh-chacha-qq.runtime')

/**
 * cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  // ① 先拆掉上一次的（HMR 重载 / 重复加载）
  const previous = globalThis[SINGLETON_KEY]
  if (previous && typeof previous.dispose === 'function') {
    try {
      console.warn('[chacha-qq] 检测到上一个实例，先拆掉再重建')
      previous.dispose()
    } catch (error) {
      console.warn('[chacha-qq] 拆除旧实例失败（继续新建）：', error?.message ?? error)
    }
  }

  // ② 建新的
  const runtime = new Runtime({ ctx, config })
  globalThis[SINGLETON_KEY] = runtime

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => runtime.dispose())
  }

  // ③ 异步装配，不阻塞 apply（否则一个慢模块会卡住 cordis）
  void runtime.start().catch((error) => {
    runtime.log.error('装配失败：', error)
  })

  return { runtime }
}
