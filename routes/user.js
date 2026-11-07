/**
 * ============================================================
 *  routes/user.js —— 账号体系（由云函数 user-center 完整移植）
 *  POST /api/user-center  body: { action, token, ... }
 *
 *  支持的 action（与云函数版完全一致，前端无需改调用参数）：
 *   register / login / getSecurityQ / forgotReset / changePassword /
 *   getProfile / updateProfile / myStatus / deactivateApply / reportCid
 */
'use strict'
const C = require('../lib/common')
const { one, all, exec, count, J } = require('../lib/db')

// 新用户注册赠送的信用点（单位：分。10000分 = 100信用点；不想送就改成 0）
const REGISTER_GIFT_CENT = 10000

// 用户表安全字段白名单（getProfile 等接口绝不返回密码哈希/密保答案/cid）
const SAFE_FIELDS = 'id, username, nickname, avatar, bio, balance, status, banReason, securityQ, deactivateReason, deactivateAt, lastActiveAt, createdAt'

module.exports = async function handle(event) {
	const action = event.action
	try {
		switch (action) {
			case 'register': return await register(event)
			case 'login': return await login(event)
			case 'getSecurityQ': return await getSecurityQ(event)
			case 'forgotReset': return await forgotReset(event)
			case 'changePassword': return await changePassword(event)
			case 'getProfile': return await getProfile(event)
			case 'updateProfile': return await updateProfile(event)
			case 'myStatus': return await myStatus(event)
			case 'deactivateApply': return await deactivateApply(event)
			case 'reportCid': return await reportCid(event)
			default: return C.fail('未知操作: ' + action)
		}
	} catch (e) {
		console.error('[user-center] 异常:', e)
		return C.fail('服务器开小差了：' + (e.message || e))
	}
}

/* ---------- 从令牌解析当前登录用户，失败返回 null ---------- */
function auth(event) {
	return C.verifyToken(event.token)
}

/* ---------- 注册 ---------- */
async function register(event) {
	const { username, password, nickname, securityQ, securityA } = event
	// 1. 基础格式校验
	if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) return C.fail('用户名需为3-20位字母/数字/下划线')
	if (!password || String(password).length < 6 || String(password).length > 32) return C.fail('密码长度需为6-32位')
	const nick = (nickname || username).slice(0, 16)
	// 2. 用户名查重
	const exists = await count(`SELECT COUNT(*) AS n FROM ${C.T.USERS} WHERE username=?`, [username])
	if (exists > 0) return C.fail('该用户名已被注册')
	// 3. 密码 bcrypt 加密（绝不存明文）
	const passwordHash = C.hashPassword(password)
	// 4. 写入用户表
	const now = Date.now()
	const id = C.rid()
	await exec(
		`INSERT INTO ${C.T.USERS}
		 (id, username, passwordHash, nickname, avatar, bio, balance, status, banReason, cid, securityQ, securityA, lastActiveAt, createdAt)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		[id, username, passwordHash, nick, '', '', REGISTER_GIFT_CENT, 'normal', '', '',
			securityQ || '', securityA ? C.hashPassword(String(securityA).trim().toLowerCase()) : '', now, now]
	)
	// 5. 注册即登录，直接返回令牌
	const token = C.makeToken({ uid: id, username, role: 'user' })
	return C.ok({ token, uid: id, username, nickname: nick }, '注册成功，欢迎加入 MomoTalk！')
}

/* ---------- 登录 ---------- */
async function login(event) {
	const { username, password, cid } = event
	if (!username || !password) return C.fail('请输入用户名和密码')
	const user = await one(`SELECT * FROM ${C.T.USERS} WHERE username=? LIMIT 1`, [username])
	if (!user) return C.fail('用户名或密码错误') // 故意不区分，防止猜用户名
	// 1. 校验密码（bcrypt）
	if (!C.verifyPassword(password, user.passwordHash)) return C.fail('用户名或密码错误')
	// 2. 检查账号状态
	if (user.status === 'banned') return C.fail('账号已被封禁' + (user.banReason ? '：' + user.banReason : '') + '，如有疑问请联系管理员')
	if (user.status === 'deleted') return C.fail('该账号已注销')
	// 3. 生成令牌 + 记录推送cid + 更新活跃时间
	const token = C.makeToken({ uid: user.id, username: user.username, role: 'user' })
	if (cid) {
		await exec(`UPDATE ${C.T.USERS} SET lastActiveAt=?, cid=? WHERE id=?`, [Date.now(), cid, user.id])
	} else {
		await exec(`UPDATE ${C.T.USERS} SET lastActiveAt=? WHERE id=?`, [Date.now(), user.id])
	}
	return C.ok({
		token,
		user: {
			uid: user.id, username: user.username, nickname: user.nickname,
			avatar: user.avatar, bio: user.bio, balance: user.balance, status: user.status
		}
	}, '登录成功')
}

/* ---------- 找回密码：查询密保问题 ---------- */
async function getSecurityQ(event) {
	const row = await one(`SELECT securityQ FROM ${C.T.USERS} WHERE username=? LIMIT 1`, [event.username])
	if (!row) return C.fail('用户不存在')
	if (!row.securityQ) return C.fail('该账号未设置密保问题，请联系管理员重置密码')
	return C.ok({ question: row.securityQ })
}

/* ---------- 找回密码：答对密保后重设 ---------- */
async function forgotReset(event) {
	const { username, answer, newPassword } = event
	if (!newPassword || String(newPassword).length < 6) return C.fail('新密码至少6位')
	const user = await one(`SELECT * FROM ${C.T.USERS} WHERE username=? LIMIT 1`, [username])
	if (!user) return C.fail('用户不存在')
	if (!user.securityA) return C.fail('该账号未设置密保，请联系管理员重置密码')
	// 密保答案同样哈希比对，不存明文
	if (!C.verifyPassword(String(answer || '').trim().toLowerCase(), user.securityA)) return C.fail('密保答案错误')
	await exec(`UPDATE ${C.T.USERS} SET passwordHash=? WHERE id=?`, [C.hashPassword(newPassword), user.id])
	return C.ok(null, '密码重置成功，请用新密码登录')
}

/* ---------- 修改密码（已登录） ---------- */
async function changePassword(event) {
	const me = auth(event); if (!me) return C.fail('登录已过期，请重新登录', 401)
	const { oldPassword, newPassword } = event
	if (!newPassword || String(newPassword).length < 6) return C.fail('新密码至少6位')
	const user = await one(`SELECT passwordHash FROM ${C.T.USERS} WHERE id=?`, [me.uid])
	if (!user) return C.fail('账号不存在')
	if (!C.verifyPassword(oldPassword, user.passwordHash)) return C.fail('原密码错误')
	await exec(`UPDATE ${C.T.USERS} SET passwordHash=? WHERE id=?`, [C.hashPassword(newPassword), me.uid])
	return C.ok(null, '密码修改成功，下次登录请使用新密码')
}

/* ---------- 获取我的资料 ---------- */
async function getProfile(event) {
	const me = auth(event); if (!me) return C.fail('登录已过期，请重新登录', 401)
	const row = await one(`SELECT ${SAFE_FIELDS} FROM ${C.T.USERS} WHERE id=?`, [me.uid])
	if (!row) return C.fail('账号不存在')
	return C.ok(C.withId(row))
}

/* ---------- 修改资料（昵称/头像/签名） ---------- */
async function updateProfile(event) {
	const me = auth(event); if (!me) return C.fail('登录已过期，请重新登录', 401)
	const sets = [], params = []
	if (event.nickname !== undefined) {
		const nick = String(event.nickname).trim().slice(0, 16)
		if (!nick) return C.fail('昵称不能为空')
		sets.push('nickname=?'); params.push(nick)
	}
	if (event.avatar !== undefined) { sets.push('avatar=?'); params.push(String(event.avatar).slice(0, 500)) }
	if (event.bio !== undefined) { sets.push('bio=?'); params.push(String(event.bio).slice(0, 60)) }
	if (!sets.length) return C.fail('没有要修改的内容')
	params.push(me.uid)
	await exec(`UPDATE ${C.T.USERS} SET ${sets.join(', ')} WHERE id=?`, params)
	return C.ok(Object.fromEntries(sets.map((s, i) => [s.split('=')[0], params[i]])), '资料已更新')
}

/* ---------- 查看账号状态 ---------- */
async function myStatus(event) {
	const me = auth(event); if (!me) return C.fail('登录已过期，请重新登录', 401)
	const row = await one(`SELECT id, username, status, banReason, createdAt FROM ${C.T.USERS} WHERE id=?`, [me.uid])
	if (!row) return C.fail('账号不存在')
	const statusText = { normal: '正常', banned: '已封禁', pending_deletion: '注销审核中', deleted: '已注销' }
	return C.ok(C.withId({ ...row, statusText: statusText[row.status] || row.status }))
}

/* ---------- 提交注销申请 ---------- */
async function deactivateApply(event) {
	const me = auth(event); if (!me) return C.fail('登录已过期，请重新登录', 401)
	const { password, reason } = event
	const user = await one(`SELECT passwordHash FROM ${C.T.USERS} WHERE id=?`, [me.uid])
	if (!user) return C.fail('账号不存在')
	// 注销需验证密码，防止误操作/被他人恶意注销
	if (!C.verifyPassword(password, user.passwordHash)) return C.fail('密码错误，无法注销')
	await exec(
		`UPDATE ${C.T.USERS} SET status='pending_deletion', deactivateReason=?, deactivateAt=? WHERE id=?`,
		[reason || '', Date.now(), me.uid]
	)
	return C.ok(null, '注销申请已提交，管理员处理后账号将被标记注销（交易流水依法保留）')
}

/* ---------- 上报推送 cid ---------- */
async function reportCid(event) {
	const me = auth(event); if (!me) return C.fail('未登录', 401)
	if (!event.cid) return C.fail('cid 为空')
	await exec(`UPDATE ${C.T.USERS} SET cid=?, lastActiveAt=? WHERE id=?`, [event.cid, Date.now(), me.uid])
	return C.ok()
}
