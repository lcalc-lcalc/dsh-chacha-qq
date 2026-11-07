/**
 * 入站探针：旁听 NapCat 的 WebSocket，看它到底有没有把消息上报出来。
 *
 * 用它来区分两种完全不同的故障：
 *   A. 探针收到了、但 DSH 的 recent 是空的  → 问题在 DSH 那边（gateway 没转 / pipeline 丢了）
 *   B. 探针也收不到                        → 问题在 NapCat 那边（没上报 / QQ 没连线）
 *
 * OneBot 11 的 WS 服务端通常**广播**给所有客户端，所以这个旁听连接不会抢走 DSH 的消息。
 *
 * 跑法：node scripts/probe-inbound.mjs [秒数]
 * 跑起来之后，在 QQ 里给茶茶酱发一条消息。
 */
const URL = process.env.NAPCAT_URL || 'ws://127.0.0.1:3001'
const SECONDS = Math.max(5, Number(process.argv[2]) || 60)

let messages = 0
let notices = 0
let ws = null

console.log(`旁听 ${URL}，${SECONDS} 秒。现在请在 QQ 里给茶茶酱发一条消息…`)
console.log('')

try {
  ws = new WebSocket(URL)
} catch (error) {
  console.log(`建连失败：${error?.message ?? error}`)
  process.exit(1)
}

ws.addEventListener('open', () => {
  console.log('✅ 已连上，开始旁听（这个连接不会影响 DSH）')
  console.log('')
})

ws.addEventListener('message', (event) => {
  let payload
  try {
    payload = JSON.parse(String(event.data))
  } catch {
    return
  }

  const type = String(payload?.post_type ?? '')

  if (type === 'message') {
    messages += 1
    const who = payload.group_id ? `群 ${payload.group_id}` : '私聊'
    const from = payload.user_id
    const text = String(payload.raw_message ?? payload.message ?? '').slice(0, 80)
    console.log(`  📨 [消息] ${who} · ${from}：${text}`)
    return
  }

  if (type === 'notice') {
    notices += 1
    console.log(`  🔔 [通知] ${payload.notice_type}/${payload.sub_type ?? ''}`)
    return
  }

  if (type === 'meta_event') {
    // 心跳 / 生命周期只记一条，免得刷屏
    if (payload.meta_event_type === 'lifecycle') {
      console.log(`  ♻️ [生命周期] ${payload.sub_type ?? ''}`)
    }
    return
  }

  if (type === 'message_sent') {
    console.log(`  📤 [自己发出] ${String(payload.raw_message ?? '').slice(0, 60)}`)
  }
})

ws.addEventListener('error', () => {
  console.log('  ⚠️ WebSocket 出错')
})

ws.addEventListener('close', () => {
  console.log('  连接关闭')
})

setTimeout(() => {
  console.log('')
  console.log('=== 结论 ===')
  if (messages > 0) {
    console.log(`✅ 旁听到 ${messages} 条消息 → **NapCat 在上报**，问题在 DSH 那边`)
    console.log('   → 去查 chacha-qq.log 有没有「收到消息」的记录；没有就是 gateway → pipeline 断了')
  } else if (notices > 0) {
    console.log(`⚠️ 收到 ${notices} 条通知，但**一条消息都没有**`)
    console.log('   → NapCat 在推送事件，但消息事件被过滤了（检查 onebot11 配置）')
  } else {
    console.log('❌ 一条消息都没收到')
    console.log('   → 要么你还没发，要么 NapCat 根本不上报消息事件')
    console.log('   → 检查 onebot11_<QQ>.json 的 websocketServers.enable 和 messagePostFormat')
  }
  try {
    ws?.close()
  } catch {
    // ignore
  }
  process.exit(0)
}, SECONDS * 1000)
