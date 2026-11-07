/**
 * ============================================================
 *  app.js —— MomoTalk 独立后端入口（Express + MySQL）
 * ============================================================
 *  由 uniCloud 云函数版完整改造：每个云函数变成一个 HTTP 接口，
 *  请求/返回格式与云函数版保持一致（{ action, token, ... } → { code, msg, data }），
 *  因此前端页面代码零改动，只换了 api.js 里的调用通道。
 *
 *  接口对照表（云函数 → HTTP）：
 *    user-center → POST /api/user-center   账号体系
 *    im          → POST /api/im            即时通讯
 *    wallet      → POST /api/wallet        钱包（信用点）
 *    miniapp     → POST /api/miniapp       小程序
 *    admin       → POST /api/admin         管理员后台
 *    mt-gateway  → POST /api/gateway       小程序沙箱网关（替代原 URL化）
 *    云存储       → POST /api/upload        文件上传（存 ECS 本地 uploads/）
 *                  GET  /uploads/...       文件访问（静态资源）
 *
 *  启动：npm start   （生产环境建议 pm2 start app.js --name momotalk）
 */
'use strict'
const path = require('path')
const fs = require('fs')
const express = require('express')
const cors = require('cors')
const multer = require('multer')

const cfg = require('./config')
const C = require('./lib/common')

// 上传目录必须存在
fs.mkdirSync(cfg.UPLOAD_DIR, { recursive: true })

const app = express()
app.use(cors()) // 小程序 web-view 沙箱跨域需要
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// 上传的文件作为静态资源对外提供访问（数据库只存 URL，不存文件内容）
app.use('/uploads', express.static(cfg.UPLOAD_DIR, { maxAge: '7d' }))

/* ---------------- 健康检查（部署完浏览器打开这个地址验证） ---------------- */
app.get('/', (req, res) => res.json(C.ok({ name: 'MomoTalk Server', version: '1.0.0', docs: '见 docs/ECS改造部署说明.md' }, 'MomoTalk 后端运行中')))
app.get('/api/health', (req, res) => res.json(C.ok({ time: Date.now() }, 'ok')))

/* ---------------- 文件上传（替代 uniCloud 云存储） ----------------
 * multipart/form-data：file=文件本体，dir=保存子目录（如 chat/image、avatar、miniapp/entry）
 * 返回 { code:0, data:{ url, name, fileID } }，fileID 即完整访问 URL（兼容旧前端字段名）
 */
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		// 目录白名单清洗：只允许字母数字下划线中划线斜杠，防止路径穿越
		const dir = String((req.body && req.body.dir) || 'misc').replace(/[^a-zA-Z0-9_\-\/]/g, '').replace(/^\/+/, '')
		const p = path.join(cfg.UPLOAD_DIR, dir)
		fs.mkdirSync(p, { recursive: true })
		cb(null, p)
	},
	filename: (req, file, cb) => {
		const ext = (path.extname(file.originalname) || '').slice(0, 10).replace(/[^a-zA-Z0-9.]/g, '')
		cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext)
	}
})
const upload = multer({ storage, limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024 } })

app.post('/api/upload', upload.single('file'), (req, res) => {
	if (!req.file) return res.json(C.fail('未收到文件'))
	// multer 对中文文件名按 latin1 解码，这里转回 utf8
	let originalName = req.file.originalname
	try { originalName = Buffer.from(originalName, 'latin1').toString('utf8') } catch (e) {}
	const rel = path.relative(cfg.UPLOAD_DIR, req.file.path).split(path.sep).join('/')
	const url = cfg.PUBLIC_BASE_URL + '/uploads/' + rel
	res.json(C.ok({ url, fileID: url, name: originalName, size: req.file.size }))
})

/* ---------------- 业务路由挂载（与云函数一一对应） ---------------- */
function mount(p, handler) {
	app.post(p, async (req, res) => {
		try {
			res.json(await handler(req.body || {}))
		} catch (e) {
			console.error('[server]', p, '异常:', e)
			res.json(C.fail('服务器开小差了：' + (e.message || e)))
		}
	})
}
mount('/api/user-center', require('./routes/user'))
mount('/api/im', require('./routes/im'))
mount('/api/wallet', require('./routes/wallet'))
mount('/api/miniapp', require('./routes/miniapp'))
mount('/api/admin', require('./routes/admin'))
mount('/api/gateway', require('./routes/gateway')) // 小程序沙箱网关（替代 mt-gateway URL化）

/* ---------------- 启动 ---------------- */
app.listen(cfg.PORT, '0.0.0.0', () => {
	console.log('==================================================')
	console.log('  MomoTalk 后端已启动')
	console.log('  本机地址: http://127.0.0.1:' + cfg.PORT)
	console.log('  对外地址: ' + cfg.PUBLIC_BASE_URL + '  ← 客户端 config.js 的 API_BASE 填这个')
	console.log('  健康检查: ' + cfg.PUBLIC_BASE_URL + '/api/health')
	if (cfg.SECRET === 'CHANGE_ME_TO_A_RANDOM_STRING_32+') {
		console.warn('  ⚠️ 警告：.env 里的 SECRET 还是默认值，请务必修改！')
	}
	if (!cfg.PUSH.appId) {
		console.log('  ℹ️ 推送未配置（.env 的 PUSH_* 为空）：客户端轮询兜底生效，功能不受影响')
	}
	console.log('==================================================')
})
