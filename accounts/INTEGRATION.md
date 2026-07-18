# Low Battery Studio 账号中心 · 产品接入文档

> 给 geo / flashpick / cutpilot 等子域产品的 Claude Code session 阅读。
> 读完本文档你应该能独立完成接入,不需要询问 SteadyQuant session。
> 参考实现(已跑通):`/Users/travis/Documents/Vibe_Coding/SteadyQuant`(quant.lowbattery.studio)。

## 是什么

全 studio 统一登录。用户在任何一个 `*.lowbattery.studio` 子域登录一次,所有子域都自动是登录状态。账号中心只管"你是谁";**每个产品的业务数据存自己的库**,用 `user_id` 关联。

- 账号中心域名:`https://accounts.lowbattery.studio`(Cloudflare Worker,名字 `lbs-accounts`,代码在 SteadyQuant 仓库 `accounts/` 目录)
- 登录方式:邮箱验证码 ✅、苹果 ✅、谷歌/微信(代码就绪,等钥匙,前端按钮先挂上即可)
- 登录凭证:cookie `lbs_session`,`Domain=.lowbattery.studio; HttpOnly; Secure; SameSite=Lax`——浏览器自动带给所有子域,JS 读不到
- CORS:账号中心已对所有 `https://*.lowbattery.studio` 开放(带凭证),前端可直接跨域调

## 账号中心 API(前端直接调,一律带 `credentials: 'include'`)

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/auth/send_code` | POST `{email, lang}` | 发验证码邮件(zh/en 文案自动切换) |
| `/api/auth/verify` | POST `{email, code, lang}` | 验码,成功即 Set-Cookie 全域登录 |
| `/api/auth/me` | GET | `{ok, email, display, lang}`;`email` 可能为 null(微信用户),显示用 `display` |
| `/api/auth/logout` | POST | 登出(清全域 cookie) |
| `/api/auth/lang` | POST `{lang}` | 保存语言偏好('zh'/'en') |
| `/api/auth/google/start?return_to=<url>` | 跳转 | 谷歌登录(未配置时 503) |
| `/api/auth/apple/start?return_to=<url>` | 跳转 | 苹果登录 ✅ |
| `/api/auth/wechat/start?return_to=<url>` | 跳转 | 微信扫码(未配置时 503) |

第三方登录流程:整页跳转 → 授权 → 回到 `return_to` 并带上 `?lbs_login=1` 参数。前端检测到该参数应:清掉参数(history.replaceState)+ 把本地未登录期间的数据合并上云(如果你的产品有本地数据)。`return_to` 必须是 `*.lowbattery.studio` 的地址,否则会被账号中心拒绝。

## 服务端怎么知道"当前用户是谁"

### 方式 A:绑共享数据库直查(推荐,产品是 Cloudflare Worker 时用)

wrangler.jsonc 加一个绑定(**只读使用,勿写入**):

```jsonc
"d1_databases": [
  // ...你产品自己的库保持不变...
  {
    "binding": "ACCOUNTS_DB",
    "database_name": "lbs-accounts-db",
    "database_id": "7844b275-22ee-4fce-bd49-fc37f5e932d3"
  }
]
```

后端鉴权函数(整段抄,来自 quant 的 `src/auth.js`):

```js
async function currentUser(env, request) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)lbs_session=([a-f0-9]+)/);
  if (!m) return null;
  const row = await env.ACCOUNTS_DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email, u.lang FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).bind(m[1]).first();
  if (!row || Date.now() > row.expires_at) return null;
  return { id: row.user_id, email: row.email, lang: row.lang };
}
```

然后你产品的"每用户数据"存**自己的库**,表结构参考 quant:

```sql
CREATE TABLE IF NOT EXISTS user_data (
  user_id TEXT PRIMARY KEY,   -- 账号中心的 users.id
  data    TEXT NOT NULL,      -- 产品自己的 JSON
  updated_at TEXT NOT NULL
);
```

### 方式 B:转发问询(产品不是 Worker / 不想绑库时用)

后端收到请求后,把请求里的 Cookie 头原样转发去问账号中心:

```js
const r = await fetch("https://accounts.lowbattery.studio/api/auth/me",
  { headers: { Cookie: request.headers.get("Cookie") || "" } });
const user = await r.json(); // {ok:true, email, display, lang} 或 {ok:false}
```

## 前端登录 UI

直接抄 quant 的实现:`/Users/travis/Documents/Vibe_Coding/SteadyQuant/public/index.html` 里搜:

- `loginModal` —— 登录弹窗(谷歌/苹果/微信按钮 + 邮箱验证码两步)
- `checkAuth` / `renderAccount` —— 页面加载时查登录态、右上角账号按钮(注意用 `USER.display` 而非 email,微信用户没邮箱)
- `googleLogin` / `appleLogin` / `wechatLogin` —— 三方跳转(`ACC + '/api/auth/xxx/start?return_to=' + encodeURIComponent(location.origin + location.pathname)`)
- `lbs_login=1` 的处理在 `checkAuth` 里

常量:`const ACC = 'https://accounts.lowbattery.studio';` 所有 auth fetch 都 `credentials: 'include'`。

样式随你产品自己的设计走;若产品用 LBS 设计语言,登录弹窗样式也可以直接抄。

## 硬性约定(违反会出安全/一致性问题)

1. **不要写 ACCOUNTS_DB**——只读。建号/发码/会话管理只能通过账号中心 API 发生
2. **不要自造登录**——不要在产品里另存密码/验证码/会话表
3. cookie 名固定 `lbs_session`,不要自己 Set-Cookie 同名 cookie
4. 未登录时产品应照常可用(本地模式),登录只是加"云同步"——除非产品本身必须登录才有意义
5. 用户邮箱可能为 null(微信用户),所有显示处用 `display` 兜底

## 验收清单(接完自测)

- [ ] 未登录打开产品 → 正常可用,右上角显示"登录"
- [ ] 邮箱验证码登录成功 → 右上角显示账号名
- [ ] **关键**:在 quant.lowbattery.studio 登录后,打开你的产品 → 应该自动已登录(免登录);反之亦然
- [ ] 苹果登录按钮走通(跳苹果授权→回来带 lbs_login=1→已登录)
- [ ] 登出后,quant 那边也同步变成未登录(全域登出)
- [ ] 你产品的用户数据在两台设备间随账号同步
