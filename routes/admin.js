/**
 * ============================================================
 *  routes/admin.js —— 管理员后台全部能力（由云函数 admin 完整移植）
 *  POST /api/admin  body: { action, token, ... }   （仅供「管理器」App 调用）
 *
 *  权限隔离：管理员账号存独立的 mt_admins 表，登录发放 role='admin' 令牌；
 *  普通用户令牌（role='user'）调用本接口一律直接拒绝。
 *
 *  支持的 action 与云函数版完全一致（管理器前端只需换调用通道）：
 *   login / changePassword / stats / listUsers / userDetail / editUser /
 *   banUsers / deactivateRequests / handleDeactivate / queryUserWallet /
 *   adjustCredit / sendBroadcast / listAnnouncements / saveAnnouncement /
 *   deleteAnnouncement / listMiniapps / reviewMiniapp / setMiniappStatus / listLogs
 */
'use strict'
const C = require('../lib/common')
const { one, all, exec, count, J, parseJ, escLike } = require('../lib/db')

// 「在线」判定窗口：5分钟内有心跳
const ONLINE_WINDOW = 5 * 60 * 1000

module.exports = async function handle(event) {
	try {
		const action = event.action
		if (action === 'login') return await login(event)
		// 其余接口全部要求管理员身份
		const admin = C.verifyToken(event.token)
		if (!admin || admin.role !== 'admin') return C.fail('无管理员权限，禁止访问', 403)
		const a = await one(`SELECT id, status, username FROM ${C.T.ADMINS} WHERE id=?`, [admin.aid])
		if (!a || a.status !== 'normal') return C.fail('管理员账号不可用', 403)

		switch (action) {
			case 'changePassword': return await changePassword(event, admin)
			case 'stats': return await stats(admin)
			case 'listUsers': return await listUsers(event)
			case 'userDetail': return await userDetail(event)
			case 'editUser': return await editUser(event, admin)
			case 'banUsers': return await banUsers(event, admin)
			case 'deactivateRequests': return await deactivateRequests()
			case 'handleDeactivate': return await handleDeactivate(event, admin)
			case 'queryUserWallet': return await queryUserWallet(event)
			case 'adjustCredit': return await adjustCredit(event, admin)
			case 'sendBroadcast': return await sendBroadcast(event, admin)
			case 'listAnnouncements': return await listAnnouncements()
			case 'saveAnnouncement': return await saveAnnouncement(event, admin)
			case 'deleteAnnouncement': return await deleteAnnouncement(event, admin)
			case 'listMiniapps': return await listMiniapps(event)
			case 'reviewMiniapp': return await reviewMiniapp(event, admin)
			case 'setMiniappStatus': return await setMiniappStatus(event, admin)
			case 'listLogs': return await listLogs(event)
			default: return C.fail('未知操作: ' + action)
		}
	} catch (e) {
		console.error('[admin] 异常:', e)
		return C.fail('服务器开小差了：' + (e.message || e))
	}
}

/* ---------- 管理员登录（独立账号体系，与普通用户完全隔离） ---------- */
async function login(event) {
	const { username, password } = event
	if (!username || !password) return C.fail('请输入管理员账号和密码')
	const a = await one(`SELECT * FROM ${C.T.ADMINS} WHERE username=? LIMIT 1`, [username])
	if (!a) return C.fail('管理员账号或密码错误')
	if (!C.verifyPassword(password, a.passwordHash)) return C.fail('管理员账号或密码错误')
	if (a.status !== 'normal') return C.fail('该管理员账号已被停用')
	const token = C.makeToken({ aid: a.id, username: a.username, role: 'admin' })
	return C.ok({ token, admin: { aid: a.id, username: a.username, nickname: a.nickname || a.username } }, '登录成功')
}

/* ---------- 修改管理员密码 ---------- */
async function changePassword(event, admin) {
	const a = await one(`SELECT passwordHash FROM ${C.T.ADMINS} WHERE id=?`, [admin.aid])
	if (!C.verifyPassword(event.oldPassword, a.passwordHash)) return C.fail('原密码错误')
	if (!event.newPassword || String(event.newPassword).length < 6) return C.fail('新密码至少6位')
	await exec(`UPDATE ${C.T.ADMINS} SET passwordHash=?, updatedAt=? WHERE id=?`, [C.hashPassword(event.newPassword), Date.now(), admin.aid])
	await C.logAdmin(admin, 'change_password', '修改了自己的管理员密码')
	return C.ok(null, '密码已修改')
}

/* ---------- 首页统计 ---------- */
async function stats(admin) {
	const now = Date.now()
	const [users, onlineUsers, convs, msgs, pendingApps, anns] = await Promise.all([
		count(`SELECT COUNT(*) AS n FROM ${C.T.USERS}`),
		count(`SELECT COUNT(*) AS n FROM ${C.T.USERS} WHERE lastActiveAt>=? AND status='normal'`, [now - ONLINE_WINDOW]),
		count(`SELECT COUNT(*) AS n FROM ${C.T.CONVERSATIONS}`),
		count(`SELECT COUNT(*) AS n FROM ${C.T.MESSAGES}`),
		count(`SELECT COUNT(*) AS n FROM ${C.T.MINIAPPS} WHERE status='pending'`),
		count(`SELECT COUNT(*) AS n FROM ${C.T.ANNOUNCEMENTS} WHERE published=1`)
	])
	const deact = await count(`SELECT COUNT(*) AS n FROM ${C.T.USERS} WHERE status='pending_deletion'`)
	return C.ok({
		totalUsers: users, onlineUsers,
		totalConversations: convs, totalMessages: msgs,
		pendingMiniapps: pendingApps, publishedAnnouncements: anns,
		pendingDeactivations: deact
	})
}

/* ---------- 用户管理 ---------- */
async function listUsers(event) {
	const page = Math.max(1, Number(event.page) || 1)
	const size = Math.min(100, Number(event.size) || 20)
	// 组合查询条件：状态筛选 + 关键词（用户名/昵称模糊匹配）
	const conds = [], params = []
	if (event.status && event.status !== 'all') { conds.push('status=?'); params.push(event.status) }
	if (event.keyword) {
		const kw = String(event.keyword).trim()
		if (kw) { conds.push('(username LIKE ? OR nickname LIKE ?)'); params.push('%' + escLike(kw) + '%', '%' + escLike(kw) + '%') }
	}
	const whereSql = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
	const total = await count(`SELECT COUNT(*) AS n FROM ${C.T.USERS} ${whereSql}`, params)
	const rows = await all(
		`SELECT id, username, nickname, avatar, balance, status, banReason, createdAt, lastActiveAt
		 FROM ${C.T.USERS} ${whereSql} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
		[...params, size, (page - 1) * size]
	)
	const statusText = { normal: '正常', banned: '已封禁', pending_deletion: '注销审核中', deleted: '已注销' }
	return C.ok({
		total, page, size,
		list: rows.map(u => ({
			uid: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar,
			balanceYuan: C.toYuan(u.balance || 0), status: u.status,
			statusText: statusText[u.status] || u.status,
			banReason: u.banReason || '',
			online: Date.now() - (u.lastActiveAt || 0) < ONLINE_WINDOW,
			createdAt: u.createdAt
		}))
	})
}

async function userDetail(event) {
	const u = await one(
		`SELECT id, username, nickname, avatar, bio, balance, status, banReason, securityQ,
		        deactivateReason, deactivateAt, lastActiveAt, createdAt
		 FROM ${C.T.USERS} WHERE id=?`,
		[event.uid]
	)
	if (!u) return C.fail('用户不存在')
	const flows = await all(`SELECT * FROM ${C.T.FLOWS} WHERE uid=? ORDER BY createdAt DESC LIMIT 10`, [event.uid])
	return C.ok({
		user: { ...C.withId(u), uid: u.id, balanceYuan: C.toYuan(u.balance || 0) },
		recentFlows: flows.map(f => ({ ...C.withId(f), amountYuan: C.toYuan(Math.abs(f.delta)), income: f.delta > 0 }))
	})
}

async function editUser(event, admin) {
	const { uid, nickname, bio } = event
	const sets = [], params = []
	if (nickname !== undefined) { sets.push('nickname=?'); params.push(String(nickname).slice(0, 16)) }
	if (bio !== undefined) { sets.push('bio=?'); params.push(String(bio).slice(0, 60)) }
	if (!sets.length) return C.fail('没有要修改的内容')
	params.push(uid)
	await exec(`UPDATE ${C.T.USERS} SET ${sets.join(', ')} WHERE id=?`, params)
	await C.logAdmin(admin, 'edit_user', `编辑用户 ${uid} 的资料：${JSON.stringify({ nickname, bio })}`, { uid })
	return C.ok(null, '已保存')
}

// 封禁/解封（uids 数组，支持批量；封禁后客户端禁止登录与发言）
async function banUsers(event, admin) {
	const { uids, banned, reason } = event
	if (!Array.isArray(uids) || !uids.length) return C.fail('请选择用户')
	if (uids.length > 100) return C.fail('单次最多操作100人')
	for (const uid of uids) {
		// 已注销/注销中的账号不动
		const cur = await one(`SELECT status FROM ${C.T.USERS} WHERE id=?`, [uid])
		if (!cur) continue
		if (cur.status === 'deleted' || cur.status === 'pending_deletion') continue
		if (banned) {
			await exec(
				`UPDATE ${C.T.USERS} SET status='banned', banReason=?, bannedAt=?, bannedBy=? WHERE id=?`,
				[String(reason || '违反内部使用规范').slice(0, 100), Date.now(), admin.username, uid]
			)
		} else {
			await exec(
				`UPDATE ${C.T.USERS} SET status='normal', banReason='', bannedAt=NULL, bannedBy='' WHERE id=?`,
				[uid]
			)
		}
	}
	await C.logAdmin(admin, banned ? 'ban_users' : 'unban_users',
		`${banned ? '封禁' : '解封'} ${uids.length} 个账号：${uids.join(',')}${reason ? '，理由：' + reason : ''}`,
		{ uids: J(uids), banned: !!banned, reason: reason || '' })
	return C.ok(null, banned ? '已封禁所选账号（其客户端将无法登录和发言）' : '已解封所选账号')
}

// 注销申请列表
async function deactivateRequests() {
	const res = await all(
		`SELECT id, username, nickname, balance, deactivateReason, deactivateAt, createdAt
		 FROM ${C.T.USERS} WHERE status='pending_deletion' ORDER BY deactivateAt DESC LIMIT 100`
	)
	return C.ok(res.map(u => ({
		uid: u.id, username: u.username, nickname: u.nickname,
		balanceYuan: C.toYuan(u.balance || 0), reason: u.deactivateReason || '', at: u.deactivateAt
	})))
}

// 处理注销申请：通过→标记 deleted（保留全部流水日志）；驳回→恢复 normal
async function handleDeactivate(event, admin) {
	const { uid, approve } = event
	const u = await one(`SELECT id, status, username FROM ${C.T.USERS} WHERE id=?`, [uid])
	if (!u) return C.fail('用户不存在')
	if (u.status !== 'pending_deletion') return C.fail('该用户没有待处理的注销申请')
	if (approve) {
		await exec(`UPDATE ${C.T.USERS} SET status='deleted', deletedAt=?, deletedBy=?, deactivateReason='', deactivateAt=NULL WHERE id=?`, [Date.now(), admin.username, uid])
		await C.logAdmin(admin, 'deactivate_approve', `通过用户 ${u.username}(${uid}) 的注销申请，账号已标记注销，交易流水保留`, { uid })
		return C.ok(null, '已通过注销：账号已标记为注销状态，历史流水与日志全部保留')
	} else {
		await exec(`UPDATE ${C.T.USERS} SET status='normal', deactivateReason='', deactivateAt=NULL WHERE id=?`, [uid])
		await C.logAdmin(admin, 'deactivate_reject', `驳回用户 ${u.username}(${uid}) 的注销申请`, { uid })
		return C.ok(null, '已驳回注销申请，账号恢复正常')
	}
}

/* ---------- 钱包后台管理 ---------- */
async function queryUserWallet(event) {
	const page = Math.max(1, Number(event.page) || 1)
	const size = Math.min(50, Number(event.size) || 20)
	const u = await one(`SELECT id, username, nickname, balance, status FROM ${C.T.USERS} WHERE id=?`, [event.uid])
	if (!u) return C.fail('用户不存在')
	const total = await count(`SELECT COUNT(*) AS n FROM ${C.T.FLOWS} WHERE uid=?`, [event.uid])
	const flows = await all(
		`SELECT * FROM ${C.T.FLOWS} WHERE uid=? ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
		[event.uid, size, (page - 1) * size]
	)
	return C.ok({
		user: { uid: u.id, username: u.username, nickname: u.nickname, balanceYuan: C.toYuan(u.balance || 0), status: u.status },
		total, page, size,
		flows: flows.map(f => ({ ...C.withId(f), amountYuan: C.toYuan(Math.abs(f.delta)), income: f.delta > 0 }))
	})
}

// 手动增加/扣除信用点（deltaYuan 正数=增加，负数=扣除；扣除时余额不足拦截）
async function adjustCredit(event, admin) {
	const { uid, deltaYuan, reason } = event
	const cent = Math.round(Number(deltaYuan) * 100)
	if (!cent || !isFinite(cent)) return C.fail('调整额度无效')
	if (!reason || !String(reason).trim()) return C.fail('必须填写调整原因（写入操作日志）')
	const u = await one(`SELECT id, username, nickname, balance FROM ${C.T.USERS} WHERE id=?`, [uid])
	if (!u) return C.fail('用户不存在')
	if (cent < 0 && (u.balance || 0) < -cent) {
		return C.fail(`扣除失败：该用户余额仅 ${C.toYuan(u.balance || 0)} 信用点，不足以扣除 ${C.toYuan(-cent)}`)
	}
	// 扣除走条件更新防并发扣成负数；增加直接加
	const upd = cent > 0
		? await exec(`UPDATE ${C.T.USERS} SET balance = balance + ? WHERE id = ?`, [cent, uid])
		: await exec(`UPDATE ${C.T.USERS} SET balance = balance + ? WHERE id = ? AND balance >= ?`, [cent, uid, -cent])
	if (upd.affectedRows === 0) return C.fail('调整失败（余额不足或并发冲突），请刷新后重试')
	const after = await one(`SELECT balance FROM ${C.T.USERS} WHERE id=?`, [uid])
	// 写流水留痕（与转账/红包同一张流水表，永久可查）
	await exec(
		`INSERT INTO ${C.T.FLOWS} (id, uid, type, delta, balanceAfter, otherUid, otherName, note, relatedId, miniappId, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		[C.rid(), uid, 'admin_adjust', cent, after.balance, '', admin.username, `管理员调整：${String(reason).slice(0, 60)}`, '', '', Date.now()]
	)
	await C.logAdmin(admin, 'adjust_credit',
		`给用户 ${u.username}(${uid}) ${cent > 0 ? '增加' : '扣除'} ${C.toYuan(Math.abs(cent))} 信用点，原因：${reason}，调整后余额 ${C.toYuan(after.balance)}`,
		{ uid, cent, balanceAfter: after.balance })
	return C.ok({ balance: after.balance, balanceYuan: C.toYuan(after.balance) }, `已${cent > 0 ? '增加' : '扣除'}，当前余额 ${C.toYuan(after.balance)} 信用点`)
}

/* ---------- 消息广播 ----------
 * target: single单个用户 / custom自定义选中一批 / online全部在线 / all全体注册
 * 客户端通过 im.popups 轮询拉取 + 推送双通道触达，App 内弹窗提醒 */
async function sendBroadcast(event, admin) {
	const { target, uids, title, content } = event
	if (!content || !String(content).trim()) return C.fail('广播内容不能为空')
	if (!['single', 'custom', 'online', 'all'].includes(target)) return C.fail('请选择推送范围')
	let targetUids = 'ALL'
	if (target === 'single') {
		if (!uids || !uids.length) return C.fail('请选择一个用户')
		targetUids = [uids[0]]
	} else if (target === 'custom') {
		if (!Array.isArray(uids) || !uids.length) return C.fail('请勾选用户')
		if (uids.length > 500) return C.fail('单次自定义广播最多500人')
		targetUids = uids
	} else if (target === 'online') {
		const rows = await all(`SELECT id FROM ${C.T.USERS} WHERE status='normal' AND lastActiveAt>=?`, [Date.now() - ONLINE_WINDOW])
		targetUids = rows.map(r => r.id)
		if (!targetUids.length) return C.fail('当前没有在线用户')
	}
	const now = Date.now()
	const bId = C.rid()
	await exec(
		`INSERT INTO ${C.T.BROADCASTS} (id, title, content, targetType, uids, pushSent, createdBy, createdAt) VALUES (?,?,?,?,?,?,?,?)`,
		[bId, String(title || '系统通知').slice(0, 30), String(content).slice(0, 500), target, J(targetUids), 0, admin.username, now]
	)
	// 在线推送（尽力而为，失败不阻塞；客户端轮询 popups 兜底必达）
	let pushSent = 0
	if (Array.isArray(targetUids) && targetUids.length) {
		const r = await C.pushToUsers(targetUids, title || '系统通知', content, { type: 'broadcast', bId })
		pushSent = r.sent || 0
		await exec(`UPDATE ${C.T.BROADCASTS} SET pushSent=? WHERE id=?`, [pushSent, bId])
	}
	await C.logAdmin(admin, 'send_broadcast',
		`发送广播「${title || '系统通知'}」，范围：${{ single: '单个用户', custom: `自选${targetUids.length}人`, online: `全部在线(${targetUids.length}人)`, all: '全体注册用户' }[target]}，内容：${String(content).slice(0, 50)}`,
		{ bId, target })
	const scopeText = { single: '该用户', custom: `${targetUids.length} 位选中用户`, online: `${targetUids.length} 位在线用户`, all: '全体注册用户' }[target]
	return C.ok({ bId, pushSent }, `广播已发送给${scopeText}（客户端将弹窗提醒）`)
}

/* ---------- 全局公告管理 ---------- */
async function listAnnouncements() {
	const res = await all(`SELECT * FROM ${C.T.ANNOUNCEMENTS} ORDER BY pinned DESC, updatedAt DESC LIMIT 200`)
	return C.ok(res.map(a => ({
		annId: a.id, title: a.title, content: a.content,
		pinned: !!a.pinned, published: !!a.published,
		createdBy: a.createdBy, updatedBy: a.updatedBy || a.createdBy,
		createdAt: a.createdAt, updatedAt: a.updatedAt
	})))
}

// 发布/编辑公告（传 annId 为编辑；pinned=true 置顶 → 客户端启动自动弹出）
async function saveAnnouncement(event, admin) {
	const { annId, title, content, pinned, published } = event
	if (!title || !String(title).trim()) return C.fail('请填写公告标题')
	if (!content || !String(content).trim()) return C.fail('请填写公告内容')
	const doc = {
		title: String(title).trim().slice(0, 50),
		content: String(content).trim().slice(0, 2000),
		pinned: pinned ? 1 : 0,
		published: published === false ? 0 : 1, // 默认发布
		updatedAt: Date.now(),
		updatedBy: admin.username
	}
	if (annId) {
		const exist = await one(`SELECT id, title FROM ${C.T.ANNOUNCEMENTS} WHERE id=?`, [annId])
		if (!exist) return C.fail('公告不存在')
		await exec(
			`UPDATE ${C.T.ANNOUNCEMENTS} SET title=?, content=?, pinned=?, published=?, updatedAt=?, updatedBy=? WHERE id=?`,
			[doc.title, doc.content, doc.pinned, doc.published, doc.updatedAt, doc.updatedBy, annId]
		)
		await C.logAdmin(admin, 'update_announcement', `编辑公告「${doc.title}」${doc.pinned ? '（置顶）' : ''}`, { annId })
		return C.ok(null, '公告已更新')
	}
	const id = C.rid()
	await exec(
		`INSERT INTO ${C.T.ANNOUNCEMENTS} (id, title, content, pinned, published, createdBy, updatedBy, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`,
		[id, doc.title, doc.content, doc.pinned, doc.published, admin.username, admin.username, Date.now(), doc.updatedAt]
	)
	await C.logAdmin(admin, 'create_announcement', `发布公告「${doc.title}」${doc.pinned ? '（置顶）' : ''}`, { annId: id })
	return C.ok({ annId: id }, '公告已发布，客户端启动时将自动弹出')
}

async function deleteAnnouncement(event, admin) {
	const a = await one(`SELECT id, title FROM ${C.T.ANNOUNCEMENTS} WHERE id=?`, [event.annId])
	if (!a) return C.fail('公告不存在')
	await exec(`DELETE FROM ${C.T.ANNOUNCEMENTS} WHERE id=?`, [event.annId])
	await C.logAdmin(admin, 'delete_announcement', `删除公告「${a.title}」`, { annId: event.annId })
	return C.ok(null, '公告已删除')
}

/* ---------- 小程序审核管理 ---------- */
async function listMiniapps(event) {
	const whereSql = event.status && event.status !== 'all' ? 'WHERE status=?' : ''
	const params = event.status && event.status !== 'all' ? [event.status] : []
	const res = await all(`SELECT * FROM ${C.T.MINIAPPS} ${whereSql} ORDER BY createdAt DESC LIMIT 200`, params)
	const statusText = { pending: '待审核', online: '已上架', rejected: '已驳回', offline: '已下架' }
	return C.ok(res.map(a => ({
		appId: a.id, name: a.name, desc: a.descr, category: a.category, iconUrl: a.iconUrl,
		ownerName: a.ownerName, needWallet: !!a.needWallet,
		status: a.status, statusText: statusText[a.status] || a.status,
		rejectReason: a.rejectReason || '', entryUrl: a.entryUrl, createdAt: a.createdAt
	})))
}

async function reviewMiniapp(event, admin) {
	const { appId, pass, reason } = event
	const app = await one(`SELECT * FROM ${C.T.MINIAPPS} WHERE id=?`, [appId])
	if (!app) return C.fail('小程序不存在')
	if (app.status !== 'pending') return C.fail('该小程序已审核过（当前状态：' + app.status + '）')
	if (pass) {
		await exec(`UPDATE ${C.T.MINIAPPS} SET status='online', rejectReason='', reviewedBy=?, reviewedAt=?, updatedAt=? WHERE id=?`, [admin.username, Date.now(), Date.now(), appId])
		await C.logAdmin(admin, 'review_miniapp_pass', `审核通过小程序「${app.name}」(${appId})${app.needWallet ? '，含钱包权限' : ''}`, { appId })
	} else {
		if (!reason) return C.fail('驳回必须填写理由')
		await exec(`UPDATE ${C.T.MINIAPPS} SET status='rejected', rejectReason=?, reviewedBy=?, reviewedAt=?, updatedAt=? WHERE id=?`, [String(reason).slice(0, 200), admin.username, Date.now(), Date.now(), appId])
		await C.logAdmin(admin, 'review_miniapp_reject', `驳回小程序「${app.name}」(${appId})，理由：${reason}`, { appId, reason })
	}
	// 推送通知开发者（未配置推送则跳过，开发者在"我的上传"里也能看到状态）
	await C.pushToUsers([app.ownerUid], 'MomoTalk 小程序', pass ? `你的小程序「${app.name}」已通过审核并上架` : `你的小程序「${app.name}」被驳回：${reason || ''}`, { type: 'miniapp' })
	return C.ok(null, pass ? '已通过审核并上架' : '已驳回')
}

// 上架/下架已审核的小程序
async function setMiniappStatus(event, admin) {
	const { appId, status } = event
	if (!['online', 'offline'].includes(status)) return C.fail('状态值无效')
	const app = await one(`SELECT id, name, status FROM ${C.T.MINIAPPS} WHERE id=?`, [appId])
	if (!app) return C.fail('小程序不存在')
	if (app.status === 'pending' || app.status === 'rejected') return C.fail('未过审的小程序不能直接上下架')
	await exec(`UPDATE ${C.T.MINIAPPS} SET status=?, updatedAt=? WHERE id=?`, [status, Date.now(), appId])
	await C.logAdmin(admin, status === 'online' ? 'miniapp_online' : 'miniapp_offline', `${status === 'online' ? '重新上架' : '下架'}小程序「${app.name}」(${appId})`, { appId, status })
	return C.ok(null, status === 'online' ? '已重新上架' : '已下架，客户端将无法打开')
}

/* ---------- 操作日志（只读；本工程不存在任何删除日志的接口 → 永久不可删除） ---------- */
async function listLogs(event) {
	const page = Math.max(1, Number(event.page) || 1)
	const size = Math.min(100, Number(event.size) || 20)
	const total = await count(`SELECT COUNT(*) AS n FROM ${C.T.ADMIN_LOGS}`)
	const rows = await all(
		`SELECT * FROM ${C.T.ADMIN_LOGS} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
		[size, (page - 1) * size]
	)
	return C.ok({
		total, page, size,
		list: rows.map(l => ({ ...C.withId(l), logId: l.id, extra: parseJ(l.extra, {}) }))
	})
}
