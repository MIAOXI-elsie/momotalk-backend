/**
 * ============================================================
 *  routes/miniapp.js —— 轻量小程序引擎（由云函数 miniapp 完整移植）
 *  POST /api/miniapp  body: { action, token, ... }
 *
 *  与云函数版的差异：
 *   - 文件不再走 uniCloud 云存储，改为先调 POST /api/upload 上传到
 *     ECS 本地 uploads/ 目录，拿到 https/http URL 后再调 submitApp 登记。
 *   - 数据库只存 URL 地址，不存文件内容（存储规则不变）。
 */
'use strict'
const C = require('../lib/common')
const { one, all, exec } = require('../lib/db')

// 运行令牌有效期：30分钟（小程序打开后 30 分钟内可调网关接口）
const RUN_TOKEN_TTL = 30 * 60 * 1000

module.exports = async function handle(event) {
	try {
		const me = C.verifyToken(event.token)
		if (!me) return C.fail('登录已过期，请重新登录', 401)
		switch (event.action) {
			case 'listApps': return await listApps()
			case 'myUploads': return await myUploads(me)
			case 'submitApp': return await submitApp(event, me)
			case 'getRuntime': return await getRuntime(event, me)
			default: return C.fail('未知操作: ' + event.action)
		}
	} catch (e) {
		console.error('[miniapp] 异常:', e)
		return C.fail('服务器开小差了：' + (e.message || e))
	}
}

// 已上架小程序列表（desc 字段在 MySQL 中列名为 descr，desc 是 SQL 保留字）
async function listApps() {
	const res = await all(`SELECT * FROM ${C.T.MINIAPPS} WHERE status='online' ORDER BY createdAt DESC LIMIT 100`)
	return C.ok(res.map(a => ({
		appId: a.id, name: a.name, desc: a.descr, category: a.category,
		iconUrl: a.iconUrl, needWallet: !!a.needWallet, ownerUid: a.ownerUid, createdAt: a.createdAt
	})))
}

// 我提交的小程序（查看审核状态/驳回理由）
async function myUploads(me) {
	const res = await all(`SELECT * FROM ${C.T.MINIAPPS} WHERE ownerUid=? ORDER BY createdAt DESC LIMIT 50`, [me.uid])
	const statusText = { pending: '待审核', online: '已上架', rejected: '已驳回', offline: '已下架' }
	return C.ok(res.map(a => ({
		appId: a.id, name: a.name, desc: a.descr, status: a.status,
		statusText: statusText[a.status] || a.status,
		rejectReason: a.rejectReason || '', needWallet: !!a.needWallet, createdAt: a.createdAt
	})))
}

/**
 * 提交小程序上架申请
 * 客户端流程：先 POST /api/upload 上传 index.html（和图标）拿到 URL，再调本接口登记
 */
async function submitApp(event, me) {
	const { name, desc, category, iconUrl, entryUrl, needWallet } = event
	if (!name || !String(name).trim()) return C.fail('请填写小程序名称')
	if (!entryUrl) return C.fail('缺少小程序入口文件（请先上传 index.html 获得地址）')
	const now = Date.now()
	const appId = C.rid()
	await exec(
		`INSERT INTO ${C.T.MINIAPPS}
		 (id, name, descr, category, iconUrl, entryUrl, ownerUid, ownerName, needWallet, status, rejectReason, createdAt, updatedAt)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		[appId, String(name).trim().slice(0, 20), String(desc || '').slice(0, 200),
			['购物', '外卖', '工具', '其他'].includes(category) ? category : '其他',
			String(iconUrl || '').slice(0, 500), entryUrl, me.uid, me.username,
			needWallet ? 1 : 0, 'pending', '', now, now]
	)
	return C.ok({ appId }, '提交成功，等待管理员审核')
}

/**
 * 打开小程序：生成带运行令牌的加载地址
 * 运行令牌 payload = { uid, appId, scope:'miniapp' }，30分钟有效；
 * 令牌通过 URL hash 传递（# 后内容不发给服务器，仅小程序页面本地可读），
 * 小程序内 mt-bridge.js 调 /api/gateway 时携带此令牌完成身份鉴权。
 */
async function getRuntime(event, me) {
	const app = await one(`SELECT * FROM ${C.T.MINIAPPS} WHERE id=?`, [event.appId])
	if (!app) return C.fail('小程序不存在')
	if (app.status !== 'online') return C.fail('该小程序未上架，无法打开')
	const runToken = C.makeToken({ uid: me.uid, appId: app.id, scope: 'miniapp' }, RUN_TOKEN_TTL)
	const url = app.entryUrl + (app.entryUrl.includes('?') ? '&' : '#') +
		`mt_token=${runToken}&mt_appid=${app.id}&mt_uid=${me.uid}`
	return C.ok({ url, appId: app.id, name: app.name, needWallet: !!app.needWallet })
}
