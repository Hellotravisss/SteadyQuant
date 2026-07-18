/**
 * Low Battery Studio 账号中心（accounts.lowbattery.studio）
 *
 * 全 studio 统一登录：quant / geo / flashpick / cutpilot … 都调这里。
 * - 邮箱验证码登录（Resend 发信）；将来谷歌/微信/苹果的 OAuth 回调也落在这
 * - 登录凭证 cookie `lbs_session` 设在 Domain=.lowbattery.studio → 一次登录全子域生效
 * - 各产品自己的业务数据留在各自的库；本中心只管"你是谁"
 * - CORS 只对 *.lowbattery.studio 开放（带凭证）
 *
 * 安全约定：验证码只存哈希、5 分钟过期、5 次尝试上限、同邮箱 60 秒不重发；
 * session token 走 httpOnly + Secure + SameSite=Lax cookie，JS 读不到。
 */

const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 180 * 24 * 3600 * 1000; // 半年免登录

const COOKIE_NAME = "lbs_session";
const COOKIE_ATTRS = "HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.lowbattery.studio";

/* ── CORS：只认自家域名 ── */
const ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)?lowbattery\.studio$/;

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  if (!ORIGIN_RE.test(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

const json = (request, obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request),
      ...headers,
    },
  });

/* ── 双语文案 ── */
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
    subject: "Low Battery Studio 登录验证码",
    emailTitle: "你的登录验证码",
    emailBody: "5 分钟内有效。不是你本人操作的话，忽略这封邮件即可。",
    emailFoot: "low battery studio · still at 1%",
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
    subject: "your Low Battery Studio sign-in code",
    emailTitle: "your sign-in code",
    emailBody: "Valid for 5 minutes. If this wasn't you, just ignore this email.",
    emailFoot: "low battery studio · still at 1%",
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
const genCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");

function codeEmailHtml(code, lang) {
  return `<!doctype html><html><body style="margin:0;background:#F7F1E7;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;color:#17150F">
  <div style="max-width:420px;margin:0 auto;padding:40px 24px">
    <div style="font-size:12px;letter-spacing:.14em;color:#8A8578;font-family:ui-monospace,monospace">// low battery studio</div>
    <h1 style="font-size:24px;font-weight:800;margin:12px 0 20px">${t(lang, "emailTitle")}</h1>
    <div style="background:#fff;border:1px solid #E4DAC7;border-radius:20px;padding:24px;text-align:center">
      <div style="font-family:ui-monospace,monospace;font-size:38px;font-weight:700;letter-spacing:.22em;color:#E5484D">${code}</div>
    </div>
    <p style="font-size:14px;line-height:1.6;color:#4A463C;margin:20px 0 0">${t(lang, "emailBody")}</p>
    <p style="font-size:11px;color:#8A8578;margin:28px 0 0;font-family:ui-monospace,monospace">${t(lang, "emailFoot")}</p>
  </div></body></html>`;
}

function cookieToken(request) {
  const m = (request.headers.get("Cookie") || "").match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-f0-9]+)`)
  );
  return m ? m[1] : null;
}

/* ───────── 端点 ───────── */

async function sendCode(env, request) {
  const { email, lang = "zh" } = await request.json().catch(() => ({}));
  const addr = String(email || "").trim().toLowerCase();
  if (!isEmail(addr)) return json(request, { ok: false, error: t(lang, "badEmail") }, 400);

  const now = Date.now();
  const prev = await env.DB.prepare("SELECT sent_at FROM login_codes WHERE email = ?").bind(addr).first();
  if (prev && now - prev.sent_at < RESEND_COOLDOWN_MS)
    return json(request, { ok: false, error: t(lang, "tooSoon") }, 429);

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
        from: "Low Battery Studio <verify@lowbattery.studio>",
        to: [addr],
        subject: `${t(lang, "subject")}: ${code}`,
        html: codeEmailHtml(code, lang),
        text: `${t(lang, "emailTitle")}: ${code}\n\n${t(lang, "emailBody")}`,
      }),
    });
    if (!res.ok) {
      console.log(`resend send fail ${res.status}: ${await res.text().catch(() => "")}`);
      return json(request, { ok: false, error: t(lang, "sendFail") }, 502);
    }
  } catch (e) {
    console.log(`resend send error: ${e.message}`);
    return json(request, { ok: false, error: t(lang, "sendFail") }, 502);
  }
  return json(request, { ok: true, message: t(lang, "sent") });
}

async function verifyCode(env, request) {
  const { email, code, lang = "zh" } = await request.json().catch(() => ({}));
  const addr = String(email || "").trim().toLowerCase();
  const input = String(code || "").trim();
  if (!isEmail(addr)) return json(request, { ok: false, error: t(lang, "badEmail") }, 400);

  const row = await env.DB.prepare("SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?")
    .bind(addr).first();
  if (!row) return json(request, { ok: false, error: t(lang, "noCode") }, 400);
  if (Date.now() > row.expires_at) {
    await env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(addr).run();
    return json(request, { ok: false, error: t(lang, "expired") }, 400);
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(addr).run();
    return json(request, { ok: false, error: t(lang, "tooMany") }, 429);
  }
  if ((await sha256(input)) !== row.code_hash) {
    await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").bind(addr).run();
    return json(request, { ok: false, error: t(lang, "wrongCode") }, 400);
  }

  await env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(addr).run();
  const nowIso = new Date().toISOString();
  let user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(addr).first();
  if (!user) {
    const id = randHex(16);
    await env.DB.prepare("INSERT INTO users (id, email, lang, created_at, last_seen) VALUES (?, ?, ?, ?, ?)")
      .bind(id, addr, lang, nowIso, nowIso).run();
    user = { id };
  } else {
    await env.DB.prepare("UPDATE users SET last_seen = ?, lang = ? WHERE id = ?").bind(nowIso, lang, user.id).run();
  }

  return json(request, { ok: true, email: addr }, 200, {
    "Set-Cookie": await createSession(env, user.id),
  });
}

/** 建会话 + 生成 Set-Cookie（邮箱登录和第三方登录共用） */
async function createSession(env, userId) {
  const token = randHex(32);
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(token, userId, Date.now() + SESSION_TTL_MS, new Date().toISOString()).run();
  return `${COOKIE_NAME}=${token}; ${COOKIE_ATTRS}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

/* ───────── 谷歌登录（OAuth 2.0 授权码模式） ─────────
   /api/auth/google/start   → 跳去谷歌授权页（带防伪 state）
   /api/auth/google/callback→ 谷歌带 code 跳回，换取身份，认亲/建号，落 session
   认亲规则：谷歌身份已绑定→直接登录；未绑定但已验证邮箱与现有账号相同→挂到该账号；
   否则新建账号。保证"邮箱注册过再用谷歌登录，持仓还在"。 */

const RETURN_RE = /^https:\/\/([a-z0-9-]+\.)?lowbattery\.studio(\/|$)/;

function googleStart(env, request) {
  if (!env.GOOGLE_CLIENT_ID)
    return json(request, { ok: false, error: "google login not configured yet" }, 503);
  const url = new URL(request.url);
  let returnTo = url.searchParams.get("return_to") || "https://quant.lowbattery.studio/";
  if (!RETURN_RE.test(returnTo)) returnTo = "https://quant.lowbattery.studio/";

  const state = randHex(16);
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  auth.searchParams.set("redirect_uri", "https://accounts.lowbattery.studio/api/auth/google/callback");
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid email");
  auth.searchParams.set("state", state);
  auth.searchParams.set("prompt", "select_account");

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      // state + 回跳地址存在临时 cookie 里，10 分钟有效，仅本域可见
      "Set-Cookie": `lbs_gstate=${state}.${encodeURIComponent(returnTo)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}

function oauthFail(msg, returnTo) {
  // 出错时给一个极简说明页，别让用户停在白屏
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#F7F1E7;color:#17150F;display:grid;place-items:center;height:100vh;margin:0">
     <div style="text-align:center"><p>${msg}</p><a href="${returnTo}" style="color:#E5484D">返回 / back</a></div>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function googleCallback(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)lbs_gstate=([a-f0-9]+)\.([^;]+)/);
  const returnTo = m ? decodeURIComponent(m[2]) : "https://quant.lowbattery.studio/";
  const clearState = "lbs_gstate=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

  if (!code || !state || !m || m[1] !== state)
    return oauthFail("登录状态校验失败，请回到网站重试 / sign-in state check failed", returnTo);
  if (!RETURN_RE.test(returnTo))
    return oauthFail("非法回跳地址 / bad return address", "https://quant.lowbattery.studio/");

  // 用授权码换 token（直连谷歌，TLS 保证来源可信）
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: "https://accounts.lowbattery.studio/api/auth/google/callback",
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.log(`google token exchange fail ${tokenRes.status}: ${await tokenRes.text().catch(() => "")}`);
    return oauthFail("谷歌登录失败，请重试 / Google sign-in failed", returnTo);
  }
  const { id_token } = await tokenRes.json();
  // id_token 是 JWT；直连谷歌拿到的，解 payload 并校验 aud/iss 即可
  let claims;
  try {
    claims = JSON.parse(atob(id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return oauthFail("身份解析失败 / could not parse identity", returnTo);
  }
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !String(claims.iss || "").includes("accounts.google.com"))
    return oauthFail("身份校验失败 / identity check failed", returnTo);

  const guid = String(claims.sub);
  const email = claims.email_verified ? String(claims.email || "").toLowerCase() : null;
  const nowIso = new Date().toISOString();

  // 1) 谷歌身份已绑定过 → 老朋友
  let userId = (await env.DB.prepare(
    "SELECT user_id FROM identities WHERE provider='google' AND provider_uid=?"
  ).bind(guid).first())?.user_id;

  // 2) 没绑过，但已验证邮箱与现有账号相同 → 认亲挂靠
  if (!userId && email) {
    userId = (await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first())?.id;
    if (userId)
      await env.DB.prepare(
        "INSERT OR IGNORE INTO identities (provider, provider_uid, user_id, created_at) VALUES ('google', ?, ?, ?)"
      ).bind(guid, userId, nowIso).run();
  }

  // 3) 全新用户 → 建号 + 绑身份
  if (!userId) {
    userId = randHex(16);
    await env.DB.prepare("INSERT INTO users (id, email, lang, created_at, last_seen) VALUES (?, ?, 'zh', ?, ?)")
      .bind(userId, email, nowIso, nowIso).run();
    await env.DB.prepare(
      "INSERT INTO identities (provider, provider_uid, user_id, created_at) VALUES ('google', ?, ?, ?)"
    ).bind(guid, userId, nowIso).run();
  }
  await env.DB.prepare("UPDATE users SET last_seen=? WHERE id=?").bind(nowIso, userId).run();

  const sessionCookie = await createSession(env, userId);
  // 回跳时带 lbs_login=1，前端据此做一次本地数据静默合并
  const dest = new URL(returnTo);
  dest.searchParams.set("lbs_login", "1");
  const headers = new Headers({ Location: dest.toString() });
  headers.append("Set-Cookie", sessionCookie);
  headers.append("Set-Cookie", clearState);
  return new Response(null, { status: 302, headers });
}

/* ───────── 苹果登录（Sign in with Apple，web 流程） ─────────
   与谷歌同构，两处苹果特色：
   ① client_secret 不是固定字符串，而是用 .p8 私钥现签的 ES256 JWT（苹果规定）
   ② scope 带 email 时回调必须是跨站 form_post(POST)——SameSite=Lax 的 cookie
      在跨站 POST 上不会被带上，所以 state 临时 cookie 必须 SameSite=None */

const b64url = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlBytes = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function appleClientSecret(env) {
  // .p8 (PKCS8 PEM) → CryptoKey
  const pem = env.APPLE_PRIVATE_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: env.APPLE_KEY_ID }));
  const payload = b64url(JSON.stringify({
    iss: env.APPLE_TEAM_ID, iat: now, exp: now + 3600,
    aud: "https://appleid.apple.com", sub: env.APPLE_SERVICES_ID,
  }));
  const input = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return `${input}.${b64urlBytes(new Uint8Array(sig))}`;
}

const appleConfigured = (env) =>
  env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_SERVICES_ID && env.APPLE_PRIVATE_KEY;

function appleStart(env, request) {
  if (!appleConfigured(env))
    return json(request, { ok: false, error: "apple login not configured yet" }, 503);
  const url = new URL(request.url);
  let returnTo = url.searchParams.get("return_to") || "https://quant.lowbattery.studio/";
  if (!RETURN_RE.test(returnTo)) returnTo = "https://quant.lowbattery.studio/";

  const state = randHex(16);
  const auth = new URL("https://appleid.apple.com/auth/authorize");
  auth.searchParams.set("client_id", env.APPLE_SERVICES_ID);
  auth.searchParams.set("redirect_uri", "https://accounts.lowbattery.studio/api/auth/apple/callback");
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "email");
  auth.searchParams.set("response_mode", "form_post"); // 带 email scope 时苹果强制 form_post
  auth.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      // 跨站 POST 回调要能读到 → SameSite=None（谷歌那条是 Lax，因为它走 GET 重定向）
      "Set-Cookie": `lbs_astate=${state}.${encodeURIComponent(returnTo)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=600`,
    },
  });
}

async function appleCallback(env, request) {
  const form = await request.formData().catch(() => null);
  const code = form?.get("code");
  const state = form?.get("state");
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)lbs_astate=([a-f0-9]+)\.([^;]+)/);
  const returnTo = m ? decodeURIComponent(m[2]) : "https://quant.lowbattery.studio/";
  const clearState = "lbs_astate=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0";

  if (form?.get("error") === "user_cancelled_authorize")
    return new Response(null, { status: 302, headers: { Location: returnTo, "Set-Cookie": clearState } });
  if (!code || !state || !m || m[1] !== state)
    return oauthFail("登录状态校验失败，请回到网站重试 / sign-in state check failed", returnTo);
  if (!RETURN_RE.test(returnTo))
    return oauthFail("非法回跳地址 / bad return address", "https://quant.lowbattery.studio/");

  let clientSecret;
  try { clientSecret = await appleClientSecret(env); }
  catch (e) {
    console.log(`apple secret sign fail: ${e.message}`);
    return oauthFail("苹果登录配置有误 / Apple sign-in misconfigured", returnTo);
  }

  const tokenRes = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.APPLE_SERVICES_ID,
      client_secret: clientSecret,
      redirect_uri: "https://accounts.lowbattery.studio/api/auth/apple/callback",
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.log(`apple token exchange fail ${tokenRes.status}: ${await tokenRes.text().catch(() => "")}`);
    return oauthFail("苹果登录失败，请重试 / Apple sign-in failed", returnTo);
  }
  const { id_token } = await tokenRes.json();
  let claims;
  try {
    claims = JSON.parse(atob(id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return oauthFail("身份解析失败 / could not parse identity", returnTo);
  }
  if (claims.aud !== env.APPLE_SERVICES_ID || !String(claims.iss || "").includes("appleid.apple.com"))
    return oauthFail("身份校验失败 / identity check failed", returnTo);

  const auid = String(claims.sub);
  // 苹果可能给"隐私中转邮箱"(xxx@privaterelay.appleid.com)——一样是能收信的真邮箱，照常用
  const verified = claims.email_verified === true || claims.email_verified === "true";
  const email = verified && claims.email ? String(claims.email).toLowerCase() : null;
  const nowIso = new Date().toISOString();

  // 认亲三步与谷歌一致：已绑身份 → 同邮箱挂靠 → 新建
  let userId = (await env.DB.prepare(
    "SELECT user_id FROM identities WHERE provider='apple' AND provider_uid=?"
  ).bind(auid).first())?.user_id;

  if (!userId && email) {
    userId = (await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first())?.id;
    if (userId)
      await env.DB.prepare(
        "INSERT OR IGNORE INTO identities (provider, provider_uid, user_id, created_at) VALUES ('apple', ?, ?, ?)"
      ).bind(auid, userId, nowIso).run();
  }

  if (!userId) {
    userId = randHex(16);
    await env.DB.prepare("INSERT INTO users (id, email, lang, created_at, last_seen) VALUES (?, ?, 'zh', ?, ?)")
      .bind(userId, email, nowIso, nowIso).run();
    await env.DB.prepare(
      "INSERT INTO identities (provider, provider_uid, user_id, created_at) VALUES ('apple', ?, ?, ?)"
    ).bind(auid, userId, nowIso).run();
  }
  await env.DB.prepare("UPDATE users SET last_seen=? WHERE id=?").bind(nowIso, userId).run();

  const sessionCookie = await createSession(env, userId);
  const dest = new URL(returnTo);
  dest.searchParams.set("lbs_login", "1");
  const headers = new Headers({ Location: dest.toString() });
  headers.append("Set-Cookie", sessionCookie);
  headers.append("Set-Cookie", clearState);
  return new Response(null, { status: 302, headers });
}

/* ───────── 微信登录（开放平台"网站应用"扫码流程） ─────────
   与谷歌同构（GET 跳转 + GET 回调），两处微信特色：
   ① 授权页是二维码页（scope=snsapi_login），用户拿手机微信扫码确认
   ② 微信不提供邮箱 → 无法按邮箱认亲，identities 用 unionid（跨应用稳定）优先、
      没有 unionid 就用 openid。微信用户是独立新账号（业界通行做法） */

function wechatStart(env, request) {
  if (!env.WECHAT_APP_ID)
    return json(request, { ok: false, error: "wechat login not configured yet" }, 503);
  const url = new URL(request.url);
  let returnTo = url.searchParams.get("return_to") || "https://quant.lowbattery.studio/";
  if (!RETURN_RE.test(returnTo)) returnTo = "https://quant.lowbattery.studio/";

  const state = randHex(16);
  const auth = new URL("https://open.weixin.qq.com/connect/qrconnect");
  auth.searchParams.set("appid", env.WECHAT_APP_ID);
  auth.searchParams.set("redirect_uri", "https://accounts.lowbattery.studio/api/auth/wechat/callback");
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "snsapi_login");
  auth.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString() + "#wechat_redirect",
      "Set-Cookie": `lbs_wstate=${state}.${encodeURIComponent(returnTo)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}

async function wechatCallback(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)lbs_wstate=([a-f0-9]+)\.([^;]+)/);
  const returnTo = m ? decodeURIComponent(m[2]) : "https://quant.lowbattery.studio/";
  const clearState = "lbs_wstate=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

  // 用户在扫码页点了取消 → 无 code，安静回家
  if (!code)
    return new Response(null, { status: 302, headers: { Location: returnTo, "Set-Cookie": clearState } });
  if (!state || !m || m[1] !== state)
    return oauthFail("登录状态校验失败，请回到网站重试 / sign-in state check failed", returnTo);
  if (!RETURN_RE.test(returnTo))
    return oauthFail("非法回跳地址 / bad return address", "https://quant.lowbattery.studio/");

  const tokenRes = await fetch(
    "https://api.weixin.qq.com/sns/oauth2/access_token?" + new URLSearchParams({
      appid: env.WECHAT_APP_ID,
      secret: env.WECHAT_APP_SECRET,
      code,
      grant_type: "authorization_code",
    })
  );
  const tok = await tokenRes.json().catch(() => ({}));
  if (!tok.openid) {
    console.log(`wechat token exchange fail: ${JSON.stringify(tok)}`);
    return oauthFail("微信登录失败，请重试 / WeChat sign-in failed", returnTo);
  }

  // unionid 在同主体多应用间稳定，优先；带前缀防止与 openid 撞值
  const wuid = tok.unionid ? `u:${tok.unionid}` : `o:${tok.openid}`;
  const nowIso = new Date().toISOString();

  let userId = (await env.DB.prepare(
    "SELECT user_id FROM identities WHERE provider='wechat' AND provider_uid=?"
  ).bind(wuid).first())?.user_id;

  if (!userId) {
    userId = randHex(16);
    await env.DB.prepare("INSERT INTO users (id, email, lang, created_at, last_seen) VALUES (?, NULL, 'zh', ?, ?)")
      .bind(userId, nowIso, nowIso).run();
    await env.DB.prepare(
      "INSERT INTO identities (provider, provider_uid, user_id, created_at) VALUES ('wechat', ?, ?, ?)"
    ).bind(wuid, userId, nowIso).run();
  }
  await env.DB.prepare("UPDATE users SET last_seen=? WHERE id=?").bind(nowIso, userId).run();

  const sessionCookie = await createSession(env, userId);
  const dest = new URL(returnTo);
  dest.searchParams.set("lbs_login", "1");
  const headers = new Headers({ Location: dest.toString() });
  headers.append("Set-Cookie", sessionCookie);
  headers.append("Set-Cookie", clearState);
  return new Response(null, { status: 302, headers });
}

async function currentUser(env, request) {
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

async function me(env, request) {
  const user = await currentUser(env, request);
  if (!user) return json(request, { ok: false });
  // 微信用户没有邮箱 → 给一个可显示的名字
  const display = user.email ? user.email.split("@")[0] : (user.lang === "en" ? "wechat user" : "微信用户");
  return json(request, { ok: true, email: user.email, display, lang: user.lang });
}

async function logout(env, request) {
  const token = cookieToken(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return json(request, { ok: true }, 200, {
    "Set-Cookie": `${COOKIE_NAME}=; ${COOKIE_ATTRS}; Max-Age=0`,
  });
}

async function setLang(env, request) {
  const user = await currentUser(env, request);
  if (!user) return json(request, { ok: true }); // 未登录只在前端存，不报错
  const { lang } = await request.json().catch(() => ({}));
  if (lang !== "zh" && lang !== "en") return json(request, { ok: false }, 400);
  await env.DB.prepare("UPDATE users SET lang = ? WHERE id = ?").bind(lang, user.id).run();
  return json(request, { ok: true });
}

/* ───────── 路由 ───────── */

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(request) });

    try {
      if (p === "/api/auth/google/start") return googleStart(env, request);
      if (p === "/api/auth/google/callback") return googleCallback(env, request);
      if (p === "/api/auth/wechat/start") return wechatStart(env, request);
      if (p === "/api/auth/wechat/callback") return wechatCallback(env, request);
      if (p === "/api/auth/apple/start") return appleStart(env, request);
      if (p === "/api/auth/apple/callback" && request.method === "POST") return appleCallback(env, request);
      if (p === "/api/auth/send_code" && request.method === "POST") return sendCode(env, request);
      if (p === "/api/auth/verify" && request.method === "POST") return verifyCode(env, request);
      if (p === "/api/auth/me") return me(env, request);
      if (p === "/api/auth/logout" && request.method === "POST") return logout(env, request);
      if (p === "/api/auth/lang" && request.method === "POST") return setLang(env, request);
    } catch (e) {
      return json(request, { ok: false, error: String(e.message || e) }, 500);
    }

    return json(request, { service: "low battery studio accounts", status: "still at 1%" }, 200);
  },
};
