/**
 * SteadyQuant Cloudflare Worker
 * 从 Vercel FastAPI (api/index.py + api/serenity.py) 逐条移植的 JS 版后端。
 * 数据源：Tushare（A股）、Yahoo Finance（美股/加股）、DeepSeek/Anthropic（AI 报告）。
 */
import Anthropic from "@anthropic-ai/sdk";
import * as auth from "./auth.js";
import { pack } from "./i18n.js";

const CUR_SYM = { CNY: "¥", USD: "$", CAD: "C$", HKD: "HK$" };
const isAshare = (c) => /^\d{6}\.(SH|SZ)$/.test(c);
// 常见币简写白名单：命中即先按 <X>-USD 试加密货币。含与股票代码同名者（LINK/UNI/APT…），
// 面向"币友"用户默认识别为币；MATIC 已改名 POL，两者都列。
const CRYPTO_SHORTHAND = new Set([
  "BTC","ETH","SOL","DOGE","XRP","BNB","ADA","LTC","DOT","AVAX","SHIB","TRX","PEPE",
  "LINK","UNI","ATOM","NEAR","FIL","APT","ARB","OP","SUI","INJ","AAVE","MKR","POL","MATIC","TON","ICP","HBAR","RENDER",
]);
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
    const closes = [], highs = [], lows = [], dates = [];
    for (let i = 0; i < quote.close.length; i++) {
      if (quote.close[i] != null) {
        closes.push(quote.close[i]);
        // 高低价偶有 null：退回收盘价（当天真实波幅按 0 算，宁可低估不编数）
        highs.push(quote.high?.[i] ?? quote.close[i]);
        lows.push(quote.low?.[i] ?? quote.close[i]);
        dates.push(fmtDate(new Date(r.timestamp[i] * 1000)));
      }
    }
    return { closes, highs, lows, dates, meta: r.meta || {} };
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
    // 腾讯行格式 [日期, 开, 收, 高, 低, 量, ...]
    const out = { dates: [], closes: [], highs: [], lows: [] };
    for (const r of rows) {
      const c = parseFloat(r[2]);
      if (!isNaN(c)) {
        out.dates.push(String(r[0]).replace(/-/g, ""));
        out.closes.push(c);
        const h = parseFloat(r[3]), l = parseFloat(r[4]);
        out.highs.push(isNaN(h) ? c : h);
        out.lows.push(isNaN(l) ? c : l);
      }
    }
    return out.closes.length >= 30 ? out : null;
  } catch { return null; }
}

async function tushareDaily(env, code) {
  const daily = await tushare(env, "daily",
    { ts_code: code, start_date: daysAgo(480), end_date: fmtDate(new Date()) }, "trade_date,close,high,low");
  if (!daily?.items || daily.items.length < 30) return null;
  const rows = daily.items.filter((r) => r[1] != null).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { dates: rows.map((r) => r[0]), closes: rows.map((r) => Number(r[1])),
    highs: rows.map((r) => Number(r[2] ?? r[1])), lows: rows.map((r) => Number(r[3] ?? r[1])) };
}

/** 统一日线序列：A股走 腾讯→Tushare 回退链，海外走 Yahoo。返回 {dates, closes, currency} */
async function dailySeries(env, code) {
  if (isAshare(code)) {
    const s = (await tencentDaily(code)) || (await tushareDaily(env, code));
    return s ? { ...s, currency: "CNY" } : null;
  }
  const y = await yahooChart(code);
  if (!y || y.closes.length < 30) return null;
  return { dates: y.dates.slice(-320), closes: y.closes.slice(-320),
    highs: y.highs.slice(-320), lows: y.lows.slice(-320), currency: y.meta.currency || "USD" };
}

/* ── 汇率：解决"用加币买美股"这类跨币种记账 ──
   Yahoo 的 USDCAD=X 表示"1 USD = ? CAD"。返回 date → rate 的映射。 */
const fxCache = {};
async function fxSeries(from, to) {
  if (from === to) return null;
  const key = `${from}${to}`;
  if (!(key in fxCache)) {
    fxCache[key] = (async () => {
      const y = await yahooChart(`${key}=X`);
      if (!y?.closes?.length) return null;
      const map = {};
      y.dates.forEach((d, i) => (map[d] = y.closes[i]));
      return map;
    })();
  }
  return fxCache[key];
}
/** 取某日汇率：优先当日，没有就用该日之前最近的一天（休市/时差）。
   拉取失败（map 为 null）或查询日早于整个序列 → 返回 null（绝不用 1 或方向错误的汇率兜底，
   调用方据此报错/跳过，避免把「拉不到汇率」伪装成「汇率正好=1」）。 */
function fxAt(map, date) {
  if (!map) return null;
  const dates = Object.keys(map).sort();
  if (!dates.length) return null;
  let pick = null;
  for (const d of dates) { if (d <= date) pick = d; else break; }
  return pick ? map[pick] : null; // date 早于序列起点 → null（不硬套之后某天的汇率）
}
const fxLatest = (map) => {
  if (!map) return null;
  const dates = Object.keys(map).sort();
  return dates.length ? map[dates[dates.length - 1]] : null;
};

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

function computePA(closes, currency, S = pack("zh"), highs = null, lows = null) {
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

  let level, levelKey;
  if (rangePos >= 90) { levelKey = "top"; level = S.lvl_top; }
  else if (rangePos >= 70) { levelKey = "high"; level = S.lvl_high; }
  else if (rangePos >= 40) { levelKey = "mid"; level = S.lvl_mid; }
  else if (rangePos >= 15) { levelKey = "low"; level = S.lvl_low; }
  else { levelKey = "bottom"; level = S.lvl_bottom; }

  let stage, stageKey;
  if (ret1m !== null && ret1m > 15 && rangePos > 80) { stageKey = "extended"; stage = S.stg_extended; }
  // 近1月大跌先判 falling，别被"3月还涨"的 momentum 抢先吞掉（否则暴跌股被判"趋势健康"、绕过接飞刀保护）
  else if (ret1m !== null && ret1m < -10) { stageKey = "falling"; stage = S.stg_falling; }
  else if (aboveSma50 && ret3m !== null && ret3m > 0 && rangePos > 50) { stageKey = "momentum"; stage = S.stg_momentum; }
  else if (rangePos < 30 && ret1m !== null && ret1m > -5) { stageKey = "basing"; stage = S.stg_basing; }
  else { stageKey = "neutral"; stage = S.stg_neutral; }

  /* ── 波动统计（借 Kronos 的"概率路径"思想，用真实历史波动率实现，非预测模型）──
     · 年化波动率：近 120 日对数收益标准差 × √252
     · 波动区间：假设零漂移（不猜方向），1周/1月/3月 的 ±1σ(68%) / ±2σ(95%) 价格区间
     · ATR14：真实波幅均值（高低价参与），用于按标的自己的脾气定止损提醒线 */
  const rets = [];
  const volWin = closes.slice(-121);
  for (let i = 1; i < volWin.length; i++) rets.push(Math.log(volWin[i] / volWin[i - 1]));
  let sigmaD = null, volAnnual = null, bands = null;
  if (rets.length >= 20) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    sigmaD = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1));
    volAnnual = sigmaD * Math.sqrt(252) * 100;
    const band = (h) => ({
      lo1: last * Math.exp(-sigmaD * Math.sqrt(h)), hi1: last * Math.exp(sigmaD * Math.sqrt(h)),
      lo2: last * Math.exp(-2 * sigmaD * Math.sqrt(h)), hi2: last * Math.exp(2 * sigmaD * Math.sqrt(h)),
    });
    bands = { w1: band(5), m1: band(21), m3: band(63) };
  }
  let atr = null, atrPct = null, stopAtrPct = null;
  if (highs && lows && highs.length === closes.length && closes.length >= 15) {
    const trs = [];
    for (let i = closes.length - 14; i < closes.length; i++) {
      const pc = closes[i - 1];
      trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - pc), Math.abs(lows[i] - pc)));
    }
    atr = trs.reduce((a, b) => a + b, 0) / trs.length;
    atrPct = (atr / last) * 100;
    // 止损提醒距离 = 2.5×ATR，钳在 8%~25%：波动小的股别被日常呼吸震出局，波动大的币别把亏损放太深
    stopAtrPct = Math.min(25, Math.max(8, 2.5 * atrPct));
  }

  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const rb = (b) => (b ? { lo1: r2(b.lo1), hi1: r2(b.hi1), lo2: r2(b.lo2), hi2: r2(b.hi2) } : null);
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
    level, levelKey,
    stage, stageKey,
    data_points: closes.length,
    win_days: win.length, // 水位实际回看的交易日数（新股不足 120 时据此如实标注，不谎称"近6个月"）
    vol_annual_pct: r1(volAnnual),
    bands: bands ? { w1: rb(bands.w1), m1: rb(bands.m1), m3: rb(bands.m3) } : null,
    atr_pct: r1(atrPct),
    stop_atr_pct: r1(stopAtrPct),
  };
}

async function priceAnalysis(env, code, S = pack("zh")) {
  const s = await dailySeries(env, code);
  if (!s) return null;
  return computePA(s.closes.slice(-140), s.currency, S, s.highs?.slice(-140), s.lows?.slice(-140));
}

/* ───────── 红旗 / 判据 / 判定 / 证伪 / 风控 ───────── */

function redFlagScan(basic, pa, S = pack("zh")) {
  const flags = [];
  const { pe, pb, total_mv: mv, amount: turnover } = basic;
  if (pe != null && pe > 100) flags.push({ level: "hard", text: S.flag_pe_extreme(Math.round(pe)) });
  if (pe == null || pe <= 0) flags.push({ level: "warn", text: S.flag_pe_neg });
  if (pb != null && pb > 10) flags.push({ level: "warn", text: S.flag_pb_high(pb.toFixed(1)) });
  if (turnover != null && turnover < 50000) flags.push({ level: "hard", text: S.flag_illiquid });
  if (mv != null && mv > 30000000) flags.push({ level: "warn", text: S.flag_megacap });
  if (pa?.stageKey === "extended") flags.push({ level: "warn", text: S.flag_extended(pa.ret_1m_pct) });
  if (pa?.stageKey === "falling") flags.push({ level: "warn", text: S.flag_falling });
  return flags;
}

const CRIT_IDS = ["monopoly", "designin", "certlag", "imbalance", "policy", "balance", "preinst"];
const critManual = (S) => CRIT_IDS.map((id, i) => ({ id, text: S.crit_manual[i] }));

function criteriaAuto(basic, S = pack("zh")) {
  const out = [];
  const mv = basic.total_mv;
  if (mv != null) {
    const mvYi = mv / 10000;
    const small = mvYi < 150;
    out.push({ id: "smallcap", hit: small, text: S.crit_smallcap(Math.round(mvYi), small) });
  }
  const pe = basic.pe;
  if (pe != null && pe > 0) {
    const cheap = pe < 25;
    out.push({ id: "valuation", hit: cheap, text: S.crit_valuation(pe.toFixed(1), cheap) });
  }
  return out;
}

function twoAxisVerdict(pa, basic, S = pack("zh")) {
  const highWater = pa.range_pos_6mo_pct >= 70;
  const pe = basic.pe;

  // 无估值数据（缺 pe 且缺 pb）→ 温和🟡，别把"缺数据"冒充"坏基本面"给 🔴
  if (pe == null && basic.pb == null) {
    if (highWater) return { code: "yellow", label: S.v_high_noval, hint: S.v_high_noval_h };
    return { code: "yellow", label: S.v_cheap_noval, hint: S.v_cheap_noval_h };
  }

  const fundOk = pe != null && pe > 0 && pe < 40;
  // 高水位 + 极低 PE：可能是周期股盈利见顶的价值陷阱（顶部盈利虚高→PE反低），不给"别 fade"的绿灯
  if (highWater && pe != null && pe > 0 && pe < 15)
    return { code: "yellow", label: S.v_cyc_top, hint: S.v_cyc_top_h };
  if (highWater && fundOk) return { code: "green", label: S.v_pricey_right, hint: S.v_pricey_right_h };
  if (highWater && !fundOk) return { code: "red", label: S.v_real_top, hint: S.v_real_top_h };
  if (!highWater && fundOk) return { code: "green", label: S.v_ambush, hint: S.v_ambush_h };
  return { code: "yellow", label: S.v_wait, hint: S.v_wait_h };
}

function invalidationRules(pa, S = pack("zh")) {
  const stop = Math.round(pa.last * 0.85 * 100) / 100;
  const cur = pa.cur || "¥";
  return {
    stop_price: stop,
    rules: [S.inval_price(cur, stop), S.inval_fund, S.inval_val],
    note: S.inval_note,
  };
}

function riskControl(principal, proposedPosition, S = pack("zh")) {
  const limit = principal * 0.1;
  const passed = proposedPosition <= limit;
  return {
    passed,
    reasons: passed ? [] : [S.risk_over(Math.round(proposedPosition), Math.round(limit))],
    proposed_position: proposedPosition,
    max_allowed: Math.round(limit * 100) / 100,
    drawdown: 0, strategy_age_days: 999,
  };
}

/* ───────── 各端点 ───────── */

async function stockCheck(env, code, principal = 2000, S = pack("zh")) {
  code = code.trim().toUpperCase();

  if (!isAshare(code)) {
    // 常见币简写（BTC / ETH / SOL…）自动补全成 Yahoo 币对；其余一律先按股票查
    let y = null;
    if (CRYPTO_SHORTHAND.has(code)) {
      const c = await yahooChart(code + "-USD");
      if (c?.meta?.instrumentType === "CRYPTOCURRENCY") { y = c; code = code + "-USD"; }
    }
    if (!y) y = await yahooChart(code);
    if (!y) return { error: S.err_not_found(code) };
    const isCrypto = y.meta.instrumentType === "CRYPTOCURRENCY";
    const name = y.meta.shortName || y.meta.longName || code;
    const market = isCrypto ? S.mkt_crypto
      : code.endsWith(".HK") || y.meta.currency === "HKD" ? S.mkt_hk
      : code.endsWith(".TO") || y.meta.currency === "CAD" ? S.mkt_ca : S.mkt_us;
    const pa = computePA(y.closes.slice(-140), y.meta.currency || "USD", S, y.highs?.slice(-140), y.lows?.slice(-140));
    if (!pa) return { error: S.err_price_thin2 };
    // 海外/币的 basic 为空是"没接数据"而非"真亏损"，去掉误导性的 PE 缺失红旗
    const flags = redFlagScan({}, pa, S).filter((f) => f.text !== S.flag_pe_neg);
    let verdict;
    if (isCrypto) {
      flags.unshift({ level: "warn", text: S.flag_crypto });
      const high = pa.range_pos_6mo_pct >= 70;
      if (pa.stage.startsWith("falling"))
        verdict = { code: "yellow", label: S.v_crypto_fall, hint: S.v_crypto_fall_h };
      else if (high)
        verdict = { code: "yellow", label: S.v_crypto_high, hint: S.v_crypto_high_h };
      else
        verdict = { code: "yellow", label: S.v_crypto_low, hint: S.v_crypto_low_h };
    } else {
      verdict = twoAxisVerdict(pa, {}, S);
      if (pa.stageKey === "falling" && verdict.code === "green")
        verdict = { code: "yellow", label: S.v_wait_fall, hint: S.v_wait_fall_h2 };
    }
    return {
      code, name, industry: market, price: pa, basic: {},
      red_flags: flags, criteria_auto: [],
      criteria_manual: isCrypto ? [] : critManual(S),
      verdict, invalidation: invalidationRules(pa, S),
      risk_check: riskControl(principal, pa.last, S),
      disclaimer: isCrypto ? S.disc_crypto : S.disc_os,
    };
  }

  const info = await tushare(env, "stock_basic", { ts_code: code }, "ts_code,name,industry,list_date");
  if (!info?.items?.length) return { error: S.err_ticker(code) };
  const [, name, industry] = info.items[0];

  const pa = await priceAnalysis(env, code, S);
  if (!pa) return { error: S.err_price_thin };

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

  const flags = redFlagScan(basic, pa, S);
  let verdict = twoAxisVerdict(pa, basic, S);
  if (pa.stageKey === "falling" && verdict.code === "green")
    verdict = { code: "yellow", label: S.v_wait_fall, hint: S.v_wait_fall_h };
  if (flags.some((f) => f.level === "hard") && verdict.code === "green")
    verdict = { code: "yellow", label: S.v_hard_flag, hint: S.v_hard_flag_h };

  const basicOut = {};
  for (const [k, v] of Object.entries(basic))
    if (v != null) basicOut[k] = typeof v === "number" ? Math.round(v * 100) / 100 : v;

  return {
    code, name, industry, price: pa, basic: basicOut,
    red_flags: flags, criteria_auto: criteriaAuto(basic, S), criteria_manual: critManual(S),
    verdict, invalidation: invalidationRules(pa, S),
    risk_check: riskControl(principal, pa.last * 100, S),
    disclaimer: S.disc_a,
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

async function watchCheck(env, items, S = pack("zh")) {
  const benchCache = {};
  const benchName = { hs300: S.bench_hs300, "^GSPC": S.bench_spx, "^GSPTSE": S.bench_tsx, "BTC-USD": S.bench_btc };
  const benchKey = (code) =>
    isAshare(code) ? "hs300"
    : /-(USD|USDT|USDC)$/.test(code) ? "BTC-USD"
    : code.endsWith(".TO") ? "^GSPTSE" : "^GSPC";
  // 基准指数用 Promise 缓存，避免并行时同一指数重复拉取
  const getBench = (code) => {
    const key = benchKey(code);
    if (!(key in benchCache))
      benchCache[key] = key === "hs300" ? hs300Series(env) : yahooSeries(key);
    return benchCache[key];
  };

  // 每只持仓独立检查，全部并行（5只 3.5s → ~1.5s）
  const parsed = items.split(",")
    .map((it) => it.trim().split(":"))
    .filter((p) => p.length >= 3);

  const results = await Promise.all(parsed.map(async (parts) => {
    const code = parts[0].toUpperCase();
    const entry = parseFloat(parts[1]), stop = parseFloat(parts[2]);
    const added = parts[3] ? parts[3].replace(/-/g, "") : null;
    const costCur = (parts[4] || "").toUpperCase() || null; // 你实际付款的币种（如加币买美股）
    const series = await dailySeries(env, code);
    const pa = series ? computePA(series.closes.slice(-140), series.currency, S, series.highs?.slice(-140), series.lows?.slice(-140)) : null;
    if (!pa) return { code, error: S.err_no_price };

    // 跨币种记账：成本按你付的币计（对得上券商账单），
    // 但水位/判定仍按标的自身币种算（避免汇率噪音污染"是不是在高位"的判断）。
    const quoteCur = series.currency;
    const needFx = costCur && costCur !== quoteCur;
    const fx = needFx ? await fxSeries(quoteCur, costCur) : null;
    const fxNow = needFx ? fxLatest(fx) : 1;
    if (needFx && !fxNow) return { code, error: S.err_fx(quoteCur, costCur) };

    const cur = needFx ? (CUR_SYM[costCur] || costCur + " ") : (pa.cur || "¥");
    const lastCost = pa.last * fxNow;                 // 现价换算成你的币
    const pnl = (lastCost / entry - 1) * 100;         // 你真实的盈亏（含汇率影响）
    const triggered = lastCost < stop && pa.ret_1m_pct !== null && pa.ret_1m_pct < 0;

    // 纪律对照（Vibe-Trading Shadow Account 的简化版）：
    // 找出加入后第一次收盘跌破止损线的那天——如果那天按纪律卖了，现在会怎样
    let shadow = null;
    if (added) {
      for (let i = 0; i < series.dates.length; i++) {
        if (series.dates[i] <= added) continue;
        const closeCost = needFx ? series.closes[i] * fxAt(fx, series.dates[i]) : series.closes[i];
        if (closeCost < stop) {
          const discPnl = (closeCost / entry - 1) * 100;
          shadow = {
            cross_date: series.dates[i],
            discipline_pnl_pct: Math.round(discPnl * 10) / 10,
            saved_pct: Math.round((discPnl - pnl) * 10) / 10, // >0 = 守纪律能少亏这么多
          };
          break;
        }
      }
    }

    // alpha 用标的自身币种算：个股和指数都在同一币种下比，汇率影响自然抵消，
    // 这样"选股有没有本事"不会被汇率涨跌搅浑。
    let alpha = null, idxPnl = null;
    if (added) {
      const bench = await getBench(code);
      if (bench) {
        const bDates = Object.keys(bench).sort();
        const base = bDates.find((d) => d >= added);
        // base 必须真正对齐建仓日：added 早于整个基准窗口 → 数据不足，不出 alpha
        // （否则拿"多年个股收益"减"仅约1年大盘收益"，超额被严重夸大）
        const aligned = base && bDates.length && added >= bDates[0];
        const fxEntry = needFx ? fxAt(fx, added) : 1;
        if (aligned && fxEntry) {
          idxPnl = (bench[bDates[bDates.length - 1]] / bench[base] - 1) * 100;
          const pnlQuote = (pa.last / (entry / fxEntry) - 1) * 100;
          alpha = pnlQuote - idxPnl;
        }
      }
    }
    const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
    return {
      code, entry, stop, cur,
      last: Math.round(lastCost * 100) / 100,
      quote_last: needFx ? pa.last : null,
      quote_cur: needFx ? (CUR_SYM[quoteCur] || quoteCur) : null,
      fx_rate: needFx ? Math.round(fxNow * 10000) / 10000 : null,
      pnl_pct: r1(pnl), bench_name: benchName[benchKey(code)],
      hs300_pnl_pct: r1(idxPnl), alpha_pct: r1(alpha),
      invalidation_triggered: triggered, level: pa.level, stage: pa.stage,
      ret_1m_pct: pa.ret_1m_pct,
      shadow,
    };
  }));
  return { items: results, checked_at: nowStr() };
}

async function wishCheck(env, items, S = pack("zh")) {
  const parsed = items.split(",").map((it) => it.trim().split(":")).filter((p) => p.length >= 2);
  const results = await Promise.all(parsed.map(async (parts) => {
    const code = parts[0].toUpperCase(), target = parseFloat(parts[1]);
    const pa = await priceAnalysis(env, code, S);
    if (!pa) return { code, error: S.err_no_price };
    return {
      code, target, last: pa.last, cur: pa.cur || "¥",
      hit: pa.last <= target,
      // "还差 X% 跌到目标" = 还需下跌多少，分母用现价：(1 - 目标/现价)
      gap_pct: Math.round((1 - target / pa.last) * 1000) / 10,
      level: pa.level, stage: pa.stage, ret_1m_pct: pa.ret_1m_pct,
    };
  }));
  return { items: results, checked_at: nowStr() };
}

/* ───────── 交易台账 → 组合分析（分市场表 + 汇率总表 + 战绩） ─────────
   输入每只股的完整买卖流水，按移动平均法算已实现/未实现盈亏，
   分市场用本币小计，总表按最新汇率换算到 base 币种。所有钱的计算都在这里。 */
const MARKET_OF = (code) =>
  isAshare(code) ? "A股"
  : /-(USD|USDT|USDC)$/.test(code) ? "加密货币"
  : code.endsWith(".HK") ? "港股"
  : code.endsWith(".TO") ? "加拿大" : "美股";
const CUR_OF_MARKET = { "A股": "CNY", "美股": "USD", "加拿大": "CAD", "港股": "HKD", "加密货币": "USD" };

async function portfolio(env, body, S = pack("zh")) {
  const items = Array.isArray(body?.items) ? body.items : [];
  const base = ["CNY", "USD", "CAD", "HKD"].includes(body?.base) ? body.base : "CNY";
  if (!items.length) return { stocks: [], markets: [], total: null, base, checked_at: nowStr() };

  // 每只股：拉现价 + 按流水算盈亏。
  // 记账币（acctCur）= 用户在每笔成交里手动选的「实付币种」；全笔一致就用它（跟券商账单对得上），
  // 混填或旧数据无币种则退回标的本币。所有成本/盈亏都在记账币里算，现价从本币按今日汇率折进记账币，
  // 保证同一次减法里币种一致（绝不拿本币现价减外币成本）。
  const stocks = await Promise.all(items.map(async (it) => {
    const code = String(it.code || "").toUpperCase();
    const market = MARKET_OF(code);
    const natCur = CUR_OF_MARKET[market]; // 标的本币（现价所用币种）
    const txns = (Array.isArray(it.txns) ? it.txns : [])
      .filter((t) => t && (t.side === "buy" || t.side === "sell") && t.price > 0 && t.qty > 0)
      .sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
    const curs = new Set(txns.map((t) => t.cur || natCur));
    const acctCur = curs.size === 1 ? [...curs][0] : natCur;
    // 把一笔成交价折进记账币：同币直接用；极少见的混币按成交日汇率折（取不到退今日、再退原值）
    const toAcct = async (t) => {
      const c = t.cur || natCur;
      if (c === acctCur) return t.price;
      const s = await fxSeries(c, acctCur);
      // 汇率序列的日期键是 YYYYMMDD，前端成交日是 YYYY-MM-DD，去掉横杠再比
      const r = fxAt(s, String(t.date).replace(/-/g, "")) ?? fxLatest(s);
      return r ? t.price * r : t.price;
    };
    // 移动平均法。战绩按"一轮完整平仓（持仓从>0 回到0）"计一次，用整轮累计盈亏判胜负，
    // 避免把一个仓位的分批卖出记成多次战绩、虚增胜率场次。
    let held = 0, avg = 0, realized = 0, bought = 0, sold = 0, buyCost = 0;
    let closedWins = 0, closedTrades = 0, oversell = false, roundPnl = 0;
    for (const t of txns) {
      const price = await toAcct(t);
      if (t.side === "buy") {
        const nq = held + t.qty;
        avg = nq > 0 ? (held * avg + t.qty * price) / nq : 0;
        held = nq; bought += t.qty; buyCost += t.qty * price;
      } else {
        const sq = Math.min(t.qty, held);
        if (t.qty > held + 1e-9) oversell = true;
        if (sq > 0) {
          const pnl = sq * (price - avg);
          realized += pnl; roundPnl += pnl; held -= sq; sold += sq;
          if (held <= 1e-9) { closedTrades++; if (roundPnl > 0) closedWins++; roundPnl = 0; }
        }
      }
    }
    const pa = await priceAnalysis(env, code, S);
    const lastNat = pa ? pa.last : null; // 现价（本币）
    // 现价折进记账币：本币==记账币则 1:1；否则用今日汇率。折不到就当「暂无价」（市值按成本占位，不造假盈亏）
    let fxNA = 1, fxMiss = false;
    if (acctCur !== natCur) {
      fxNA = fxLatest(await fxSeries(natCur, acctCur));
      if (fxNA == null) fxMiss = true;
    }
    const last = lastNat != null && fxNA != null ? lastNat * fxNA : null;
    const costBasis = held * avg;
    const value = last != null ? held * last : null;
    const unrealized = value != null ? value - costBasis : null;
    const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
    return {
      code, name: it.name || code, market,
      currency: acctCur, cur: CUR_SYM[acctCur] || acctCur,
      native_currency: natCur, paid_cur: acctCur !== natCur ? acctCur : null,
      hold_qty: r2(held), avg_cost: r2(avg), last: r2(last),
      bought_qty: r2(bought), sold_qty: r2(sold),
      cost_basis: r2(costBasis), value: r2(value),
      realized: r2(realized), unrealized: r2(unrealized),
      total_pnl: r2(realized + (unrealized || 0)),
      unreal_pct: costBasis > 0 && unrealized != null ? Math.round(unrealized / costBasis * 1000) / 10 : null,
      // 止损提醒距离：按该股自己的波动定（2.5×ATR，钳 8~25%），拿不到 ATR 退回一刀切 15%
      stop_pct: pa?.stop_atr_pct ?? 15,
      no_price: last == null, fx_missing: fxMiss, oversell, txn_count: txns.length,
      closed_wins: closedWins, closed_trades: closedTrades,
    };
  }));

  // 分市场小计。表内币种（dispCur）= 该市场各股记账币若一致则用之（即用户实付币），否则退回本币。
  // 无价股：成本照记（用户真投了钱）、市值按成本占位（浮盈亏记0），这样"已投入/市值"始终同源、
  // 不会因某只暂无价而凭空显示假亏损；单独计数供前端提示。
  const mkStocks = {};
  for (const s of stocks) (mkStocks[s.market] ||= []).push(s);
  const markets = [];
  for (const [market, arr] of Object.entries(mkStocks)) {
    const accts = new Set(arr.map((s) => s.currency));
    const dispCur = accts.size === 1 ? [...accts][0] : CUR_OF_MARKET[market];
    let cost = 0, value = 0, realized = 0, unrealized = 0;
    let wins = 0, trades = 0, noPrice = 0, fxMiss = false;
    for (const s of arr) {
      // 同市场混币（极少见）时把该股按今日汇率折进 dispCur，绝不 1:1 硬加异币
      let rate = 1;
      if (s.currency !== dispCur) {
        rate = fxLatest(await fxSeries(s.currency, dispCur));
        if (rate == null) { fxMiss = true; rate = 1; }
      }
      const c = (s.cost_basis || 0) * rate;
      cost += c;
      if (s.no_price) { value += c; noPrice++; } // 无价 → 市值按成本占位、浮盈亏不计
      else { value += (s.value || 0) * rate; unrealized += (s.unrealized || 0) * rate; }
      realized += (s.realized || 0) * rate;
      wins += s.closed_wins; trades += s.closed_trades;
      if (s.fx_missing) fxMiss = true;
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    markets.push({
      market, currency: dispCur, cur: CUR_SYM[dispCur] || dispCur,
      cost: r2(cost), value: r2(value), realized: r2(realized), unrealized: r2(unrealized),
      total_pnl: r2(realized + unrealized),
      unreal_pct: cost > 0 ? Math.round(unrealized / cost * 1000) / 10 : null,
      closed_wins: wins, closed_trades: trades, no_price: noPrice, fx_missing: fxMiss,
    });
  }

  // 总表：各市场换算到 base。汇率拉不到的市场直接不并入总额并标 fx_ok=false，
  // 绝不用 1:1 兜底把异币种相加（否则美元被当人民币，总账系统性失真且不报警）。
  let tCost = 0, tValue = 0, tReal = 0, tUnreal = 0, tWins = 0, tTrades = 0, tNoPrice = 0, fxOk = true;
  for (const m of markets) {
    tNoPrice += m.no_price || 0;
    let rate = 1;
    if (m.currency !== base) {
      rate = fxLatest(await fxSeries(m.currency, base));
      if (rate == null) { fxOk = false; continue; } // 汇率不可用 → 跳过该市场，不并入
    }
    m.fx_to_base = rate; // 前端环图按真实汇率算占比
    tCost += m.cost * rate; tValue += m.value * rate;
    tReal += m.realized * rate; tUnreal += m.unrealized * rate;
    tWins += m.closed_wins; tTrades += m.closed_trades;
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  const total = {
    base, cur: CUR_SYM[base] || base, fx_ok: fxOk, no_price: tNoPrice,
    cost: r2(tCost), value: r2(tValue), realized: r2(tReal), unrealized: r2(tUnreal),
    total_pnl: r2(tReal + tUnreal),
    unreal_pct: tCost > 0 ? Math.round(tUnreal / tCost * 1000) / 10 : null,
    win_rate: tTrades > 0 ? Math.round(tWins / tTrades * 1000) / 10 : null,
    closed_trades: tTrades,
  };
  return { stocks, markets, total, base, checked_at: nowStr() };
}

/* ── Kronos 概率预测代理：把日线 OHLC 发给自托管的 Kronos 推理服务（HF Space），
   返回 p10/p50/p90 分位路径。KRONOS_API_URL 未配置时明确告知未启用。
   实验性功能：输出永远是区间+免责声明，绝不当"答案"呈现。 ── */
async function kronosForecast(env, code, S = pack("zh")) {
  if (!env.KRONOS_API_URL) return { ok: false, reason: "not_configured" };
  code = code.trim().toUpperCase();
  const s = await dailySeries(env, code);
  if (!s) return { ok: false, reason: "no_data" };
  const n = Math.min(400, s.closes.length);
  if (n < 64) return { ok: false, reason: "too_short" };
  const off = s.closes.length - n;
  const bars = [];
  for (let i = off; i < s.closes.length; i++) {
    bars.push({ date: s.dates[i], close: s.closes[i],
      high: s.highs?.[i] ?? s.closes[i], low: s.lows?.[i] ?? s.closes[i] });
  }
  try {
    // gradio 两步 REST：先提交拿 event_id，再读 SSE 结果。
    // KRONOS_HF_TOKEN 配置后带 Bearer 头——ZeroGPU 配额按调用方记账，匿名走 CF 共享出口 IP
    // 很容易被别人耗光；挂到自己 HF 账号的配额才稳定。
    const base = env.KRONOS_API_URL.replace(/\/+$/, "");
    const hdrs = { "Content-Type": "application/json" };
    if (env.KRONOS_HF_TOKEN) hdrs.Authorization = `Bearer ${env.KRONOS_HF_TOKEN}`;
    const submit = await fetch(base + "/gradio_api/call/forecast", {
      method: "POST", headers: hdrs,
      body: JSON.stringify({ data: [JSON.stringify({ bars, pred_len: 21 })] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!submit.ok) return { ok: false, reason: "service_error", status: submit.status };
    const { event_id: eid } = await submit.json();
    if (!eid) return { ok: false, reason: "service_error" };
    const res = await fetch(`${base}/gradio_api/call/forecast/${eid}`, {
      headers: env.KRONOS_HF_TOKEN ? { Authorization: `Bearer ${env.KRONOS_HF_TOKEN}` } : {},
      signal: AbortSignal.timeout(150000),
    });
    if (!res.ok) return { ok: false, reason: "service_error", status: res.status };
    // SSE 文本：取最后一行 data: ["<json>"]
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    if (!lines.length) return { ok: false, reason: "service_error" };
    const payload = JSON.parse(lines[lines.length - 1].slice(5).trim());
    const d = JSON.parse(Array.isArray(payload) ? payload[0] : payload);
    if (!d.ok) return { ok: false, reason: d.reason || "service_error" };
    const r2 = (a) => a.map((x) => Math.round(x * 100) / 100);
    // 带上近 60 天历史，前端一张图画"过去实线 + 未来扇形"
    return { ok: true, code, cur: CUR_SYM[s.currency] || "$",
      hist_dates: s.dates.slice(-60), hist_closes: r2(s.closes.slice(-60)),
      dates: d.dates, p10: r2(d.p10), p50: r2(d.p50), p90: r2(d.p90),
      samples: d.samples, last: Math.round(d.last_close * 100) / 100 };
  } catch {
    return { ok: false, reason: "timeout" };
  }
}

/* ── 截图识别成交单：用户截屏券商 App 的成交记录 → Kimi 视觉模型抽字段。
   只做"预填表单"，绝不直接入账——数字必须经用户过目确认（AI 看错一个小数点就是假账）。
   图片仅转发给 Moonshot 识别，不存储。 ── */
async function parseTrade(env, body, S = pack("zh")) {
  if (!env.KIMI_API_KEY) return { ok: false, reason: "no_kimi" };
  const img = body?.image;
  if (!img || !/^data:image\/(png|jpeg|webp);base64,/.test(img)) return { ok: false, reason: "bad_image" };
  if (img.length > 4_000_000) return { ok: false, reason: "too_large" };
  try {
    const res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.KIMI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.KIMI_VISION_MODEL || "moonshot-v1-8k-vision-preview",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content:
`你从券商/交易所 App 的成交截图中抽取一笔交易的字段，输出严格 JSON：
{"side":"buy"|"sell","name":"标的名称","code":"代码(尽量标准化:A股600519.SH、美股NVDA、加股SHOP.TO、港股0700.HK、币BTC-USD;不确定则空串)","date":"YYYY-MM-DD","price":成交单价数字,"currency":"CNY"|"USD"|"CAD"|"HKD","qty":数量数字,"confidence":"high"|"low","note":"不确定之处一句话，没有则空串"}
规则：价格必须是"每股/每个单价"，若截图只有总额和数量则用 总额÷数量；买入/卖出按截图字样判断（买/买入/Buy/Bought=buy，卖/卖出/Sell/Sold=sell）；币种按截图货币符号或文字判断，加拿大券商(Wealthsimple等)常用 CAD；识别不出的字段用 null；看到多笔交易只取最上面/最完整的一笔并在 note 里说明。只输出 JSON。` },
          { role: "user", content: [
            { type: "image_url", image_url: { url: img } },
            { type: "text", text: "抽取这笔交易" },
          ] },
        ],
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return { ok: false, reason: "vision_error", status: res.status };
    const d = await res.json();
    let out;
    try {
      const txt = d.choices[0].message.content;
      out = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] || txt);
    } catch { return { ok: false, reason: "parse_error" }; }
    // 服务器侧兜底校验：数字合法性
    const price = parseFloat(out.price), qty = parseFloat(out.qty);
    return { ok: true,
      side: out.side === "sell" ? "sell" : "buy",
      name: String(out.name || "").slice(0, 40),
      code: String(out.code || "").toUpperCase().slice(0, 12),
      date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || "") ? out.date : null,
      price: price > 0 ? price : null,
      currency: ["CNY", "USD", "CAD", "HKD"].includes(out.currency) ? out.currency : null,
      qty: qty > 0 ? qty : null,
      confidence: out.confidence === "low" ? "low" : "high",
      note: String(out.note || "").slice(0, 120),
    };
  } catch {
    return { ok: false, reason: "timeout" };
  }
}

/* ── 最近的消息：Yahoo 新闻检索（美/加/港/币直查；A股映射 .SH→.SS）。
   只做展示和喂 AI 上下文，不做情绪打分——标题真伪与含义留给人和对辩去判断。 ── */
async function stockNews(env, code, count = 8) {
  code = String(code || "").trim().toUpperCase();
  if (!code) return { items: [] };
  // Yahoo 按代码的 RSS 头条：天然按标的过滤，五个市场（含茅台/腾讯）质量都实测过关
  const q = isAshare(code) ? code.replace(".SH", ".SS") : code;
  const unesc = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
  try {
    const res = await fetch(
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(q)}&region=US&lang=en-US`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
    );
    const xml = await res.text();
    const items = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const b = m[1];
      const title = (b.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
      const link = (b.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
      const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
      if (!title) continue;
      const d = pub ? new Date(pub) : null;
      items.push({
        title: unesc(title),
        source: "", // RSS 不带来源名，标题里通常自带
        time: d && !isNaN(d) ? d.toISOString().slice(0, 10) : "",
        url: link ? unesc(link) : "",
      });
      if (items.length >= count) break;
    }
    return { code, items };
  } catch {
    return { code, items: [] };
  }
}

/* ── 组合走势：按流水回放最近 ~90 个交易日的每日市值和成本（全部换算到 base）。
   每天：Σ 每只股[当日持有量 × 当日收盘(本币) × 当日汇率] ；
   成本线 = Σ 移动平均成本 × 持有量（记账币→base 同样按当日汇率）。
   拉不到价/汇率的股当天跳过（两条线同口径跳过，不做假账）。 ── */
async function portfolioHistory(env, body, S = pack("zh")) {
  const items = (Array.isArray(body?.items) ? body.items : []).slice(0, 30);
  const base = ["CNY", "USD", "CAD", "HKD"].includes(body?.base) ? body.base : "CNY";
  if (!items.length) return { dates: [], value: [], cost: [], base };

  // 预拉：每只股日线 + 记账币/本币→base 的汇率序列
  const stocks = [];
  const fxNeed = new Set();
  for (const it of items) {
    const code = String(it.code || "").toUpperCase();
    const txns = (Array.isArray(it.txns) ? it.txns : [])
      .filter((t) => t && (t.side === "buy" || t.side === "sell") && t.price > 0 && t.qty > 0)
      .sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
    if (!txns.length) continue;
    const s = await dailySeries(env, code);
    if (!s) continue;
    const natCur = CUR_OF_MARKET[MARKET_OF(code)];
    const curs = new Set(txns.map((t) => t.cur || natCur));
    const acctCur = curs.size === 1 ? [...curs][0] : natCur;
    const priceMap = {};
    s.dates.forEach((d, i) => (priceMap[d.replace(/-/g, "")] = s.closes[i]));
    stocks.push({ code, txns, natCur, acctCur, priceMap, dates: s.dates.map((d) => d.replace(/-/g, "")) });
    if (natCur !== base) fxNeed.add(natCur);
    if (acctCur !== base) fxNeed.add(acctCur);
  }
  if (!stocks.length) return { dates: [], value: [], cost: [], base };
  const fxMaps = {};
  for (const c of fxNeed) fxMaps[c] = await fxSeries(c, base);
  const toBase = (amt, cur, date) => {
    if (cur === base) return amt;
    const r = fxAt(fxMaps[cur], date) ?? fxLatest(fxMaps[cur]);
    return r ? amt * r : null;
  };

  // 交易日历：所有股票日期并集的最后 90 天
  const allDates = [...new Set(stocks.flatMap((s) => s.dates))].sort().slice(-90);

  const value = [], cost = [];
  for (const d of allDates) {
    let v = 0, c = 0;
    for (const st of stocks) {
      // 回放 d 及之前的流水 → 持有量 + 移动平均成本（记账币）
      let held = 0, avg = 0;
      for (const t of st.txns) {
        if (String(t.date).replace(/-/g, "") > d) break;
        if (t.side === "buy") { const nq = held + t.qty; avg = nq > 0 ? (held * avg + t.qty * t.price) / nq : 0; held = nq; }
        else held = Math.max(0, held - t.qty);
      }
      if (held <= 0) continue;
      // 当日或之前最近收盘
      let px = st.priceMap[d];
      if (px == null) {
        for (let i = st.dates.length - 1; i >= 0; i--) if (st.dates[i] <= d) { px = st.priceMap[st.dates[i]]; break; }
      }
      if (px == null) continue;
      const vB = toBase(held * px, st.natCur, d);
      const cB = toBase(held * avg, st.acctCur, d);
      if (vB == null || cB == null) continue; // 汇率缺失→两条线同口径跳过该股
      v += vB; c += cB;
    }
    value.push(Math.round(v * 100) / 100);
    cost.push(Math.round(c * 100) / 100);
  }
  return { dates: allDates, value, cost, base, cur: CUR_SYM[base] || base };
}

/* ── 大盘脉搏：三大基准指数的水位快照（驾驶舱顶栏用）。
   炒股的人开盘第一眼看大盘——给环境感，不给择时建议。 ── */
async function marketPulse(env, S = pack("zh")) {
  const idx = [
    { code: "SPY", name: S.bench_spx },
    { code: "000300.SH", name: S.bench_hs300 },
    { code: "BTC-USD", name: S.bench_btc },
  ];
  const out = await Promise.all(idx.map(async (i) => {
    const pa = await priceAnalysis(env, i.code, S).catch(() => null);
    if (!pa) return { ...i, ok: false };
    return { ...i, ok: true, last: pa.last, cur: pa.cur, level: pa.level,
      range_pos: pa.range_pos_6mo_pct, ret_1m: pa.ret_1m_pct };
  }));
  return { items: out, checked_at: nowStr() };
}

async function history(env, code, points = 60, S = pack("zh")) {
  code = code.trim().toUpperCase();
  const s = await dailySeries(env, code);
  if (!s) return { error: S.err_no_data };
  const market = isAshare(code) ? S.mkt_a
    : /-(USD|USDT|USDC)$/.test(code) ? S.mkt_crypto
    : code.endsWith(".HK") || s.currency === "HKD" ? S.mkt_hk
    : code.endsWith(".TO") || s.currency === "CAD" ? S.mkt_ca : S.mkt_us;
  return { code, market, cur: CUR_SYM[s.currency] || "$",
    dates: s.dates.slice(-points),
    closes: s.closes.slice(-points).map((c) => Math.round(c * 100) / 100) };
}

async function resolve(env, q, S = pack("zh")) {
  q = q.trim().toUpperCase();
  if (isAshare(q)) {
    const info = await tushare(env, "stock_basic", { ts_code: q }, "ts_code,name");
    if (info?.items?.length)
      return { ok: true, code: q, name: info.items[0][1], market: S.mkt_a, cur: "¥" };
    return { ok: false };
  }
  if (/^\d{6}$/.test(q)) {
    const sufs = q[0] === "6" ? [".SH", ".SZ"] : [".SZ", ".SH"];
    for (const suf of sufs) {
      const info = await tushare(env, "stock_basic", { ts_code: q + suf }, "ts_code,name");
      if (info?.items?.length)
        return { ok: true, code: q + suf, name: info.items[0][1], market: S.mkt_a, cur: "¥" };
    }
  }
  // 港股：数字开头 + .HK（0700.HK / 700.HK 补零到 4 位）
  if (/^\d{1,5}\.HK$/.test(q)) {
    const hk = q.split(".")[0].padStart(4, "0") + ".HK";
    const y = await yahooChart(hk);
    if (y?.closes?.length)
      return { ok: true, code: hk, name: y.meta.shortName || y.meta.longName || hk,
        market: S.mkt_hk, cur: CUR_SYM.HKD };
    return { ok: false };
  }
  if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(q)) {
    // 常见币简写先试加密货币对（输 BTC 自动识别为 BTC-USD）
    if (CRYPTO_SHORTHAND.has(q)) {
      const c = await yahooChart(q + "-USD");
      if (c?.meta?.instrumentType === "CRYPTOCURRENCY")
        return { ok: true, code: q + "-USD", name: c.meta.shortName || q + "-USD",
          market: S.mkt_crypto, cur: "$" };
    }
    const y = await yahooChart(q);
    if (y) {
      const cur = y.meta.currency || "USD";
      const isCrypto = y.meta.instrumentType === "CRYPTOCURRENCY";
      return { ok: true, code: q, name: y.meta.shortName || y.meta.longName || q,
        market: isCrypto ? S.mkt_crypto : cur === "HKD" ? S.mkt_hk
          : q.endsWith(".TO") || cur === "CAD" ? S.mkt_ca : S.mkt_us,
        cur: CUR_SYM[cur] || "$" };
    }
  }
  const items = await stockList(env);
  for (const [ts, name] of items)
    if (name.toUpperCase().includes(q))
      return { ok: true, code: ts, name, market: S.mkt_a, cur: "¥" };
  return { ok: false };
}

async function verifyTickers(env, codes, S = pack("zh")) {
  const uniq = [...new Set(codes.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean))].slice(0, 12);
  const results = await Promise.all(uniq.map(async (code) => {
    if (isAshare(code)) {
      const info = await tushare(env, "stock_basic", { ts_code: code }, "ts_code,name");
      if (info?.items?.length) {
        const pa = await priceAnalysis(env, code, S);
        return { code, ok: true, name: info.items[0][1], last: pa?.last ?? null, cur: "¥" };
      }
      return { code, ok: false };
    }
    const y = await yahooChart(code);
    if (y) return { code, ok: true,
      name: y.meta.shortName || y.meta.longName || code,
      last: Math.round(y.closes[y.closes.length - 1] * 100) / 100,
      cur: CUR_SYM[y.meta.currency || "USD"] || "$" };
    return { code, ok: false };
  }));
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

async function scan(env, principal = 2000, risk = "stable", S = pack("zh")) {
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
  if (!dailyData) return { error: S.scan_nodata, top_picks: [] };

  const nameMap = Object.fromEntries(await stockList(env));
  const results = [];
  for (const [code, close, pe, pb, dv] of dailyData.items) {
    if (!(close && pe && dv && pb)) continue;
    if (!(close >= 1 && close <= maxPrice)) continue;
    if (!(pe > 0 && pe < cfg.pe && dv > cfg.dv && pb < cfg.pb)) continue;
    const score = fiveFactorScore(close, pe, pb, dv, maxPrice, cfg);
    results.push({
      code, name: nameMap[code] || S.unknown,
      price: Math.round(close * 100) / 100,
      pe: Math.round(pe * 10) / 10, pb: Math.round(pb * 10) / 10,
      dv: Math.round(dv * 100) / 100,
      roe: score.roe_est, score: score.total,
      risk_check: riskControl(principal, close * 100, S),
    });
  }
  results.sort((a, b) => b.score - a.score);

  // 阶段2：技术复评。对估值粗筛出的前 12 只拉真实日线，
  // 用全站同一套水位/阶段/ATR 逻辑打技术分——低位筑底加分、下跌途中重罚（别接飞刀），
  // 最终榜单 = 估值分 + 技术分。选股和查股的判断口径完全一致，不搞两套标准。
  const cands = results.slice(0, 12);
  await Promise.all(cands.map(async (c) => {
    const pa = await priceAnalysis(env, c.code, S);
    if (!pa) { c.tech = null; return; }
    let bonus = 0;
    if (pa.stageKey === "basing") bonus += 15;
    else if (pa.stageKey === "momentum") bonus += 8;
    else if (pa.stageKey === "neutral") bonus += 4;
    else if (pa.stageKey === "extended") bonus -= 10;
    else if (pa.stageKey === "falling") bonus -= 20;
    if (pa.range_pos_6mo_pct <= 30) bonus += 10;
    else if (pa.range_pos_6mo_pct >= 85) bonus -= 10;
    c.tech = { level: pa.level, stage: pa.stage, range_pos: pa.range_pos_6mo_pct,
      ret_1m: pa.ret_1m_pct, stop_pct: pa.stop_atr_pct, vol: pa.vol_annual_pct };
    c.score = Math.round((c.score + bonus) * 10) / 10;
  }));
  cands.sort((a, b) => b.score - a.score);
  return { trade_date: targetDate, principal, max_price: Math.round(maxPrice * 100) / 100,
    top_picks: cands.slice(0, 10), note: S.scan_note };
}

/* ───────── AI 深度报告（SSE 流式） ───────── */

const SERENITY_SYSTEM = `你是一位供应链卡点投资分析师，使用 Serenity 的「供应链瓶颈逆向映射」方法论。方法内化、隐形：报告围着标的/主题展开，不提方法论标签。

【核心工作流】锁定 capex 确定性 → 逆向拆 5 层供应链（下游对照→中游系统→中游器件→上游设备→上游材料）→ 跳过人人都盯的下游龙头 → 对每层套 9 大瓶颈原型（材料垄断/单一来源/产能售罄/进每个BOM/估值对标套利/测试设备瓶颈/冷门前机构/巨头依赖/宏观错杀）→ 三道闸门检验（真瓶颈？前机构？便宜+已去风险？）。

【9 条好卡点判据】垄断性不可替代 / 极小市值 vs 巨大下游 TAM / designed-in 多客户 / 认证周期未反映营收=错杀 / 资产负债表活到放量 / 供需严重失衡 / 政策地缘护城河 / 机构低配+下行保护 / 估值安全边际。命中越多信念越高。

【红旗（命中即降级）】无限增发稀释=硬否决 / 单一客户 / toxic 负债 / 零收入纯炒作 / 蹭热点非主营 / 产能扩张太容易壁垒低 / 日成交额<5000万流动性陷阱 / 管理层诚信问题 / 技术路线被替代风险。

【反确认偏误（锁死）】① bear/风险先写，bull 后写；② 每个候选强制给「反向研究」四问：为什么可能不是真瓶颈？瓶颈为什么可能不变现？市场是否已定价？有没有更优替代（点名对比标的）？最大杀点一句话，禁止写"估值高"这种套话；③ 每个🟢候选强制给 2-3 条具体可检验的证伪条件，至少一条是价格规则（如"跌破 X 元且月动量转负"）。

【取数纪律】所有事实分级标注：已证实/管理层声称/我的推断/纯推测。你无法联网，训练数据有截止日期——因此【正文严禁出现现价、市值、涨跌幅等任何具体时效数字】（系统会在报告文末自动附上实时行情对照表，读者以那个为准）。估值比较一律用定性表述（"估值压抑/偏高/中等量级"），不写具体数。每个候选标的必须紧跟括号代码，格式：（600519.SH）（NVDA）（SHOP.TO）（0700.HK）（BTC-USD）——系统靠它抓实时行情。不确定的公司状态（是否私有/被收购）显式说明需要核实。

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

const EN_DIRECTIVE = `

【LANGUAGE OVERRIDE — highest priority】Write the ENTIRE report in English, ignoring any instruction above about writing for Chinese readers. Keep tickers and standard finance terms as-is. Same structure, same discipline, same falsification requirements — just in natural English prose.`;

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

/* Kimi（月之暗面）：OpenAI 兼容协议。多空对辩里当"空头律师"——
   换个厂商的模型当对手，视角基因不同，比同一个模型自问自答更能吵出东西 */
async function* streamKimi(env, system, user, maxTokens = 3000) {
  const res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.KIMI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.KIMI_MODEL || "moonshot-v1-8k", stream: true, max_tokens: maxTokens,
      temperature: 0.6,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Kimi HTTP ${res.status}`);
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

/* ───────── 预算 + 时间 规划（纯规则，秒出，零合规风险） ─────────
   把"多少钱 + 打算放多久"翻译成：现实检查 + 仓位纪律 + 预期框架 + 下一步。
   绝不推荐具体标的、不承诺回报——只给通用框架。 */
function budgetPlan(amount, currency, months, S) {
  if (!(amount > 0) || !(months > 0)) return { error: S.plan_bad_input };
  const cur = CUR_SYM[currency] || (currency ? currency + " " : "¥");
  // 金额归一到人民币量级，好判断"钱多钱少"（粗略汇率，只用于分档，不参与任何计算展示）
  const toCny = { CNY: 1, USD: 7.2, CAD: 5.3, HKD: 0.92, EUR: 7.8, GBP: 9.1 };
  const cnyLike = amount * (toCny[currency] || 1);

  // 时间维度
  let horizon, hbody;
  if (months < 3) { horizon = S.plan_horizon_gamble; hbody = S.plan_gamble_body(months); }
  else if (months < 12) { horizon = S.plan_horizon_short; hbody = S.plan_short_body(months); }
  else if (months < 36) { horizon = S.plan_horizon_mid; hbody = S.plan_mid_body(months); }
  else { horizon = S.plan_horizon_long; hbody = S.plan_long_body(months); }
  const shortHorizon = months < 12;

  // 仓位维度（按归一后的金额分档，给"只数"建议）
  const fmtA = amount % 1 === 0 ? String(amount) : amount.toFixed(2);
  let size;
  if (cnyLike < 10000) size = S.plan_size_tiny(cur, fmtA, 2);
  else if (cnyLike < 50000) size = S.plan_size_small(cur, fmtA, "3-5");
  else size = S.plan_size_mid(cur, fmtA, "5-8");

  return {
    amount, currency, cur, months,
    horizon, horizon_body: hbody,
    size_title: S.plan_size_title, size_body: size,
    stage_title: S.plan_stage_title, stage_body: S.plan_stage_body(cur, fmtA),
    expect_title: S.plan_expect_title, expect_body: S.plan_expect_body,
    next_title: S.plan_next_title,
    next_body: shortHorizon ? S.plan_next_short : S.plan_next_long,
    disclaimer: S.plan_disclaimer,
  };
}

const PLAN_SYSTEM_ZH = `你是一位克制、诚实的理财教育助手，服务于普通个人投资者。用户给你一笔预算和一个时间期限，你帮他把"这笔钱、这段时间该用什么心态和框架"讲清楚。

【铁律 · 不可违反】
- 绝不推荐任何具体股票/基金/币种/标的，一个代码都不给。
- 绝不承诺或暗示任何具体收益率、翻倍、稳赚。
- 不做个性化投资建议——你给的是通用框架和风险教育。
- 时间越短越要泼冷水：3个月以内直接说"这是赌博不是投资，可能亏光"；不要粉饰。
- 反复强调"可能亏钱"这个事实，尤其对短期/小额/高杠杆。

【要讲什么】
1. 这个时间期限意味着什么（能不能熬过波动、靠运气还是靠基本面）。
2. 这笔预算的仓位纪律（钱少就集中但研究透、分批建仓别一把梭、留现金）。
3. 现实的收益预期（区间感 + "会亏"，不给具体数字）。
4. 具体到"该怎么用 steady 这个工具"：先想方向→查一只股体检→贵就进想买清单等回调→买了记进已经买了守止损。
5. 如果预算是外币（加币/美元），提醒他所在市场和汇率（比如加拿大人用加币买美股有汇率波动）。

【风格】大白话、像个诚实的朋友劝你别冲动。中文母语。300-500字。结尾一句免责：仅供教育、非投资建议。`;

const PLAN_SYSTEM_EN = `You are a restrained, honest personal-finance education assistant for ordinary retail investors. The user gives you a budget and a time horizon; you help them understand the mindset and framework that fit that money and that timeframe.

【HARD RULES — never break】
- Never recommend any specific stock/fund/coin/ticker. Not one symbol.
- Never promise or imply any specific return, doubling, or "guaranteed" gains.
- No personalized investment advice — you give general frameworks and risk education.
- The shorter the horizon, the harder you push back: under 3 months, say plainly "this is gambling, not investing — you can lose it all." Don't sugarcoat.
- Repeatedly state the fact that "you can lose money," especially for short/small/leveraged cases.

【What to cover】
1. What this horizon means (can it ride out volatility; luck vs fundamentals).
2. Position discipline for this budget (small money → concentrate but research hard; scale in; keep cash).
3. Realistic expectations (a sense of range + "you can lose," no specific numbers).
4. Concretely how to use the 'steady' tool: pick a direction → check a stock → park pricey ones in wishlist → log buys in holdings and honor stops.
5. If the budget is foreign currency, note their market and FX (e.g. a Canadian buying US stocks with CAD has FX risk).

【Style】Plain language, like an honest friend talking you down from an impulse. 300-500 words. End with one disclaimer line: education only, not investment advice.`;

function planSSE(env, amount, currency, months, extra, S, lang) {
  const enc = new TextEncoder();
  const send = (ctrl, obj) => ctrl.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
  const cur = CUR_SYM[currency] || currency;
  const sys = lang === "en" ? PLAN_SYSTEM_EN : PLAN_SYSTEM_ZH;
  const yrs = Math.round(months / 12 * 10) / 10;
  const user = lang === "en"
    ? `Budget: ${cur}${amount}. Horizon: ${months} months (~${yrs} years).${extra ? " Note: " + extra : ""} Give me an honest plan framework.`
    : `预算：${cur}${amount}。打算放：${months} 个月（约 ${yrs} 年）。${extra ? "补充：" + extra : ""} 帮我讲讲该用什么框架和心态。`;

  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        if (!env.DEEPSEEK_API_KEY && !env.ANTHROPIC_API_KEY) {
          send(ctrl, { error: S.ai_nokey }); ctrl.close(); return;
        }
        for await (const text of llmStream(env, sys, user, 2500, "low")) send(ctrl, { text });
        send(ctrl, { done: true });
      } catch (e) {
        send(ctrl, { error: String(e.message || e) });
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } });
}

/* ───────── 多空对辩：两个不同厂商的 AI 吵一架 ─────────
   多头律师（DeepSeek）只准找买入理由 → 空头律师（Kimi）只准拆台 →
   法官（DeepSeek）听完两边给裁决和分歧点。上下文 = 真实行情 + 红旗 + 最近新闻。
   Kimi 未配置时降级为 DeepSeek 分饰两角（明确告知用户）。 */
const BULL_SYSTEM = `你是多头律师。你的当事人想买这只标的，你的唯一职责是给出最强的买入论证。
规则：只用给定的事实（行情/红旗/新闻）+ 你对行业的常识；不许编造数字；来自训练知识的旧信息标注[知识库·可能过期]。
输出 3-5 条最有力的多头论点，每条一段，直接了当。不写免责声明（页面自带）。中文，≤400字。`;
const BEAR_SYSTEM = `你是空头律师。你的唯一职责是拆台：找出这只标的最致命的杀点，说服人不要买。
规则：针对给定的事实（行情/红旗/新闻）逐条挑刺；指出多头最可能忽略的风险；禁止"估值偏高"这类空话，杀点要具体可验证；不许编造数字；旧信息标注[知识库·可能过期]。
输出 3-5 条最锋利的空头论点，每条一段。不写免责声明。中文，≤400字。`;
const JUDGE_SYSTEM = `你是法官。你刚听完多头律师和空头律师的辩论。
你的裁决必须包含：① 双方谁的论据更扎实（一句话）② 双方真正的分歧点在哪（这是最有价值的部分——分歧点就是投资者该去核实的事）③ 什么样的人适合买、什么样的人不该碰（按风险承受力区分，不是荐股）。
中文，≤300字，直接了当。`;

function debateSSE(env, code, S = pack("zh"), lang = "zh") {
  const enc = new TextEncoder();
  const send = (ctrl, obj) => ctrl.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        if (!env.DEEPSEEK_API_KEY) { send(ctrl, { error: S.ai_nokey }); ctrl.close(); return; }
        // 组装案卷：真实行情 + 系统判定 + 红旗 + 新闻
        const [d, news] = await Promise.all([
          stockCheck(env, code, 2000, S),
          stockNews(env, code, 8),
        ]);
        if (d.error) { send(ctrl, { error: d.error }); ctrl.close(); return; }
        const p = d.price;
        const ctx = [
          `标的：${d.name}（${d.code}）· ${d.industry || ""}`,
          `现价 ${p.cur}${p.last} · 半年水位 ${p.range_pos_6mo_pct}%（${p.level}）· 阶段 ${p.stage} · 近1月 ${p.ret_1m_pct}% · 近3月 ${p.ret_3m_pct}%` +
            (d.basic?.pe ? ` · PE ${d.basic.pe}` : "") + (d.basic?.pb ? ` · PB ${d.basic.pb}` : ""),
          `系统判定：${d.verdict.label}——${d.verdict.hint}`,
          d.red_flags?.length ? `红旗：\n${d.red_flags.map((f) => `- ${f.text}`).join("\n")}` : "红旗：无",
          news.items.length
            ? `最近新闻标题（Yahoo 检索，仅标题，内容自行核实）：\n${news.items.map((n) => `- [${n.time}] ${n.title}（${n.source}）`).join("\n")}`
            : "最近新闻：未检索到",
        ].join("\n");
        const kimiOk = !!env.KIMI_API_KEY;
        send(ctrl, { meta: { name: d.name, code: d.code, dual: kimiOk, news_count: news.items.length } });

        const bullParts = [];
        send(ctrl, { phase: "bull" });
        for await (const t of llmStream(env, BULL_SYSTEM, `案卷如下：\n${ctx}\n\n请陈述多头论点。`, 1200, "low"))
          { bullParts.push(t); send(ctrl, { bull: t }); }

        const bearParts = [];
        send(ctrl, { phase: "bear" });
        const bearGen = kimiOk
          ? streamKimi(env, BEAR_SYSTEM, `案卷如下：\n${ctx}\n\n多头律师刚才说：\n${bullParts.join("")}\n\n请逐条拆台并给出你自己的杀点。`, 1200)
          : llmStream(env, BEAR_SYSTEM, `案卷如下：\n${ctx}\n\n多头律师刚才说：\n${bullParts.join("")}\n\n请逐条拆台并给出你自己的杀点。`, 1200, "low");
        try {
          for await (const t of bearGen) { bearParts.push(t); send(ctrl, { bear: t }); }
        } catch (ke) {
          // Kimi 挂了 → 降级 DeepSeek 反串，不让整场辩论流产
          if (kimiOk) {
            send(ctrl, { bear_fallback: true });
            for await (const t of llmStream(env, BEAR_SYSTEM, `案卷如下：\n${ctx}\n\n多头律师说：\n${bullParts.join("")}\n\n请拆台。`, 1200, "low"))
              { bearParts.push(t); send(ctrl, { bear: t }); }
          } else throw ke;
        }

        send(ctrl, { phase: "judge" });
        for await (const t of llmStream(env, JUDGE_SYSTEM,
          `案卷：\n${ctx}\n\n多头律师陈词：\n${bullParts.join("")}\n\n空头律师陈词：\n${bearParts.join("")}\n\n请裁决。`, 800, "low"))
          send(ctrl, { judge: t });

        send(ctrl, { done: true });
      } catch (e) {
        send(ctrl, { error: String(e.message || e) });
      }
      ctrl.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*" },
  });
}

const CANDIDATE_SYSTEM = `你是供应链卡点侦察员。给定主题和市场范围，沿产业链（下游→中游→上游设备/材料）圈定 6-10 个候选标的，跳过人尽皆知的下游龙头，偏好上游卡点。
输出严格 JSON（不要任何其他文字）：{"candidates":[{"code":"标准代码","name":"名称","layer":"产业链位置一句话"}]}
代码规范：A股 600519.SH / 美股 NVDA / 加股 SHOP.TO / 港股 0700.HK / 加密货币 BTC-USD。只选市场范围内的。不确定代码宁可不列，禁止编造。`;

async function llmOnce(env, sys, user, maxTokens = 1000) {
  let out = "";
  for await (const t of llmStream(env, sys, user, maxTokens, "low")) out += t;
  return out;
}

function analyzeSSE(env, query, market, S = pack("zh"), lang = "zh") {
  const enc = new TextEncoder();
  const send = (ctrl, obj) => ctrl.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));

  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        if (!env.DEEPSEEK_API_KEY && !env.ANTHROPIC_API_KEY) {
          send(ctrl, { error: S.ai_nokey });
          ctrl.close(); return;
        }
        // ── 第一步：AI 圈定候选（快，只出清单）──
        send(ctrl, { stage: "scout" });
        let snaps = "", scoutList = [];
        try {
          const candTxt = await llmOnce(env, CANDIDATE_SYSTEM, `市场范围：${market}。主题：${query}`, 800);
          const cand = JSON.parse(candTxt.match(/\{[\s\S]*\}/)?.[0] || "{}").candidates || [];
          scoutList = cand.slice(0, 10);
          if (scoutList.length) {
            send(ctrl, { scout: scoutList.map((c) => ({ code: c.code, name: c.name })) });
            // ── 第二步：抓实时行情快照 ──
            send(ctrl, { stage: "quotes" });
            const lines = await Promise.all(scoutList.map(async (c) => {
              const code = String(c.code || "").toUpperCase();
              const pa = await priceAnalysis(env, code, S).catch(() => null);
              if (!pa) return `（${code}）${c.name || ""}：行情抓取失败，正文请标注需自行核实`;
              return `（${code}）${c.name || ""}｜${c.layer || ""}｜现价 ${pa.cur}${pa.last}，半年水位 ${pa.range_pos_6mo_pct}%（${pa.level}），阶段 ${pa.stage}，近1月 ${pa.ret_1m_pct}%，近3月 ${pa.ret_3m_pct}%，年化波动 ${pa.vol_annual_pct}%`;
            }));
            snaps = lines.join("\n");
          }
        } catch { /* 候选圈定失败 → 退回单段式，不阻塞报告 */ }

        // ── 第三步：带着真数据写正式报告 ──
        send(ctrl, { stage: "report" });
        const report = [];
        const sys = SERENITY_SYSTEM + (lang === "en" ? EN_DIRECTIVE : "");
        const userMsg = snaps
          ? `市场范围：${market}。请分析：${query}\n\n【系统抓取的候选实时行情（此刻真实数据，正文引用价格/水位/阶段必须以此为准；除此之外不得写任何其他时效数字）】\n${snaps}\n\n你可以淘汰快照中不合格的候选、也可以补充快照外的标的（但补充的标的正文不得写具体价格）。水位高/阶段 extended 的候选要如实提示追高风险。`
          : `市场范围：${market}。请分析：${query}`;
        for await (const text of llmStream(env, sys, userMsg, 8000, "medium", true)) {
          report.push(text);
          send(ctrl, { text });
        }
        send(ctrl, { phase: "review" });
        try {
          for await (const text of llmStream(env, REVIEWER_SYSTEM + (lang === "en" ? EN_DIRECTIVE : ""),
            `用户的原始问题：${query}\n\n待复核的报告：\n${report.join("")}`, 1800, "low"))
            send(ctrl, { review: text });
        } catch (re) {
          send(ctrl, { review: S.ai_review_fail(re.message) });
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

/* ───────── 每日巡检：收盘后扫所有用户的持仓+心愿单，有事发邮件 ─────────
   规则（全部复用查股/持仓的同一套口径）：
   · 🔴 跌破止损提醒线（ATR 自适应距离，回退 15%）
   · 🟡 距止损线不足 3%（预警区，给反应时间）
   · 🟠 持仓进入 extended（抛物线）→ 提示思考止盈
   · 🎯 心愿单到价 / 👀 接近心愿价 3% 以内
   记账币与本币不同（如加币买美股）时按最新汇率折算后再比，与持仓表同口径。 */
async function runPatrol(env) {
  const S = pack("zh");
  const rows = (await env.DB.prepare("SELECT user_id, hold, wish FROM user_data").all()).results || [];
  const paCache = new Map(); // 同一只股多个用户持有时只拉一次
  const getPA = (code) => {
    if (!paCache.has(code)) paCache.set(code, priceAnalysis(env, String(code).toUpperCase(), S).catch(() => null));
    return paCache.get(code);
  };
  // 模型 21 天中位涨跌（只为触发警报的股调用；跨用户缓存；失败返回 null 不阻塞）
  const fcCache = new Map();
  const getModelChg = async (code) => {
    code = String(code).toUpperCase();
    if (!fcCache.has(code)) fcCache.set(code, (async () => {
      try {
        const f = await kronosForecast(env, code);
        if (!f.ok) return null;
        return Math.round((f.p50[f.p50.length - 1] / f.last - 1) * 1000) / 10;
      } catch { return null; }
    })());
    return fcCache.get(code);
  };
  // 统一复审结论（与前端 reviewText 同一套话术，大方向必然一致）
  const reviewMsg = (isLong, chgS, stopS, mc) => {
    if (isLong) {
      let txt = `已跌破防线（现 ${chgS}% / 防线 -${stopS}%，按长线放宽）。长线仓位只问一个问题：当初的理由还在吗？在→拿住；不在→退出。`;
      if (mc != null && mc > 1.5) txt += `若决定退出：模型看短期或有反弹（21天中位 +${mc}%），可等反弹分批走，别抛在地板价。`;
      else if (mc != null && mc < -1.5) txt += `若决定退出：模型短期也偏弱（21天中位 ${mc}%），别指望反弹解套。`;
      return txt;
    }
    if (mc != null && mc < -1.5) return `已跌破止损线（现 ${chgS}% / 线 -${stopS}%），模型短期同向看跌（21天中位 ${mc}%）——两个信号一致：按纪律离场。`;
    if (mc != null && mc > 1.5) return `已跌破止损线（现 ${chgS}% / 线 -${stopS}%），但模型看短期或有反弹（21天中位 +${mc}%）——可等反弹择机离场、别割在地板价；反弹不来仍要执行纪律。`;
    return `已跌破止损线（现 ${chgS}% / 线 -${stopS}%）——短线仓位按纪律处理，别让小亏拖成大亏。`;
  };

  for (const row of rows) {
    let hold = [], wish = [];
    try { hold = JSON.parse(row.hold || "[]"); wish = JSON.parse(row.wish || "[]"); } catch { continue; }
    const events = [];

    for (const h of hold) {
      if (!h?.code || !Array.isArray(h.txns)) continue;
      // 移动平均持仓/成本（与 portfolio 同法，记账币 = 流水实付币）
      const txns = h.txns.filter((t) => t && t.price > 0 && t.qty > 0)
        .sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
      if (!txns.length) continue;
      const natCur = CUR_OF_MARKET[MARKET_OF(String(h.code).toUpperCase())];
      const curs = new Set(txns.map((t) => t.cur || natCur));
      const acctCur = curs.size === 1 ? [...curs][0] : natCur;
      let held = 0, avg = 0;
      for (const t of txns) {
        if (t.side === "buy") { const nq = held + t.qty; avg = nq > 0 ? (held * avg + t.qty * t.price) / nq : 0; held = nq; }
        else held = Math.max(0, held - t.qty);
      }
      if (held <= 0 || avg <= 0) continue;
      const pa = await getPA(h.code);
      if (!pa || pa.last == null) continue;
      let rate = 1;
      if (acctCur !== natCur) {
        rate = fxLatest(await fxSeries(natCur, acctCur));
        if (rate == null) continue; // 汇率拿不到 → 宁可不报，不报错账
      }
      const lastAcct = pa.last * rate;
      // 手动止损优先；自动线按持有期缩放（短线收紧、长线放宽，封顶45%）
      const HZF = { "1m": 0.8, "3m": 1.0, "1y": 1.4, "3y": 1.8, "hold": 2.2 };
      const isLong = ["1y", "3y", "hold"].includes(h.horizon);
      const stopPct = (h.stopPct > 0 ? h.stopPct
        : Math.min(45, (pa.stop_atr_pct ?? 15) * (HZF[h.horizon] || 1))) / 100;
      const chg = lastAcct / avg - 1;
      const name = h.name || h.code;
      if (isLong) {
        // 长线三档：灾难线才报警；季度例行体检温和提醒；计划内回撤不打扰
        const disPct = Math.min(60, stopPct * 100 * 1.6);
        const buys2 = txns.filter((t) => t.side === "buy" && t.date).map((t) => t.date).sort();
        const daysHeld = buys2.length ? Math.floor((Date.now() - new Date(buys2[buys2.length - 1]).getTime()) / 86400000) : null;
        if (chg <= -disPct / 100) {
          const mc = await getModelChg(h.code);
          let txt = `🔴 ${name}（${h.code}）回撤已达 ${(chg * 100).toFixed(1)}%，超过长线灾难线（-${disPct.toFixed(1)}%）。这不是普通波动了——理由复核不能再拖：基本面没崩就分批补回信心，崩了就认错离场。`;
          if (mc != null && mc > 1.5) txt += `若决定退出：模型看短期或有反弹（21天中位 +${mc}%），可等反弹分批走。`;
          else if (mc != null && mc < -1.5) txt += `若决定退出：模型短期也偏弱（21天中位 ${mc}%），别指望反弹解套。`;
          events.push(txt);
        } else if (daysHeld != null && daysHeld >= 89 && (daysHeld % 91) <= 2) {
          events.push(`🟡 ${name}（${h.code}）例行体检：长线计划已持有约 ${Math.round(daysHeld / 30)} 个月（现 ${(chg * 100).toFixed(1)}%）。花两分钟确认当初的买入理由还在——在就继续安心拿，不用操作。`);
        }
      } else if (chg <= -stopPct) {
        const mc = await getModelChg(h.code);
        events.push(`🔴 ${name}（${h.code}）${reviewMsg(false, (chg * 100).toFixed(1), (stopPct * 100).toFixed(1), mc)}`);
      }
      else if (chg <= -stopPct + 0.03)
        events.push(`🟡 ${name}（${h.code}）距离止损提醒线只剩 ${((chg + stopPct) * 100).toFixed(1)}%（现 ${(chg * 100).toFixed(1)}%）。提前想好：跌破了执行吗？`);
      // 持有意图到期 → 复盘提醒（当初用户自己设的持有期）
      const HZM = { "1m": 1, "3m": 3, "1y": 12, "3y": 36 };
      if (h.horizon && HZM[h.horizon]) {
        const buys = txns.filter((t) => t.side === "buy" && t.date).map((t) => t.date).sort();
        if (buys.length) {
          const due = new Date(buys[buys.length - 1]);
          due.setMonth(due.getMonth() + HZM[h.horizon]);
          if (due < new Date()) {
            const hzName = { "1m": "一个月", "3m": "几个月", "1y": "一年左右", "3y": "两三年" }[h.horizon];
            events.push(`🗓 ${name}（${h.code}）当初买入时打算拿${hzName}——时间到了。复盘一下：当初的理由兑现了吗？留还是走？`);
          }
        }
      }
      if (pa.stageKey === "extended" && chg > 0.15)
        events.push(`🟠 ${name}（${h.code}）近一月拉出抛物线且你已浮盈 ${(chg * 100).toFixed(0)}%——考虑分批止盈锁一部分？树不会长到天上。`);
    }

    for (const w of wish) {
      if (!w?.code || !w.target) continue;
      const pa = await getPA(w.code);
      if (!pa || pa.last == null) continue;
      const name = w.name || w.code;
      if (pa.last <= w.target)
        events.push(`🎯 ${name}（${w.code}）到了你想买的价：现价 ${pa.cur}${pa.last}（目标 ${pa.cur}${w.target}）。去查一查它现在的水位和红旗，别闭眼接。`);
      else if (pa.last <= w.target * 1.03)
        events.push(`👀 ${name}（${w.code}）离你的心愿价只差 ${((pa.last / w.target - 1) * 100).toFixed(1)}%（现 ${pa.cur}${pa.last}）。`);
    }

    if (!events.length) continue;
    const u = await env.ACCOUNTS_DB.prepare("SELECT email FROM users WHERE id = ?").bind(row.user_id).first();
    if (!u?.email || !env.RESEND_API_KEY) continue;
    const html = `<div style="font-family:ui-monospace,Menlo,monospace;max-width:560px;margin:0 auto;padding:24px;color:#17150F">
      <div style="font-size:13px;color:#8A8578">steady · 定风波 — 每日巡检</div>
      <div style="font-size:20px;font-weight:800;margin:10px 0 18px">今天有 ${events.length} 件事需要你看一眼</div>
      ${events.map((e) => `<div style="padding:12px 14px;border:1px solid #E4DAC7;border-radius:12px;margin-bottom:10px;font-size:14px;line-height:1.6">${e}</div>`).join("")}
      <a href="https://steady.lowbattery.studio" style="display:inline-block;margin-top:10px;padding:12px 22px;background:#E5484D;color:#fff;border-radius:999px;text-decoration:none;font-weight:700;font-size:14px">打开 steady 处理 →</a>
      <div style="font-size:11px;color:#8A8578;margin-top:22px">提醒基于你自己设的清单和全站统一的止损口径。仅供研究教育，非投资建议。</div>
    </div>`;
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "steady · 定风波 <steady@lowbattery.studio>",
          to: [u.email],
          subject: `steady 巡检：${events.length} 件事需要你看一眼`,
          html,
        }),
      });
    } catch { /* 单个用户发信失败不影响其他人 */ }
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPatrol(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const q = (k, def = "") => url.searchParams.get(k) ?? def;
    const lang = q("lang", "zh") === "en" ? "en" : "zh";
    const S = pack(lang);

    try {
      // ── 登录 / 同步 ──
      // 登录/发码/登出已移交账号中心 accounts.lowbattery.studio；
      // quant 只保留"查身份"和自己的业务数据
      if (p === "/api/auth/me") return auth.me(env, request);
      if (p === "/api/data" && request.method === "GET") return auth.getData(env, request);
      if (p === "/api/data" && request.method === "PUT") return auth.putData(env, request);

      if (p === "/api/serenity/stock_check")
        return json({ ...(await stockCheck(env, q("code"), parseFloat(q("principal", "2000")), S)),
          forecast_enabled: !!env.KRONOS_API_URL });
      if (p === "/api/serenity/forecast") return json(await kronosForecast(env, q("code"), S));
      if (p === "/api/serenity/news") return json(await stockNews(env, q("code")));
      if (p === "/api/serenity/debate") return debateSSE(env, q("code"), S, lang);
      if (p === "/api/serenity/pulse") return json(await marketPulse(env, S));
      if (p === "/api/serenity/parse_trade" && request.method === "POST")
        return json(await parseTrade(env, await request.json().catch(() => ({})), S));
      if (p === "/api/serenity/portfolio_history" && request.method === "POST")
        return json(await portfolioHistory(env, await request.json().catch(() => ({})), S));
      if (p === "/api/serenity/watch_check") return json(await watchCheck(env, q("items"), S));
      if (p === "/api/serenity/wish_check") return json(await wishCheck(env, q("items"), S));
      if (p === "/api/serenity/portfolio" && request.method === "POST")
        return json(await portfolio(env, await request.json().catch(() => ({})), S));
      if (p === "/api/serenity/history")
        return json(await history(env, q("code"), parseInt(q("points", "60")), S));
      if (p === "/api/serenity/resolve") return json(await resolve(env, q("q"), S));
      if (p === "/api/serenity/verify_tickers") return json(await verifyTickers(env, q("codes"), S));
      if (p === "/api/serenity/plan")
        return json(budgetPlan(parseFloat(q("amount")), q("currency", "CNY"), parseInt(q("months")), S));
      if (p === "/api/serenity/plan_ai")
        return planSSE(env, parseFloat(q("amount")), q("currency", "CNY"), parseInt(q("months")), q("extra", ""), S, lang);
      if (p === "/api/serenity/analyze") return analyzeSSE(env, q("query"), q("market", S.mkt_a), S, lang);
      if (p === "/api/search") return json(await search(env, q("keyword")));
      if (p === "/api/scan")
        return json(await scan(env, parseFloat(q("principal", "2000")), q("risk", "stable"), S));
      if (p.startsWith("/api/"))
        return json({ error: S.err_api(p) }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }

    // 非 API 请求 → 静态资源（public/）
    return env.ASSETS.fetch(request);
  },
};
