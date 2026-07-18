/**
 * 邮箱验证码登录 + 云端同步
 * 发信走 Resend（免费额度 3000 封/月），REST 接口 + RESEND_API_KEY 密钥。
 * 安全约定：验证码只存哈希、5 分钟过期、5 次尝试上限、同邮箱 60 秒内不重发；
 * session token 走 httpOnly + Secure + SameSite=Lax cookie，JS 读不到。
 */

const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 180 * 24 * 3600 * 1000; // 半年免登录

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

const T = {
  zh: {
    badEmail: "邮箱格式不对，检查一下",
    tooSoon: "验证码刚发过，请等 60 秒再试",
    sendFail: "验证码发送失败，稍后再试",
    sent: "验证码已发送，请查收邮件（可能在垃圾箱）",
    noCode: "请先获取验证码",
    expired: "验证码已过期，请重新获取",
    tooMany: "错误次数过多，请重新获取验证码",
    wrongCode: "验证码不对，再看看",
    needLogin: "请先登录",
    subject: "steadyquant 登录验证码",
    emailTitle: "你的登录验证码",
    emailBody: "5 分钟内有效。不是你本人操作的话，忽略这封邮件即可。",
    emailFoot: "steadyquant · 仅供研究教育，非投资建议",
  },
  en: {
    badEmail: "That doesn't look like a valid email",
    tooSoon: "A code was just sent — wait 60 seconds",
    sendFail: "Couldn't send the code, try again shortly",
    sent: "Code sent — check your inbox (and spam folder)",
    noCode: "Request a code first",
    expired: "That code expired — request a new one",
    tooMany: "Too many wrong tries — request a new code",
    wrongCode: "Wrong code, have another look",
    needLogin: "Please sign in first",
    subject: "your steadyquant sign-in code",
    emailTitle: "your sign-in code",
    emailBody: "Valid for 5 minutes. If this wasn't you, just ignore this email.",
    emailFoot: "steadyquant · research & education only, not investment advice",
  },
};
const t = (lang, k) => (T[lang] || T.zh)[k];

const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randHex = (bytes = 32) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
// 6 位验证码，用 CSPRNG，避免 Math.random 可预测
const genCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");

function codeEmailHtml(code, lang) {
  return `<!doctype html><html><body style="margin:0;background:#F7F1E7;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;color:#17150F">
  <div style="max-width:420px;margin:0 auto;padding:40px 24px">
    <div style="font-size:12px;letter-spacing:.14em;color:#8A8578;font-family:ui-monospace,monospace">// steadyquant</div>
    <h1 style="font-size:24px;font-weight:800;margin:12px 0 20px">${t(lang, "emailTitle")}</h1>
    <div style="background:#fff;border:1px solid #E4DAC7;border-radius:20px;padding:24px;text-align:center">
      <div style="font-family:ui-monospace,monospace;font-size:38px;font-weight:700;letter-spacing:.22em;color:#E5484D">${code}</div>
    </div>
    <p style="font-size:14px;line-height:1.6;color:#4A463C;margin:20px 0 0">${t(lang, "emailBody")}</p>
    <p style="font-size:11px;color:#8A8578;margin:28px 0 0;font-family:ui-monospace,monospace">${t(lang, "emailFoot")}</p>
  </div></body></html>`;
}

/* ───────── 端点 ───────── */

export async function sendCode(env, request) {
  const { email, lang = "zh" } = await request.json().catch(() => ({}));
  const addr = String(email || "").trim().toLowerCase();
  if (!isEmail(addr)) return json({ ok: false, error: t(lang, "badEmail") }, 400);

  const now = Date.now();
  const prev = await env.DB.prepare("SELECT sent_at FROM login_codes WHERE email = ?").bind(addr).first();
  if (prev && now - prev.sent_at < RESEND_COOLDOWN_MS)
    return json({ ok: false, error: t(lang, "tooSoon") }, 429);

  const code = genCode();
  await env.DB.prepare(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at`
  ).bind(addr, await sha256(code), now + CODE_TTL_MS, now).run();

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "steadyquant <verify@lowbattery.studio>",
        to: [addr],
        subject: `${t(lang, "subject")}: ${code}`,
        html: codeEmailHtml(code, lang),
        text: `${t(lang, "emailTitle")}: ${code}\n\n${t(lang, "emailBody")}`,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.log(`resend send fail ${res.status}: ${detail}`);
      return json({ ok: false, error: t(lang, "sendFail") }, 502);
    }
  } catch (e) {
    console.log(`resend send error: ${e.message}`);
    return json({ ok: false, error: t(lang, "sendFail") }, 502);
  }
  return json({ ok: true, message: t(lang, "sent") });
}

export async function verifyCode(env, request) {
  const { email, code, lang = "zh" } = await request.json().catch(() => ({}));
  const addr = String(email || "").trim().toLowerCase();
  const input = String(code || "").trim();
  if (!isEmail(addr)) return json({ ok: false, error: t(lang, "badEmail") }, 400);

  const row = await env.DB.prepare("SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?")
    .bind(addr).first();
  if (!row) return json({ ok: false, error: t(lang, "noCode") }, 400);
  if (Date.now() > row.expires_at) {
    await env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(addr).run();
    return json({ ok: false, error: t(lang, "expired") }, 400);
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(addr).run();
    return json({ ok: false, error: t(lang, "tooMany") }, 429);
  }
  if ((await sha256(input)) !== row.code_hash) {
    await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").bind(addr).run();
    return json({ ok: false, error: t(lang, "wrongCode") }, 400);
  }

  await env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(addr).run();
  const nowIso = new Date().toISOString();
  let user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(addr).first();
  if (!user) {
    const id = randHex(16);
    await env.DB.prepare("INSERT INTO users (id, email, lang, created_at, last_seen) VALUES (?, ?, ?, ?, ?)")
      .bind(id, addr, lang, nowIso, nowIso).run();
    await env.DB.prepare("INSERT INTO user_data (user_id, hold, wish, updated_at) VALUES (?, '[]', '[]', ?)")
      .bind(id, Date.now()).run();
    user = { id };
  } else {
    await env.DB.prepare("UPDATE users SET last_seen = ?, lang = ? WHERE id = ?").bind(nowIso, lang, user.id).run();
  }

  const token = randHex(32);
  const expires = Date.now() + SESSION_TTL_MS;
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(token, user.id, expires, nowIso).run();

  return json({ ok: true, email: addr }, 200, {
    "Set-Cookie": `sq_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  });
}

function cookieToken(request) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)sq_session=([a-f0-9]+)/);
  return m ? m[1] : null;
}

export async function currentUser(env, request) {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email, u.lang FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return { id: row.user_id, email: row.email, lang: row.lang };
}

export async function me(env, request) {
  const user = await currentUser(env, request);
  return json(user ? { ok: true, email: user.email, lang: user.lang } : { ok: false });
}

export async function logout(env, request) {
  const token = cookieToken(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return json({ ok: true }, 200, {
    "Set-Cookie": "sq_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
  });
}

/* ───────── 云端同步（持仓 + 想买清单） ───────── */

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

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO user_data (user_id, hold, wish, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET hold=excluded.hold, wish=excluded.wish, updated_at=excluded.updated_at`
  ).bind(user.id, payload[0], payload[1], now).run();
  return json({ ok: true, updated_at: now });
}

export async function setLang(env, request) {
  const user = await currentUser(env, request);
  if (!user) return json({ ok: true }); // 未登录只在前端存，不报错
  const { lang } = await request.json().catch(() => ({}));
  if (lang !== "zh" && lang !== "en") return json({ ok: false }, 400);
  await env.DB.prepare("UPDATE users SET lang = ? WHERE id = ?").bind(lang, user.id).run();
  return json({ ok: true });
}
