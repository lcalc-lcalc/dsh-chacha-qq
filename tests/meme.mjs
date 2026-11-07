/**
 * 表情包系统测试：存储（文件即分类）+ 句内渲染（&&类别&&）+ 盗图（概率闸/视觉/去重）。
 *
 * 铁律（跟其他套件一致）：
 *   · 所有文件操作都在系统临时目录里（fs.mkdtempSync），测完删干净 —— **绝不碰真实 data 目录**；
 *   · 不碰网络：下载用注入的假 fetch，视觉判断用注入的假函数；
 *   · rng / now 全部注入，测试可复现（不用 Math.random）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { group, check, ok, notOk, throws, rejects, report } from './harness.mjs'

import {
  DEFAULT_MEME_CONFIG,
  IMAGE_EXTS,
  MEME_CATEGORIES,
  MemeStore,
  normalizeExt,
  readMemeConfig,
  sanitizeFileNameBase,
  sha256Of,
  sniffImageExt,
} from '../src/controller/meme/store.js'
import {
  buildSegments,
  extractTags,
  splitSegmentPlan,
  splitThinking,
  stripResidualMarkers,
} from '../src/controller/meme/render.js'
import { StealGate, fixTencentCdnUrl, peerKeyOf } from '../src/controller/meme/steal.js'
import { MemeSystem } from '../src/controller/meme/index.js'

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }

/* ── 临时目录 ────────────────────────────────────────────────── */

const TEMP_DIRS = []
function tempDir(prefix = 'chacha-meme-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录删不掉不影响测试结论
    }
  }
})

/* ── 素材 ────────────────────────────────────────────────────── */

/** 造一张「文件头合法」的假 PNG（内容随便，格式嗅探只看前 8 字节）。 */
function pngBytes(size = 5000, seed = 1) {
  const buffer = Buffer.alloc(size)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  for (let index = 8; index < size; index += 1) buffer[index] = (index + seed) % 251
  return buffer
}

function gifBytes(size = 5000, seed = 3) {
  const buffer = Buffer.alloc(size)
  buffer.write('GIF89a', 0, 'ascii')
  for (let index = 6; index < size; index += 1) buffer[index] = (index * seed) % 251
  return buffer
}

/** 按顺序吐值的 rng：测试里「第一次掷概率、第二次掷混排、第三次抽图」这类顺序要钉死。 */
function seqRng(values, fallback = 0.5) {
  let index = 0
  return () => (index < values.length ? values[index++] : fallback)
}

/** 假 store：只提供 pick（render 只需要这个）。 */
function fakeStore(paths) {
  return {
    pick(category) {
      const found = paths[category]
      return found ? { path: found, name: path.basename(found) } : null
    },
  }
}

/** 造一个类 fetch 的 Response（够 StealGate 用：ok/status/headers.get/arrayBuffer）。 */
function makeResponse(buffer, { status = 200, headers = {} } = {}) {
  const normalized = {}
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized[String(name).toLowerCase()] ?? null },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
  }
}

/** 带一张图的群消息。 */
function imageMessage(overrides = {}) {
  return {
    id: 'msg-1',
    scene: 'group',
    groupId: '123456',
    peerId: '123456',
    userId: '111',
    media: [{ kind: 'image', url: 'http://example.com/a.gif', name: 'a.gif', fileId: 'file-1' }],
    ...overrides,
  }
}

/* ══════════════════════════════════════════════════════════════
 * 一、配置默认值（键在这里定下来）
 * ══════════════════════════════════════════════════════════════ */
group('配置：模块内默认值')

check('概率总闸默认 0.5', DEFAULT_MEME_CONFIG.probability, 0.5)
check('单条上限默认 2', DEFAULT_MEME_CONFIG.maxPerMessage, 2)
check('混排率默认 0.5', DEFAULT_MEME_CONFIG.inlineProbability, 0.5)
check('类别冷却默认 120000ms', DEFAULT_MEME_CONFIG.cooldownMs, 120000)
check('盗图概率默认 0.15', DEFAULT_MEME_CONFIG.steal.probability, 0.15)
check('盗图最小字节 4096', DEFAULT_MEME_CONFIG.steal.minBytes, 4096)
check('盗图最大字节 2MB', DEFAULT_MEME_CONFIG.steal.maxBytes, 2 * 1024 * 1024)
check('盗图扩展名白名单', DEFAULT_MEME_CONFIG.steal.allowedExt, ['gif', 'png', 'jpg', 'jpeg', 'webp'])
check('盗图 peers 默认空对象', DEFAULT_MEME_CONFIG.steal.peers, {})

group('配置：缺键兜底与越界钳制')

check('空配置全套默认值', readMemeConfig({}).probability, 0.5)
check('meme 段部分覆盖', readMemeConfig({ meme: { probability: 0.2 } }).probability, 0.2)
check('未覆盖的键仍走默认', readMemeConfig({ meme: { probability: 0.2 } }).maxPerMessage, 2)
check('直传 meme 子配置也认', readMemeConfig({ probability: 0.3 }).probability, 0.3)
check('概率 >1 钳到 1', readMemeConfig({ meme: { probability: 5 } }).probability, 1)
check('概率 <0 钳到 0', readMemeConfig({ meme: { probability: -3 } }).probability, 0)
check('概率非数字回默认', readMemeConfig({ meme: { probability: 'abc' } }).probability, 0.5)
check('单条上限取整', readMemeConfig({ meme: { maxPerMessage: 2.9 } }).maxPerMessage, 2)
check('盗图 peers 保留', readMemeConfig({ meme: { steal: { peers: { 'group-123456': 0.3 } } } }).steal.peers['group-123456'], 0.3)
check('非法扩展名被过滤', readMemeConfig({ meme: { steal: { allowedExt: ['gif', 'exe', 'png'] } } }).steal.allowedExt, ['gif', 'png'])
check('allowedExt 传空回默认', readMemeConfig({ meme: { steal: { allowedExt: [] } } }).steal.allowedExt, ['gif', 'png', 'jpg', 'jpeg', 'webp'])
check('jpg 自动补 jpeg', readMemeConfig({ meme: { steal: { allowedExt: ['jpg'] } } }).steal.allowedExt, ['jpg', 'jpeg'])

/* ══════════════════════════════════════════════════════════════
 * 二、类别骨架（hint 写「什么时候用」）
 * ══════════════════════════════════════════════════════════════ */
group('类别骨架')

ok('类别数在 6~8 之间', MEME_CATEGORIES.length >= 6 && MEME_CATEGORIES.length <= 8,
  String(MEME_CATEGORIES.length))

const skeletonKeys = MEME_CATEGORIES.map((item) => item.key)
check('骨架 key 不重复', skeletonKeys.length, new Set(skeletonKeys).size)
for (const required of ['happy', 'sad', 'angry', 'shocked', 'speechless', 'hug']) {
  ok(`骨架包含 ${required}`, skeletonKeys.includes(required), skeletonKeys.join(','))
}
ok('每个类别都有中文名', MEME_CATEGORIES.every((item) => item.name && item.name.length > 0))
ok('每个类别都有使用场景 hint', MEME_CATEGORIES.every((item) => item.hint && item.hint.length >= 8))
ok('hint 写的是「什么时候用」（都带「时使用」）',
  MEME_CATEGORIES.every((item) => item.hint.includes('时使用')),
  MEME_CATEGORIES.map((item) => `${item.key}:${item.hint}`).join(' | '))

group('类别列表：骨架 + 磁盘合并')

{
  const store = new MemeStore({ dataDir: tempDir('chacha-meme-cat-'), log: SILENT })
  const categories = store.listCategories()
  check('空库也返回完整骨架', categories.length, MEME_CATEGORIES.length)
  check('空库 count 全是 0', categories.every((item) => item.count === 0), true)
  check('happy 的中文名', categories.find((item) => item.key === 'happy').name, '开心')
  ok('happy 的 hint 是场景描述', categories.find((item) => item.key === 'happy').hint.includes('时使用'))
}

{
  const dir = tempDir('chacha-meme-cat2-')
  const store = new MemeStore({ dataDir: dir, log: SILENT })
  fs.mkdirSync(path.join(dir, 'memes', 'custom'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'memes', 'custom', '自定义.gif'), gifBytes(200))
  const categories = store.listCategories()
  const custom = categories.find((item) => item.key === 'custom')
  ok('磁盘上手建的类别会出现', Boolean(custom), JSON.stringify(categories.map((item) => item.key)))
  check('手建类别的张数', custom?.count, 1)
}

{
  const dir = tempDir('chacha-meme-cat3-')
  fs.mkdirSync(path.join(dir, 'memes'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'memes', '_catalog.json'),
    JSON.stringify({ categories: { happy: { name: '开森', hint: '主人开心时用' } } }),
    'utf8',
  )
  const store = new MemeStore({ dataDir: dir, log: SILENT })
  const happy = store.listCategories().find((item) => item.key === 'happy')
  check('catalog 里手改的 name 生效', happy.name, '开森')
  check('catalog 里手改的 hint 生效', happy.hint, '主人开心时用')
}

/* ══════════════════════════════════════════════════════════════
 * 三、pick：类别内随机抽一张（这就是全部「检索」）
 * ══════════════════════════════════════════════════════════════ */
group('pick')

{
  const dir = tempDir('chacha-meme-pick-')
  const store = new MemeStore({ dataDir: dir, log: SILENT })
  const happyDir = path.join(dir, 'memes', 'happy')
  fs.mkdirSync(happyDir, { recursive: true })
  fs.writeFileSync(path.join(happyDir, 'a.gif'), gifBytes(300))
  fs.writeFileSync(path.join(happyDir, 'b.png'), pngBytes(300))
  fs.writeFileSync(path.join(happyDir, 'c.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(300)]))

  check('空类别返回 null', store.pick('sad', { rng: () => 0 }), null)
  check('未知类别返回 null', store.pick('不存在', { rng: () => 0 }), null)

  const first = store.pick('happy', { rng: () => 0 })
  const last = store.pick('happy', { rng: () => 0.99 })
  check('rng=0 抽第一张', path.basename(first.path), 'a.gif')
  check('rng=0.99 抽最后一张', path.basename(last.path), 'c.webp')
  check('返回的是本机绝对路径', path.isAbsolute(first.path), true)
  check('抽到的文件真的存在', fs.existsSync(first.path), true)
  check('返回类别', first.category, 'happy')
  check('空目录里的隐藏文件/元数据不算图', (() => {
    fs.writeFileSync(path.join(happyDir, '_catalog.json'), '{}')
    fs.writeFileSync(path.join(happyDir, 'note.txt'), 'x')
    return store.listFiles('happy').length
  })(), 3)
  const seededA = store.pick('happy', { rng: seqRng([0.1]) })
  const seededB = store.pick('happy', { rng: seqRng([0.1]) })
  check('注入 rng 后结果可复现', path.basename(seededA.path), path.basename(seededB.path))
}

/* ══════════════════════════════════════════════════════════════
 * 四、extractTags：严格识别 + 思考区保护 + 超上限丢弃
 * ══════════════════════════════════════════════════════════════ */
group('extractTags')

{
  const result = extractTags('主人早安呀 &&happy&& 今天也要开心哦', { maxTags: 2, validCategories: ['happy'] })
  check('抽出一个类别', result.tags, ['happy'])
  notOk('清洗后不含 &&', result.cleaned.includes('&&'), result.cleaned)
  ok('清洗后正文完整', result.cleaned.includes('主人早安呀') && result.cleaned.includes('今天也要开心哦'))
  check('记录了标记位置（已清洗正文坐标）', result.positions, [6])
}

{
  const result = extractTags('&&happy&& &&sad&& &&angry&&', { maxTags: 2, validCategories: ['happy', 'sad', 'angry'] })
  check('超过 maxTags 的丢弃', result.tags, ['happy', 'sad'])
  notOk('超上限的标记也从正文删掉', result.cleaned.includes('&&'), result.cleaned)
  check('positions 与 tags 等长', result.positions.length, result.tags.length)
}

{
  const result = extractTags('好耶 &&dance&&', { maxTags: 2, validCategories: ['happy'] })
  check('非法类别不认', result.tags, [])
  notOk('非法类别标记也要清掉（不能漏给用户）', result.cleaned.includes('&&'), result.cleaned)
}

{
  const result = extractTags('&&HAPPY&&', { maxTags: 2, validCategories: ['happy'] })
  check('类别大小写不敏感（统一小写）', result.tags, ['happy'])
}

{
  const result = extractTags('&&dance&&', { maxTags: 2, validCategories: [] })
  check('validCategories 为空 = 凡是严格格式都认', result.tags, ['dance'])
}

{
  const result = extractTags('&&happy &&', { maxTags: 2, validCategories: ['happy'] })
  check('严格格式：类别里带空格不认', result.tags, [])
  notOk('带空格的不合格标记照样清掉', result.cleaned.includes('&&'), result.cleaned)
}

{
  const result = extractTags(
    '<thinking>这里用 &&happy&& 举例就好</thinking>其实我很开心 &&happy&&',
    { maxTags: 2, validCategories: ['happy'] },
  )
  check('<thinking> 里的标记不算', result.tags, ['happy'])
  notOk('思考内容不进正文', result.cleaned.includes('举例'), result.cleaned)
  notOk('正文不含 &&', result.cleaned.includes('&&'), result.cleaned)
  check('hadThinking 标记', result.hadThinking, true)
}

{
  const result = extractTags('<thinking>&&happy&& 她还在想', { maxTags: 2, validCategories: ['happy'] })
  check('未闭合的 <thinking>：后面全算思考', result.tags, [])
  check('未闭合时正文为空', result.cleaned.trim(), '')
}

{
  const result = extractTags('今天天气不错', { maxTags: 2 })
  check('没有标记时 tags 为空', result.tags, [])
  check('没有标记时正文不变', result.cleaned, '今天天气不错')
  check('没有标记时 positions 为空', result.positions, [])
}

{
  const result = extractTags('&&happy&& &&sad&&', { maxTags: 0, validCategories: ['happy', 'sad'] })
  check('maxTags=0 一张都不要', result.tags, [])
  notOk('maxTags=0 时标记仍然清干净', result.cleaned.includes('&&'), result.cleaned.trim())
}

group('splitThinking')

{
  check('普通文本原样返回', splitThinking('你好').body, '你好')
  check('普通文本没有思考', splitThinking('你好').hadThinking, false)
  const split = splitThinking('正文A<thinking>想一会儿</thinking>正文B')
  check('思考区被切走', split.body, '正文A正文B')
  check('思考片段留存（排错用）', split.thinking.length, 1)
}

/* ══════════════════════════════════════════════════════════════
 * 五、stripResidualMarkers：兜底清理（任何路径都不能漏 &&）
 * ══════════════════════════════════════════════════════════════ */
group('stripResidualMarkers')

check('成对标记清掉', stripResidualMarkers('a &&happy&& b'), 'a b')
check('落单 && 清掉', stripResidualMarkers('a && b'), 'a b')
check('单个 & 不动（正常文字）', stripResidualMarkers('A & B'), 'A & B')
check('& & 也清掉', stripResidualMarkers('x & & y'), 'x y')
check('只有标记 → 空串', stripResidualMarkers('&&happy&&'), '')
check('连续标记一起清', stripResidualMarkers('x&&happy&&&&sad&&y'), 'xy')
check('标点前空格清理', stripResidualMarkers('好 ！'), '好！')
check('多余空行压缩', stripResidualMarkers('a\n\n\n\nb'), 'a\n\nb')
check('标记删掉后的双空格合并', stripResidualMarkers('早安 &&happy&& 呀'), '早安 呀')

/* ══════════════════════════════════════════════════════════════
 * 六、buildSegments：图文混排 + 抽不到图退回纯文本
 * ══════════════════════════════════════════════════════════════ */
group('buildSegments：混排两种结果')

const FAKE_IMAGE = path.join(os.tmpdir(), 'fake-memes', 'happy', '眯眼笑.gif')

{
  // 有标记位置（门面会传）：图插在原来标记的位置
  const extracted = extractTags('AB&&happy&&CD', { maxTags: 2, validCategories: ['happy'] })
  const segments = buildSegments(extracted.cleaned, ['happy'], fakeStore({ happy: FAKE_IMAGE }), {
    inlineProbability: 1,
    rng: () => 0.1,
    positions: extracted.positions,
  })
  check('混排段数 = 文字/图/文字', segments.length, 3)
  check('第一段是文字', segments[0].data.text, 'AB')
  check('第二段是图', segments[1].data.path, FAKE_IMAGE)
  check('第三段是文字', segments[2].data.text, 'CD')
  check('混排的图不带 trailing', segments[1].trailing ?? false, false)
}

{
  // 没有位置：按自然边界切
  const segments = buildSegments('主人早安呀 今天也要开心哦', ['happy'], fakeStore({ happy: FAKE_IMAGE }), {
    inlineProbability: 1,
    rng: () => 0.1,
  })
  check('自然切分后仍是文字/图/文字', segments.map((item) => item.type), ['text', 'image', 'text'])
  check('图夹在两句之间', segments[1].data.path, FAKE_IMAGE)
  ok('第一段文字在标记前', segments[0].data.text.includes('主人早安呀'), segments[0].data.text)
  ok('最后一段文字在标记后', segments[2].data.text.includes('今天也要开心哦'), segments[2].data.text)
}

{
  const segments = buildSegments('随便说点什么', ['happy'], fakeStore({ happy: FAKE_IMAGE }), {
    inlineProbability: 0,
    rng: () => 0.1,
  })
  check('混排率不通过：文字在前', segments[0].data.text, '随便说点什么')
  check('混排率不通过：图在最后', segments[1].type, 'image')
  check('图带 trailing 标记交给调用方', segments[1].trailing, true)
}

{
  const segments = buildSegments('文字', ['happy'], fakeStore({ happy: FAKE_IMAGE }), {
    inlineProbability: 0.5,
    rng: () => 0.9,
  })
  check('rng 高于混排率 → 走末尾单独发', segments[1].trailing, true)
}

{
  const segments = buildSegments('文字', ['happy'], fakeStore({ happy: FAKE_IMAGE }), {
    inlineProbability: 0.5,
    rng: () => Number.NaN,
  })
  check('rng 异常按 0.5 处理（偏保守，走末尾）', segments[1].trailing, true)
}

group('buildSegments：兜底路径')

{
  const segments = buildSegments('a &&happy&& b', ['happy'], null, { inlineProbability: 1, rng: () => 0 })
  check('没有图库 → 退回纯文本一段', segments.length, 1)
  check('退回纯文本时标记已清', segments[0].data.text, 'a b')
}

{
  const segments = buildSegments('随便', ['sad'], fakeStore({ happy: FAKE_IMAGE }), { inlineProbability: 1, rng: () => 0 })
  check('类别空 → 退回纯文本', segments.map((item) => item.type), ['text'])
}

{
  const segments = buildSegments('', ['happy'], fakeStore({ happy: FAKE_IMAGE }), { inlineProbability: 1, rng: () => 0 })
  check('正文只有标记 → 只发图', segments.map((item) => item.type), ['image'])
  check('只发图时也不带 trailing（属于混排）', segments[0].trailing ?? false, false)
}

{
  const segments = buildSegments('好', ['happy', 'sad'], fakeStore({ happy: FAKE_IMAGE, sad: FAKE_IMAGE }), {
    inlineProbability: 1,
    rng: () => 0,
  })
  check('文本段比图少也一张不丢', segments.filter((item) => item.type === 'image').length, 2)
  check('短文本不被劈成单字', segments[0].data.text, '好')
}

{
  const segments = buildSegments('😀😀😀😀', ['happy'], fakeStore({ happy: FAKE_IMAGE }), {
    inlineProbability: 1,
    rng: () => 0,
  })
  const texts = segments.filter((item) => item.type === 'text').map((item) => item.data.text)
  check('emoji 不会被劈开', texts.join(''), '😀😀😀😀')
  ok('每段都是完整的码点', texts.every((text) => !/[\uD800-\uDBFF]$/.test(text)), JSON.stringify(texts))
}

{
  const segments = buildSegments('第一句。第二句。第三句。', ['happy', 'sad'], fakeStore({ happy: FAKE_IMAGE, sad: FAKE_IMAGE }), {
    inlineProbability: 1,
    rng: () => 0,
  })
  check('按句末标点切三段', segments.filter((item) => item.type === 'text').length, 3)
  check('图插在段间', segments.filter((item) => item.type === 'image').length, 2)
}

{
  const segments = buildSegments('a &&happy&& b', ['happy'], fakeStore({ happy: FAKE_IMAGE }), {
    inlineProbability: 0,
    rng: () => 0.9,
  })
  const texts = segments.filter((item) => item.type === 'text').map((item) => item.data.text)
  notOk('trailing 路径也不漏 &&', texts.join('').includes('&&'), texts.join(''))
}

group('splitSegmentPlan')

{
  const plan = splitSegmentPlan([
    { type: 'text', data: { text: 'a' } },
    { type: 'image', data: { path: 'x' }, trailing: true },
  ])
  check('拆出文字段', plan.texts.length, 1)
  check('拆出图段', plan.images.length, 1)
  check('有 trailing 标记', plan.hasTrailing, true)
}

/* ══════════════════════════════════════════════════════════════
 * 七、ingest：去重 / 同名补序号 / 文件名清洗
 * ══════════════════════════════════════════════════════════════ */
group('ingest：落盘与 catalog')

{
  const dir = tempDir('chacha-meme-ingest-')
  const store = new MemeStore({ dataDir: dir, log: SILENT, now: () => 1700000000000 })
  const buffer = pngBytes(5000)
  const result = await store.ingest({ buffer, ext: 'png', description: '眯眼笑_竖大拇指', category: 'happy' })

  check('入库返回 deduped=false', result.deduped, false)
  check('文件名 = 描述.png', path.basename(result.path), '眯眼笑_竖大拇指.png')
  check('文件真的落盘', fs.existsSync(result.path), true)
  check('catalog 自动创建', fs.existsSync(store.catalogPath), true)

  const catalog = JSON.parse(fs.readFileSync(store.catalogPath, 'utf8'))
  check('catalog 记录 sha256', catalog.memes['happy/眯眼笑_竖大拇指.png'].sha256, sha256Of(buffer))
  check('catalog 记录类别', catalog.memes['happy/眯眼笑_竖大拇指.png'].category, 'happy')
  check('catalog 记录字节数', catalog.memes['happy/眯眼笑_竖大拇指.png'].bytes, 5000)
  ok('catalog 记录内容描述', catalog.memes['happy/眯眼笑_竖大拇指.png'].description.includes('眯眼笑'))
  check('catalog 记录中文类别名', catalog.categories.happy.name, '开心')
  ok('catalog 记录类别使用场景', catalog.categories.happy.hint.includes('时使用'))

  const second = await store.ingest({ buffer, ext: 'png', description: '完全不同的描述', category: 'sad' })
  check('同内容第二次 deduped=true', second.deduped, true)
  check('同内容去重后路径相同', second.path, result.path)
  check('同内容去重后不产生第二个文件', store.listFiles('sad').length, 0)
}

group('ingest：同名补序号与文件名清洗')

{
  const dir = tempDir('chacha-meme-names-')
  const store = new MemeStore({ dataDir: dir, log: SILENT })
  const first = await store.ingest({ buffer: pngBytes(5000, 1), ext: 'png', description: '猫猫', category: 'happy' })
  const second = await store.ingest({ buffer: pngBytes(5000, 2), ext: 'png', description: '猫猫', category: 'happy' })
  const third = await store.ingest({ buffer: pngBytes(5000, 3), ext: 'png', description: '猫猫', category: 'happy' })
  check('第一张原名', path.basename(first.path), '猫猫.png')
  check('同名补 _2', path.basename(second.path), '猫猫_2.png')
  check('同名补 _3', path.basename(third.path), '猫猫_3.png')
  check('同名文件都在', store.listFiles('happy').length, 3)
}

{
  const store = new MemeStore({ dataDir: tempDir('chacha-meme-sanitize-'), log: SILENT })
  check('去掉 Windows 非法字符', sanitizeFileNameBase('眯眼笑/竖大拇指'), '眯眼笑竖大拇指')
  check('去掉引号等符号', sanitizeFileNameBase('a:b*c?"d"<e>|f'), 'abcdef')
  check('空白变下划线', sanitizeFileNameBase('猫 猫 震惊'), '猫_猫_震惊')
  check('英文中文都允许', sanitizeFileNameBase('cat_笑_666'), 'cat_笑_666')
  check('首尾点横线下划线去掉', sanitizeFileNameBase('.._笑_.'), '笑')
  check('Windows 保留名加前缀', sanitizeFileNameBase('CON'), '_CON')
  const long = sanitizeFileNameBase('很长的描述'.repeat(100))
  ok('超长描述被限长（<=40 字符）', [...long].length <= 40, String([...long].length))
  check('空描述清洗后为空（由调用方兜底）', sanitizeFileNameBase('///'), '')

  const emptyDesc = await store.ingest({ buffer: pngBytes(5000, 9), ext: 'png', description: '///', category: 'happy' })
  ok('空描述兜底成「表情_时间戳」', path.basename(emptyDesc.path).startsWith('表情_'), path.basename(emptyDesc.path))
}

group('ingest：格式与扩展名')

{
  const store = new MemeStore({ dataDir: tempDir('chacha-meme-ext-'), log: SILENT })
  check('sniff PNG', sniffImageExt(pngBytes(64)), 'png')
  check('sniff GIF', sniffImageExt(gifBytes(64)), 'gif')
  check('sniff 非图片', sniffImageExt(Buffer.from('hello world 1234567')), '')
  check('扩展名归一化 jpe→jpg', normalizeExt('JPE'), 'jpg')
  check('扩展名归一化去点', normalizeExt('.PNG'), 'png')

  // URL 经常给假扩展名；以文件头为准
  const result = await store.ingest({ buffer: pngBytes(5000, 4), ext: 'gif', description: '其实是png', category: 'happy' })
  check('文件头优先：假 gif 存成 png', path.extname(result.path), '.png')

  await rejects('不支持的内容 + 非法扩展名要报错', () =>
    store.ingest({ buffer: Buffer.from('not an image at all'), ext: 'txt', description: 'x', category: 'happy' }),
  )
  await rejects('空 buffer 要报错', () => store.ingest({ buffer: Buffer.alloc(0), ext: 'png', description: 'x', category: 'happy' }))
}

group('ingest：类别归一化与统计')

{
  const dir = tempDir('chacha-meme-cat-norm-')
  const store = new MemeStore({ dataDir: dir, log: SILENT })
  const happy = await store.ingest({ buffer: pngBytes(5000, 5), ext: 'png', description: '笑', category: '开心' })
  check('中文类别名映射到 key', happy.category, 'happy')

  const weird = await store.ingest({ buffer: pngBytes(5000, 6), ext: 'png', description: '怪', category: 'garbage name!!' })
  check('非法类别落到 other', weird.category, 'other')

  const custom = await store.ingest({ buffer: pngBytes(5000, 7), ext: 'png', description: '新类', category: 'meme_custom' })
  check('ingest 允许建新类别（allowNew）', custom.category, 'meme_custom')

  const stats = store.stats()
  check('stats: 类别数（骨架 8 + 手建 1）', stats.categories, MEME_CATEGORIES.length + 1)
  check('stats: 总张数', stats.memes, 3)
  ok('stats: 总字节数 > 0', stats.bytes > 0, String(stats.bytes))
  check('stats: 分类计数', stats.byCategory.happy.count, 1)
}

group('ensureDirs 与 dispose')

{
  const dir = tempDir('chacha-meme-ensure-')
  const store = new MemeStore({ dataDir: dir, log: SILENT })
  const result = await store.ensureDirs()
  ok('骨架目录全部创建', result.created.length === MEME_CATEGORIES.length, String(result.created.length))
  ok('首次运行写出 catalog', fs.existsSync(store.catalogPath), store.catalogPath)
  const catalog = JSON.parse(fs.readFileSync(store.catalogPath, 'utf8'))
  ok('catalog 里有类别使用场景', catalog.categories.speechless.hint.includes('时使用'))
  ok('catalog 版本号存在', Number(catalog.version) >= 1, String(catalog.version))

  const second = await store.ensureDirs()
  check('重复 ensureDirs 不再重复 seed', second.seeded, false)
}

{
  const store = new MemeStore({ dataDir: tempDir('chacha-meme-dispose-'), log: SILENT })
  store.dispose()
  store.dispose() // 可重复调用
  ok('dispose 后 pick 返回 null', store.pick('happy', { rng: () => 0 }) === null)
  await rejects('dispose 后 ingest 拒绝', () => store.ingest({ buffer: pngBytes(100), ext: 'png', description: 'x' }), 'dispose')
}

/* ══════════════════════════════════════════════════════════════
 * 八、StealGate：概率 / 覆盖 / 模式 / 视觉 / 尺寸 / 去重 / 清理
 * ══════════════════════════════════════════════════════════════ */
group('peerKeyOf 与腾讯 CDN')

check('群聊 peerKey', peerKeyOf({ scene: 'group', groupId: '123456' }), 'group-123456')
check('私聊 peerKey', peerKeyOf({ scene: 'private', peerId: '1111111111' }), 'private-1111111111')
check('群聊缺 groupId 时用 peerId', peerKeyOf({ scene: 'group', peerId: '777' }), 'group-777')
check('腾讯 CDN https 降 http',
  fixTencentCdnUrl('https://multimedia.nt.qq.com.cn/download?fileid=1'),
  'http://multimedia.nt.qq.com.cn/download?fileid=1')
check('别的 https 不动', fixTencentCdnUrl('https://example.com/a.gif'), 'https://example.com/a.gif')
check('空地址返回空串', fixTencentCdnUrl(''), '')

/**
 * 造一个盗图环境：真 MemeStore + 假 fetch + 假 vision + 注入 rng/now。
 */
function stealEnv({ config = {}, fetchImpl, vision, inbound = null, rng = () => 0 } = {}) {
  const dataDir = tempDir('chacha-meme-steal-')
  const tmpBase = tempDir('chacha-meme-tmp-')
  const store = new MemeStore({ dataDir, log: SILENT })
  const calls = { fetch: [], vision: [] }
  const cfg = config
  const defaultVision = async (filePath) => {
    calls.vision.push(filePath)
    return { ok: true, isMeme: true, description: '猫猫震惊', category: 'shocked' }
  }
  const defaultFetch = async (url) => {
    calls.fetch.push(url)
    return makeResponse(gifBytes(5000))
  }
  const gate = new StealGate({
    store,
    config: cfg,
    log: SILENT,
    vision: vision ?? ((filePath) => defaultVision(filePath)) ,
    inbound,
    rng,
    now: () => 1700000000000,
    fetchImpl: fetchImpl ?? ((url) => defaultFetch(url)),
    tmpDir: tmpBase,
  })
  return { dataDir, tmpBase, store, gate, calls }
}

/** 基础配置：概率 100%，允许所有默认格式。 */
function stealConfig(patch = {}) {
  return {
    modes: { default: 'companion', peers: {} },
    meme: {
      steal: {
        probability: 1,
        minBytes: 4096,
        maxBytes: 2097152,
        allowedExt: ['gif', 'png', 'jpg', 'jpeg', 'webp'],
        ...patch,
      },
    },
  }
}

group('StealGate：零成本与概率闸')

{
  const { gate, calls, store } = stealEnv({
    config: stealConfig(),
    rng: () => {
      calls.rng = (calls.rng ?? 0) + 1
      return 0
    },
  })
  const result = await gate.maybeSteal({ id: 'm', scene: 'group', groupId: '123456', media: [] })
  check('没有图片 → false', result, false)
  check('没有图片时连 rng 都不掷（零成本）', calls.rng ?? 0, 0)
  check('没有图片时没有下载', calls.fetch.length, 0)
  check('计数：skippedNoImage', gate.stats().skippedNoImage, 1)
  check('图库仍是空的', store.stats().memes, 0)
}

{
  const { gate, calls, store } = stealEnv({ config: stealConfig({ probability: 0 }) })
  const result = await gate.maybeSteal(imageMessage())
  check('概率 0 永不盗图', result, false)
  check('概率 0 不下载', calls.fetch.length, 0)
  check('计数：skippedProbability', gate.stats().skippedProbability, 1)
  check('图库仍是空的', store.stats().memes, 0)
}

group('StealGate：成功路径')

{
  const { gate, calls, store, tmpBase } = stealEnv({ config: stealConfig() })
  const result = await gate.maybeSteal(imageMessage())
  check('概率 1 → 盗到', result, true)
  check('下载了一次', calls.fetch.length, 1)
  check('视觉判断了一次', calls.vision.length, 1)
  check('入库一张', store.stats().memes, 1)
  check('按视觉给的类别入库', store.listFiles('shocked').length, 1)
  ok('文件名用了视觉给的描述', fs.readdirSync(path.join(store.root, 'shocked')).some((name) => name.includes('猫猫震惊')))
  check('临时文件用完删干净', fs.readdirSync(tmpBase).length, 0)
  check('计数：stolen', gate.stats().stolen, 1)
}

group('StealGate：peers 按对话覆盖概率')

{
  const config = stealConfig({ probability: 0, peers: { 'group-123456': 1 } })
  const { gate, calls } = stealEnv({ config })
  check('peers 覆盖为 1：这个群盗图', await gate.maybeSteal(imageMessage()), true)
  check('下载发生', calls.fetch.length, 1)

  const other = stealEnv({ config, rng: () => 0 })
  const otherMessage = imageMessage({ groupId: '999', peerId: '999' })
  check('没覆盖的群仍按默认 0 拒绝', await other.gate.maybeSteal(otherMessage), false)
}

group('StealGate：work 模式拒收')

{
  const config = stealConfig()
  config.modes = { default: 'companion', peers: { 'group-123456': 'work' } }
  const { gate, calls } = stealEnv({ config })
  const result = await gate.maybeSteal(imageMessage())
  check('work 模式不盗图', result, false)
  check('work 模式不下载', calls.fetch.length, 0)
  check('计数：skippedMode', gate.stats().skippedMode, 1)
}

group('StealGate：视觉判断')

{
  const { gate, store, tmpBase } = stealEnv({
    config: stealConfig(),
    vision: async () => ({ ok: true, isMeme: false, description: '截图' }),
  })
  check('vision 说不是表情包 → 拒绝', await gate.maybeSteal(imageMessage()), false)
  check('拒绝后不入库', store.stats().memes, 0)
  check('拒绝后临时文件也删掉', fs.readdirSync(tmpBase).length, 0)
  check('计数：visionRejected', gate.stats().visionRejected, 1)
}

{
  const { gate, store } = stealEnv({
    config: stealConfig(),
    vision: async () => ({ ok: false, isMeme: true, description: '看不清' }),
  })
  check('vision 说 ok=false → 拒绝', await gate.maybeSteal(imageMessage()), false)
  check('ok=false 不入库', store.stats().memes, 0)
}

group('StealGate：尺寸/格式过滤')

{
  const { gate, calls } = stealEnv({
    config: stealConfig({ minBytes: 4096 }),
    fetchImpl: async () => makeResponse(gifBytes(1000)),
  })
  check('小于 minBytes → 拒绝', await gate.maybeSteal(imageMessage()), false)
  check('尺寸不合格时不调视觉', calls.vision.length, 0)
  check('计数：failed', gate.stats().failed, 1)
}

{
  const { gate, calls } = stealEnv({
    config: stealConfig({ maxBytes: 4096 }),
    fetchImpl: async () => makeResponse(gifBytes(8000)),
  })
  check('大于 maxBytes → 拒绝', await gate.maybeSteal(imageMessage()), false)
  check('超限时不调视觉', calls.vision.length, 0)
}

{
  const { gate, calls } = stealEnv({ config: stealConfig() })
  const bmpMessage = imageMessage({
    media: [{ kind: 'image', url: 'http://example.com/a.bmp', name: 'a.bmp' }],
  })
  check('扩展名不在白名单 → 拒绝', await gate.maybeSteal(bmpMessage), false)
  check('格式不合格时连下载都不做', calls.fetch.length, 0)
  check('计数：skippedFormat', gate.stats().skippedFormat, 1)
}

group('StealGate：腾讯 CDN 与去重')

{
  const { gate, calls } = stealEnv({ config: stealConfig() })
  const message = imageMessage({
    media: [{ kind: 'image', url: 'https://multimedia.nt.qq.com.cn/download?fileid=abc.gif', name: 'a.gif' }],
  })
  check('腾讯 CDN 图能盗', await gate.maybeSteal(message), true)
  ok('下载时把 https 降成 http', calls.fetch[0].startsWith('http://multimedia.nt.qq.com.cn/'), calls.fetch[0])
}

{
  const { gate, calls, store } = stealEnv({ config: stealConfig() })
  check('第一次收藏', await gate.maybeSteal(imageMessage()), true)
  check('第二次同一张图', await gate.maybeSteal(imageMessage()), true)
  check('去重后图库只有一张', store.stats().memes, 1)
  check('去重后不再浪费视觉调用', calls.vision.length, 1)
  check('计数：deduped', gate.stats().deduped, 1)
}

group('StealGate：下载异常与清理')

{
  const { gate, store } = stealEnv({
    config: stealConfig(),
    fetchImpl: async () => {
      throw new Error('网络炸了')
    },
  })
  check('下载抛错 → false（不拖垮聊天）', await gate.maybeSteal(imageMessage()), false)
  check('下载失败不入库', store.stats().memes, 0)
  check('计数：failed', gate.stats().failed, 1)
}

{
  const { gate, store } = stealEnv({ config: stealConfig(), vision: null })
  // vision 显式置空 → 构造时不注入；这里直接改实例模拟「装配时忘了接视觉」
  gate.vision = null
  check('没有视觉能力 → 不盗图', await gate.maybeSteal(imageMessage()), false)
  check('没有视觉能力不入库', store.stats().memes, 0)
}

{
  const tmpBase = tempDir('chacha-meme-tmp2-')
  const store = new MemeStore({ dataDir: tempDir('chacha-meme-steal2-'), log: SILENT })
  const gate = new StealGate({
    store,
    config: stealConfig(),
    log: SILENT,
    vision: async () => ({ ok: true, isMeme: true, description: 'x', category: 'happy' }),
    rng: () => 0,
    fetchImpl: async () => makeResponse(gifBytes(5000)),
    tmpDir: tmpBase,
  })
  const downloaded = await gate.acquire(
    { url: 'http://example.com/a.gif', ext: 'gif', media: { name: 'a.gif' } },
    readMemeConfig(stealConfig()).steal,
    imageMessage(),
  )
  ok('下载后临时文件存在', downloaded && fs.existsSync(downloaded.path), String(downloaded?.path))
  gate.dispose()
  check('dispose 清掉挂着的临时文件', fs.readdirSync(tmpBase).length, 0)
  gate.dispose() // 可重复调用
}

group('StealGate：复用 inbound 的落盘能力')

{
  const inboundDir = tempDir('chacha-meme-inbound-')
  const inbound = {
    async collect(message) {
      const file = path.join(inboundDir, `${message.id}-0.gif`)
      fs.writeFileSync(file, gifBytes(5000))
      return [{ kind: 'image', url: 'x', path: file, bytes: 5000, failed: false }]
    },
  }
  const { gate, store, calls } = stealEnv({ config: stealConfig(), inbound })
  const result = await gate.maybeSteal(imageMessage())
  check('inbound 路径也能盗到', result, true)
  check('走 inbound 时不自己 fetch', calls.fetch.length, 0)
  check('视觉拿到的是 inbound 落盘的路径', calls.vision.length, 1)
  check('入库一张', store.stats().memes, 1)
  check('inbound 落盘的临时副本用完也删了', fs.readdirSync(inboundDir).length, 0)
}

/* ══════════════════════════════════════════════════════════════
 * 九、MemeSystem 门面：三级闸门 + 发送编排
 * ══════════════════════════════════════════════════════════════ */

/** 造一个装好图的 MemeSystem。 */
async function makeMeme({ config = {}, now = () => 1700000000000, rng = () => 0 } = {}) {
  const dataDir = tempDir('chacha-meme-sys-')
  const memes = new MemeSystem({ dataDir, config, log: SILENT, now, rng })
  await memes.ensureDirs()
  await memes.store.ingest({ buffer: pngBytes(5000, 11), ext: 'png', description: '眯眼笑', category: 'happy' })
  await memes.store.ingest({ buffer: pngBytes(5000, 12), ext: 'png', description: '难过', category: 'sad' })
  await memes.store.ingest({ buffer: pngBytes(5000, 13), ext: 'png', description: '生气', category: 'angry' })
  return memes
}

function sysConfig(patch = {}) {
  return {
    modes: { default: 'companion', peers: {} },
    meme: {
      probability: 1,
      maxPerMessage: 2,
      inlineProbability: 1,
      cooldownMs: 120000,
      ...patch,
    },
  }
}

group('MemeSystem：渲染闸门')

{
  const memes = await makeMeme({ config: sysConfig() })
  const plan = memes.renderReply('主人早安呀 &&happy&& 今天也要开心哦', { peerKey: 'private-1' })
  check('正常渲染产出图段', plan.segments.filter((item) => item.type === 'image').length, 1)
  check('记录抽到的类别', plan.picked, ['happy'])
  notOk('plan.text 不含 &&', plan.text.includes('&&'), plan.text)
  memes.dispose()
}

{
  const config = sysConfig()
  config.modes = { default: 'companion', peers: { 'group-9': 'work' } }
  const memes = await makeMeme({ config })
  const plan = memes.renderReply('哇 &&happy&&', { peerKey: 'group-9' })
  check('work 模式不插图', plan.segments, null)
  check('work 模式给出原因', plan.reason, 'mode')
  notOk('work 模式也不漏 &&', plan.text.includes('&&'), plan.text)
  memes.dispose()
}

{
  const memes = await makeMeme({ config: sysConfig({ probability: 0 }) })
  const plan = memes.renderReply('哇 &&happy&&', { peerKey: 'private-1' })
  check('消息级概率 0 → 不发图', plan.segments, null)
  check('概率闸原因', plan.reason, 'probability')
  check('正文仍是干净的', plan.text, '哇')
  memes.dispose()
}

group('MemeSystem：给 Mind 的说明与错误兜底')

{
  const memes = await makeMeme({ config: sysConfig({ maxPerMessage: 2 }) })
  const guide = memes.renderGuide()
  ok('说明含标记格式', guide.includes('&&happy&&'), guide.slice(0, 120))
  ok('说明写的是「什么时候用」', guide.includes('什么时候用'), '')
  ok('说明列全类别 key', MEME_CATEGORIES.every((item) => guide.includes(item.key)), '')
  ok('说明写清单条上限', guide.includes('最多 2 个'), guide.slice(0, 200))
  ok('空类别会标注抽不到图', guide.includes('抽不到图'), '')
  memes.dispose()
}

{
  const memes = await makeMeme({ config: sysConfig() })
  // 模拟图库目录坏掉：渲染必须回落纯文本，不能把整条回复弄丢，也不能漏标记
  memes.store.listCategories = () => {
    throw new Error('磁盘炸了')
  }
  const plan = memes.renderReply('好耶 &&happy&&', { peerKey: 'private-1' })
  check('渲染异常 → 退回纯文本', plan.segments, null)
  check('渲染异常的原因', plan.reason, 'error')
  check('渲染异常时正文也不漏 &&', plan.text, '好耶')
  memes.dispose()
}

group('MemeSystem：类别冷却')

{
  let clock = 1700000000000
  const memes = await makeMeme({ config: sysConfig({ cooldownMs: 120000 }), now: () => clock })
  const first = memes.renderReply('一 &&happy&&', { peerKey: 'private-1' })
  check('第一次抽到 happy', first.picked, ['happy'])

  const second = memes.renderReply('二 &&happy&&', { peerKey: 'private-1' })
  check('冷却中不重复抽同类别', second.segments, null)
  check('冷却原因', second.reason, 'cooldown')

  clock += 120001
  const third = memes.renderReply('三 &&happy&&', { peerKey: 'private-1' })
  check('冷却过去后能再抽', third.picked, ['happy'])
  memes.dispose()
}

group('MemeSystem：单条上限与同类别去重')

{
  const memes = await makeMeme({ config: sysConfig({ cooldownMs: 0 }) })
  const plan = memes.renderReply('&&happy&& &&sad&& &&angry&&', { peerKey: 'private-1' })
  check('maxPerMessage=2 → 最多两张图', plan.picked.length, 2)
  check('图段数量受上限约束', plan.segments.filter((item) => item.type === 'image').length, 2)
  memes.dispose()
}

{
  const memes = await makeMeme({ config: sysConfig({ cooldownMs: 0 }) })
  const plan = memes.renderReply('&&happy&&&&happy&&', { peerKey: 'private-1' })
  check('同一条消息重复类别只抽一张', plan.picked, ['happy'])
  memes.dispose()
}

group('MemeSystem：sendReply 编排')

function fakeOutbox() {
  const record = { texts: [], images: [] }
  return {
    record,
    async send(message, text, options = {}) {
      record.texts.push({ text, quote: Boolean(options.quote) })
      return { sent: 1, total: 1, cancelled: false }
    },
    async deliver(target, segments) {
      record.images.push({ target, segments })
      return {}
    },
  }
}

{
  const memes = await makeMeme({ config: sysConfig() })
  const outbox = fakeOutbox()
  const message = { id: 'm', scene: 'group', groupId: '123', peerId: '123', userId: '1' }
  const result = await memes.sendReply({ outbox, message, text: '主人早安呀 &&happy&& 今天也要开心哦', quote: true })
  check('sendReply 报告发出文字段', result.textOnly, false)
  check('发了图', result.images, 1)
  ok('文字段数 >= 2', outbox.record.texts.length >= 2, String(outbox.record.texts.length))
  check('只有第一段带引用', outbox.record.texts[0].quote, true)
  check('后续段不带引用', outbox.record.texts[1].quote, false)
  check('发图走 deliver', outbox.record.images.length, 1)
  const imagePath = outbox.record.images[0].segments[0].data.path
  ok('发的是本机绝对路径', path.isAbsolute(imagePath), imagePath)
  notOk('任何文字段都不含 &&', outbox.record.texts.some((item) => item.text.includes('&&')), JSON.stringify(outbox.record.texts))
  memes.dispose()
}

{
  const memes = await makeMeme({ config: sysConfig({ probability: 0 }) })
  const outbox = fakeOutbox()
  const message = { id: 'm', scene: 'private', peerId: '1', userId: '1' }
  const result = await memes.sendReply({ outbox, message, text: '只是说话 &&happy&&', quote: false })
  check('不发图时退回纯文本一条', result.textOnly, true)
  check('纯文本路径不带 &&', outbox.record.texts[0].text, '只是说话')
  memes.dispose()
}

group('MemeSystem：统计与 dispose')

{
  const memes = await makeMeme({ config: sysConfig() })
  const stats = memes.stats()
  check('stats 有图库分类计数', stats.byCategory.happy.count, 1)
  check('stats 有盗图计数', typeof stats.steal?.stolen, 'number')
  memes.dispose()
  memes.dispose() // 可重复调用
  ok('dispose 后缓存清空', memes.cooldowns.size === 0)
}

/* ══════════════════════════════════════════════════════════════ */
report('表情包系统（store / render / steal）')
