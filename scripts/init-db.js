/**
 * ============================================================
 *  scripts/init-db.js —— 一键建库建表（小白友好版）
 * ============================================================
 *  用法：node scripts/init-db.js
 *  作用：读取 sql/init.sql 并执行 —— 自动创建 momotalk 数据库和全部 12 张表。
 *  前提：.env 里的 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD 已填对
 *       （本脚本建库阶段不需要 DB_NAME 已存在，会自动 CREATE DATABASE）
 *  已存在的表不会被覆盖（脚本里全部是 CREATE TABLE IF NOT EXISTS），可放心重复执行。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const mysql = require('mysql2/promise')
require('dotenv').config()

async function main() {
	const sqlFile = path.join(__dirname, '..', 'sql', 'init.sql')
	const sql = fs.readFileSync(sqlFile, 'utf8')
	console.log('正在连接 MySQL:', process.env.DB_HOST || '127.0.0.1', ':', process.env.DB_PORT || '3306')
	// 注意：不指定 database（脚本自己 CREATE DATABASE + USE），开启多语句执行
	const conn = await mysql.createConnection({
		host: process.env.DB_HOST || '127.0.0.1',
		port: Number(process.env.DB_PORT || 3306),
		user: process.env.DB_USER || 'root',
		password: process.env.DB_PASSWORD || '',
		multipleStatements: true
	})
	await conn.query(sql)
	// 校验建表结果
	const [tables] = await conn.query('SHOW TABLES FROM momotalk')
	console.log('✅ 建库建表完成！momotalk 数据库现有', tables.length, '张表：')
	tables.forEach(t => console.log('   -', Object.values(t)[0]))
	await conn.end()
	console.log('下一步：node scripts/admin-init.js 你的管理员账号 你的密码   （创建第一个管理员）')
}

main().catch(e => {
	console.error('❌ 初始化失败:', e.message)
	if (e.code === 'ECONNREFUSED') console.error('   → MySQL 没启动，或 .env 里 DB_HOST/DB_PORT 填错了')
	if (e.code === 'ER_ACCESS_DENIED_ERROR') console.error('   → .env 里 DB_USER/DB_PASSWORD 不对')
	process.exit(1)
})
