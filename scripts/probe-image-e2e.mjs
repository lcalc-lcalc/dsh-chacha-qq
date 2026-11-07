/**
 * 图片出站探针：验证「表情包系统产出的 image 段」能被 L1 转成 NapCat 认的格式。
 *
 * 这条链是刚接上的，而且是个真实缺口：
 *   meme 产出 `{ type:'image', data:{ path:'C:\\...\\开心.gif' } }`
 *   → 如果 L1 原样发给 NapCat，它会拿这个路径去 QQ 服务器找，报「文件不存在」。
 *   → 必须在 L1 转成 `base64://`（v2 踩过的坑）。
 *
 * 跑法：node scripts/probe-image-e2e.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createQqApi } from '../src/napcat/api.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chacha-img-'))

// 写一个最小的合法 GIF（1×1 透明），不用真的表情包
const gifPath = path.join(dir, '开心_眯眼笑.gif')
fs.writeFileSync(
  gifPath,
  Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
)

const calls = []
const gateway = {
  selfId: '1000000001',
  connected: true,
  async call(action, params) {
    calls.push({ action, params })
    return { ok: true, data: { message_id: 1 } }
  },
}

const api = createQqApi(gateway)

let failures = 0
function assert(name, condition, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures += 1
}

// ① 带本机路径的 image 段（表情包系统的产出形状）
await api.sendGroup('999', [
  { type: 'text', data: { text: '主人早安呀 ' } },
  { type: 'image', data: { path: gifPath } },
  { type: 'text', data: { text: ' 今天也要开心哦' } },
])

const groupSegments = calls.at(-1)?.params?.message ?? []
const imageSegment = groupSegments.find((segment) => segment.type === 'image')
const fileRef = String(imageSegment?.data?.file ?? '')

assert('群聊：文字段还在', groupSegments.filter((s) => s.type === 'text').length === 2, `共 ${groupSegments.length} 段`)
assert('群聊：image 段存在', Boolean(imageSegment))
assert('群聊：path 被转成了 base64://', fileRef.startsWith('base64://'), fileRef.slice(0, 24))
assert('群聊：没有残留 path 字段', !imageSegment?.data?.path)

// ② 已经是 base64:// 的段不能被二次转码
await api.sendGroup('999', [{ type: 'image', data: { file: 'base64://AAAA' } }])
const passthrough = calls.at(-1)?.params?.message?.[0]?.data?.file
assert('已经是 base64 的原样放行', passthrough === 'base64://AAAA', String(passthrough))

// ③ 文件读不到时不能把整条消息搞丢
await api.sendPrivate('1111111111', [
  { type: 'image', data: { path: path.join(dir, '根本不存在.gif') } },
  { type: 'text', data: { text: '后面这句还得发出去' } },
])
const fallbackSegments = calls.at(-1)?.params?.message ?? []
const stillHasText = fallbackSegments.some(
  (segment) => segment.type === 'text' && String(segment.data?.text ?? '').includes('后面这句'),
)
assert('私聊：坏图降级成文字提示，后面的段照发', stillHasText, JSON.stringify(fallbackSegments.map((s) => s.type)))

fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '✅ 图片出站链路正常' : `❌ ${failures} 项异常`}\n`)
if (failures > 0) process.exitCode = 1
