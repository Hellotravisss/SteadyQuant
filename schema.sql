-- steadyquant · 用户与云端同步
-- 只存"你自己记的东西"：持仓、想买清单。不存行情（行情每次实时拉）。

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  lang        TEXT NOT NULL DEFAULT 'zh',
  created_at  TEXT NOT NULL,
  last_seen   TEXT
);

-- 登录验证码：只存哈希，不存明文；每个邮箱同时只有一个有效码
CREATE TABLE IF NOT EXISTS login_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 用户数据：整份 JSON 存取（持仓+想买），简单可靠，规模足够
CREATE TABLE IF NOT EXISTS user_data (
  user_id     TEXT PRIMARY KEY,
  hold        TEXT NOT NULL DEFAULT '[]',
  wish        TEXT NOT NULL DEFAULT '[]',
  updated_at  INTEGER NOT NULL
);
