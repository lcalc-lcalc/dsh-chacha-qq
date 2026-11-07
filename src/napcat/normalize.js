/**
 * OneBot 11 原始帧 → QqMessage。纯函数，零 IO。
 *
 * 这里只做「形状转换」，一个业务判断都不做（要不要回、给什么权限是 L2 的事）。
 * 字段名严格照 DESIGN §3，少一个字段 L2 就会拿到 undefined，别自作主张改。
 *
 * 设计参照 AstrBot 的「统一事件 + 消息链 + UMO 标识」：
 *   UMO = `{platform}-{scene}-{peerId}`，同时当会话键、白名单键、日志检索键。
 */

/** 能进 QqMessage.media 的段类型 → kind。表情/卡片不算媒体（没东西可下载）。 */
const MEDIA_KINDS = { image: 'image', file: 'file', record: 'record', video: 'video' }

/**
 * 把 `message` 字段统一成消息段数组。
 *
 * NapCat 开 `messagePostFormat: 'array'` 才给数组；默认的字符串形态这里只当纯文本，
 * 不写半个 CQ 码解析器 —— 引用、@ 的准确信息只在段里，CQ 串解析漏一个转义就出事。
 */
function toSegments(message) {
  if (Array.isArray(message)) {
    return message.filter((segment) => segment !== null && typeof segment === 'object' && typeof segment.type === 'string')
  }
  if (typeof message === 'string' && message) {
    return [{ type: 'text', data: { text: message } }]
  }
  return []
}

/**
 * 把消息段数组压成纯文本。
 *
 * @at 变成 `@昵称`（没有昵称就用 QQ 号），表情/图片等没有文字意义的段变占位，
 * 让 L3 看到的是一句人话，而不是一堆二进制或空字符串。
 */
export function segmentsToText(segments) {
  if (!Array.isArray(segments)) return ''
  const parts = []
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue
    const data = segment.data ?? {}
    switch (segment.type) {
      case 'text': {
        // 少数版本把文本直接挂在段上（{type:'text', text:'xx'}），一起兜住
        const text = String(data.text ?? segment.text ?? '')
        if (text) parts.push(text)
        break
      }
      case 'at': {
        const qq = String(data.qq ?? '')
        if (qq === 'all') parts.push('@全体成员')
        else if (data.name) parts.push(`@${String(data.name)}`)
        else parts.push(`@${qq || '某人'}`)
        break
      }
      case 'face':
      case 'mface':
        parts.push('[表情]')
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'record':
        parts.push('[语音]')
        break
      case 'video':
        parts.push('[视频]')
        break
      case 'file':
        parts.push(data.name ? `[文件 ${String(data.name)}]` : '[文件]')
        break
      case 'json':
      case 'xml':
        parts.push('[卡片]')
        break
      case 'forward':
        parts.push('[合并转发]')
        break
      case 'markdown':
        parts.push(String(data.content ?? '[富文本]'))
        break
      // reply 是引用、poke 是戳一戳：正文里不留占位，交给上层按需读 segments
      default:
        break
    }
  }
  return parts.join('').trim()
}

/** 取出所有 @ 目标（含 'all'，判定 mentionsMe 时不会误伤）。 */
function extractAtTargets(segments) {
  const targets = []
  for (const segment of segments) {
    if (segment.type !== 'at') continue
    const qq = String(segment.data?.qq ?? '')
    if (qq) targets.push(qq)
  }
  return targets
}

/** 收集媒体段，交给 L2 落盘/下载。 */
function extractMedia(segments) {
  const media = []
  for (const segment of segments) {
    const kind = MEDIA_KINDS[segment.type]
    if (!kind) continue
    const data = segment.data ?? {}
    media.push({
      kind,
      url: String(data.url ?? ''),
      // NapCat 各版本的字段名不完全一样：标准是 file，有的给 file_id/path
      fileId: String(data.file_id ?? data.file ?? ''),
      name: String(data.name ?? (kind === 'file' ? data.file ?? '' : '')),
    })
  }
  return media
}

/**
 * CQ 码兜底：字符串形态的消息里 @ 长这样 `[CQ:at,qq=123]`，
 * NapCat 段数组里通常不会出现，但机器人自己拼消息、或者别家协议端会。
 */
function hasAtCq(message, selfId) {
  if (!selfId) return false
  const candidates = []
  if (typeof message === 'string') candidates.push(message)
  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment?.type === 'text' && typeof segment.data?.text === 'string') candidates.push(segment.data.text)
    }
  }
  if (candidates.length === 0) return false
  // qq 后面可能跟 name 等参数，也可能直接是 ]，两种都要认
  const pattern = new RegExp(`\\[CQ:at,qq=${selfId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[,\\]])`, 'i')
  return candidates.some((text) => pattern.test(text))
}

/** 群/私聊判定：message_type 缺失时按 group_id 猜一把，NapCat 理论不会缺。 */
function sceneOf(packet) {
  if (packet.message_type === 'group') return 'group'
  if (packet.message_type === 'private') return 'private'
  return packet.group_id ? 'group' : 'private'
}

/**
 * 把 post_type=message 的事件归一化成 QqMessage（DESIGN §3，字段一个不少）。
 *
 * @param {object} packet OneBot 原始事件
 * @param {string} [selfId] 自己的号；缺省时用事件里的 self_id 兜底
 * @returns {object|null} 非消息事件返回 null
 */
export function normalizeMessage(packet, selfId = '') {
  if (!packet || packet.post_type !== 'message') return null

  const self = String(selfId || packet.self_id || '')
  const scene = sceneOf(packet)
  const segments = toSegments(packet.message)
  const userId = String(packet.user_id ?? packet.sender?.user_id ?? '')
  const groupId = scene === 'group' ? String(packet.group_id ?? '') : ''
  const peerId = scene === 'group' ? groupId : userId

  return {
    id: String(packet.message_id ?? ''),
    scene,
    peerId,
    groupId,
    userId,
    selfId: self,
    sender: {
      id: String(packet.sender?.user_id ?? userId),
      // 显示名优先群名片，L2 拼提示词时用 nickname 兜底
      nickname: String(packet.sender?.nickname ?? ''),
      card: String(packet.sender?.card ?? ''),
      // DESIGN §3 的 sender 只列了 id/nickname/card，但群管要判群主/管理员，
      // OneBot 本来就给了 sender.role，原样带出来（已报给 Lead，等契约补这一行）
      role: String(packet.sender?.role ?? ''),
    },
    text: segmentsToText(segments),
    // 原始段原样留着：L2 要引用、要下载媒体、要判断 at 谁，都从这里看
    segments,
    mentionsMe: self !== '' && (extractAtTargets(segments).includes(self) || hasAtCq(packet.message, self)),
    media: extractMedia(segments),
    // OneBot 的 time 是秒，这里统一给毫秒时间戳（观望/去重都按毫秒算）
    at: Number(packet.time) > 0 ? Number(packet.time) * 1000 : Date.now(),
    raw: packet,
  }
}

/**
 * UMO 会话标识：`qq-private-123` / `qq-group-456`。
 * 群聊只到群号这一级 —— 具体是谁说的由 message.userId 表达，不塞进 UMO。
 */
export function umoOf(message) {
  if (!message) throw new Error('umoOf 需要一条 QqMessage')
  return `qq-${message.scene}-${message.peerId}`
}

/**
 * 会话的稳定标识（不含代次），用来当配置/缓存的 key。
 *
 * ⚠️ 群聊必须按发言人身份拆开：
 *   `qq-group-999` 里的主人和群友是两种权限的 agent，共用一条 session 会让角色
 *   随每句话在 owner/guest 之间跳，每次都触发「拆 agent + 重建」，又慢又搅上下文。
 *   私聊没有身份冲突，不需要拆。
 */
export function sessionKeyOf(message, prefix = 'qq', role = 'guest') {
  if (!message) throw new Error('sessionKeyOf 需要一条 QqMessage')
  const p = String(prefix || 'qq')
  if (message.scene === 'group') {
    return `${p}-group-${message.peerId}-${role === 'owner' ? 'owner' : 'guest'}`
  }
  return `${p}-private-${message.peerId}`
}

/**
 * DSH 的 sessionId = sessionKey + 代次后缀。
 *
 * 第四参 `generation`：重置过的会话带 `-g<N>`。
 * 为什么需要它：DSH 会话按 sessionId 持久化，直接 dispose + 重建会把旧历史
 * resume 回来（等于没重置）；换一个 sessionId 才是真清空。
 */
export function sessionIdOf(message, prefix = 'qq', role = 'guest', generation = 0) {
  const base = sessionKeyOf(message, prefix, role)
  const gen = Math.floor(Number(generation))
  return Number.isFinite(gen) && gen > 0 ? `${base}-g${gen}` : base
}
