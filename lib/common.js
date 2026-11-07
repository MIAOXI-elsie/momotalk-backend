/**
 * ============================================================
 *  lib/common.js —— 公共模块（由 uniCloud 版 mt-common 完整移植）
 * ============================================================
 *  1. 统一返回格式 ok/fail
 *  2. 登录令牌生成与校验（HMAC-SHA256 签名，算法与云函数版完全一致）
 *  3. 密码加密（bcrypt，依赖缺失自动降级 pbkdf2，与云函数版数据互通）
 *  4. 消息推送（可选：个推 REST API；不配置则静默跳过，客户端轮询兜底）
 *  5. 管理员操作日志（只增不删）
 *  6. 金额（信用点）分/元换算
 */
'use strict'
const crypto = require('crypto')
const cfg = require('../config')
const { exec, all, J } = require('./db')

/* ---------------- 数据表名（与 sql/init.sql 一一对应） ---------------- */
const T = {
	USERS: 'mt_users',                     // 用户表
	ADMINS: 'mt_admins',                   // 管理员表
	FRIENDSHIPS: 'mt_friendships',         // 好友关系表
	FRIEND_REQUESTS: 'mt_friend_requests', // 好友申请表
	CONVERSATIONS: 'mt_conversations',     // 会话表
	MESSAGES: 'mt_messages',               // 消息表
	FLOWS: 'mt_wallet_flows',              // 钱包流水表
	REDPACKETS: 'mt_redpackets',           // 红包表
	MINIAPPS: 'mt_miniapps',               // 小程序表
	ANNOUNCEMENTS: 'mt_announcements',     // 公告表
	BROADCASTS: 'mt_broadcasts',           // 广播消息表
	ADMIN_LOGS: 'mt_admin_logs'            // 管理员操作日志表（永久保留）
}

/* ---------------- 统一返回格式（与云函数版一致） ---------------- */
function ok(data, msg) {
	return { code: 0, msg: msg || 'ok', data: data === undefined ? null : data }
}
function fail(msg, code) {
	return { code: code || 1, msg: msg || '操作失败' }
}

/* ---------------- 工具 ---------------- */
// 32位十六进制随机 id（与云函数版 rid 相同，数据可互通）
function rid() {
	return crypto.randomBytes(16).toString('hex')
}
function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(str) {
	str = str.replace(/-/g, '+').replace(/_/g, '/')
	while (str.length % 4) str += '='
	return Buffer.from(str, 'base64').toString('utf8')
}
function sign(str) {
	return crypto.createHmac('sha256', cfg.SECRET).update(str).digest('hex')
}
// 兼容层：把 MySQL 行数据补上 _id 字段（原云函数返回的文档主键叫 _id，前端有引用）
function withId(row) {
	if (!row) return row
	if (Array.isArray(row)) return row.map(withId)
	return Object.assign({ _id: row.id }, row)
}

/* ---------------- 登录令牌（算法与云函数版完全一致） ---------------- */
const TOKEN_TTL = 7 * 24 * 3600 * 1000 // 7天
function makeToken(payload, ttl) {
	const body = JSON.stringify(payload)
	const exp = Date.now() + (ttl || TOKEN_TTL)
	const raw = b64url(body) + '.' + exp
	return raw + '.' + sign(raw)
}
function verifyToken(token) {
	if (!token || typeof token !== 'string') return null
	const parts = token.split('.')
	if (parts.length !== 3) return null
	const raw = parts[0] + '.' + parts[1]
	if (sign(raw) !== parts[2]) return null        // 签名不对 → 被篡改
	if (Number(parts[1]) < Date.now()) return null // 已过期
	try { return JSON.parse(b64urlDecode(parts[0])) } catch (e) { return null }
}

/* ---------------- 密码加密（bcrypt 优先，降级 pbkdf2；与云函数版哈希互通） ---------------- */
let bcrypt = null
try { bcrypt = require('bcryptjs') } catch (e) { bcrypt = null }

function hashPassword(plain) {
	if (bcrypt) return bcrypt.hashSync(String(plain), 10)
	const salt = crypto.randomBytes(16).toString('hex')
	const hash = crypto.pbkdf2Sync(String(plain), salt, 100000, 32, 'sha256').toString('hex')
	return 'pbkdf2$' + salt + '$' + hash
}
function verifyPassword(plain, hashed) {
	if (!hashed) return false
	if (String(hashed).startsWith('pbkdf2$')) {
		const [, salt, hash] = String(hashed).split('$')
		const calc = crypto.pbkdf2Sync(String(plain), salt, 100000, 32, 'sha256').toString('hex')
		return calc === hash
	}
	if (bcrypt) return bcrypt.compareSync(String(plain), hashed)
	throw new Error('bcryptjs 依赖未安装，无法校验 bcrypt 密码，请执行 npm install')
}

/* ---------------- 消息推送（可选：个推 REST API） ----------------
 * uni-push 2.0 底层即个推。客户端上报的 cid 就是 getui cid，直接可用。
 * .env 未配置 PUSH_APPID/PUSH_APPKEY/PUSH_MASTERSECRET 时静默跳过，
 * 客户端「轮询兜底」保证消息仍然自动到达（前台实时拉取，无需手动刷新）。
 */
let cachedPushToken = { token: '', expireAt: 0 }
async function getuiAuth() {
	const ts = String(Date.now())
	const signStr = crypto.createHash('sha256')
		.update(cfg.PUSH.appKey + ts + cfg.PUSH.masterSecret).digest('hex')
	const r = await fetch(`https://restapi.getui.com/v2/${cfg.PUSH.appId}/auth_sign`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json;charset=utf-8' },
		body: JSON.stringify({ sign: signStr, timestamp: ts, appkey: cfg.PUSH.appKey })
	})
	const j = await r.json()
	if (j.code !== 0) throw new Error('个推鉴权失败: ' + (j.msg || j.code))
	cachedPushToken = { token: j.data.token, expireAt: Date.now() + 20 * 3600 * 1000 }
	return cachedPushToken.token
}
async function sendPush(cids, title, content, payload) {
	if (!cids || !cids.length) return { sent: 0 }
	if (!cfg.PUSH.appId || !cfg.PUSH.appKey || !cfg.PUSH.masterSecret) {
		// 未配置推送 → 静默跳过（轮询兜底生效），不打扰日志
		return { sent: 0, skipped: true }
	}
	try {
		if (!cachedPushToken.token || Date.now() > cachedPushToken.expireAt) await getuiAuth()
		const r = await fetch(`https://restapi.getui.com/v2/${cfg.PUSH.appId}/push/single/cid`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json;charset=utf-8', token: cachedPushToken.token },
			body: JSON.stringify({
				request_id: rid(),
				audience: { cid: cids.slice(0, 500) },
				push_message: {
					notification: {
						title: title || 'MomoTalk',
						body: content || '',
						payload: payload || {}
					}
				}
			})
		})
		const j = await r.json()
		if (j.code === 10001) { // token 过期重试一次
			cachedPushToken = { token: '', expireAt: 0 }
			return sendPush(cids, title, content, payload)
		}
		return { sent: j.code === 0 ? cids.length : 0, res: j }
	} catch (e) {
		console.warn('[push] 推送失败（不影响业务，轮询兜底生效）:', e.message)
		return { sent: 0, error: e.message }
	}
}
/** 按用户 id 列表推送：自动查库拿每个人的 cid */
async function pushToUsers(uids, title, content, payload) {
	if (!uids || !uids.length) return { sent: 0 }
	const ph = uids.slice(0, 500).map(() => '?').join(',')
	const rows = await all(`SELECT cid FROM ${T.USERS} WHERE id IN (${ph}) AND cid<>''`, uids.slice(0, 500))
	const cids = rows.map(u => u.cid).filter(Boolean)
	return sendPush(cids, title, content, payload)
}

/* ---------------- 管理员操作日志（只增不删） ---------------- */
async function logAdmin(admin, action, detail, extra) {
	try {
		await exec(
			`INSERT INTO ${T.ADMIN_LOGS} (aid, adminName, action, detail, extra, createdAt) VALUES (?,?,?,?,?,?)`,
			[admin ? admin.aid : 'system', admin ? admin.username : 'system', action, detail, J(extra || {}), Date.now()]
		)
	} catch (e) {
		console.error('[common] 写管理日志失败:', e.message)
	}
}

/* ---------------- 金额（信用点）工具：内部一律用「分」为单位的整数 ---------------- */
function toCent(yuan) {
	const n = Math.round(Number(yuan) * 100)
	if (!isFinite(n) || n < 0) return NaN
	return n
}
function toYuan(cent) {
	return (Number(cent) || 0) / 100
}

module.exports = {
	T, ok, fail, rid, withId, sign,
	makeToken, verifyToken,
	hashPassword, verifyPassword,
	sendPush, pushToUsers,
	logAdmin,
	toCent, toYuan
}
