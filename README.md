# MomoTalk 后端（Node.js + Express + MySQL）

独立后端服务，用于 MomoTalk 客户端（聊天 / 钱包 / 小程序网关 / 管理后台）。

## 目录结构

```
app.js              入口，挂载全部路由，监听 0.0.0.0:PORT
config.js           全项目唯一配置入口（读取环境变量）
lib/                公共库（db、工具函数、会话）
routes/             user / im / wallet / miniapp / admin / gateway 六个模块
scripts/            init-db.js 建表初始化、admin-init.js 管理员初始化
sql/init.sql        建表脚本（12 张表，对应原 uniCloud schema）
.env.example        环境变量模板
```

## 环境变量

| Key | 说明 |
|---|---|
| PORT | 监听端口（Render 会自动注入，代码读 `process.env.PORT`） |
| DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME | MySQL 连接（TiDB Cloud 端口是 **4000**） |
| DB_SSL | 是否强制 TLS。云数据库填 `true`，本机填 `false` |
| SECRET | 令牌签名密钥，必须改成 32 位以上随机字符串 |
| PUBLIC_BASE_URL | 对外访问地址，用于拼接上传文件完整 URL |
| UPLOAD_DIR / MAX_UPLOAD_MB | 上传目录与单文件大小上限（默认 ./uploads / 50MB） |
| PUSH_APPID / PUSH_APPKEY / PUSH_MASTERSECRET | 可选，个推推送，不填则关闭推送走轮询兜底 |

## 本地 / 云主机运行

```bash
npm install
cp .env.example .env    # 按实际情况修改
npm run init-db         # 首次建表
npm run init-admin      # 首次创建管理员
npm start
```

健康检查：`GET /api/health`

## 部署到 Render

- Build Command：`npm install`
- Start Command：`node app.js`
- 环境变量按上表在 Render 面板逐个填写（不要提交 .env 文件）
- 注意：`uploads` 目录为容器本地存储，Render 重新部署会丢失，聊天图片如需持久化请改用对象存储
