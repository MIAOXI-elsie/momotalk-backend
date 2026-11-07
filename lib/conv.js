/**
 * lib/conv.js —— 会话消息公共助手（im / wallet / admin 三个路由共用）
 * 由云函数版 im 里的 addConvMessage / addSystemMessage 移植，逻辑一致：
 *   1. 消息插入 mt_messages
 *   2. 会话表更新"最后一条消息"摘要
 *   3. 除发送者外所有成员未读数 +1（JSON 字段读-改-写，小团队规模足够安全）
 */
'use strict'
const C = require('./common')
const { one, exec, J, parseJ } = require('./db')

/**
 * 往会话里发一条消息
 * @param {String} convId  会话id
 * @param {String} fromUid 发送者uid（系统消息传 'system'）
 * @param {String} type    text/image/file/redpacket/system
 * @param {String} content 内容或文件URL
 * @param {Object} ext     附加数据（文件名/大小/红包id等）
 * @param {Object} opts    { silent:true 不推送 }
 */
async function addConvMessage(convId, fromUid, type, content, ext, opts = {}) {
	const now = Date.now()
	const msgId = C.rid()
	await exec(
		`INSERT INTO ${C.T.MESSAGES} (id, convId, fromUid, type, content, ext, status, createdAt) VALUES (?,?,?,?,?,?,?,?)`,
		[msgId, convId, fromUid, type, content, J(ext || {}), 'sent', now]
	)
	const conv = await one(`SELECT id, members, unread, dismissed FROM ${C.T.CONVERSATIONS} WHERE id=?`, [convId])
	if (!conv || conv.dismissed) return msgId
	// 更新会话摘要 + 未读数（除发送者外全部 +1）
	const members = parseJ(conv.members, [])
	const unread = parseJ(conv.unread, {})
	members.forEach(u => {
		if (u !== fromUid) unread[u] = (Number(unread[u]) || 0) + 1
	})
	await exec(
		`UPDATE ${C.T.CONVERSATIONS} SET lastMsg=?, lastMsgType=?, lastTs=?, unread=? WHERE id=?`,
		[String(content || '').slice(0, 50), type, now, J(unread), convId]
	)
	// 推送提醒（红包/群邀请等场景由调用方自行推送，这里默认推普通消息）
	if (!opts.silent && fromUid !== 'system' && members.length) {
		C.pushToUsers(members.filter(u => u !== fromUid).slice(0, 100), 'MomoTalk', '你有一条新消息', { type: 'chat', convId }).catch(() => {})
	}
	return msgId
}

/** 系统消息（撤回提示/红包领完/进群退群等，不推送） */
async function addSystemMessage(convId, text, ts) {
	return addConvMessage(convId, 'system', 'system', text, { at: ts || Date.now() }, { silent: true })
}

module.exports = { addConvMessage, addSystemMessage }
