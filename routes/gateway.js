/**
 * ============================================================
 *  routes/gateway.js —— 小程序沙箱接口网关（由云函数 mt-gateway 完整移植）
 *  POST /api/gateway  body: { action, token, ... }
 *
 *  这是小程序唯一能调用的后端入口。所有请求必须携带运行令牌
 *  （打开小程序时由客户端注入），网关强制校验：
 *    ① 令牌合法且在有效期内（身份鉴权）
 *    ② 令牌对应的小程序处于「已上架」状态
 *    ③ 调用钱包类接口时，该小程序必须已被授予钱包权限（needWallet=1 且过审）
 *  任何一条不满足直接拒绝 —— 防止小程序越权调用钱包。
 *
 *  支持的接口：
 *   user.info       获取当前用户昵称/头像/uid（小程序展示用）
 *   wallet.balance  查询当前用户信用点余额
 *   wallet.pay      信用点支付：从小程序使用者账户扣款，付给小程序开发者
 */
'use strict'
const C = require('../lib/common')
const { one, exec, tx } = require('../lib/db')

module.exports = async function handle(body) {
	try {
		const token = body.token
		// ---- ① 校验运行令牌 ----
		const payload = C.verifyToken(token)
		if (!payload || payload.scope !== 'miniapp') return C.fail('身份鉴权失败：运行令牌无效或已过期，请重新打开小程序', 401)
		// ---- ② 校验小程序状态 ----
		const app = await one(`SELECT * FROM ${C.T.MINIAPPS} WHERE id=?`, [payload.appId])
		if (!app) return C.fail('小程序不存在', 404)
		if (app.status !== 'online') return C.fail('小程序已下架，接口禁止调用', 403)
		// ---- ③ 校验用户状态 ----
		const user = await one(
			`SELECT id, nickname, avatar, username, balance, status FROM ${C.T.USERS} WHERE id=?`,
			[payload.uid]
		)
		if (!user || user.status !== 'normal') return C.fail('用户账号不可用', 403)

		switch (body.action) {
			case 'user.info':
				return C.ok({ uid: payload.uid, nickname: user.nickname, avatar: user.avatar, username: user.username })

			case 'wallet.balance':
				// 钱包类接口：必须已被授予钱包权限
				if (!app.needWallet) return C.fail('该小程序未被授予钱包权限，禁止调用', 403)
				return C.ok({ balance: user.balance, balanceYuan: C.toYuan(user.balance) })

			case 'wallet.pay': {
				if (!app.needWallet) return C.fail('该小程序未被授予钱包权限，禁止调用', 403)
				const cent = C.toCent(body.amount)
				if (!cent || cent <= 0) return C.fail('支付金额无效')
				if (cent > 1000000) return C.fail('小程序单笔支付上限为 10000 信用点')
				// 收款方 = 小程序开发者（内部记账）
				const payeeUid = app.ownerUid
				if (payeeUid === payload.uid) return C.fail('不能支付给自己')
				const txId = C.rid()
				const now = Date.now()
				// 事务：原子扣款（余额不足拦截）→ 开发者入账 → 双方流水
				const result = await tx(async (conn) => {
					const upd = await conn.exec(
						`UPDATE ${C.T.USERS} SET balance = balance - ? WHERE id = ? AND balance >= ?`,
						[cent, payload.uid, cent]
					)
					if (upd.affectedRows === 0) return { fail: '余额不足，支付失败' }
					const after = await conn.one(`SELECT balance FROM ${C.T.USERS} WHERE id=?`, [payload.uid])
					await conn.exec(`UPDATE ${C.T.USERS} SET balance = balance + ? WHERE id = ?`, [cent, payeeUid])
					await conn.exec(
						`INSERT INTO ${C.T.FLOWS} (id, uid, type, delta, balanceAfter, otherUid, otherName, note, relatedId, miniappId, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
						[C.rid(), payload.uid, 'miniapp_pay', -cent, after.balance, payeeUid, app.ownerName || '开发者',
							`小程序「${app.name}」消费：${String(body.note || '').slice(0, 40)}`, txId, app.id, now]
					)
					await conn.exec(
						`INSERT INTO ${C.T.FLOWS} (id, uid, type, delta, balanceAfter, otherUid, otherName, note, relatedId, miniappId, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
						[C.rid(), payeeUid, 'miniapp_pay', cent, 0, payload.uid, user.nickname,
							`小程序「${app.name}」收入`, txId, app.id, now]
					)
					return { balance: after.balance }
				})
				if (result.fail) return C.fail(result.fail)
				return C.ok({ txId, paidYuan: C.toYuan(cent), balance: result.balance }, '支付成功')
			}
			default:
				return C.fail('未知接口: ' + body.action)
		}
	} catch (e) {
		console.error('[gateway] 异常:', e)
		return C.fail('网关异常：' + (e.message || e))
	}
}
