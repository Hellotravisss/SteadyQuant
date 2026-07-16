/**
 * SteadyQuant Cloudflare Worker
 * 从 Vercel FastAPI (api/index.py + api/serenity.py) 逐条移植的 JS 版后端。
 * 数据源：Tushare（A股）、Yahoo Finance（美股/加股）、DeepSeek/Anthropic（AI 报告）。
 */
import Anthropic from "@anthropic-ai/sdk";

const CUR_SYM = { CNY: "¥", USD: "$", CAD: "C$" };
const isAshare = (c) => /^\d{6}\.(SH|SZ)$/.test(c);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const fmtDate = (d) =>
  d.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD (UTC，对日频数据足够)
const daysAgo = (n) => fmtDate(new Date(Date.now() - n * 864e5));
const nowStr = () => {
  const d = new Date(Date.now() + 8 * 3600e3); // 北京时间显示
  return d.toISOString().slice(0, 16).replace("T", " ");
};

/* ───────── 数据源 ───────── */

async function tushare(env, apiName, params = {}, fields = "") {
  try {
    const res = await fetch("http://api.tushare.pro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_name: apiName, token: env.TUSHARE_TOKEN, params, fields }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (data.code !== 0) {
      console.log(`tushare ${apiName} err code=${data.code} msg=${data.msg}`);
      return null;
    }
    return data.data;
  } catch (e) {
    console.log(`tushare ${apiName} fetch fail: ${e.message}`);
    return null;
  }
}

async function yahooChart(symbol) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) }
    );
    const r = (await res.json()).chart.result[0];
    const quote = r.indicators.quote[0];
    const closes = [];
    const dates = [];
    for (let i = 0; i < quote.close.length; i++) {
      if (quote.close[i] != null) {
        closes.push(quote.close[i]);
        dates.push(fmtDate(new Date(r.timestamp[i] * 1000)));
      }
    }
    return { closes, dates, meta: r.meta || {} };
  } catch {
    return null;
  }
}

/* ── A股日线：腾讯实时源优先（免key/免积分/盘中实时），Tushare 兜底 ──
   借鉴 Vibe-Trading 的 FALLBACK_CHAINS：a_share = [tencent, ..., tushare] */
async function tencentDaily(code) {
  try {
    const sym = (code.endsWith(".SH") ? "sh" : "sz") + code.slice(0, 6);
    const end = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,${end},320,qfq`,
      { headers: { Referer: "https://web.ifzq.gtimg.cn/", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8000) }
    );
    const d = (await res.json()).data?.[sym];
    const rows = d?.qfqday || d?.day;
    if (!rows?.length) return null;
    const out = { dates: [], closes: [] };
    for (const r of rows) {
      const c = parseFloat(r[2]);
      if (!isNaN(c)) { out.dates.push(String(r[0]).replace(/-/g, "")); out.closes.push(c); }
    }
    return out.closes.length >= 30 ? out : null;
  } catch { return null; }
}

async function tushareDaily(env, code) {
  const daily = await tushare(env, "daily",
    { ts_code: code, start_date: daysAgo(480), end_date: fmtDate(new Date()) }, "trade_date,close");
  if (!daily?.items || daily.items.length < 30) return null;
  const rows = daily.items.filter((r) => r[1] != null).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { dates: rows.map((r) => r[0]), closes: rows.map((r) => Number(r[1])) };
}

/** 统一日线序列：A股走 腾讯→Tushare 回退链，海外走 Yahoo。返回 {dates, closes, currency} */
async function dailySeries(env, code) {
  if (isAshare(code)) {
    const s = (await tencentDaily(code)) || (await tushareDaily(env, code));
    return s ? { ...s, currency: "CNY" } : null;
  }
  const y = await yahooChart(code);
  if (!y || y.closes.length < 30) return null;
  return { dates: y.dates.slice(-320), closes: y.closes.slice(-320), currency: y.meta.currency || "USD" };
}

// A股全量列表缓存（isolate 级，1小时）
let stockCache = { data: null, ts: 0 };
async function stockList(env) {
  if (stockCache.data && Date.now() - stockCache.ts < 3600e3) return stockCache.data;
  const res = await tushare(env, "stock_basic", { list_status: "L" }, "ts_code,name");
  if (res?.items) {
    stockCache = { data: res.items, ts: Date.now() };
    return res.items;
  }
  return stockCache.data || [];
}

/* ───────── 水位标尺（skill 硬规则：全部真实价格） ───────── */

function computePA(closes, currency) {
  if (!closes || closes.length < 30) return null;
  const last = closes[closes.length - 1];
  const win = closes.slice(-120);
  const hi = Math.max(...win), lo = Math.min(...win);
  const rangePos = hi > lo ? ((last - lo) / (hi - lo)) * 100 : 50;
  const offHigh = ((last - hi) / hi) * 100;
  const ret = (n) => (closes.length > n ? (last / closes[closes.length - 1 - n] - 1) * 100 : null);
  const ret1m = ret(21), ret3m = ret(63);
  const smaN = Math.min(50, closes.length);
  const sma50 = closes.slice(-smaN).reduce((a, b) => a + b, 0) / smaN;
  const aboveSma50 = last > sma50;

  let level;
  if (rangePos >= 90) level = "贴顶";
  else if (rangePos >= 70) level = "高位";
  else if (rangePos >= 40) level = "中位";
  else if (rangePos >= 15) level = "低位";
  else level = "贴底";

  let stage;
  if (ret1m !== null && ret1m > 15 && rangePos > 80) stage = "extended（已抛物线，追高风险大）";
  else if (aboveSma50 && ret3m !== null && ret3m > 0 && rangePos > 50) stage = "momentum（趋势健康）";
  else if (rangePos < 30 && ret1m !== null && ret1m > -5) stage = "basing（低位筑底）";
  else if (ret1m !== null && ret1m < -10) stage = "falling（下跌中，别接飞刀）";
  else stage = "neutral（震荡）";

  const r2 = (x) => Math.round(x * 100) / 100;
  const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    last: r2(last),
    cur: CUR_SYM[currency] || currency + " ",
    currency,
    high_6mo: r2(hi),
    low_6mo: r2(lo),
    range_pos_6mo_pct: r1(rangePos),
    pct_off_6mo_high: r1(offHigh),
    ret_1m_pct: r1(ret1m),
    ret_3m_pct: r1(ret3m),
    above_sma50: aboveSma50,
    level,
    stage,
    data_points: closes.length,
  };
}

async function priceAnalysis(env, code) {
  const s = await dailySeries(env, code);
  if (!s) return null;
  return computePA(s.closes.slice(-140), s.currency);
}

/* ───────── 红旗 / 判据 / 判定 / 证伪 / 风控 ───────── */

function redFlagScan(basic, pa) {
  const flags = [];
  const { pe, pb, total_mv: mv, amount: turnover } = basic;
  if (pe != null && pe > 100)
    flags.push({ level: "hard", text: `估值极端（PE ${Math.round(pe)}）——好卡点被炒到 100x forward P/E 就不是好卡点` });
  if (pe == null || pe <= 0)
    flags.push({ level: "warn", text: "PE 为负/缺失 —— 亏损中，检查现金跑道能否活到放量" });
  if (pb != null && pb > 10)
    flags.push({ level: "warn", text: `PB ${pb.toFixed(1)} 偏高，安全边际薄` });
  if (turnover != null && turnover < 50000)
    flags.push({ level: "hard", text: "日均成交额 < 5000万 —— A股流动性陷阱（无机构关注）" });
  if (mv != null && mv > 30000000)
    flags.push({ level: "warn", text: "市值超大盘 —— 已被充分发现，本框架判断力弱、无不对称空间" });
  if (pa?.stage.startsWith("extended"))
    flags.push({ level: "warn", text: `1个月涨 ${pa.ret_1m_pct}% 且贴顶 —— stage 问题，降🟡等回调或确认基本面跟得上` });
  if (pa?.stage.startsWith("falling"))
    flags.push({ level: "warn", text: "下跌趋势中 —— 区分「非实质性错杀」与「基本面恶化」，别接飞刀" });
  return flags;
}

const CRITERIA_QUALITATIVE = [
  { id: "monopoly", text: "垄断性/不可替代：单一供应商或寡头，别人 1-2 年内绕不过" },
  { id: "designin", text: "designed-in + 多客户：进了多条链的 BOM，替换成本高（收费站式卡位）" },
  { id: "certlag", text: "认证周期未反映营收：量产在后年 → 现在财报难看 = 错杀机会" },
  { id: "imbalance", text: "供需严重失衡：产能售罄/大客户包产能/backlog 已去风险" },
  { id: "policy", text: "政策/地缘护城河：国产替代/出口管制壁垒/自给率低" },
  { id: "balance", text: "资产负债表能活到放量：现金跑道 > 烧钱速度，无 toxic 负债" },
  { id: "preinst", text: "前机构：卖方研报少、机构低配、散户没听过" },
];

function criteriaAuto(basic) {
  const out = [];
  const mv = basic.total_mv;
  if (mv != null) {
    const mvYi = mv / 10000;
    const small = mvYi < 150;
    out.push({ id: "smallcap", hit: small,
      text: `极小市值（现 ${Math.round(mvYi)} 亿）：${small ? "✓ 有 10x 不对称空间" : "✗ 市值偏大，不对称性减弱"}` });
  }
  const pe = basic.pe;
  if (pe != null && pe > 0) {
    const cheap = pe < 25;
    out.push({ id: "valuation", hit: cheap,
      text: `估值安全边际（PE ${pe.toFixed(1)}）：${cheap ? "✓ 估值压抑" : "✗ 已有溢价，问自己是否已 priced in"}` });
  }
  return out;
}

function twoAxisVerdict(pa, basic) {
  const highWater = pa.range_pos_6mo_pct >= 70;
  const pe = basic.pe;

  if (pe == null && Object.keys(basic).length === 0) {
    if (highWater)
      return { code: "yellow", label: "🟡 价格在高位",
        hint: "已接近半年高点。暂无估值数据，无法判断是「贵但对」还是「博傻」—— 先自查业绩增速能不能跟上涨幅" };
    return { code: "yellow", label: "🟡 位置不贵，但要自查基本面",
      hint: "价格位置有吸引力，但暂无估值数据 —— 确认 PE/增速/现金流没问题再考虑" };
  }

  const fundOk = pe != null && pe > 0 && pe < 40;
  if (highWater && fundOk)
    return { code: "green", label: "🟢 贵但可能对",
      hint: "高水位但估值未失控 —— 动量龙头别轻易 fade；确认盈利增速跟得上涨幅再定" };
  if (highWater && !fundOk)
    return { code: "red", label: "🔴 真贴顶", hint: "高水位 + 纯重估（基本面跟不上）—— 再涨是博傻，回避" };
  if (!highWater && fundOk)
    return { code: "green", label: "🟢 经典埋伏区",
      hint: "低/中水位 + 估值合理 —— Mode A 早期埋伏或 Mode B 超跌反弹的猎区" };
  return { code: "yellow", label: "🟡 观望",
    hint: "水位不高 + 估值/基本面存疑 —— 先搞清市场为什么给这个定价，想清「重估触发条件」再考虑" };
}

function invalidationRules(pa) {
  const stop = Math.round(pa.last * 0.85 * 100) / 100;
  const cur = pa.cur || "¥";
  return {
    stop_price: stop,
    rules: [
      `价格/stage（机器可检）：跌破 ${cur}${stop}（现价-15%）且 1 月动量转负 → 承认判断错，无条件离场`,
      "基本面：下季度订单/营收未随主题增长（认证/放量逻辑证伪）",
      "估值：继续大涨但毛利/盈利未扩 → 纯博傻阶段，止盈离场",
    ],
    note: "没有证伪条件的🟢 = 故事，不是投资假设。入观察池后每次打开自动检查是否触发。",
  };
}

function riskControl(principal, proposedPosition) {
  const limit = principal * 0.1;
  const passed = proposedPosition <= limit;
  return {
    passed,
    reasons: passed ? [] : [`单笔仓位超限（${Math.round(proposedPosition)} > ${Math.round(limit)}）`],
    proposed_position: proposedPosition,
    max_allowed: Math.round(limit * 100) / 100,
    drawdown: 0, strategy_age_days: 999,
  };
}

/* ───────── 各端点 ───────── */

async function stockCheck(env, code, principal = 2000) {
  code = code.trim().toUpperCase();

  if (!isAshare(code)) {
    const y = await yahooChart(code);
    if (!y) return { error: `查不到 ${code}。美股直接输代码（如 AAPL / NVDA），加拿大股加 .TO（如 SHOP.TO / RY.TO）` };
    const name = y.meta.shortName || y.meta.longName || code;
    const market = code.endsWith(".TO") || y.meta.currency === "CAD" ? "加拿大" : "美股";
    const pa = computePA(y.closes.slice(-140), y.meta.currency || "USD");
    if (!pa) return { error: "价格数据不足，无法判定" };
    const basic = {};
    const flags = redFlagScan(basic, pa);
    let verdict = twoAxisVerdict(pa, basic);
    if (pa.stage.startsWith("falling") && verdict.code === "green")
      verdict = { code: "yellow", label: "🟡 先等它跌完", hint: "位置还行，但正在下跌途中 —— 等跌势企稳再考虑，别接飞刀" };
    return {
      code, name, industry: market, price: pa, basic: {},
      red_flags: flags, criteria_auto: [], criteria_manual: CRITERIA_QUALITATIVE,
      verdict, invalidation: invalidationRules(pa),
      risk_check: riskControl(principal, pa.last),
      disclaimer: "仅供研究教育，非投资建议。海外标的估值/财务数据未接入，判定只基于价格位置，基本面需自查。",
    };
  }

  const info = await tushare(env, "stock_basic", { ts_code: code }, "ts_code,name,industry,list_date");
  if (!info?.items?.length) return { error: `代码 ${code} 不存在或无法验证（skill 纪律：禁止凭记忆写 ticker）` };
  const [, name, industry] = info.items[0];

  const pa = await priceAnalysis(env, code);
  if (!pa) return { error: "价格数据不足（skill 纪律：严禁凭印象猜水位，无真实价格则不判定）" };

  let basic = {};
  for (let i = 1; i < 10; i++) {
    const db = await tushare(env, "daily_basic", { ts_code: code, trade_date: daysAgo(i) },
      "ts_code,pe_ttm,pb,dv_ratio,total_mv,turnover_rate");
    if (db?.items?.length) {
      const r = db.items[0];
      basic = { pe: r[1], pb: r[2], dv: r[3], total_mv: r[4], amount: null };
      break;
    }
  }
  const daily = await tushare(env, "daily",
    { ts_code: code, start_date: daysAgo(10), end_date: fmtDate(new Date()) }, "trade_date,amount");
  if (daily?.items?.length) {
    const amts = daily.items.map((r) => r[1]).filter(Boolean);
    if (amts.length) basic.amount = amts.reduce((a, b) => a + b, 0) / amts.length;
  }

  const flags = redFlagScan(basic, pa);
  let verdict = twoAxisVerdict(pa, basic);
  if (pa.stage.startsWith("falling") && verdict.code === "green")
    verdict = { code: "yellow", label: "🟡 先等它跌完",
      hint: "位置和估值都还行，但正在下跌途中 —— 等跌势企稳（1个月动量转正）再考虑，别接飞刀" };
  if (flags.some((f) => f.level === "hard") && verdict.code === "green")
    verdict = { code: "yellow", label: "🟡 有硬红旗，降级观望", hint: "命中硬红旗（见下）——除非红旗解除，否则不进" };

  const basicOut = {};
  for (const [k, v] of Object.entries(basic))
    if (v != null) basicOut[k] = typeof v === "number" ? Math.round(v * 100) / 100 : v;

  return {
    code, name, industry, price: pa, basic: basicOut,
    red_flags: flags, criteria_auto: criteriaAuto(basic), criteria_manual: CRITERIA_QUALITATIVE,
    verdict, invalidation: invalidationRules(pa),
    risk_check: riskControl(principal, pa.last * 100),
    disclaimer: "仅供研究教育，非投资建议。判定基于量化规则，定性判据需你自己勾选核实。",
  };
}

async function hs300Series(env) {
  // 沪深300 同样走 腾讯→Tushare 回退
  const t = await tencentDaily("000300.SH");
  if (t) {
    const map = {};
    t.dates.forEach((d, i) => (map[d] = t.closes[i]));
    return map;
  }
  const idx = await tushare(env, "index_daily",
    { ts_code: "000300.SH", start_date: daysAgo(260), end_date: fmtDate(new Date()) }, "trade_date,close");
  if (!idx?.items) return null;
  const map = {};
  for (const [d, c] of idx.items) if (c != null) map[d] = Number(c);
  return map;
}

async function yahooSeries(symbol) {
  const y = await yahooChart(symbol);
  if (!y) return null;
  const map = {};
  y.dates.forEach((d, i) => (map[d] = y.closes[i]));
  return map;
}

async function watchCheck(env, items) {
  const benchCache = {};
  const benchName = { hs300: "沪深300", "^GSPC": "标普500", "^GSPTSE": "多伦多综指" };
  const benchKey = (code) => (isAshare(code) ? "hs300" : code.endsWith(".TO") ? "^GSPTSE" : "^GSPC");
  const getBench = async (code) => {
    const key = benchKey(code);
    if (!(key in benchCache))
      benchCache[key] = key === "hs300" ? await hs300Series(env) : await yahooSeries(key);
    return benchCache[key];
  };

  const results = [];
  for (const it of items.split(",")) {
    const parts = it.trim().split(":");
    if (parts.length < 3) continue;
    const code = parts[0].toUpperCase();
    const entry = parseFloat(parts[1]), stop = parseFloat(parts[2]);
    const added = parts[3] ? parts[3].replace(/-/g, "") : null;
    const series = await dailySeries(env, code);
    const pa = series ? computePA(series.closes.slice(-140), series.currency) : null;
    if (!pa) { results.push({ code, error: "无价格数据" }); continue; }
    const last = pa.last;
    const pnl = (last / entry - 1) * 100;
    const triggered = last < stop && pa.ret_1m_pct !== null && pa.ret_1m_pct < 0;

    // 纪律对照（Vibe-Trading Shadow Account 的简化版）：
    // 找出加入后第一次收盘跌破止损线的那天——如果那天按纪律卖了，现在会怎样
    let shadow = null;
    if (added) {
      for (let i = 0; i < series.dates.length; i++) {
        if (series.dates[i] > added && series.closes[i] < stop) {
          const sellPx = series.closes[i];
          const discPnl = (sellPx / entry - 1) * 100;
          shadow = {
            cross_date: series.dates[i],
            discipline_pnl_pct: Math.round(discPnl * 10) / 10,
            saved_pct: Math.round((discPnl - pnl) * 10) / 10, // >0 = 守纪律能少亏这么多
          };
          break;
        }
      }
    }

    let alpha = null, idxPnl = null;
    if (added) {
      const bench = await getBench(code);
      if (bench) {
        const bDates = Object.keys(bench).sort();
        const base = bDates.find((d) => d >= added);
        if (base && bDates.length) {
          idxPnl = (bench[bDates[bDates.length - 1]] / bench[base] - 1) * 100;
          alpha = pnl - idxPnl;
        }
      }
    }
    const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
    results.push({
      code, entry, stop, last, cur: pa.cur || "¥",
      pnl_pct: r1(pnl), bench_name: benchName[benchKey(code)],
      hs300_pnl_pct: r1(idxPnl), alpha_pct: r1(alpha),
      invalidation_triggered: triggered, level: pa.level, stage: pa.stage,
      ret_1m_pct: pa.ret_1m_pct,
      shadow,
    });
  }
  return { items: results, checked_at: nowStr() };
}

async function wishCheck(env, items) {
  const results = [];
  for (const it of items.split(",")) {
    const parts = it.trim().split(":");
    if (parts.length < 2) continue;
    const code = parts[0].toUpperCase(), target = parseFloat(parts[1]);
    const pa = await priceAnalysis(env, code);
    if (!pa) { results.push({ code, error: "无价格数据" }); continue; }
    results.push({
      code, target, last: pa.last, cur: pa.cur || "¥",
      hit: pa.last <= target,
      gap_pct: Math.round((pa.last / target - 1) * 1000) / 10,
      level: pa.level, stage: pa.stage, ret_1m_pct: pa.ret_1m_pct,
    });
  }
  return { items: results, checked_at: nowStr() };
}

async function history(env, code, points = 60) {
  code = code.trim().toUpperCase();
  const s = await dailySeries(env, code);
  if (!s) return { error: "无数据" };
  const market = isAshare(code) ? "A股"
    : code.endsWith(".TO") || s.currency === "CAD" ? "加拿大" : "美股";
  return { code, market, cur: CUR_SYM[s.currency] || "$",
    dates: s.dates.slice(-points),
    closes: s.closes.slice(-points).map((c) => Math.round(c * 100) / 100) };
}

async function resolve(env, q) {
  q = q.trim().toUpperCase();
  if (isAshare(q)) {
    const info = await tushare(env, "stock_basic", { ts_code: q }, "ts_code,name");
    if (info?.items?.length)
      return { ok: true, code: q, name: info.items[0][1], market: "A股", cur: "¥" };
    return { ok: false };
  }
  if (/^\d{6}$/.test(q)) {
    const sufs = q[0] === "6" ? [".SH", ".SZ"] : [".SZ", ".SH"];
    for (const suf of sufs) {
      const info = await tushare(env, "stock_basic", { ts_code: q + suf }, "ts_code,name");
      if (info?.items?.length)
        return { ok: true, code: q + suf, name: info.items[0][1], market: "A股", cur: "¥" };
    }
  }
  if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(q)) {
    const y = await yahooChart(q);
    if (y) {
      const cur = y.meta.currency || "USD";
      return { ok: true, code: q, name: y.meta.shortName || y.meta.longName || q,
        market: q.endsWith(".TO") || cur === "CAD" ? "加拿大" : "美股",
        cur: CUR_SYM[cur] || "$" };
    }
  }
  const items = await stockList(env);
  for (const [ts, name] of items)
    if (name.toUpperCase().includes(q))
      return { ok: true, code: ts, name, market: "A股", cur: "¥" };
  return { ok: false };
}

async function verifyTickers(env, codes) {
  const uniq = [...new Set(codes.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean))].slice(0, 12);
  const results = [];
  for (const code of uniq) {
    if (isAshare(code)) {
      const info = await tushare(env, "stock_basic", { ts_code: code }, "ts_code,name");
      if (info?.items?.length) {
        const pa = await priceAnalysis(env, code);
        results.push({ code, ok: true, name: info.items[0][1], last: pa?.last ?? null, cur: "¥" });
      } else results.push({ code, ok: false });
    } else {
      const y = await yahooChart(code);
      if (y) results.push({ code, ok: true,
        name: y.meta.shortName || y.meta.longName || code,
        last: Math.round(y.closes[y.closes.length - 1] * 100) / 100,
        cur: CUR_SYM[y.meta.currency || "USD"] || "$" });
      else results.push({ code, ok: false });
    }
  }
  return { items: results, checked_at: nowStr() };
}

async function search(env, keyword) {
  const items = await stockList(env);
  const kw = keyword.toUpperCase();
  const out = [];
  for (const [code, name] of items) {
    if (code.includes(kw) || name.toUpperCase().includes(kw)) {
      out.push({ code, name });
      if (out.length >= 10) break;
    }
  }
  return { items: out };
}

/* ───────── 一键选股 + AI 风险审查（高级工具，从 index.py 移植） ───────── */

function fiveFactorScore(close, pe, pb, dv, maxPrice, cfg) {
  const sDv = Math.min((dv / 6) * 20, 20);
  const [peMin, peMax] = [3, cfg.pe];
  const sPe = pe > 0 ? Math.max(0, Math.min(20, ((peMax - pe) / (peMax - peMin)) * 20)) : 0;
  const [pbMin, pbMax] = [0.5, cfg.pb];
  const sPb = pb > 0 ? Math.max(0, Math.min(20, ((pbMax - pb) / (pbMax - pbMin)) * 20)) : 0;
  const roe = pe > 0 && pb > 0 ? (pb / pe) * 100 : 0;
  const sRoe = Math.min((roe / 20) * 20, 20);
  const best = maxPrice * 0.7;
  const dev = Math.abs(close - best) / Math.max(best, 0.01);
  const sPrice = Math.max(0, 20 - dev * 20);
  const r1 = (x) => Math.round(x * 10) / 10;
  return { total: r1(sDv + sPe + sPb + sRoe + sPrice), roe_est: r1(roe) };
}

async function scan(env, principal = 2000, risk = "stable") {
  let maxPrice = Math.max(Math.min(principal / 100, 300), 2);
  const cfgs = {
    stable: { pe: 15, dv: 4, pb: 2 },
    growth: { pe: 25, dv: 2.5, pb: 3.5 },
    aggressive: { pe: 55, dv: 0.8, pb: 7 },
  };
  const cfg = cfgs[risk] || cfgs.stable;

  let dailyData = null, targetDate = "";
  for (let i = 1; i < 10; i++) {
    const d = daysAgo(i);
    dailyData = await tushare(env, "daily_basic", { trade_date: d }, "ts_code,close,pe,pb,dv_ratio");
    if (dailyData?.items?.length) { targetDate = d; break; }
  }
  if (!dailyData) return { error: "暂无行情数据", top_picks: [] };

  const nameMap = Object.fromEntries(await stockList(env));
  const results = [];
  for (const [code, close, pe, pb, dv] of dailyData.items) {
    if (!(close && pe && dv && pb)) continue;
    if (!(close >= 1 && close <= maxPrice)) continue;
    if (!(pe > 0 && pe < cfg.pe && dv > cfg.dv && pb < cfg.pb)) continue;
    const score = fiveFactorScore(close, pe, pb, dv, maxPrice, cfg);
    results.push({
      code, name: nameMap[code] || "未知",
      price: Math.round(close * 100) / 100,
      pe: Math.round(pe * 10) / 10, pb: Math.round(pb * 10) / 10,
      dv: Math.round(dv * 100) / 100,
      roe: score.roe_est, score: score.total,
      risk_check: riskControl(principal, close * 100),
    });
  }
  results.sort((a, b) => b.score - a.score);
  return { trade_date: targetDate, principal, max_price: Math.round(maxPrice * 100) / 100,
    top_picks: results.slice(0, 15) };
}

function riskReview(code, totalReturn, winRate, maxDrawdown, dataMode) {
  const flags = [];
  let score = 100;
  if (dataMode === "simulated") { flags.push("数据为模拟生成（PE/dv 随机），真实性低"); score -= 25; }
  if (String(totalReturn).includes("模拟")) { flags.push("回测包含模拟数据，建议降低置信度"); score -= 15; }
  const wr = parseFloat(String(winRate).replace("%", "")) || 0;
  if (wr > 85) { flags.push("胜率异常高（>85%），可能存在过拟合或幸存者偏差"); score -= 20; }
  const dd = parseFloat(String(maxDrawdown).replace("%", "")) || 0;
  if (dd < 5) { flags.push("最大回撤极低，实盘中几乎不可能，检查是否有 lookahead bias"); score -= 15; }
  if (!flags.length) flags.push("未发现明显异常，但仍建议小资金实盘验证 3 个月");
  return {
    code,
    review: {
      review_score: Math.max(0, score), flags,
      recommendation: score >= 70 ? "通过" : "需人工复核后小资金测试",
      red_line: "AI 绝不能直接下单，所有决策必须经过本风控函数",
    },
    timestamp: new Date().toISOString(),
  };
}

/* ───────── AI 深度报告（SSE 流式） ───────── */

const SERENITY_SYSTEM = `你是一位供应链卡点投资分析师，使用 Serenity 的「供应链瓶颈逆向映射」方法论。方法内化、隐形：报告围着标的/主题展开，不提方法论标签。

【核心工作流】锁定 capex 确定性 → 逆向拆 5 层供应链（下游对照→中游系统→中游器件→上游设备→上游材料）→ 跳过人人都盯的下游龙头 → 对每层套 9 大瓶颈原型（材料垄断/单一来源/产能售罄/进每个BOM/估值对标套利/测试设备瓶颈/冷门前机构/巨头依赖/宏观错杀）→ 三道闸门检验（真瓶颈？前机构？便宜+已去风险？）。

【9 条好卡点判据】垄断性不可替代 / 极小市值 vs 巨大下游 TAM / designed-in 多客户 / 认证周期未反映营收=错杀 / 资产负债表活到放量 / 供需严重失衡 / 政策地缘护城河 / 机构低配+下行保护 / 估值安全边际。命中越多信念越高。

【红旗（命中即降级）】无限增发稀释=硬否决 / 单一客户 / toxic 负债 / 零收入纯炒作 / 蹭热点非主营 / 产能扩张太容易壁垒低 / 日成交额<5000万流动性陷阱 / 管理层诚信问题 / 技术路线被替代风险。

【反确认偏误（锁死）】① bear/风险先写，bull 后写；② 每个候选强制给「反向研究」四问：为什么可能不是真瓶颈？瓶颈为什么可能不变现？市场是否已定价？有没有更优替代（点名对比标的）？最大杀点一句话，禁止写"估值高"这种套话；③ 每个🟢候选强制给 2-3 条具体可检验的证伪条件，至少一条是价格规则（如"跌破 X 元且月动量转负"）。

【取数纪律】所有事实分级标注：已证实/管理层声称/我的推断/纯推测。你无法联网，训练数据有截止日期——凡是价格、市值、最新订单等时效数据一律标 [知识库·可能过期，需自行核实]，禁止编造具体数字冒充实时数据。不确定的公司状态（是否私有/被收购）显式说明需要核实。

【中文表达】写给中文母语读者。投资圈通用术语保留（PE/capex/backlog/TAM），首次出现给一句中文解释。禁止英式句法和生造词。加粗克制。

【估值纪律】给估值必须分 bear/base/bull 三档区间并绑死假设（对标谁/几倍/哪年）。可比公司质量高用相对估值（PE/EV/S/PEG 对标 gap），无好对标退化用份额跨层法（份额=营收/TAM，TAM 需说明来源）。精度降级铁律：关键假设里有[推断]/[推测]，就禁止给精确百分比，只给数量级和方向；无可信对标就直说"区间太宽，不给假精确"。禁止抄分析师目标价当标尺。

【输出结构】30秒看懂（大白话）→ 供应链拆解（哪层可能是卡点，为什么）→ 候选名单（每只：是什么/卡点逻辑/命中判据/红旗/反向研究/三档判定🟢🟡🔴/证伪条件）→ 落地结论 → 免责声明。A股候选给 6 位代码+交易所后缀。

【供应链图谱】报告最末尾必须附一个机器可读图谱块，格式严格如下（单独一行开始）：
\`\`\`chain
{"layers":[{"name":"下游应用","nodes":["特斯拉","比亚迪 002594.SZ"]},{"name":"中游系统","nodes":[...]},{"name":"中游器件","nodes":[...]},{"name":"上游设备","nodes":[...]},{"name":"上游材料","nodes":[...]}],"edges":[["上游节点名","下游节点名"],...]}
\`\`\`
节点名与正文一致（有代码带代码），edges 方向为供货方→采购方，每层 2-4 个节点。

【铁律】仅供研究教育，非投资建议，不给具体仓位和买卖指令。按框架不成立就直说不成立。`;

const REVIEWER_SYSTEM = `你是独立复核员，立场是挑刺反驳，不是背书。对这份供应链卡点投研报告快速复核，输出必须简短（300字内）、大白话：

1. 【裁决】通过 / 有问题需注意（一句话）
2. 【最可疑的 2-3 处】：编造嫌疑的数字（没标注来源或时效的具体价格/市值/份额）、逻辑硬伤（判据命中没依据、结论与事实不符）、迎合用户倾向的地方
3. 【读者动手前必须自己核实的清单】：列 3 条以内最关键的待核实项

不复述报告内容。没发现大问题就说"未发现硬伤"再给核实清单。`;

async function* streamDeepseek(env, system, user, maxTokens = 8000) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat", stream: true, max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      try {
        const delta = JSON.parse(line.slice(6)).choices[0].delta?.content;
        if (delta) yield delta;
      } catch { /* 忽略半截 JSON */ }
    }
  }
}

async function* streamAnthropic(env, system, user, maxTokens = 8000, effort = "medium", webSearch = false) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const params = {
    model: "claude-opus-4-8",
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  };
  if (webSearch) params.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }];
  const stream = client.messages.stream(params);
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta")
      yield event.delta.text;
  }
}

function llmStream(env, system, user, maxTokens = 8000, effort = "medium", webSearch = false) {
  if (env.DEEPSEEK_API_KEY) return streamDeepseek(env, system, user, maxTokens);
  return streamAnthropic(env, system, user, maxTokens, effort, webSearch);
}

function analyzeSSE(env, query, market) {
  const enc = new TextEncoder();
  const send = (ctrl, obj) => ctrl.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));

  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        if (!env.DEEPSEEK_API_KEY && !env.ANTHROPIC_API_KEY) {
          send(ctrl, { error: "未配置 AI 密钥。请用 wrangler secret put DEEPSEEK_API_KEY 添加后重试；「查一只股」和持仓功能不受影响。" });
          ctrl.close(); return;
        }
        const report = [];
        for await (const text of llmStream(env, SERENITY_SYSTEM, `市场范围：${market}。请分析：${query}`, 8000, "medium", true)) {
          report.push(text);
          send(ctrl, { text });
        }
        send(ctrl, { phase: "review" });
        try {
          for await (const text of llmStream(env, REVIEWER_SYSTEM,
            `用户的原始问题：${query}\n\n待复核的报告：\n${report.join("")}`, 1800, "low"))
            send(ctrl, { review: text });
        } catch (re) {
          send(ctrl, { review: `（复核失败：${re.message}）` });
        }
        send(ctrl, { done: true });
      } catch (e) {
        send(ctrl, { error: String(e.message || e) });
      }
      ctrl.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

/* ───────── 路由 ───────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const q = (k, def = "") => url.searchParams.get(k) ?? def;

    try {
      if (p === "/api/serenity/stock_check")
        return json(await stockCheck(env, q("code"), parseFloat(q("principal", "2000"))));
      if (p === "/api/serenity/watch_check") return json(await watchCheck(env, q("items")));
      if (p === "/api/serenity/wish_check") return json(await wishCheck(env, q("items")));
      if (p === "/api/serenity/history")
        return json(await history(env, q("code"), parseInt(q("points", "60"))));
      if (p === "/api/serenity/resolve") return json(await resolve(env, q("q")));
      if (p === "/api/serenity/verify_tickers") return json(await verifyTickers(env, q("codes")));
      if (p === "/api/serenity/analyze") return analyzeSSE(env, q("query"), q("market", "A股"));
      if (p === "/api/search") return json(await search(env, q("keyword")));
      if (p === "/api/scan")
        return json(await scan(env, parseFloat(q("principal", "2000")), q("risk", "stable")));
      if (p === "/api/risk_review")
        return json(riskReview(q("code"), q("total_return", "12.5%"), q("win_rate", "68%"),
          q("max_drawdown", "9.2%"), q("data_mode", "real")));
      if (p.startsWith("/api/"))
        return json({ error: `接口 ${p} 未在 Cloudflare 版实现（旧回测接口已下线）` }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }

    // 非 API 请求 → 静态资源（public/）
    return env.ASSETS.fetch(request);
  },
};
