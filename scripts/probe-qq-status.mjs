/**
 * NapCat / QQ 状态只读探针。
 *
 * 用途：当「插件连得上 NapCat、NapCat 端口也在听，但收不到也发不出消息」时，
 * 用这个脚本直接问 NapCat「你的 QQ 到底登录着没有」。
 *
 * 为什么需要它：
 *   `retcode=1200 NTEvent ... sendMsg ... Timeout` 这种错有多种可能 ——
 *   QQ 掉线 / 登录态失效 / 号被封 / NT 内核卡死。光看插件日志分不清，
 *   只能问 NapCat 自己。
 *
 * 只读：只发 get_login_info / get_status，不发消息、不改任何东西。
 * 跑法：node scripts/probe-qq-status.mjs
 */
const URL = process.env.NAPCAT_URL || 'ws://127.0.0.1:3001'
const TIMEOUT_MS = 6000

const got = new Map()
let opened = false
let ws = null

function done(code = 0) {
  try {
    ws?.close()
  } catch {
    // ignore
  }
  report()
  process.exitCode = code
}

function report() {
  console.log('')
  console.log('=== 结论 ===')
  if (!opened) {
    console.log('❌ 连不上 NapCat 的 WebSocket')
    console.log('   → NapCat 可能没在跑，或者端口不是 3001')
    return
  }

  const login = got.get('login')
  const status = got.get('status')

  if (!login) {
    console.log('❌ get_login_info 没回来（超时或被拒）')
    console.log('   → QQ 大概率**没登录**：掉线 / 登录态失效 / 号被封')
    console.log('   → 修复：重启 NapCat（杀进程后重新拉起，可能需要扫码）')
  } else {
    const uid = login.data?.user_id
    const nick = login.data?.nickname
    const ok = Number(uid) > 0
    console.log(ok ? `✅ QQ 已登录：${uid}（${nick}）` : '❌ get_login_info 返回了空号')
    if (!ok) console.log('   → 仍是未登录状态')
  }

  if (status) {
    console.log(`   get_status: ${JSON.stringify(status.data ?? status)}`)
  } else {
    console.log('   get_status: （没回来）')
  }

  console.log('')
  if (login?.data?.user_id) {
    console.log('⚠️ 如果 QQ 显示已登录、但发消息仍然 retcode=1200 超时：')
    console.log('   那是 NT 内核卡死（常见于长时间不重启），重启 NapCat 也能解。')
  }
}

try {
  ws = new WebSocket(URL)
} catch (error) {
  console.log(`建连失败：${error?.message ?? error}`)
  process.exit(1)
}

const timer = setTimeout(() => {
  console.log(`（${TIMEOUT_MS}ms 超时，收尾）`)
  done(0)
}, TIMEOUT_MS)

ws.addEventListener('open', () => {
  opened = true
  console.log(`已连上 ${URL}`)
  ws.send(JSON.stringify({ action: 'get_login_info', echo: 'login' }))
  ws.send(JSON.stringify({ action: 'get_status', echo: 'status' }))
})

ws.addEventListener('message', (event) => {
  let payload
  try {
    payload = JSON.parse(String(event.data))
  } catch {
    return
  }
  if (payload?.echo === 'login') got.set('login', payload)
  if (payload?.echo === 'status') got.set('status', payload)
  console.log(`← ${String(event.data).slice(0, 300)}`)
  if (got.has('login') && got.has('status')) {
    clearTimeout(timer)
    done(0)
  }
})

ws.addEventListener('error', (event) => {
  console.log(`WebSocket 错误：${event?.message ?? '(无详情)'}`)
})

ws.addEventListener('close', () => {
  if (opened && got.size === 0) console.log('连接被 NapCat 关闭了')
  clearTimeout(timer)
  done(0)
})
