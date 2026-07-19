/**
 * SteadyQuant Cloudflare Worker
 * 从 Vercel FastAPI (api/index.py + api/serenity.py) 逐条移植的 JS 版后端。
 * 数据源：Tushare（A股）、Yahoo Finance（美股/加股）、DeepSeek/Anthropic（AI 报告）。
 */
import Anthropic from "@anthropic-ai/sdk";
import * as auth from "./auth.js";
import { pack } from "./i18n.js";

const CUR_SYM = { CNY: "¥", USD: "$", CAD: "C$" };
const isAshare = (c) => /^\d{6}\.(SH|SZ)$/.test(c);
// 常见币简写白名单（避免 UNI/LINK 等股票代码被币抢先识别）
const CRYPTO_SHORTHAND = new Set(["BTC","ETH","SOL","DOGE","XRP","BNB","ADA","LTC","DOT","AVAX","SHIB","TRX","MATIC","PEPE"]);
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
/** 取某日汇率：优先当日，没有就用该日之前最近的一天（休市/时差） */
function fxAt(map, date) {
  if (!map) return 1;
  const dates = Object.keys(map).sort();
  if (!dates.length) return null;
  let pick = null;
  for (const d of dates) { if (d <= date) pick = d; else break; }
  return map[pick || dates[0]];
}
const fxLatest = (map) => {
  if (!map) return 1;
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

function computePA(closes, currency, S = pack("zh")) {
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
  else if (aboveSma50 && ret3m !== null && ret3m > 0 && rangePos > 50) { stageKey = "momentum"; stage = S.stg_momentum; }
  else if (rangePos < 30 && ret1m !== null && ret1m > -5) { stageKey = "basing"; stage = S.stg_basing; }
  else if (ret1m !== null && ret1m < -10) { stageKey = "falling"; stage = S.stg_falling; }
  else { stageKey = "neutral"; stage = S.stg_neutral; }

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
    level, levelKey,
    stage, stageKey,
    data_points: closes.length,
  };
}

async function priceAnalysis(env, code, S = pack("zh")) {
  const s = await dailySeries(env, code);
  if (!s) return null;
  return computePA(s.closes.slice(-140), s.currency, S);
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

  if (pe == null && Object.keys(basic).length === 0) {
    if (highWater) return { code: "yellow", label: S.v_high_noval, hint: S.v_high_noval_h };
    return { code: "yellow", label: S.v_cheap_noval, hint: S.v_cheap_noval_h };
  }

  const fundOk = pe != null && pe > 0 && pe < 40;
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
      : code.endsWith(".TO") || y.meta.currency === "CAD" ? S.mkt_ca : S.mkt_us;
    const pa = computePA(y.closes.slice(-140), y.meta.currency || "USD", S);
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
    const pa = series ? computePA(series.closes.slice(-140), series.currency, S) : null;
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
        if (base && bDates.length) {
          idxPnl = (bench[bDates[bDates.length - 1]] / bench[base] - 1) * 100;
          const entryQuote = needFx ? entry / fxAt(fx, added) : entry;
          const pnlQuote = (pa.last / entryQuote - 1) * 100;
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
      gap_pct: Math.round((pa.last / target - 1) * 1000) / 10,
      level: pa.level, stage: pa.stage, ret_1m_pct: pa.ret_1m_pct,
    };
  }));
  return { items: results, checked_at: nowStr() };
}

async function history(env, code, points = 60, S = pack("zh")) {
  code = code.trim().toUpperCase();
  const s = await dailySeries(env, code);
  if (!s) return { error: S.err_no_data };
  const market = isAshare(code) ? S.mkt_a
    : /-(USD|USDT|USDC)$/.test(code) ? S.mkt_crypto
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
        market: isCrypto ? S.mkt_crypto : q.endsWith(".TO") || cur === "CAD" ? S.mkt_ca : S.mkt_us,
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
  return { trade_date: targetDate, principal, max_price: Math.round(maxPrice * 100) / 100,
    top_picks: results.slice(0, 15) };
}

function riskReview(code, totalReturn, winRate, maxDrawdown, dataMode, S = pack("zh")) {
  const flags = [];
  let score = 100;
  if (dataMode === "simulated") { flags.push(S.rr_sim); score -= 25; }
  if (String(totalReturn).includes("模拟")) { flags.push(S.rr_sim2); score -= 15; }
  const wr = parseFloat(String(winRate).replace("%", "")) || 0;
  if (wr > 85) { flags.push(S.rr_winrate); score -= 20; }
  const dd = parseFloat(String(maxDrawdown).replace("%", "")) || 0;
  if (dd < 5) { flags.push(S.rr_dd); score -= 15; }
  if (!flags.length) flags.push(S.rr_ok);
  return {
    code,
    review: {
      review_score: Math.max(0, score), flags,
      recommendation: score >= 70 ? S.rr_pass : S.rr_review,
      red_line: S.risk_redline,
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
        const report = [];
        const sys = SERENITY_SYSTEM + (lang === "en" ? EN_DIRECTIVE : "");
        for await (const text of llmStream(env, sys, `市场范围：${market}。请分析：${query}`, 8000, "medium", true)) {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 品牌改名：quant → steady（旧域名 301 保收藏夹）
    if (url.hostname === "quant.lowbattery.studio")
      return Response.redirect("https://steady.lowbattery.studio" + url.pathname + url.search, 301);
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
        return json(await stockCheck(env, q("code"), parseFloat(q("principal", "2000")), S));
      if (p === "/api/serenity/watch_check") return json(await watchCheck(env, q("items"), S));
      if (p === "/api/serenity/wish_check") return json(await wishCheck(env, q("items"), S));
      if (p === "/api/serenity/history")
        return json(await history(env, q("code"), parseInt(q("points", "60")), S));
      if (p === "/api/serenity/resolve") return json(await resolve(env, q("q"), S));
      if (p === "/api/serenity/verify_tickers") return json(await verifyTickers(env, q("codes"), S));
      if (p === "/api/serenity/analyze") return analyzeSSE(env, q("query"), q("market", S.mkt_a), S, lang);
      if (p === "/api/search") return json(await search(env, q("keyword")));
      if (p === "/api/scan")
        return json(await scan(env, parseFloat(q("principal", "2000")), q("risk", "stable"), S));
      if (p === "/api/risk_review")
        return json(riskReview(q("code"), q("total_return", "12.5%"), q("win_rate", "68%"),
          q("max_drawdown", "9.2%"), q("data_mode", "real"), S));
      if (p.startsWith("/api/"))
        return json({ error: S.err_api(p) }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }

    // 非 API 请求 → 静态资源（public/）
    return env.ASSETS.fetch(request);
  },
};
