/**
 * ============================================================
 *  routes/im.js —— 即时通讯（由云函数 im 完整移植）
 *  POST /api/im  body: { action, token, ... }
 *
 *  好友/会话/消息/群聊/撤回/在线状态/公告广播弹窗，逻辑与云函数版一致。
 *  MongoDB 的数组字段（members/hiddenFor）与动态字段（unread）
 *  在 MySQL 中用 JSON 类型存储，成员查询用 JSON_CONTAINS。
 */
'use strict'
const C = require('../lib/common')
const { one, all, exec, count, J, parseJ, escLike } = require('../lib/db')
const { addConvMessage, addSystemMessage } = require('../lib/conv')

// 在线判定：2分钟内有心跳视为在线
const ONLINE_WINDOW = 2 * 60 * 1000
// 消息撤回时限：2分钟
const RECALL_WINDOW = 2 * 60 * 1000

module.exports = async function handle(event) {
	try {
		const action = event.action
		switch (action) {
			case 'searchUser': return await searchUser(event)
			case 'sendFriendRequest': return await withUser(event, sendFriendRequest)
			case 'friendRequests': return await withUser(event, friendRequests)
			case 'handleFriendRequest': return await withUser(event, handleFriendRequest)
			case 'friends': return await withUser(event, friends)
			case 'deleteFriend': return await withUser(event, deleteFriend)
			case 'conversations': return await withUser(event, conversations)
			case 'createGroup': return await withUser(event, createGroup)
			case 'getConvInfo': return await withUser(event, getConvInfo)
			case 'sendMessage': return await withUser(event, sendMessage, true)
			case 'openPrivate': return await withUser(event, openPrivate)
			case 'pullMessages': return await withUser(event, pullMessages)
			case 'markRead': return await withUser(event, markRead)
			case 'recallMessage': return await withUser(event, recallMessage)
			case 'groupLeave': return await withUser(event, groupLeave)
			case 'groupDismiss': return await withUser(event, groupDismiss)
			case 'heartbeat': return await withUser(event, heartbeat)
			case 'popups': return await popups(event) // 公告/广播未登录也可看，登录则带个性化
			case 'announcements': return await announcements(event)
			default: return C.fail('未知操作: ' + action)
		}
	} catch (e) {
		console.error('[im] 异常:', e)
		return C.fail('服务器开小差了：' + (e.message || e))
	}
}

/**
 * 登录态包装器：校验 token → （敏感操作）查库确认账号状态 → 执行业务
 */
async function withUser(event, fn, checkBan) {
	const me = C.verifyToken(event.token)
	if (!me) return C.fail('登录已过期，请重新登录', 401)
	if (checkBan) {
		const u = await one(`SELECT status FROM ${C.T.USERS} WHERE id=?`, [me.uid])
		if (!u) return C.fail('账号不存在', 401)
		if (u.status === 'banned') return C.fail('账号已被封禁，无法发言', 403)
		if (u.status === 'deleted') return C.fail('账号已注销', 401)
	}
	return fn(event, me)
}

/* ---------- 搜索用户（用户名精确 或 昵称模糊，最多20条） ---------- */
async function searchUser(event) {
	const kw = String(event.keyword || '').trim()
	if (!kw) return C.fail('请输入搜索关键词')
	const res = await all(
		`SELECT id, username, nickname, avatar, bio, status, lastActiveAt FROM ${C.T.USERS}
		 WHERE (username = ? OR nickname LIKE ?) LIMIT 20`,
		[kw, '%' + escLike(kw) + '%']
	)
	const now = Date.now()
	const me = C.verifyToken(event.token)
	const list = res
		.filter(u => u.status === 'normal' && (!me || u.id !== me.uid))
		.map(u => ({ ...C.withId(u), uid: u.id, online: now - (u.lastActiveAt || 0) < ONLINE_WINDOW }))
	return C.ok(list)
}

/* ---------- 好友申请 ---------- */
async function sendFriendRequest(event, me) {
	const { toUid, note } = event
	if (!toUid) return C.fail('缺少目标用户')
	if (toUid === me.uid) return C.fail('不能加自己为好友')
	// 对方是否存在且正常
	const to = await one(`SELECT id, username, nickname, status, cid FROM ${C.T.USERS} WHERE id=?`, [toUid])
	if (!to || to.status !== 'normal') return C.fail('对方账号不可用')
	// 已经是好友？
	const f = await count(`SELECT COUNT(*) AS n FROM ${C.T.FRIENDSHIPS} WHERE owner=? AND friend=?`, [me.uid, toUid])
	if (f > 0) return C.fail('你们已经是好友了')
	// 是否已有待处理申请（防重复）
	const dup = await count(`SELECT COUNT(*) AS n FROM ${C.T.FRIEND_REQUESTS} WHERE fromUid=? AND toUid=? AND status='pending'`, [me.uid, toUid])
	if (dup > 0) return C.fail('申请已发送，等待对方处理')
	const now = Date.now()
	const id = C.rid()
	await exec(
		`INSERT INTO ${C.T.FRIEND_REQUESTS} (id, fromUid, fromName, toUid, note, status, createdAt) VALUES (?,?,?,?,?,?,?)`,
		[id, me.uid, me.username, toUid, String(note || '').slice(0, 60), 'pending', now]
	)
	// 推送提醒对方（未配置推送则自动跳过）
	if (to.cid) await C.sendPush([to.cid], 'MomoTalk', `${me.username} 请求加你为好友`, { type: 'friend_request' })
	return C.ok({ reqId: id }, '好友申请已发送')
}

// 我收到的好友申请（按时间倒序，最多50条，补充申请人资料）
async function friendRequests(event, me) {
	const res = await all(`SELECT * FROM ${C.T.FRIEND_REQUESTS} WHERE toUid=? ORDER BY createdAt DESC LIMIT 50`, [me.uid])
	const uids = [...new Set(res.map(r => r.fromUid))]
	let umap = {}
	if (uids.length) {
		const users = await all(`SELECT id, nickname, avatar, username FROM ${C.T.USERS} WHERE id IN (${uids.map(() => '?').join(',')})`, uids)
		users.forEach(u => umap[u.id] = u)
	}
	return C.ok(res.map(r => ({
		...C.withId(r), reqId: r.id,
		fromUser: umap[r.fromUid] ? C.withId(umap[r.fromUid]) : { nickname: '未知用户', avatar: '' }
	})))
}

// 处理好友申请：accept=true 同意 / false 拒绝
async function handleFriendRequest(event, me) {
	const { reqId, accept } = event
	const req = await one(`SELECT * FROM ${C.T.FRIEND_REQUESTS} WHERE id=?`, [reqId])
	if (!req) return C.fail('申请不存在')
	if (req.toUid !== me.uid) return C.fail('无权处理该申请', 403)
	if (req.status !== 'pending') return C.fail('该申请已处理过')
	await exec(`UPDATE ${C.T.FRIEND_REQUESTS} SET status=?, handledAt=? WHERE id=?`, [accept ? 'accepted' : 'rejected', Date.now(), reqId])
	if (!accept) return C.ok(null, '已拒绝')
	// 同意 → 双向写入好友关系（唯一索引防并发重复）
	const now = Date.now()
	const other = await one(`SELECT id, nickname, avatar, username, cid FROM ${C.T.USERS} WHERE id=?`, [req.fromUid])
	const exists = await count(`SELECT COUNT(*) AS n FROM ${C.T.FRIENDSHIPS} WHERE owner=? AND friend=?`, [me.uid, req.fromUid])
	if (exists === 0) {
		await exec(`INSERT IGNORE INTO ${C.T.FRIENDSHIPS} (id, owner, friend, createdAt) VALUES (?,?,?,?)`, [C.rid(), me.uid, req.fromUid, now])
		await exec(`INSERT IGNORE INTO ${C.T.FRIENDSHIPS} (id, owner, friend, createdAt) VALUES (?,?,?,?)`, [C.rid(), req.fromUid, me.uid, now])
	}
	// 自动创建私聊会话并发一条系统消息
	const convId = await ensurePrivateConv(me.uid, req.fromUid)
	await addSystemMessage(convId, '你们已成为好友，开始聊天吧～', now)
	// 推送通知对方
	if (other && other.cid) {
		await C.sendPush([other.cid], 'MomoTalk', `${me.username} 已同意你的好友申请`, { type: 'friend_accepted', convId })
	}
	return C.ok({ convId }, '已添加为好友')
}

/* ---------- 好友列表（含在线状态） ---------- */
async function friends(event, me) {
	const res = await all(`SELECT friend FROM ${C.T.FRIENDSHIPS} WHERE owner=? LIMIT 500`, [me.uid])
	const fids = res.map(f => f.friend)
	if (!fids.length) return C.ok([])
	const ur = await all(
		`SELECT id, username, nickname, avatar, bio, status, lastActiveAt FROM ${C.T.USERS} WHERE id IN (${fids.map(() => '?').join(',')})`,
		fids
	)
	const now = Date.now()
	const list = ur
		.filter(u => u.status !== 'deleted')
		.map(u => ({
			uid: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar, bio: u.bio,
			banned: u.status === 'banned',
			online: now - (u.lastActiveAt || 0) < ONLINE_WINDOW
		}))
		.sort((a, b) => a.nickname.localeCompare(b.nickname, 'zh'))
	return C.ok(list)
}

/* ---------- 删除好友（双向删除） ---------- */
async function deleteFriend(event, me) {
	const { uid } = event
	if (!uid) return C.fail('参数缺失')
	await exec(
		`DELETE FROM ${C.T.FRIENDSHIPS} WHERE (owner=? AND friend=?) OR (owner=? AND friend=?)`,
		[me.uid, uid, uid, me.uid]
	)
	return C.ok(null, '已删除好友')
}

/* ---------- 私聊会话：不存在则创建（幂等） ----------
 * 私聊会话用固定 key = 两个uid排序后拼接，保证同一对人只有一个会话 */
async function ensurePrivateConv(uid1, uid2) {
	const key = [uid1, uid2].sort().join('_')
	const row = await one(`SELECT * FROM ${C.T.CONVERSATIONS} WHERE \`key\`=? LIMIT 1`, [key])
	if (row) {
		// 会话可能被某方删除过（hiddenFor），重新对双方可见
		const hiddenFor = parseJ(row.hiddenFor, []).filter(u => u !== uid1 && u !== uid2)
		await exec(`UPDATE ${C.T.CONVERSATIONS} SET hiddenFor=? WHERE id=?`, [J(hiddenFor), row.id])
		return row.id
	}
	const now = Date.now()
	const id = C.rid()
	await exec(
		`INSERT INTO ${C.T.CONVERSATIONS}
		 (id, type, \`key\`, members, name, avatar, owner, lastMsg, lastMsgType, lastTs, unread, hiddenFor, dismissed, createdAt)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		[id, 'private', key, J([uid1, uid2]), '', '', '', '', 'system', now, J({ [uid1]: 0, [uid2]: 0 }), J([]), 0, now]
	)
	return id
}

/* ---------- 会话列表 ---------- */
async function conversations(event, me) {
	const res = await all(
		`SELECT * FROM ${C.T.CONVERSATIONS}
		 WHERE JSON_CONTAINS(members, JSON_QUOTE(?)) AND NOT JSON_CONTAINS(hiddenFor, JSON_QUOTE(?)) AND dismissed=0
		 ORDER BY lastTs DESC LIMIT 200`,
		[me.uid, me.uid]
	)
	if (!res.length) return C.ok([])
	// 收集所有相关用户，批量查昵称头像
	const uids = [...new Set(res.flatMap(c => parseJ(c.members, [])))]
	let umap = {}
	if (uids.length) {
		const ur = await all(
			`SELECT id, nickname, avatar, username, lastActiveAt FROM ${C.T.USERS} WHERE id IN (${uids.map(() => '?').join(',')})`,
			uids
		)
		ur.forEach(u => umap[u.id] = u)
	}
	const now = Date.now()
	const list = res.map(c => {
		const members = parseJ(c.members, [])
		const unread = parseJ(c.unread, {})
		const item = {
			convId: c.id, type: c.type, name: c.name, avatar: c.avatar,
			lastMsg: c.lastMsg || '', lastMsgType: c.lastMsgType || 'text', lastTs: c.lastTs || 0,
			unread: Number(unread[me.uid]) || 0,
			memberCount: members.length
		}
		if (c.type === 'private') {
			// 私聊：显示对方信息
			const otherUid = members.find(u => u !== me.uid)
			const other = umap[otherUid] || {}
			item.otherUid = otherUid
			item.name = other.nickname || other.username || '未知用户'
			item.avatar = other.avatar || ''
			item.online = now - (other.lastActiveAt || 0) < ONLINE_WINDOW
		}
		return item
	})
	return C.ok(list)
}

/* ---------- 创建群聊 ---------- */
async function createGroup(event, me) {
	const { name, memberUids } = event
	if (!name || !String(name).trim()) return C.fail('请输入群名称')
	const members = [...new Set([me.uid, ...(memberUids || [])])]
	if (members.length < 3) return C.fail('群聊至少需要3人（含自己）')
	if (members.length > 200) return C.fail('群成员不能超过200人')
	const now = Date.now()
	const convId = C.rid()
	await exec(
		`INSERT INTO ${C.T.CONVERSATIONS}
		 (id, type, \`key\`, members, name, avatar, owner, lastMsg, lastMsgType, lastTs, unread, hiddenFor, dismissed, createdAt)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		[convId, 'group', null, J(members), String(name).trim().slice(0, 20), '', me.uid, '', 'system', now,
			J(Object.fromEntries(members.map(u => [u, 0]))), J([]), 0, now]
	)
	// 系统消息 + 推送
	await addSystemMessage(convId, `群聊「${String(name).trim()}」创建成功`, now)
	await C.pushToUsers(members.filter(u => u !== me.uid), 'MomoTalk', `你被邀请加入群聊「${name}」`, { type: 'chat', convId })
	return C.ok({ convId }, '群聊创建成功')
}

/* ---------- 会话详情（聊天页顶部用） ---------- */
async function getConvInfo(event, me) {
	const conv = await one(`SELECT * FROM ${C.T.CONVERSATIONS} WHERE id=?`, [event.convId])
	if (!conv) return C.fail('会话不存在')
	const members = parseJ(conv.members, [])
	if (!members.includes(me.uid)) return C.fail('你不在该会话中', 403)
	if (conv.type === 'private') {
		const otherUid = members.find(u => u !== me.uid)
		const other = await one(`SELECT id, nickname, avatar, username, bio, lastActiveAt FROM ${C.T.USERS} WHERE id=?`, [otherUid])
		return C.ok({
			convId: conv.id, type: 'private',
			name: other ? (other.nickname || other.username) : '未知用户',
			avatar: other ? other.avatar : '',
			otherUid,
			online: other ? Date.now() - (other.lastActiveAt || 0) < ONLINE_WINDOW : false,
			memberCount: 2
		})
	}
	// 群聊：附成员列表
	let list = []
	if (members.length) {
		const ur = await all(
			`SELECT id, nickname, avatar, username, lastActiveAt FROM ${C.T.USERS} WHERE id IN (${members.map(() => '?').join(',')})`,
			members
		)
		const now = Date.now()
		list = ur.map(u => ({
			uid: u.id, nickname: u.nickname, avatar: u.avatar,
			isOwner: u.id === conv.owner,
			online: now - (u.lastActiveAt || 0) < ONLINE_WINDOW
		}))
	}
	return C.ok({
		convId: conv.id, type: 'group', name: conv.name, avatar: conv.avatar,
		owner: conv.owner, memberCount: members.length, members: list
	})
}

/* ---------- 打开与某人的私聊（没有会话则自动创建） ---------- */
async function openPrivate(event, me) {
	const convId = await ensurePrivateConv(me.uid, event.toUid)
	return C.ok({ convId })
}

/* ---------- 发送消息 ---------- */
async function sendMessage(event, me) {
	const { convId, type, content, ext } = event
	if (!convId) return C.fail('缺少会话id')
	const t = ['text', 'image', 'file'].includes(type) ? type : 'text'
	if (t === 'text' && !String(content || '').trim()) return C.fail('消息内容不能为空')
	if (String(content || '').length > 5000) return C.fail('单条消息不能超过5000字')
	const conv = await one(`SELECT * FROM ${C.T.CONVERSATIONS} WHERE id=?`, [convId])
	if (!conv || conv.dismissed) return C.fail('会话不存在')
	const members = parseJ(conv.members, [])
	if (!members.includes(me.uid)) return C.fail('你不在该会话中', 403)
	// addConvMessage 内部完成：插消息 + 更新会话摘要 + 其他成员未读+1 + 推送
	const msgId = await addConvMessage(convId, me.uid, t, content, ext)
	return C.ok({ msgId, createdAt: Date.now() }, '已发送')
}

/* ---------- 拉取消息（beforeTs 往前翻页 / afterTs 增量拉新） ---------- */
async function pullMessages(event, me) {
	const { convId, beforeTs, afterTs, limit } = event
	const size = Math.min(100, Math.max(1, Number(limit) || 30))
	const conv = await one(`SELECT id, members FROM ${C.T.CONVERSATIONS} WHERE id=?`, [convId])
	if (!conv || !parseJ(conv.members, []).includes(me.uid)) return C.fail('会话不存在或无权限', 403)
	let rows
	if (afterTs) {
		// 增量拉新：正序返回
		rows = await all(
			`SELECT * FROM ${C.T.MESSAGES} WHERE convId=? AND createdAt>? ORDER BY createdAt ASC LIMIT 500`,
			[convId, Number(afterTs)]
		)
	} else if (beforeTs) {
		// 往前翻页：倒序取再反转
		rows = await all(
			`SELECT * FROM ${C.T.MESSAGES} WHERE convId=? AND createdAt<? ORDER BY createdAt DESC LIMIT ?`,
			[convId, Number(beforeTs), size]
		)
		rows.reverse()
	} else {
		rows = await all(
			`SELECT * FROM ${C.T.MESSAGES} WHERE convId=? ORDER BY createdAt DESC LIMIT ?`,
			[convId, size]
		)
		rows.reverse()
	}
	return C.ok(await fillMsgs(rows, me))
}

// 批量补充消息发送者的昵称头像（内部复用）
async function fillMsgs(msgs, me) {
	const uids = [...new Set(msgs.map(m => m.fromUid).filter(u => u !== 'system'))]
	let umap = {}
	if (uids.length) {
		const ur = await all(`SELECT id, nickname, avatar FROM ${C.T.USERS} WHERE id IN (${uids.map(() => '?').join(',')})`, uids)
		ur.forEach(u => umap[u.id] = u)
	}
	return msgs.map(m => ({
		...C.withId(m), msgId: m.id,
		ext: parseJ(m.ext, {}),
		fromName: (umap[m.fromUid] || {}).nickname || '',
		fromAvatar: (umap[m.fromUid] || {}).avatar || '',
		isMine: m.fromUid === me.uid
	}))
}

/* ---------- 标记已读（未读清零 + 从"已删除列表"恢复） ---------- */
async function markRead(event, me) {
	if (!event.convId) return C.fail('缺少会话id')
	const conv = await one(`SELECT id, unread, hiddenFor FROM ${C.T.CONVERSATIONS} WHERE id=?`, [event.convId])
	if (!conv) return C.fail('会话不存在')
	const unread = parseJ(conv.unread, {})
	unread[me.uid] = 0
	const hiddenFor = parseJ(conv.hiddenFor, []).filter(u => u !== me.uid)
	await exec(`UPDATE ${C.T.CONVERSATIONS} SET unread=?, hiddenFor=? WHERE id=?`, [J(unread), J(hiddenFor), conv.id])
	return C.ok()
}

/* ---------- 撤回消息（2分钟内、仅自己） ---------- */
async function recallMessage(event, me) {
	const msg = await one(`SELECT * FROM ${C.T.MESSAGES} WHERE id=?`, [event.msgId])
	if (!msg) return C.fail('消息不存在')
	if (msg.fromUid !== me.uid) return C.fail('只能撤回自己的消息', 403)
	if (Date.now() - msg.createdAt > RECALL_WINDOW) return C.fail('发送超过2分钟的消息不能撤回')
	await exec(`UPDATE ${C.T.MESSAGES} SET status='recalled', content='' WHERE id=?`, [event.msgId])
	// 若会话最后一条是被撤回的消息，更新摘要
	const conv = await one(`SELECT id, lastTs FROM ${C.T.CONVERSATIONS} WHERE id=?`, [msg.convId])
	if (conv && conv.lastTs === msg.createdAt) {
		await exec(`UPDATE ${C.T.CONVERSATIONS} SET lastMsg='[消息已撤回]', lastMsgType='system' WHERE id=?`, [msg.convId])
	}
	return C.ok(null, '消息已撤回')
}

/* ---------- 退出群聊 ---------- */
async function groupLeave(event, me) {
	const conv = await one(`SELECT * FROM ${C.T.CONVERSATIONS} WHERE id=?`, [event.convId])
	if (!conv || conv.type !== 'group') return C.fail('群聊不存在')
	if (conv.owner === me.uid) return C.fail('群主不能退群，请选择解散群聊')
	const members = parseJ(conv.members, []).filter(u => u !== me.uid)
	const unread = parseJ(conv.unread, {})
	delete unread[me.uid]
	await exec(`UPDATE ${C.T.CONVERSATIONS} SET members=?, unread=? WHERE id=?`, [J(members), J(unread), conv.id])
	await addSystemMessage(conv.id, `${me.username} 退出了群聊`)
	return C.ok(null, '已退出群聊')
}

/* ---------- 解散群聊（仅群主） ---------- */
async function groupDismiss(event, me) {
	const conv = await one(`SELECT * FROM ${C.T.CONVERSATIONS} WHERE id=?`, [event.convId])
	if (!conv || conv.type !== 'group') return C.fail('群聊不存在')
	if (conv.owner !== me.uid) return C.fail('只有群主可以解散群聊', 403)
	await addSystemMessage(conv.id, '群主解散了该群聊')
	await exec(`UPDATE ${C.T.CONVERSATIONS} SET members=?, dismissed=1 WHERE id=?`, [J([]), conv.id])
	return C.ok(null, '群聊已解散')
}

/* ---------- 心跳（在线状态） ---------- */
async function heartbeat(event, me) {
	await exec(`UPDATE ${C.T.USERS} SET lastActiveAt=? WHERE id=?`, [Date.now(), me.uid])
	return C.ok({ serverTime: Date.now() })
}

/* ---------- 公告历史列表（只返回已发布的，置顶在前） ---------- */
async function announcements(event) {
	const res = await all(
		`SELECT * FROM ${C.T.ANNOUNCEMENTS} WHERE published=1 ORDER BY pinned DESC, updatedAt DESC LIMIT 100`
	)
	return C.ok(res.map(a => ({
		annId: a.id, title: a.title, content: a.content,
		pinned: !!a.pinned, updatedBy: a.updatedBy || a.createdBy || '管理员',
		updatedAt: a.updatedAt || a.createdAt
	})))
}

/* ---------- 启动弹窗数据：置顶公告 + 我的未读广播 ---------- */
async function popups(event) {
	const sinceTs = Number(event.sinceTs) || 0
	// 1. 最新一条置顶公告
	const ann = await one(
		`SELECT * FROM ${C.T.ANNOUNCEMENTS} WHERE pinned=1 AND published=1 ORDER BY updatedAt DESC LIMIT 1`
	)
	// 2. 新广播（全部用户 或 点名到我）
	const me = C.verifyToken(event.token)
	let broadcasts = []
	if (me) {
		const bRes = await all(
			`SELECT * FROM ${C.T.BROADCASTS} WHERE createdAt>? ORDER BY createdAt DESC LIMIT 10`,
			[sinceTs]
		)
		broadcasts = bRes
			.map(b => ({ ...b, uids: parseJ(b.uids, []) }))
			.filter(b => b.uids === 'ALL' || (Array.isArray(b.uids) && b.uids.includes(me.uid)))
	}
	return C.ok({
		announcement: ann ? C.withId(ann) : null,
		broadcasts
	})
}
