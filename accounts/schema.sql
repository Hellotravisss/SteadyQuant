-- Low Battery Studio 账号中心（全 studio 共享）
-- 只管"你是谁"：账号、验证码、登录会话、第三方登录身份。
-- 各产品的业务数据（quant 的持仓等）留在各自的库里，用 user_id 关联。

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE,               -- 微信用户可能没邮箱，允许 NULL
  lang        TEXT NOT NULL DEFAULT 'zh',
  created_at  TEXT NOT NULL,
  last_seen   TEXT
);

-- 登录验证码：只存哈希；每个邮箱同时只有一个有效码
CREATE TABLE IF NOT EXISTS login_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER NOT NULL
);

-- 登录会话：cookie 里的 token 对应一行；Domain=.lowbattery.studio 全子域共享
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 第三方登录身份（第 2 步谷歌 / 第 3 步微信用）：
-- 同一账号可挂多个登录方式；provider+provider_uid 唯一定位一个外部身份
CREATE TABLE IF NOT EXISTS identities (
  provider     TEXT NOT NULL,            -- 'google' | 'wechat' | 'apple'
  provider_uid TEXT NOT NULL,            -- 对方系统里的用户唯一 ID
  user_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (provider, provider_uid)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);
