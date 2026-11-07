/**
 * config.js —— 读取 .env 配置并导出（全项目唯一配置入口）
 */
'use strict'
require('dotenv').config()

const path = require('path')

module.exports = {
	PORT: Number(process.env.PORT || 3000),
	DB: {
		host: process.env.DB_HOST || '127.0.0.1',
		port: Number(process.env.DB_PORT || 3306),
		user: process.env.DB_USER || 'root',
		password: process.env.DB_PASSWORD || '',
		database: process.env.DB_NAME || 'momotalk',
		// 是否强制 TLS 连接。TiDB Cloud / 云数据库一般要求开；本机或内网 MySQL 可关
		ssl: ['1', 'true', 'yes'].includes(String(process.env.DB_SSL || '').toLowerCase())
	},
	// 令牌签名密钥（务必在 .env 里改掉默认值！）
	SECRET: process.env.SECRET || 'CHANGE_ME_TO_A_RANDOM_STRING_32+',
	// 对外访问地址（末尾不带 /）
	PUBLIC_BASE_URL: String(process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
	UPLOAD_DIR: path.resolve(__dirname, process.env.UPLOAD_DIR || './uploads'),
	MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB || 50),
	PUSH: {
		appId: process.env.PUSH_APPID || '',
		appKey: process.env.PUSH_APPKEY || '',
		masterSecret: process.env.PUSH_MASTERSECRET || ''
	}
}
