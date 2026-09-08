
## 🔴 改 JSON-LD / 页脚时别把 Avowd 署名弄丢

`public/index.html` 的 `<head>` 里有一个 `@graph`，必须保留：

- `WebSite`（`@id: https://steady.lowbattery.studio/#website`）上面挂着 `creator`，指向 Avowd 的组织节点
- 那个被指向的 `Organization` **只放四个字段**（`@type` / `@id` / `name` / `url`）——
  权威定义在 avowd.ai 自己站上，只能有一处，别把完整那份复制过来

页脚有且只有**一处**署名链接（`utm_source=steady.lowbattery.studio&utm_medium=credit`），
文案走 i18n 的 `avowdCredit` 键（中英各一条），但 `href` 写死在静态 HTML 里 ——
不执行 JS 的 AI 爬虫照样抓得到。

本站是**自有站** → 文案只能是「Avowd 青眼出品 / An Avowd project」，
**不能写「网站由 Avowd 构建」**（那是客户建站的文案）。

spec 在 `~/Obsidian/TravisVault/03 领域/GEO/Avowd 署名链接 · spec 与执行手册.md`。
⚠️ 验收用 `grep -o 'avowd.ai/#org' | wc -l` 期望是 **2**；注释里别写那个 @id 字符串，否则会变 3 误判。
