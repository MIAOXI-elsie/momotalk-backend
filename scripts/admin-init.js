/**
 * ============================================================
 *  scripts/admin-init.js —— 创建第一个管理员账号（对应部署手册步骤10）
 * ============================================================
 *  用法：
 *    node scripts/admin-init.js admin MyPass123456          # 创建管理员
 *    node scripts/admin-init.js admin NewPass654 --force    # 重置已有管理员密码
 *
 *  安全说明：
 *   - 密码使用 bcrypt 加密后存储，数据库里看不到明文
 *   - 同名管理员已存在时不会覆盖（防止误运行重置密码），确需重置加 --force
 *   - 创建成功后即可用该账号登录「MomoTalk管理员」App
 */
'use strict'
require('dotenv').config()
const C = require('../lib/common')
const { one, exec } = require('../lib/db')

async function main() {
	const args = process.argv.slice(2)
	const force = args.includes('--force')
	const positional = args.filter(a => !a.startsWith('--'))
	const username = positional[0]
	const password = positional[1]

	if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
		console.error('用法: node scripts/admin-init.js <管理员账号3-20位字母数字下划线> <密码至少6位> [--force重置密码]')
		process.exit(1)
	}
	if (!password || password.length < 6) {
		console.error('密码至少6位。用法: node scripts/admin-init.js admin MyPass123456')
		process.exit(1)
	}

	const exists = await one(`SELECT id FROM ${C.T.ADMINS} WHERE username=?`, [username])
	if (exists) {
		if (!force) {
			console.error(`管理员「${username}」已存在。如需重置密码请加 --force 参数：`)
			console.error(`  node scripts/admin-init.js ${username} 新密码 --force`)
			process.exit(1)
		}
		await exec(`UPDATE ${C.T.ADMINS} SET passwordHash=?, updatedAt=? WHERE id=?`, [C.hashPassword(password), Date.now(), exists.id])
		console.log(`✅ 管理员「${username}」密码已重置（--force 模式）`)
		process.exit(0)
	}

	const now = Date.now()
	await exec(
		`INSERT INTO ${C.T.ADMINS} (id, username, passwordHash, nickname, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)`,
		[C.rid(), username, C.hashPassword(password), '超级管理员', 'normal', now, now]
	)
	console.log(`✅ 管理员「${username}」创建成功！现在可以打开「MomoTalk管理员」App 登录了。`)
	console.log('   请牢记密码，本脚本不提供明文找回（可用 --force 重置）。')
	process.exit(0)
}

main().catch(e => {
	console.error('❌ 初始化失败:', e.message)
	console.error('   → 先确认已执行过 node scripts/init-db.js 建表，且 .env 数据库配置正确')
	process.exit(1)
})
