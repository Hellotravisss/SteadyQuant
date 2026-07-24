/**
 * quant 侧的账号接入层
 *
 * 登录/发码/登出已全部移交账号中心（accounts.lowbattery.studio，见 accounts/ 目录）。
 * 这里只做两件事：
 *   1. 用共享 cookie `lbs_session` 到账号中心的库（ACCOUNTS_DB）里确认"你是谁"
 *   2. 管 quant 自己的业务数据（持仓/想买清单，存本产品的 DB，user_id 关联账号中心）
 *
 * 其他子域产品（geo / flashpick / cutpilot）将来照抄这个文件即可接入统一账号。
 */

const COOKIE_NAME = "lbs_session";

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

function cookieToken(request) {
  const m = (request.headers.get("Cookie") || "").match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-f0-9]+)`)
  );
  return m ? m[1] : null;
}

/** 查共享账号库确认当前用户；未登录返回 null */
export async function currentUser(env, request) {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await env.ACCOUNTS_DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email, u.lang FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (Date.now() > row.expires_at) return null; // 过期清理交给账号中心，这里只判定
  return { id: row.user_id, email: row.email, lang: row.lang };
}

export async function me(env, request) {
  const user = await currentUser(env, request);
  if (!user) return json({ ok: false });
  const display = user.email ? user.email.split("@")[0] : (user.lang === "en" ? "wechat user" : "微信用户");
  return json({ ok: true, email: user.email, display, lang: user.lang });
}

/* ───────── quant 自己的云端数据（持仓 + 想买清单） ───────── */

export async function getData(env, request) {
  const user = await currentUser(env, request);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const row = await env.DB.prepare("SELECT hold, wish, updated_at FROM user_data WHERE user_id = ?")
    .bind(user.id).first();
  return json({
    ok: true,
    hold: JSON.parse(row?.hold || "[]"),
    wish: JSON.parse(row?.wish || "[]"),
    updated_at: row?.updated_at || 0,
  });
}

export async function putData(env, request) {
  const user = await currentUser(env, request);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.hold) || !Array.isArray(body.wish))
    return json({ ok: false, error: "bad payload" }, 400);
  // 防滥用：单用户数据量上限
  if (body.hold.length > 200 || body.wish.length > 200)
    return json({ ok: false, error: "too many items" }, 413);
  const payload = [JSON.stringify(body.hold), JSON.stringify(body.wish)];
  if (payload[0].length + payload[1].length > 100000)
    return json({ ok: false, error: "payload too large" }, 413);

  // 乱序防护：客户端带 ts（发起快照的时刻），比库里已存的更旧就拒收——
  // 防止两次快照在网络上乱序到达时，旧数据覆盖新数据
  if (body.ts) {
    const cur = await env.DB.prepare("SELECT updated_at FROM user_data WHERE user_id = ?").bind(user.id).first();
    if (cur && Number(cur.updated_at) > Number(body.ts))
      return json({ ok: true, skipped: "stale_snapshot" }); // 静默跳过，客户端不用重试
  }
  const now = body.ts ? Number(body.ts) : Date.now();
  await env.DB.prepare(
    `INSERT INTO user_data (user_id, hold, wish, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET hold=excluded.hold, wish=excluded.wish, updated_at=excluded.updated_at`
  ).bind(user.id, payload[0], payload[1], now).run();
  return json({ ok: true, updated_at: now });
}
