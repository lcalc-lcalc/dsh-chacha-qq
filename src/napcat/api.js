/**
 * OneBot 11 action 薄封装。
 *
 * 定位：把「action 名字 + 参数名」这些协议细节关在这一层，L2 只认
 * `api.sendGroup(groupId, segments)` 这种写法。参数名严格按 OneBot 11 规范，
 * 别自作聪明改名（NapCat 对拼错的参数是静默忽略，排查起来要命）。
 *
 * 两个 v2 抄来的坑：
 *  1. 发图片不能给 `file:///C:/...`，NapCat 不认，必须 `base64://`。
 *     处理在 sendFile() 里，注释写在那儿了。
 *  2. 发普通文件不需要 base64，NapCat 和我们在同一台机器，直接给本地路径最快。
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 上传文件比发消息慢得多（大文件要传），超时给足。 */
const UPLOAD_TIMEOUT_MS = 120000

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

/** 统一把 id 变成非空字符串；QQ 号/群号在 OneBot 里是整数，但字符串各端都认。 */
function targetId(value, field) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`缺少${field}`)
  return text
}

/** 发消息的内容：允许直接给字符串（图省事），空内容直接拒绝。 */
function asSegments(message) {
  if (Array.isArray(message) && message.length > 0) return message
  if (typeof message === 'string' && message.trim()) {
    return [{ type: 'text', data: { text: message } }]
  }
  throw new Error('消息内容为空')
}

/** 从文件引用里猜一个显示名：本地路径取 basename，URL 取最后一段。 */
function nameOf(file) {
  if (typeof file !== 'string') return ''
  const value = file.trim()
  if (!value || value.startsWith('base64://')) return ''
  if (/^https?:\/\//i.test(value)) {
    try {
      return decodeURIComponent(new URL(value).pathname.split('/').pop() ?? '')
    } catch {
      return ''
    }
  }
  try {
    return basename(value.startsWith('file://') ? fileURLToPath(value) : value)
  } catch {
    return ''
  }
}

/** 看名字像不像图片（发图走消息段，发文件走 upload_*_file，路线完全不同）。 */
function looksLikeImage(name, file) {
  const candidates = [name, nameOf(file)]
  return candidates.some((value) => typeof value === 'string' && value.trim() && IMAGE_EXT.test(value.split('?')[0].trim()))
}

/**
 * 把本机文件 / file:/// URL / Buffer 变成 NapCat 会真的去读的 `base64://...`。
 *
 * ⚠️ 这就是 v2 那个坑：本地图片塞 `file:///C:/xxx.png`，NapCat 只会把它当普通
 * 字符串拿去 QQ 服务器找，最后报「文件不存在」。图片必须读出来内联成 base64。
 * http(s) 和已经是 base64:// 的原样透传。
 */
export async function toFileRef(file) {
  if (Buffer.isBuffer(file)) return `base64://${file.toString('base64')}`
  const value = String(file ?? '').trim()
  if (!value) throw new Error('缺少文件内容')
  if (value.startsWith('base64://')) return value
  if (/^https?:\/\//i.test(value)) return value

  let localPath = value
  if (value.startsWith('file://')) {
    try {
      localPath = fileURLToPath(value)
    } catch (error) {
      throw new Error(`file:/// 地址不合法：${error.message}`)
    }
  }

  let buffer
  try {
    buffer = await readFile(localPath)
  } catch (error) {
    throw new Error(`读不了文件 ${localPath}：${error.message}（NapCat 不认 file:///，本地图片要先读成 base64://）`)
  }
  return `base64://${buffer.toString('base64')}`
}

/**
 * 把「带本机路径的 image 段」转成 NapCat 认的 `base64://`。
 *
 * 为什么必须在 L1 做：
 *   L2/L3 只该关心「发哪张图」，不该关心 QQ 协议认什么格式。
 *   表情包系统输出的段长这样：`{ type:'image', data:{ path:'C:\\...\\开心.gif' } }`，
 *   而 NapCat 只认 `base64://` 或 http(s) URL —— 直接给本地路径它会拿去 QQ 服务器找，
 *   报「文件不存在」。这是 v2 踩过的坑，别让上层再碰一次。
 *
 * 一张图读不出来不能把整条消息搞丢：降级成一条文字提示，继续发后面的段。
 */
async function normalizeSegments(message) {
  const segments = asSegments(message)
  const out = []
  for (const segment of segments) {
    if (segment?.type !== 'image') {
      out.push(segment)
      continue
    }
    const data = segment.data ?? {}
    // 已经是 base64:// 或 http(s) 的、或者没有 path 的，原样放行
    if (data.file || !data.path) {
      out.push(segment)
      continue
    }
    try {
      // 转完把 path 去掉：留着会让 NapCat 多一个不认识的字段（实测不影响发送，
      // 但排错时容易误以为它还在用本地路径）
      const { path: localPath, ...rest } = data
      out.push({ ...segment, data: { ...rest, file: await toFileRef(localPath) } })
    } catch (error) {
      out.push({ type: 'text', data: { text: `（这张图没发出去：${error?.message ?? error}）` } })
    }
  }
  return out
}

/** 普通文件上传用本地路径：file:/// 还原成路径，http/base64 原样交给 NapCat。 */
function localPathOf(file) {
  if (typeof file !== 'string') return ''
  const value = file.trim()
  if (!value) return ''
  if (value.includes('://')) {
    if (!value.startsWith('file://')) return value
    try {
      return fileURLToPath(value)
    } catch {
      return ''
    }
  }
  return value
}

function sendTo(gateway, scene, peerId, segments) {
  if (scene === 'group') return gateway.call('send_group_msg', { group_id: peerId, message: segments })
  return gateway.call('send_private_msg', { user_id: peerId, message: segments })
}

/**
 * 创建 QQ action 集合。
 * @param {{ call(action: string, params?: object, timeoutMs?: number): Promise<any> }} gateway
 */
export function createQqApi(gateway) {
  if (!gateway || typeof gateway.call !== 'function') {
    throw new Error('createQqApi 需要一个能 call 的网关')
  }

  async function sendPrivate(userId, segments) {
    return gateway.call('send_private_msg', {
      user_id: targetId(userId, 'userId'),
      message: await normalizeSegments(segments),
    })
  }

  async function sendGroup(groupId, segments) {
    return gateway.call('send_group_msg', {
      group_id: targetId(groupId, 'groupId'),
      message: await normalizeSegments(segments),
    })
  }

  /**
   * 发文件/图片的统一入口。
   * @param {{scene:string, peerId:string, file:string|Buffer, name?:string, folder?:string}} opts
   */
  async function sendFile({ scene, peerId, file, name, folder } = {}) {
    const target = scene === 'group' ? 'group' : 'private'
    const id = targetId(peerId, target === 'group' ? '群号' : 'QQ 号')
    const label = String(name ?? '').trim() || nameOf(file)

    if (looksLikeImage(label, file)) {
      // ✅ 图片：读成 base64:// 当 image 段发（file:/// 是 v2 的坑，见 toFileRef 注释）
      const ref = await toFileRef(file)
      return sendTo(gateway, target, id, [{ type: 'image', data: { file: ref } }])
    }

    // ✅ 普通文件：走 upload_*_file，直接把本机路径给 NapCat（同一台机器，最快）
    const localPath = localPathOf(file)
    if (!localPath) throw new Error('缺少文件路径')
    const action = target === 'group' ? 'upload_group_file' : 'upload_private_file'
    const params = {
      [target === 'group' ? 'group_id' : 'user_id']: id,
      file: localPath,
      name: label || basename(localPath),
    }
    if (target === 'group' && folder) params.folder = String(folder)
    return gateway.call(action, params, UPLOAD_TIMEOUT_MS)
  }

  async function sendFilePrivate({ userId, file, name } = {}) {
    return sendFile({ scene: 'private', peerId: userId, file, name })
  }

  async function sendFileGroup({ groupId, file, name, folder } = {}) {
    return sendFile({ scene: 'group', peerId: groupId, file, name, folder })
  }

  /** 禁言。duration 单位秒；0 = 解除禁言。缺省给 10 分钟，免得误调成永封。 */
  async function ban(groupId, userId, durationSec = 600) {
    const seconds = Number(durationSec)
    return gateway.call('set_group_ban', {
      group_id: targetId(groupId, '群号'),
      user_id: targetId(userId, 'QQ 号'),
      duration: Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 600,
    })
  }

  async function kick(groupId, userId, rejectAddRequest = false) {
    return gateway.call('set_group_kick', {
      group_id: targetId(groupId, '群号'),
      user_id: targetId(userId, 'QQ 号'),
      reject_add_request: Boolean(rejectAddRequest),
    })
  }

  async function recall(messageId) {
    return gateway.call('delete_msg', { message_id: targetId(messageId, 'messageId') })
  }

  async function getGroupList() {
    return gateway.call('get_group_list')
  }

  async function getGroupMembers(groupId) {
    return gateway.call('get_group_member_list', { group_id: targetId(groupId, '群号') })
  }

  async function getGroupHistory(groupId, count = 20) {
    return gateway.call('get_group_msg_history', {
      group_id: targetId(groupId, '群号'),
      count: Math.max(1, Math.round(Number(count) || 20)),
    })
  }

  async function getFriendList() {
    return gateway.call('get_friend_list')
  }

  async function friendRequest(flag, approve = true, remark = '') {
    return gateway.call('set_friend_add_request', {
      flag: String(flag ?? ''),
      approve: Boolean(approve),
      remark: String(remark ?? ''),
    })
  }

  /**
   * 处理群请求。
   *
   * 契约里只写了 (flag, approve, reason)，但 OneBot 11 的 set_group_add_request
   * 必须带 `sub_type`（add=加群邀请 / invite=别人拉我进群），缺了 NapCat 直接报参数错。
   * 所以这里加了第四个可选参数，默认 'add'，不破坏契约的调用方式。
   */
  async function groupRequest(flag, approve = true, reason = '', subType = 'add') {
    return gateway.call('set_group_add_request', {
      flag: String(flag ?? ''),
      sub_type: subType === 'invite' ? 'invite' : 'add',
      approve: Boolean(approve),
      reason: String(reason ?? ''),
    })
  }

  return {
    sendPrivate,
    sendGroup,
    sendFile,
    sendFilePrivate,
    sendFileGroup,
    ban,
    kick,
    recall,
    getGroupList,
    getGroupMembers,
    getGroupHistory,
    getFriendList,
    friendRequest,
    groupRequest,
  }
}
