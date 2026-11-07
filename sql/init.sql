-- ============================================================
--  MomoTalk MySQL 建表脚本（ECS 版）
--  与 uniCloud 版 12 张 schema 一一对应；时间戳一律 BIGINT 毫秒（Date.now()）
--  金额一律 INT「分」为单位（1信用点=100分），杜绝浮点误差
--  JSON 类型字段：MySQL 5.7+ / 8.0 均支持
--
--  使用方法（部署手册步骤3）：
--    mysql -u root -p < init.sql
--  或在宝塔/Navicat 等工具里整体执行本文件
-- ============================================================

CREATE DATABASE IF NOT EXISTS momotalk DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE momotalk;

-- ---------- 用户表 ----------
CREATE TABLE IF NOT EXISTS mt_users (
  id               CHAR(32)     NOT NULL COMMENT '用户ID（32位随机hex）',
  username         VARCHAR(20)  NOT NULL COMMENT '用户名（3-20位字母数字下划线，唯一）',
  passwordHash     VARCHAR(100) NOT NULL COMMENT '密码哈希（bcrypt，绝不存明文）',
  nickname         VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '昵称',
  avatar           VARCHAR(500) NOT NULL DEFAULT '' COMMENT '头像URL（文件本体在uploads/，库里只存地址）',
  bio              VARCHAR(60)  NOT NULL DEFAULT '' COMMENT '个性签名',
  balance          INT          NOT NULL DEFAULT 0 COMMENT '信用点余额（单位：分）',
  status           VARCHAR(20)  NOT NULL DEFAULT 'normal' COMMENT '状态：normal正常/banned封禁/pending_deletion注销审核中/deleted已注销',
  banReason        VARCHAR(100) NOT NULL DEFAULT '' COMMENT '封禁理由',
  bannedAt         BIGINT       NULL COMMENT '封禁时间',
  bannedBy         VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '封禁操作管理员',
  cid              VARCHAR(100) NOT NULL DEFAULT '' COMMENT '推送客户端id（个推cid，登录后上报）',
  securityQ        VARCHAR(100) NOT NULL DEFAULT '' COMMENT '密保问题（找回密码用）',
  securityA        VARCHAR(100) NOT NULL DEFAULT '' COMMENT '密保答案哈希（bcrypt，不存明文）',
  deactivateReason VARCHAR(200) NOT NULL DEFAULT '' COMMENT '注销申请原因',
  deactivateAt     BIGINT       NULL COMMENT '注销申请时间',
  deletedAt        BIGINT       NULL COMMENT '注销生效时间',
  deletedBy        VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '批准注销的管理员',
  lastActiveAt     BIGINT       NOT NULL DEFAULT 0 COMMENT '最后活跃时间（心跳/登录时更新，在线状态依据）',
  createdAt        BIGINT       NOT NULL DEFAULT 0 COMMENT '注册时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username),
  KEY idx_status (status),
  KEY idx_lastActive (lastActiveAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表';

-- ---------- 管理员表（与用户表完全隔离的独立账号体系） ----------
CREATE TABLE IF NOT EXISTS mt_admins (
  id           CHAR(32)     NOT NULL COMMENT '管理员ID',
  username     VARCHAR(20)  NOT NULL COMMENT '管理员用户名（唯一）',
  passwordHash VARCHAR(100) NOT NULL COMMENT '密码哈希（bcrypt）',
  nickname     VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '管理员昵称',
  status       VARCHAR(10)  NOT NULL DEFAULT 'normal' COMMENT 'normal可用/disabled停用',
  createdAt    BIGINT       NOT NULL DEFAULT 0,
  updatedAt    BIGINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理员表';

-- ---------- 好友关系表（双向各存一条） ----------
CREATE TABLE IF NOT EXISTS mt_friendships (
  id        CHAR(32) NOT NULL,
  owner     CHAR(32) NOT NULL COMMENT '关系拥有者uid',
  friend    CHAR(32) NOT NULL COMMENT '好友uid',
  createdAt BIGINT   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_owner_friend (owner, friend),
  KEY idx_owner (owner)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='好友关系表';

-- ---------- 好友申请表 ----------
CREATE TABLE IF NOT EXISTS mt_friend_requests (
  id        CHAR(32)    NOT NULL COMMENT '申请ID',
  fromUid   CHAR(32)    NOT NULL COMMENT '申请人uid',
  fromName  VARCHAR(20) NOT NULL DEFAULT '' COMMENT '申请人用户名（冗余，列表展示用）',
  toUid     CHAR(32)    NOT NULL COMMENT '被申请人uid',
  note      VARCHAR(60) NOT NULL DEFAULT '' COMMENT '验证消息',
  status    VARCHAR(10) NOT NULL DEFAULT 'pending' COMMENT 'pending待处理/accepted已同意/rejected已拒绝',
  createdAt BIGINT      NOT NULL DEFAULT 0,
  handledAt BIGINT      NULL COMMENT '处理时间',
  PRIMARY KEY (id),
  KEY idx_toUid (toUid, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='好友申请表';

-- ---------- 会话表（单聊/群聊） ----------
CREATE TABLE IF NOT EXISTS mt_conversations (
  id          CHAR(32)     NOT NULL COMMENT '会话ID',
  type        VARCHAR(10)  NOT NULL DEFAULT 'private' COMMENT 'private单聊/group群聊',
  `key`       CHAR(65)     NULL COMMENT '单聊唯一key=两uid排序拼接（群聊为NULL）',
  members     JSON         NOT NULL COMMENT '成员uid数组，如 ["uid1","uid2"]',
  name        VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '群名称',
  avatar      VARCHAR(500) NOT NULL DEFAULT '' COMMENT '群头像URL',
  owner       CHAR(32)     NOT NULL DEFAULT '' COMMENT '群主uid',
  lastMsg     VARCHAR(200) NOT NULL DEFAULT '' COMMENT '最后一条消息摘要',
  lastMsgType VARCHAR(10)  NOT NULL DEFAULT 'text',
  lastTs      BIGINT       NOT NULL DEFAULT 0 COMMENT '最后消息时间（会话列表排序依据）',
  unread      JSON         NOT NULL COMMENT '未读数映射 {"uid1":2,"uid2":0}',
  hiddenFor   JSON         NOT NULL COMMENT '删除了该会话的用户uid数组（重新收消息自动恢复）',
  dismissed   TINYINT      NOT NULL DEFAULT 0 COMMENT '群是否已解散',
  createdAt   BIGINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_key (`key`),
  KEY idx_lastTs (lastTs)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会话表';

-- ---------- 消息表 ----------
CREATE TABLE IF NOT EXISTS mt_messages (
  id        CHAR(32)     NOT NULL COMMENT '消息ID',
  convId    CHAR(32)     NOT NULL COMMENT '所属会话ID',
  fromUid   CHAR(32)     NOT NULL COMMENT '发送者uid（系统消息为 system）',
  type      VARCHAR(10)  NOT NULL DEFAULT 'text' COMMENT 'text文字/image图片/file文件/redpacket红包/system系统',
  content   TEXT         COMMENT '文字内容 或 图片/文件的URL地址（文件本体在uploads/）',
  ext       JSON         NULL COMMENT '附加数据：{fileName,fileSize,rpId...}',
  status    VARCHAR(10)  NOT NULL DEFAULT 'sent' COMMENT 'sent已发送/recalled已撤回',
  createdAt BIGINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_conv_time (convId, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='聊天消息表';

-- ---------- 钱包流水表（只增不删，每笔资金变动永久留痕） ----------
CREATE TABLE IF NOT EXISTS mt_wallet_flows (
  id           CHAR(32)     NOT NULL COMMENT '流水ID',
  uid          CHAR(32)     NOT NULL COMMENT '账户用户uid',
  type         VARCHAR(20)  NOT NULL COMMENT 'transfer_in/out转账、scanpay_in/out扫码、redpacket_in/out红包、redpacket_refund过期退回、admin_adjust管理员调整、miniapp_pay小程序消费',
  delta        INT          NOT NULL COMMENT '变动金额（分，正=收入 负=支出）',
  balanceAfter INT          NOT NULL DEFAULT 0 COMMENT '变动后余额（分）',
  otherUid     CHAR(32)     NOT NULL DEFAULT '' COMMENT '对方uid',
  otherName    VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '对方昵称（冗余留痕）',
  note         VARCHAR(100) NOT NULL DEFAULT '' COMMENT '备注',
  relatedId    CHAR(32)     NOT NULL DEFAULT '' COMMENT '关联单据ID（转账/红包ID，双方流水用同一个）',
  miniappId    CHAR(32)     NOT NULL DEFAULT '' COMMENT '小程序ID（小程序消费时）',
  createdAt    BIGINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_uid_time (uid, createdAt),
  KEY idx_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钱包流水表（信用点为内部虚拟积分，非法定货币）';

-- ---------- 红包表 ----------
CREATE TABLE IF NOT EXISTS mt_redpackets (
  id          CHAR(32)     NOT NULL COMMENT '红包ID',
  convId      CHAR(32)     NOT NULL COMMENT '所属会话ID',
  fromUid     CHAR(32)     NOT NULL COMMENT '发送者uid',
  fromName    VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '发送者昵称（冗余）',
  blessing    VARCHAR(30)  NOT NULL DEFAULT '' COMMENT '祝福语',
  type        VARCHAR(10)  NOT NULL DEFAULT 'single' COMMENT 'single一对一固定金额/group群拼手气',
  totalCent   INT          NOT NULL DEFAULT 0 COMMENT '总金额（分）',
  totalCount  INT          NOT NULL DEFAULT 1 COMMENT '红包个数',
  remainCent  INT          NOT NULL DEFAULT 0 COMMENT '剩余金额（分）',
  remainCount INT          NOT NULL DEFAULT 0 COMMENT '剩余个数',
  grabbed     JSON         NOT NULL COMMENT '领取记录 [{uid,name,cent,at}]',
  status      VARCHAR(20)  NOT NULL DEFAULT 'active' COMMENT 'active进行中/finished已领完/expired_refunded过期已退回',
  createdAt   BIGINT       NOT NULL DEFAULT 0,
  expireAt    BIGINT       NOT NULL DEFAULT 0 COMMENT '过期时间（24小时，过期未领完自动退回）',
  PRIMARY KEY (id),
  KEY idx_conv (convId, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='红包表';

-- ---------- 小程序表 ----------
CREATE TABLE IF NOT EXISTS mt_miniapps (
  id           CHAR(32)     NOT NULL COMMENT '小程序ID',
  name         VARCHAR(20)  NOT NULL COMMENT '名称',
  descr        VARCHAR(200) NOT NULL DEFAULT '' COMMENT '简介（desc是SQL保留字，列名用descr）',
  category     VARCHAR(10)  NOT NULL DEFAULT '其他' COMMENT '分类：购物/外卖/工具/其他',
  iconUrl      VARCHAR(500) NOT NULL DEFAULT '' COMMENT '图标URL',
  entryUrl     VARCHAR(500) NOT NULL DEFAULT '' COMMENT '入口index.html的URL（文件本体在uploads/miniapp/）',
  ownerUid     CHAR(32)     NOT NULL COMMENT '开发者uid',
  ownerName    VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '开发者用户名',
  needWallet   TINYINT      NOT NULL DEFAULT 0 COMMENT '是否申请钱包权限（审核重点；未授权调钱包接口一律拒绝）',
  status       VARCHAR(10)  NOT NULL DEFAULT 'pending' COMMENT 'pending待审核/online已上架/rejected已驳回/offline已下架',
  rejectReason VARCHAR(200) NOT NULL DEFAULT '' COMMENT '驳回理由',
  reviewedBy   VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '审核管理员',
  reviewedAt   BIGINT       NULL,
  createdAt    BIGINT       NOT NULL DEFAULT 0,
  updatedAt    BIGINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_status (status),
  KEY idx_owner (ownerUid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='小程序表';

-- ---------- 公告表 ----------
CREATE TABLE IF NOT EXISTS mt_announcements (
  id        CHAR(32)     NOT NULL COMMENT '公告ID',
  title     VARCHAR(50)  NOT NULL COMMENT '标题',
  content   TEXT         NOT NULL COMMENT '正文',
  pinned    TINYINT      NOT NULL DEFAULT 0 COMMENT '是否置顶（置顶公告客户端启动自动弹出）',
  published TINYINT      NOT NULL DEFAULT 1 COMMENT '是否已发布',
  createdBy VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '发布管理员',
  updatedBy VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '最后编辑管理员',
  createdAt BIGINT       NOT NULL DEFAULT 0,
  updatedAt BIGINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_pub (published, pinned, updatedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='全局公告表';

-- ---------- 广播消息表 ----------
CREATE TABLE IF NOT EXISTS mt_broadcasts (
  id         CHAR(32)     NOT NULL COMMENT '广播ID',
  title      VARCHAR(30)  NOT NULL DEFAULT '系统通知',
  content    VARCHAR(500) NOT NULL,
  targetType VARCHAR(10)  NOT NULL DEFAULT 'all' COMMENT 'single单个/custom自选一批/online全部在线/all全体注册',
  uids       JSON         NOT NULL COMMENT '目标uid数组，或字符串 "ALL" 表示全体',
  pushSent   INT          NOT NULL DEFAULT 0 COMMENT '推送成功数（0=未开推送，客户端轮询兜底必达）',
  createdBy  VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '发送管理员',
  createdAt  BIGINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_created (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='广播消息表';

-- ---------- 管理员操作日志表（永久保留，代码层不存在任何删除接口） ----------
CREATE TABLE IF NOT EXISTS mt_admin_logs (
  id        BIGINT       NOT NULL AUTO_INCREMENT COMMENT '日志ID（自增）',
  aid       VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '操作管理员ID',
  adminName VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '操作人用户名',
  action    VARCHAR(30)  NOT NULL DEFAULT '' COMMENT '操作类型：edit_user/ban_users/unban_users/deactivate_approve/deactivate_reject/adjust_credit/send_broadcast/create_announcement/update_announcement/delete_announcement/review_miniapp_pass/review_miniapp_reject/miniapp_online/miniapp_offline/change_password',
  detail    TEXT         COMMENT '操作详情（人类可读完整描述）',
  extra     JSON         NULL COMMENT '附加数据（被操作用户id、金额等）',
  createdAt BIGINT       NOT NULL DEFAULT 0 COMMENT '操作时间',
  PRIMARY KEY (id),
  KEY idx_created (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理员操作日志表（只增不删）';
