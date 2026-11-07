/**
 * ============================================================
 *  routes/wallet.js —— MomoTalk 钱包（由云函数 wallet 完整移植）
 *  POST /api/wallet  body: { action, token, ... }
 *
 *  ⚠️ 声明：结算单位「信用点」为团队内部虚拟积分，不是法定货币，
 *     不对接任何现实支付渠道，仅限内部记账流转。
 *
 *  安全设计（与云函数版一致）：
 *   - 扣款一律条件更新（UPDATE ... WHERE balance>=金额），并发也不会透支
 *   - 红包领取放事务 + SELECT FOR UPDATE 行锁，防超抢
 *   - 每笔资金变动写入 mt_wallet_flows 流水，永久留痕
 *   - 金额内部一律用「分」为单位的整数，杜绝小数误差
 */
'use strict'
const C = require('../lib/common')
const { one, all, exec, count, tx, J, parseJ } = require('../lib/db')
const { addConvMessage, addSystemMessage } = require('../lib/conv')

// 红包有效期：24小时（过期未领完自动退回）
const RP_EXPIRE = 24 * 3600 * 1000

module.exports = async function handle(event) {
	try {
		const action = event.action
		const me = C.verifyToken(event.token)
		if (!me) return C.fail('登录已过期，请重新登录', 401)
		// 封禁/注销用户禁止资金操作
		const u = await one(`SELECT id, status, nickname, username FROM ${C.T.USERS} WHERE id=?`, [me.uid])
		if (!u) return C.fail('账号不存在', 401)
		if (u.status === 'banned') return C.fail('账号已被封禁，无法使用钱包', 403)
		if (u.status === 'deleted') return C.fail('账号已注销', 401)
		me.nickname = u.nickname || u.username

		switch (action) {
			case 'myWallet': return await myWallet(me)
			case 'transfer': return await transfer(event, me)
			case 'sendRedPacket': return await sendRedPacket(event, me)
			case 'grabRedPacket': return await grabRedPacket(event, me)
			case 'rpDetail': return await rpDetail(event, me)
			case 'myQrcodeData': return await myQrcodeData(me)
			case 'scanPay': return await scanPay(event, me)
			case 'bills': return await bills(event, me)
			default: return C.fail('未知操作: ' + action)
		}
	} catch (e) {
		console.error('[wallet] 异常:', e)
		return C.fail('服务器开小差了：' + (e.message || e))
	}
}

/* ============ 记账核心：带余额校验的扣款 + 入账 + 流水 ============ */

/** 扣款（原子条件更新）：只有余额足够才会成功 → { success, balance } */
async function debit(conn, uid, cent) {
	const r = await conn.exec(`UPDATE ${C.T.USERS} SET balance = balance - ? WHERE id = ? AND balance >= ?`, [cent, uid, cent])
	if (r.affectedRows === 0) {
		const cur = await conn.one(`SELECT balance FROM ${C.T.USERS} WHERE id=?`, [uid])
		return { success: false, balance: cur ? cur.balance : 0 }
	}
	const after = await conn.one(`SELECT balance FROM ${C.T.USERS} WHERE id=?`, [uid])
	return { success: true, balance: after.balance }
}
/** 入账（原子加钱），返回入账后余额 */
async function credit(conn, uid, cent) {
	await conn.exec(`UPDATE ${C.T.USERS} SET balance = balance + ? WHERE id = ?`, [cent, uid])
	const after = await conn.one(`SELECT balance FROM ${C.T.USERS} WHERE id=?`, [uid])
	return after.balance
}
/** 写一条流水（每笔资金变动都必须留痕） */
async function addFlow(conn, doc) {
	await conn.exec(
		`INSERT INTO ${C.T.FLOWS} (id, uid, type, delta, balanceAfter, otherUid, otherName, note, relatedId, miniappId, createdAt)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		[C.rid(), doc.uid, doc.type, doc.delta, doc.balanceAfter || 0, doc.otherUid || '', doc.otherName || '',
			doc.note || '', doc.relatedId || '', doc.miniappId || '', Date.now()]
	)
}

/* ============ 各业务 ============ */

// 我的钱包首页数据（余额 + 本月收支统计）
async function myWallet(me) {
	const u = await one(`SELECT balance FROM ${C.T.USERS} WHERE id=?`, [me.uid])
	const balance = u ? (u.balance || 0) : 0
	const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
	const flows = await all(
		`SELECT delta FROM ${C.T.FLOWS} WHERE uid=? AND createdAt>=? LIMIT 500`,
		[me.uid, monthStart.getTime()]
	)
	let income = 0, expense = 0
	flows.forEach(f => { if (f.delta > 0) income += f.delta; else expense += -f.delta })
	return C.ok({ balance, balanceYuan: C.toYuan(balance), monthIncome: C.toYuan(income), monthExpense: C.toYuan(expense) })
}

// 好友一对一转账
async function transfer(event, me) {
	const { toUid, amount, note } = event
	const cent = C.toCent(amount)
	if (!toUid) return C.fail('请选择收款好友')
	if (!cent || cent <= 0) return C.fail('转账金额必须大于0')
	if (cent > 100000000) return C.fail('单笔转账不能超过100万信用点')
	if (toUid === me.uid) return C.fail('不能给自己转账')
	// 必须是好友
	const f = await count(`SELECT COUNT(*) AS n FROM ${C.T.FRIENDSHIPS} WHERE owner=? AND friend=?`, [me.uid, toUid])
	if (f === 0) return C.fail('你们还不是好友，无法转账')
	const toUser = await one(`SELECT id, nickname, username, status, cid FROM ${C.T.USERS} WHERE id=?`, [toUid])
	if (!toUser || toUser.status !== 'normal') return C.fail('对方账号不可用')
	const toName = toUser.nickname || toUser.username

	// 事务：扣款（余额不足拦截）→ 对方入账 → 双方流水
	const txId = C.rid()
	const result = await tx(async (conn) => {
		const d = await debit(conn, me.uid, cent)
		if (!d.success) return { fail: `余额不足：本次转账需要 ${C.toYuan(cent)} 信用点，当前余额 ${C.toYuan(d.balance)} 信用点` }
		const balanceAfter = await credit(conn, toUid, cent)
		await addFlow(conn, { uid: me.uid, type: 'transfer_out', delta: -cent, balanceAfter: d.balance, otherUid: toUid, otherName: toName, note: note || '转账', relatedId: txId })
		await addFlow(conn, { uid: toUid, type: 'transfer_in', delta: cent, balanceAfter, otherUid: me.uid, otherName: me.nickname, note: note || '转账', relatedId: txId })
		return { balance: d.balance }
	})
	if (result.fail) return C.fail(result.fail)
	// 推送提醒收款人（事务提交后再推，推送失败不影响转账结果）
	if (toUser.cid) await C.sendPush([toUser.cid], 'MomoTalk 钱包', `${me.nickname} 向你转账 ${C.toYuan(cent)} 信用点`, { type: 'transfer' })
	return C.ok({ txId, balance: result.balance }, `转账成功：${C.toYuan(cent)} 信用点已转给 ${toName}`)
}

// 扫码付款（扫收款码后调用；收款人可以是任何正常用户）
async function scanPay(event, me) {
	const { toUid, amount, note } = event
	const cent = C.toCent(amount)
	if (!toUid || toUid === me.uid) return C.fail('收款码无效')
	if (!cent || cent <= 0) return C.fail('付款金额必须大于0')
	const toUser = await one(`SELECT id, nickname, username, status, cid FROM ${C.T.USERS} WHERE id=?`, [toUid])
	if (!toUser || toUser.status !== 'normal') return C.fail('收款方账号不可用')
	const toName = toUser.nickname || toUser.username

	const txId = C.rid()
	const result = await tx(async (conn) => {
		const d = await debit(conn, me.uid, cent)
		if (!d.success) return { fail: `余额不足：本次付款需要 ${C.toYuan(cent)} 信用点，当前余额 ${C.toYuan(d.balance)} 信用点` }
		const balanceAfter = await credit(conn, toUid, cent)
		await addFlow(conn, { uid: me.uid, type: 'scanpay_out', delta: -cent, balanceAfter: d.balance, otherUid: toUid, otherName: toName, note: note || '扫码付款', relatedId: txId })
		await addFlow(conn, { uid: toUid, type: 'scanpay_in', delta: cent, balanceAfter, otherUid: me.uid, otherName: me.nickname, note: note || '扫码收款', relatedId: txId })
		return { balance: d.balance }
	})
	if (result.fail) return C.fail(result.fail)
	if (toUser.cid) await C.sendPush([toUser.cid], 'MomoTalk 钱包', `收到 ${me.nickname} 扫码付款 ${C.toYuan(cent)} 信用点`, { type: 'transfer' })
	return C.ok({ txId, balance: result.balance }, `付款成功：${C.toYuan(cent)} 信用点`)
}

// 我的收款码数据（客户端用 qrcode.js 本地渲染成二维码图片）
async function myQrcodeData(me) {
	const u = await one(`SELECT username, nickname, avatar FROM ${C.T.USERS} WHERE id=?`, [me.uid])
	if (!u) return C.fail('账号不存在')
	// 收款码内容格式：momotalk://pay?uid=xxx&name=昵称（对方扫一扫识别后跳到付款页）
	const qrText = `momotalk://pay?uid=${me.uid}&name=${encodeURIComponent(u.nickname || u.username)}`
	return C.ok({ qrText, uid: me.uid, nickname: u.nickname, username: u.username, avatar: u.avatar })
}

// 发红包：toUid(私聊固定金额) 或 convId(群聊拼手气)
async function sendRedPacket(event, me) {
	const { toUid, convId, amount, count: rpNum, blessing } = event
	const totalCent = C.toCent(amount)
	if (!totalCent || totalCent <= 0) return C.fail('红包金额必须大于0')
	if (totalCent > 10000000) return C.fail('单个红包不能超过10万信用点')

	let cid = convId, isGroup = false
	if (toUid && !convId) {
		const f = await count(`SELECT COUNT(*) AS n FROM ${C.T.FRIENDSHIPS} WHERE owner=? AND friend=?`, [me.uid, toUid])
		if (f === 0) return C.fail('你们还不是好友，无法发红包')
		// 找私聊会话（与 im 相同的 key 规则）
		const key = [me.uid, toUid].sort().join('_')
		const c = await one(`SELECT id FROM ${C.T.CONVERSATIONS} WHERE \`key\`=? LIMIT 1`, [key])
		if (!c) return C.fail('会话不存在，请先给对方发一条消息')
		cid = c.id
	}
	if (!cid) return C.fail('缺少会话信息')
	const conv = await one(`SELECT * FROM ${C.T.CONVERSATIONS} WHERE id=?`, [cid])
	if (!conv || !parseJ(conv.members, []).includes(me.uid)) return C.fail('会话无效')
	isGroup = conv.type === 'group'

	let rpCount = 1
	if (isGroup) {
		rpCount = Math.max(1, Math.min(Number(rpNum) || 1, parseJ(conv.members, []).length - 1, 100))
		if (totalCent < rpCount) return C.fail(`红包个数不能多于金额（每个至少0.01信用点），当前最多 ${totalCent} 个`)
	}

	// 事务：先扣款（余额不足拦截）→ 创建红包 → 写流水
	const rpId = C.rid()
	const now = Date.now()
	const result = await tx(async (conn) => {
		const d = await debit(conn, me.uid, totalCent)
		if (!d.success) return { fail: `余额不足：发红包需要 ${C.toYuan(totalCent)} 信用点，当前余额 ${C.toYuan(d.balance)} 信用点` }
		await conn.exec(
			`INSERT INTO ${C.T.REDPACKETS}
			 (id, convId, fromUid, fromName, blessing, type, totalCent, totalCount, remainCent, remainCount, grabbed, status, createdAt, expireAt)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			[rpId, cid, me.uid, me.nickname, String(blessing || '恭喜发财，大吉大利').slice(0, 30),
				isGroup ? 'group' : 'single', totalCent, rpCount, totalCent, rpCount, J([]), 'active', now, now + RP_EXPIRE]
		)
		await addFlow(conn, { uid: me.uid, type: 'redpacket_out', delta: -totalCent, balanceAfter: d.balance, note: isGroup ? '发群红包' : '发红包', relatedId: rpId })
		return {}
	})
	if (result.fail) return C.fail(result.fail)
	// 会话里插入红包卡片消息 + 推送提醒（事务外执行，失败不影响红包）
	await addConvMessage(cid, me.uid, 'redpacket', `[红包] ${String(blessing || '恭喜发财，大吉大利').slice(0, 30)}`, { rpId }, { silent: true })
	const others = parseJ(conv.members, []).filter(u => u !== me.uid)
	if (others.length) {
		await C.pushToUsers(others.slice(0, 100), 'MomoTalk 红包', `${me.nickname} 发了一个红包：${String(blessing || '恭喜发财').slice(0, 20)}`, { type: 'chat', convId: cid })
	}
	return C.ok({ rpId, convId: cid }, '红包发送成功')
}

// 抢红包（事务 + 行锁，防并发超抢；过期自动退回发送者）
async function grabRedPacket(event, me) {
	const { rpId } = event
	// 先读一次做快速判断（不进事务，减少锁竞争）
	const rp0 = await one(`SELECT * FROM ${C.T.REDPACKETS} WHERE id=?`, [rpId])
	if (!rp0) return C.fail('红包不存在')
	const now0 = Date.now()

	// 过期处理：剩余金额自动退回发送者（也在事务里完成，防重复退款）
	if (now0 > rp0.expireAt) {
		await tx(async (conn) => {
			const rp = await conn.one(`SELECT * FROM ${C.T.REDPACKETS} WHERE id=? FOR UPDATE`, [rpId])
			if (rp && rp.status === 'active' && rp.remainCent > 0) {
				const back = await credit(conn, rp.fromUid, rp.remainCent)
				await addFlow(conn, { uid: rp.fromUid, type: 'redpacket_refund', delta: rp.remainCent, balanceAfter: back, note: '红包过期退回', relatedId: rpId })
				await conn.exec(`UPDATE ${C.T.REDPACKETS} SET status='expired_refunded', remainCent=0, remainCount=0 WHERE id=?`, [rpId])
			}
		})
		return C.fail('红包已过期，剩余金额已退回发送者')
	}

	// 领取（事务 + SELECT FOR UPDATE 行锁：同一红包同时只有一个人在结算）
	let grabbed = null
	const result = await tx(async (conn) => {
		const rp = await conn.one(`SELECT * FROM ${C.T.REDPACKETS} WHERE id=? FOR UPDATE`, [rpId])
		if (!rp) return { fail: '红包不存在' }
		const now = Date.now()
		if (now > rp.expireAt) return { fail: '红包已过期' } // 交给下一次调用做过期退款
		if (rp.status !== 'active') return { fail: '红包已被领完' }
		if (rp.fromUid === me.uid) return { fail: '不能抢自己发的红包' }
		const grabbedArr = parseJ(rp.grabbed, [])
		if (grabbedArr.some(g => g.uid === me.uid)) return { fail: '你已经领过这个红包了' }

		// 计算本次领取金额
		let cent
		if (rp.remainCount === 1) {
			cent = rp.remainCent // 最后一个：拿剩余全部
		} else if (rp.type === 'single') {
			cent = rp.totalCent
		} else {
			// 群红包拼手气：二倍均值法（随机 1分 ~ 剩余均值*2，保证后面的人有的抢）
			const max = Math.floor(rp.remainCent / rp.remainCount * 2)
			cent = Math.max(1, Math.floor(Math.random() * Math.max(1, max - 1)) + 1)
			cent = Math.min(cent, rp.remainCent - (rp.remainCount - 1)) // 给每人至少留1分
		}

		const newGrabbed = grabbedArr.concat([{ uid: me.uid, name: me.nickname, cent, at: now }])
		await conn.exec(
			`UPDATE ${C.T.REDPACKETS} SET remainCent=remainCent-?, remainCount=remainCount-1, grabbed=? WHERE id=? AND status='active' AND remainCount>=1 AND remainCent>=?`,
			[cent, J(newGrabbed), rpId, cent]
		)
		const balanceAfter = await credit(conn, me.uid, cent)
		await addFlow(conn, { uid: me.uid, type: 'redpacket_in', delta: cent, balanceAfter, otherUid: rp.fromUid, otherName: rp.fromName, note: '领红包', relatedId: rpId })
		grabbed = { cent, balanceAfter }

		// 领完了 → 标记结束 + 群内系统消息
		const after = await conn.one(`SELECT remainCount FROM ${C.T.REDPACKETS} WHERE id=?`, [rpId])
		if (after.remainCount === 0) {
			await conn.exec(`UPDATE ${C.T.REDPACKETS} SET status='finished' WHERE id=?`, [rpId])
		}
		return { rp, finished: after.remainCount === 0 }
	})
	if (result.fail) return C.fail(result.fail)
	if (result.finished) await addSystemMessage(result.rp.convId, '红包已被领完')

	// 推送告诉发送者（事务外，失败不影响领取结果）
	const sender = await one(`SELECT cid FROM ${C.T.USERS} WHERE id=?`, [result.rp.fromUid])
	if (sender && sender.cid) {
		await C.sendPush([sender.cid], 'MomoTalk 红包', `${me.nickname} 领取了你的红包 ${C.toYuan(grabbed.cent)} 信用点`, { type: 'chat', convId: result.rp.convId })
	}
	return C.ok({ cent: grabbed.cent, centYuan: C.toYuan(grabbed.cent), balance: grabbed.balanceAfter }, `领取成功：${C.toYuan(grabbed.cent)} 信用点`)
}

// 红包详情（领取记录；顺带做过期结算）
async function rpDetail(event, me) {
	let rp = await one(`SELECT * FROM ${C.T.REDPACKETS} WHERE id=?`, [event.rpId])
	if (!rp) return C.fail('红包不存在')
	// 非会话成员不可见
	const conv = await one(`SELECT members FROM ${C.T.CONVERSATIONS} WHERE id=?`, [rp.convId])
	if (!conv || !parseJ(conv.members, []).includes(me.uid)) return C.fail('无权查看该红包', 403)
	// 过期结算（与 grabRedPacket 相同的退款逻辑）
	if (Date.now() > rp.expireAt && rp.status === 'active' && rp.remainCent > 0) {
		await tx(async (conn) => {
			const r2 = await conn.one(`SELECT * FROM ${C.T.REDPACKETS} WHERE id=? FOR UPDATE`, [rp.id])
			if (r2 && r2.status === 'active' && r2.remainCent > 0) {
				const back = await credit(conn, r2.fromUid, r2.remainCent)
				await addFlow(conn, { uid: r2.fromUid, type: 'redpacket_refund', delta: r2.remainCent, balanceAfter: back, note: '红包过期退回', relatedId: r2.id })
				await conn.exec(`UPDATE ${C.T.REDPACKETS} SET status='expired_refunded', remainCent=0, remainCount=0 WHERE id=?`, [r2.id])
			}
		})
		rp = await one(`SELECT * FROM ${C.T.REDPACKETS} WHERE id=?`, [rp.id])
	}
	const grabbedArr = parseJ(rp.grabbed, [])
	const mine = grabbedArr.find(g => g.uid === me.uid) || null
	return C.ok({
		rpId: rp.id, fromUid: rp.fromUid, fromName: rp.fromName, blessing: rp.blessing,
		type: rp.type, totalYuan: C.toYuan(rp.totalCent), totalCount: rp.totalCount,
		remainCount: rp.remainCount, status: rp.status, expireAt: rp.expireAt, createdAt: rp.createdAt,
		isMine: rp.fromUid === me.uid,
		iGrabbed: mine ? C.toYuan(mine.cent) : null,
		grabbed: grabbedArr.map(g => ({ uid: g.uid, name: g.name, yuan: C.toYuan(g.cent), at: g.at }))
	})
}

// 我的收支流水（分页；type 可选过滤）
async function bills(event, me) {
	const page = Math.max(1, Number(event.page) || 1)
	const size = Math.min(50, Number(event.limit) || 20)
	const whereSql = event.type ? 'WHERE uid=? AND type=?' : 'WHERE uid=?'
	const whereParams = event.type ? [me.uid, event.type] : [me.uid]
	const total = await count(`SELECT COUNT(*) AS n FROM ${C.T.FLOWS} ${whereSql}`, whereParams)
	const rows = await all(
		`SELECT * FROM ${C.T.FLOWS} ${whereSql} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
		[...whereParams, size, (page - 1) * size]
	)
	const typeText = {
		transfer_out: '转账支出', transfer_in: '转账收入',
		scanpay_out: '扫码付款', scanpay_in: '扫码收款',
		redpacket_out: '发红包', redpacket_in: '领红包', redpacket_refund: '红包退回',
		admin_adjust: '管理员调整', register_gift: '注册赠送', miniapp_pay: '小程序消费'
	}
	return C.ok({
		total, page, size,
		list: rows.map(f => ({
			...C.withId(f), flowId: f.id,
			amountYuan: C.toYuan(Math.abs(f.delta)),
			income: f.delta > 0,
			typeText: typeText[f.type] || f.type
		}))
	})
}
