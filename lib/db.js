/**
 * lib/db.js —— MySQL 连接池 + 常用查询助手
 * 所有路由都用这里的助手函数操作数据库，不直接写连接逻辑。
 */
'use strict'
const mysql = require('mysql2/promise')
const cfg = require('../config')

// 连接池：最多10个连接，自动重连
const pool = mysql.createPool({
	host: cfg.DB.host,
	port: cfg.DB.port,
	user: cfg.DB.user,
	password: cfg.DB.password,
	database: cfg.DB.database,
	waitForConnections: true,
	connectionLimit: 10,
	charset: 'utf8mb4_unicode_ci',
	timezone: '+08:00',
	// JSON 字段自动解析由 mysql2 完成，无需额外配置
})

/** 查询多行：all('SELECT * FROM mt_users WHERE status=?', ['normal']) → [ {...}, ... ] */
async function all(sql, params = []) {
	const [rows] = await pool.query(sql, params)
	return rows
}
/** 查询单行：查不到返回 null */
async function one(sql, params = []) {
	const rows = await all(sql, params)
	return rows[0] || null
}
/** 执行写操作：返回 { affectedRows, insertId } */
async function exec(sql, params = []) {
	const [result] = await pool.query(sql, params)
	return result
}
/** 计数：count('SELECT COUNT(*) AS n FROM mt_users WHERE ...') → 数字 */
async function count(sql, params = []) {
	const row = await one(sql, params)
	return row ? Number(Object.values(row)[0]) : 0
}
/**
 * 事务：tx(async (conn) => { ... })
 * conn 提供与上面同名的 all/one/exec 方法，出错自动回滚。
 * 涉及资金（转账/红包）的操作必须放事务里，保证要么全成功要么全失败。
 */
async function tx(fn) {
	const conn = await pool.getConnection()
	const wrap = {
		all: async (sql, params = []) => (await conn.query(sql, params))[0],
		one: async (sql, params = []) => ((await conn.query(sql, params))[0] || [])[0] || null,
		exec: async (sql, params = []) => (await conn.query(sql, params))[0]
	}
	try {
		await conn.beginTransaction()
		const result = await fn(wrap)
		await conn.commit()
		return result
	} catch (e) {
		await conn.rollback()
		throw e
	} finally {
		conn.release()
	}
}

/** JSON 字段序列化助手：写库前把 JS 对象/数组转成 JSON 字符串 */
function J(v) {
	return JSON.stringify(v === undefined ? null : v)
}
/** 兼容读取：JSON 字段为 null/字符串时安全解析 */
function parseJ(v, fallback) {
	if (v === null || v === undefined) return fallback
	if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return fallback } }
	return v
}
/** LIKE 关键词转义（防止 % _ 干扰模糊搜索） */
function escLike(kw) {
	return String(kw || '').replace(/[\\%_]/g, '\\$&')
}

module.exports = { pool, all, one, exec, count, tx, J, parseJ, escLike }
