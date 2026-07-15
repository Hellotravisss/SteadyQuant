"""
Serenity 供应链卡点分析模块
融合两套 skill 的方法论：
  - serenity-bottleneck-hunter：水位标尺 / 二轴判定 / 证伪条件 / 价格纪律
  - serenity-unified (BestSerenitySkillFromAT)：九步工作流 / 9条卡点判据 / 红旗扫描 / 反确认偏误

拆成两部分落地：
  1. 纯代码可算：stock_check —— 水位/动量/stage、红旗自动扫描、判据打分、二轴判定、证伪条件、仓位风控
  2. 需要 LLM：analyze —— 主题/个股的供应链卡点深度报告（流式）
"""

import json
import os
import requests
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

try:
    from .risk import risk_control
except ImportError:
    from risk import risk_control

router = APIRouter()

TUSHARE_TOKEN = os.getenv("TUSHARE_TOKEN")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")

CUR_SYM = {"CNY": "¥", "USD": "$", "CAD": "C$"}


def is_ashare(code: str) -> bool:
    import re
    return bool(re.match(r"^\d{6}\.(SH|SZ)$", code))


# ─────────────────────────────────────────────
# 海外行情（美股/加股）：Yahoo chart API，免 key
# ─────────────────────────────────────────────
def _yahoo_chart(symbol: str):
    try:
        res = requests.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
            params={"range": "1y", "interval": "1d"},
            headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        r = res.json()["chart"]["result"][0]
        closes = [c for c in r["indicators"]["quote"][0]["close"] if c is not None]
        meta = r.get("meta", {})
        return closes, meta
    except Exception:
        return None, None


def _tushare(api_name, params=None, fields="", timeout=8):
    try:
        res = requests.post(
            "http://api.tushare.pro",
            data=json.dumps({"api_name": api_name, "token": TUSHARE_TOKEN,
                             "params": params or {}, "fields": fields}),
            headers={"Content-Type": "application/json"}, timeout=timeout)
        data = res.json()
        if data.get("code") != 0:
            return None
        return data.get("data")
    except Exception:
        return None


# ─────────────────────────────────────────────
# 水位标尺（skill 硬规则：所有数字来自真实价格，禁止猜测）
# ─────────────────────────────────────────────
def price_analysis(code: str):
    """三市场统一入口：A股走 Tushare，美/加股走 Yahoo。输出 9 字段水位标尺 + 币种"""
    if is_ashare(code):
        end = datetime.now().strftime("%Y%m%d")
        start = (datetime.now() - timedelta(days=200)).strftime("%Y%m%d")
        daily = _tushare("daily", {"ts_code": code, "start_date": start, "end_date": end},
                         "trade_date,close", timeout=10)
        if not daily or not daily.get("items") or len(daily["items"]) < 30:
            return None
        rows = sorted([(r[0], float(r[1])) for r in daily["items"] if r[1] is not None])
        closes = [c for _, c in rows]
        currency = "CNY"
    else:
        closes, meta = _yahoo_chart(code)
        if not closes or len(closes) < 30:
            return None
        closes = closes[-140:]  # 与A股约200天窗口对齐
        currency = (meta or {}).get("currency", "USD")
    if not closes:
        return None
    last = closes[-1]
    # 近6个月（约120交易日）
    win = closes[-120:]
    hi, lo = max(win), min(win)
    range_pos = (last - lo) / (hi - lo) * 100 if hi > lo else 50.0
    off_high = (last - hi) / hi * 100

    def ret(n):
        if len(closes) > n:
            return (last / closes[-1 - n] - 1) * 100
        return None

    ret_1m, ret_3m = ret(21), ret(63)
    sma50 = sum(closes[-50:]) / min(50, len(closes))
    above_sma50 = last > sma50

    # stage 标签（skill：贴顶/高位/中位/低位/贴底 + 动量）
    if range_pos >= 90:
        level = "贴顶"
    elif range_pos >= 70:
        level = "高位"
    elif range_pos >= 40:
        level = "中位"
    elif range_pos >= 15:
        level = "低位"
    else:
        level = "贴底"

    if ret_1m is not None and ret_1m > 15 and range_pos > 80:
        stage = "extended（已抛物线，追高风险大）"
    elif above_sma50 and ret_3m is not None and ret_3m > 0 and range_pos > 50:
        stage = "momentum（趋势健康）"
    elif range_pos < 30 and ret_1m is not None and ret_1m > -5:
        stage = "basing（低位筑底）"
    elif ret_1m is not None and ret_1m < -10:
        stage = "falling（下跌中，别接飞刀）"
    else:
        stage = "neutral（震荡）"

    return {
        "last": round(last, 2),
        "cur": CUR_SYM.get(currency, currency + " "),
        "currency": currency,
        "high_6mo": round(hi, 2),
        "low_6mo": round(lo, 2),
        "range_pos_6mo_pct": round(range_pos, 1),
        "pct_off_6mo_high": round(off_high, 1),
        "ret_1m_pct": round(ret_1m, 1) if ret_1m is not None else None,
        "ret_3m_pct": round(ret_3m, 1) if ret_3m is not None else None,
        "above_sma50": above_sma50,
        "level": level,
        "stage": stage,
        "data_points": len(closes),
    }


# ─────────────────────────────────────────────
# 红旗扫描（skill Step 3：命中即降级/否决，A股特色红旗）
# ─────────────────────────────────────────────
def red_flag_scan(basic: dict, pa: dict):
    flags = []
    pe, pb, dv = basic.get("pe"), basic.get("pb"), basic.get("dv")
    mv = basic.get("total_mv")          # 万元
    turnover = basic.get("amount")      # 千元（当日成交额）

    if pe is not None and pe > 100:
        flags.append({"level": "hard", "text": f"估值极端（PE {pe:.0f}）——好卡点被炒到 100x forward P/E 就不是好卡点"})
    if pe is None or pe <= 0:
        flags.append({"level": "warn", "text": "PE 为负/缺失 —— 亏损中，检查现金跑道能否活到放量"})
    if pb is not None and pb > 10:
        flags.append({"level": "warn", "text": f"PB {pb:.1f} 偏高，安全边际薄"})
    if turnover is not None and turnover < 50000:  # <5000万元
        flags.append({"level": "hard", "text": "日均成交额 < 5000万 —— A股流动性陷阱（无机构关注）"})
    if mv is not None and mv > 30000000:  # >3000亿
        flags.append({"level": "warn", "text": "市值超大盘 —— 已被充分发现，本框架判断力弱、无不对称空间"})
    if pa and pa["stage"].startswith("extended"):
        flags.append({"level": "warn", "text": f"1个月涨 {pa['ret_1m_pct']}% 且贴顶 —— stage 问题，降🟡等回调或确认基本面跟得上"})
    if pa and pa["stage"].startswith("falling"):
        flags.append({"level": "warn", "text": "下跌趋势中 —— 区分「非实质性错杀」与「基本面恶化」，别接飞刀"})
    return flags


# ─────────────────────────────────────────────
# 9 条卡点判据（skill Step 2）：量化项自动打分，定性项留给前端勾选
# ─────────────────────────────────────────────
CRITERIA_QUALITATIVE = [
    {"id": "monopoly",   "text": "垄断性/不可替代：单一供应商或寡头，别人 1-2 年内绕不过"},
    {"id": "designin",   "text": "designed-in + 多客户：进了多条链的 BOM，替换成本高（收费站式卡位）"},
    {"id": "certlag",    "text": "认证周期未反映营收：量产在后年 → 现在财报难看 = 错杀机会"},
    {"id": "imbalance",  "text": "供需严重失衡：产能售罄/大客户包产能/backlog 已去风险"},
    {"id": "policy",     "text": "政策/地缘护城河：国产替代/出口管制壁垒/自给率低"},
    {"id": "balance",    "text": "资产负债表能活到放量：现金跑道 > 烧钱速度，无 toxic 负债"},
    {"id": "preinst",    "text": "前机构：卖方研报少、机构低配、散户没听过"},
]


def criteria_auto(basic: dict, pa: dict):
    """可量化判据的自动判定"""
    out = []
    mv = basic.get("total_mv")
    if mv is not None:
        mv_yi = mv / 10000  # 亿元
        small = mv_yi < 150  # ≈ sub-$2B
        out.append({"id": "smallcap", "hit": small,
                    "text": f"极小市值（现 {mv_yi:.0f} 亿）：{'✓ 有 10x 不对称空间' if small else '✗ 市值偏大，不对称性减弱'}"})
    pe = basic.get("pe")
    if pe is not None and pe > 0:
        cheap = pe < 25
        out.append({"id": "valuation", "hit": cheap,
                    "text": f"估值安全边际（PE {pe:.1f}）：{'✓ 估值压抑' if cheap else '✗ 已有溢价，问自己是否已 priced in'}"})
    return out


# ─────────────────────────────────────────────
# 二轴判定（skill 2026-06-21 核心修正：水位 ≠ 判定，必须叠加基本面轴）
# ─────────────────────────────────────────────
def two_axis_verdict(pa: dict, basic: dict):
    high_water = pa["range_pos_6mo_pct"] >= 70
    # 基本面轴的代理：PE 是否合理 + 3月相对动量（数据有限时降级为提示）
    pe = basic.get("pe")

    # 海外标的常拿不到估值 → 只按价格位置给保守判定，明说要自查
    if pe is None and not basic:
        if high_water:
            return {"code": "yellow", "label": "🟡 价格在高位",
                    "hint": "已接近半年高点。没有估值数据，无法判断是「贵但对」还是「博傻」—— 先自查业绩增速能不能跟上涨幅"}
        return {"code": "yellow", "label": "🟡 位置不贵，但要自查基本面",
                "hint": "价格位置有吸引力，但海外标的暂无估值数据 —— 确认 PE/增速/现金流没问题再考虑"}

    fundamentals_ok = pe is not None and 0 < pe < 40

    if high_water and fundamentals_ok:
        return {"code": "green", "label": "🟢 贵但可能对", "hint": "高水位但估值未失控 —— 动量龙头别轻易 fade；确认盈利增速跟得上涨幅再定"}
    if high_water and not fundamentals_ok:
        return {"code": "red", "label": "🔴 真贴顶", "hint": "高水位 + 纯重估（基本面跟不上）—— 再涨是博傻，回避"}
    if not high_water and fundamentals_ok:
        return {"code": "green", "label": "🟢 经典埋伏区", "hint": "低/中水位 + 估值合理 —— Mode A 早期埋伏或 Mode B 超跌反弹的猎区"}
    return {"code": "yellow", "label": "🟡 观望", "hint": "水位不高 + 估值/基本面存疑 —— 先搞清市场为什么给这个定价，想清「重估触发条件」再考虑"}


# ─────────────────────────────────────────────
# 证伪条件（skill Tier-1 §B：至少一条机器可读）
# ─────────────────────────────────────────────
def invalidation_rules(pa: dict):
    stop = round(pa["last"] * 0.85, 2)
    cur = pa.get("cur", "¥")
    return {
        "stop_price": stop,
        "rules": [
            f"价格/stage（机器可检）：跌破 {cur}{stop}（现价-15%）且 1 月动量转负 → 承认判断错，无条件离场",
            "基本面：下季度订单/营收未随主题增长（认证/放量逻辑证伪）",
            "估值：继续大涨但毛利/盈利未扩 → 纯博傻阶段，止盈离场",
        ],
        "note": "没有证伪条件的🟢 = 故事，不是投资假设。入观察池后每次打开自动检查是否触发。",
    }


# ─────────────────────────────────────────────
# 个股卡点体检（主端点）
# ─────────────────────────────────────────────
@router.get("/api/serenity/stock_check")
def stock_check(code: str, principal: float = 2000.0):
    code = code.strip().upper()

    # ── 海外标的（美股直接输 AAPL，加股带 .TO 如 SHOP.TO）──
    if not is_ashare(code):
        closes, meta = _yahoo_chart(code)
        if not closes:
            return {"error": f"查不到 {code}。美股直接输代码（如 AAPL / NVDA），加拿大股加 .TO（如 SHOP.TO / RY.TO）"}
        name = (meta or {}).get("shortName") or (meta or {}).get("longName") or code
        market = "加拿大" if code.endswith(".TO") or (meta or {}).get("currency") == "CAD" else "美股"
        pa = price_analysis(code)
        if not pa:
            return {"error": "价格数据不足，无法判定"}
        basic = {}
        flags = red_flag_scan(basic, pa)
        verdict = two_axis_verdict(pa, basic)
        if pa["stage"].startswith("falling") and verdict["code"] == "green":
            verdict = {"code": "yellow", "label": "🟡 先等它跌完",
                       "hint": "位置还行，但正在下跌途中 —— 等跌势企稳再考虑，别接飞刀"}
        rc = risk_control(principal=principal, proposed_position=pa["last"] * 1,
                          current_drawdown=0.0, strategy_age_days=999)
        return {
            "code": code, "name": name, "industry": market,
            "price": pa, "basic": {},
            "red_flags": flags,
            "criteria_auto": [],
            "criteria_manual": CRITERIA_QUALITATIVE,
            "verdict": verdict,
            "invalidation": invalidation_rules(pa),
            "risk_check": rc,
            "disclaimer": "仅供研究教育，非投资建议。海外标的估值/财务数据未接入，判定只基于价格位置，基本面需自查。",
        }

    # ── A股：ticker 双向验证纪律的简化版，先确认代码真实存在 ──
    info = _tushare("stock_basic", {"ts_code": code}, "ts_code,name,industry,list_date")
    if not info or not info.get("items"):
        return {"error": f"代码 {code} 不存在或无法验证（skill 纪律：禁止凭记忆写 ticker）"}
    name, industry = info["items"][0][1], info["items"][0][2]

    pa = price_analysis(code)
    if not pa:
        return {"error": "价格数据不足（skill 纪律：严禁凭印象猜水位，无真实价格则不判定）"}

    # 最新基本面指标
    basic = {}
    for i in range(1, 10):
        d = (datetime.now() - timedelta(days=i)).strftime("%Y%m%d")
        db = _tushare("daily_basic", {"ts_code": code, "trade_date": d},
                      "ts_code,pe_ttm,pb,dv_ratio,total_mv,turnover_rate")
        if db and db.get("items"):
            row = db["items"][0]
            basic = {"pe": row[1], "pb": row[2], "dv": row[3], "total_mv": row[4], "amount": None}
            break
    # 成交额
    daily = _tushare("daily", {"ts_code": code, "start_date": (datetime.now()-timedelta(days=10)).strftime("%Y%m%d"),
                               "end_date": datetime.now().strftime("%Y%m%d")}, "trade_date,amount")
    if daily and daily.get("items"):
        amts = [r[1] for r in daily["items"] if r[1]]
        if amts:
            basic["amount"] = sum(amts) / len(amts)

    flags = red_flag_scan(basic, pa)
    verdict = two_axis_verdict(pa, basic)
    # 下跌趋势中不给绿灯（别接飞刀）
    if pa["stage"].startswith("falling") and verdict["code"] == "green":
        verdict = {"code": "yellow", "label": "🟡 先等它跌完",
                   "hint": "位置和估值都还行，但正在下跌途中 —— 等跌势企稳（1个月动量转正）再考虑，别接飞刀"}
    # 硬红旗直接降级
    if any(f["level"] == "hard" for f in flags) and verdict["code"] == "green":
        verdict = {"code": "yellow", "label": "🟡 有硬红旗，降级观望",
                   "hint": "命中硬红旗（见下）——除非红旗解除，否则不进"}

    rc = risk_control(principal=principal, proposed_position=pa["last"] * 100,
                      current_drawdown=0.0, strategy_age_days=999)

    return {
        "code": code, "name": name, "industry": industry,
        "price": pa, "basic": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in basic.items() if v is not None},
        "red_flags": flags,
        "criteria_auto": criteria_auto(basic, pa),
        "criteria_manual": CRITERIA_QUALITATIVE,
        "verdict": verdict,
        "invalidation": invalidation_rules(pa),
        "risk_check": rc,
        "disclaimer": "仅供研究教育，非投资建议。判定基于量化规则，定性判据需你自己勾选核实。",
    }


# ─────────────────────────────────────────────
# 观察池证伪检查
# ─────────────────────────────────────────────
def _yahoo_series(symbol: str):
    """Yahoo 指数/个股日线 map: YYYYMMDD -> close"""
    try:
        res = requests.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
            params={"range": "1y", "interval": "1d"},
            headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        r = res.json()["chart"]["result"][0]
        ts = r["timestamp"]
        closes = r["indicators"]["quote"][0]["close"]
        return {datetime.utcfromtimestamp(t).strftime("%Y%m%d"): c
                for t, c in zip(ts, closes) if c is not None}
    except Exception:
        return None


def _hs300_series(days=260):
    """沪深300 日线 map: YYYYMMDD -> close（skill 纪律：收益必须对照大盘才算 alpha）"""
    end = datetime.now().strftime("%Y%m%d")
    start = (datetime.now() - timedelta(days=days)).strftime("%Y%m%d")
    idx = _tushare("index_daily", {"ts_code": "000300.SH", "start_date": start, "end_date": end},
                   "trade_date,close", timeout=8)
    if not idx or not idx.get("items"):
        return None
    return dict(sorted((r[0], float(r[1])) for r in idx["items"] if r[1]))


@router.get("/api/serenity/watch_check")
def watch_check(items: str):
    """items: code:entry:stop[:added]，检查证伪触发 + 对照各自市场大盘算 alpha
    基准：A股→沪深300 / 美股→标普500 / 加股→多伦多综指"""
    bench_cache = {}

    def get_bench(code):
        if is_ashare(code):
            key = "hs300"
        elif code.endswith(".TO"):
            key = "^GSPTSE"
        else:
            key = "^GSPC"
        if key not in bench_cache:
            bench_cache[key] = _hs300_series() if key == "hs300" else _yahoo_series(key)
        return bench_cache[key]

    bench_name = {"hs300": "沪深300", "^GSPC": "标普500", "^GSPTSE": "多伦多综指"}

    results = []
    for it in items.split(","):
        parts = it.strip().split(":")
        if len(parts) < 3:
            continue
        code, entry, stop = parts[0].upper(), float(parts[1]), float(parts[2])
        added = parts[3].replace("-", "") if len(parts) > 3 and parts[3] else None
        pa = price_analysis(code)
        if not pa:
            results.append({"code": code, "error": "无价格数据"})
            continue
        last = pa["last"]
        pnl = (last / entry - 1) * 100
        triggered = last < stop and (pa["ret_1m_pct"] is not None and pa["ret_1m_pct"] < 0)

        # alpha = 个股收益 − 对应市场大盘同期收益（skill：牛市里啥都涨，raw return 看不出本事）
        alpha = None
        idx_pnl = None
        bench = get_bench(code) if added else None
        if bench:
            b_dates = sorted(bench.keys())
            base_dates = [d for d in b_dates if d >= added]
            if base_dates and b_dates:
                idx_base = bench[base_dates[0]]
                idx_pnl = (bench[b_dates[-1]] / idx_base - 1) * 100
                alpha = pnl - idx_pnl

        bkey = "hs300" if is_ashare(code) else ("^GSPTSE" if code.endswith(".TO") else "^GSPC")
        results.append({
            "code": code, "entry": entry, "stop": stop, "last": last,
            "cur": pa.get("cur", "¥"),
            "pnl_pct": round(pnl, 1),
            "bench_name": bench_name[bkey],
            "hs300_pnl_pct": round(idx_pnl, 1) if idx_pnl is not None else None,
            "alpha_pct": round(alpha, 1) if alpha is not None else None,
            "invalidation_triggered": triggered,
            "level": pa["level"], "stage": pa["stage"],
            "ret_1m_pct": pa["ret_1m_pct"],
        })
    return {"items": results, "checked_at": datetime.now().strftime("%Y-%m-%d %H:%M")}


# ─────────────────────────────────────────────
# AI 深度报告（LLM 部分，流式）
# ─────────────────────────────────────────────
SERENITY_SYSTEM = """你是一位供应链卡点投资分析师，使用 Serenity 的「供应链瓶颈逆向映射」方法论。方法内化、隐形：报告围着标的/主题展开，不提方法论标签。

【核心工作流】锁定 capex 确定性 → 逆向拆 5 层供应链（下游对照→中游系统→中游器件→上游设备→上游材料）→ 跳过人人都盯的下游龙头 → 对每层套 9 大瓶颈原型（材料垄断/单一来源/产能售罄/进每个BOM/估值对标套利/测试设备瓶颈/冷门前机构/巨头依赖/宏观错杀）→ 三道闸门检验（真瓶颈？前机构？便宜+已去风险？）。

【9 条好卡点判据】垄断性不可替代 / 极小市值 vs 巨大下游 TAM / designed-in 多客户 / 认证周期未反映营收=错杀 / 资产负债表活到放量 / 供需严重失衡 / 政策地缘护城河 / 机构低配+下行保护 / 估值安全边际。命中越多信念越高。

【红旗（命中即降级）】无限增发稀释=硬否决 / 单一客户 / toxic 负债 / 零收入纯炒作 / 蹭热点非主营 / 产能扩张太容易壁垒低 / 日成交额<5000万流动性陷阱 / 管理层诚信问题 / 技术路线被替代风险。

【反确认偏误（锁死）】① bear/风险先写，bull 后写；② 每个候选强制给「反向研究」四问：为什么可能不是真瓶颈？瓶颈为什么可能不变现？市场是否已定价？有没有更优替代（点名对比标的）？最大杀点一句话，禁止写"估值高"这种套话；③ 每个🟢候选强制给 2-3 条具体可检验的证伪条件，至少一条是价格规则（如"跌破 X 元且月动量转负"）。

【取数纪律】所有事实分级标注：已证实/管理层声称/我的推断/纯推测。你无法联网，训练数据有截止日期——凡是价格、市值、最新订单等时效数据一律标 [知识库·可能过期，需自行核实]，禁止编造具体数字冒充实时数据。不确定的公司状态（是否私有/被收购）显式说明需要核实。

【中文表达】写给中文母语读者。投资圈通用术语保留（PE/capex/backlog/TAM），首次出现给一句中文解释。禁止英式句法和生造词。加粗克制。

【估值纪律】给估值必须分 bear/base/bull 三档区间并绑死假设（对标谁/几倍/哪年）。可比公司质量高用相对估值（PE/EV/S/PEG 对标 gap），无好对标退化用份额跨层法（份额=营收/TAM，TAM 需说明来源）。精度降级铁律：关键假设里有[推断]/[推测]，就禁止给精确百分比，只给数量级和方向；无可信对标就直说"区间太宽，不给假精确"。禁止抄分析师目标价当标尺。

【输出结构】30秒看懂（大白话）→ 供应链拆解（哪层可能是卡点，为什么）→ 候选名单（每只：是什么/卡点逻辑/命中判据/红旗/反向研究/三档判定🟢🟡🔴/证伪条件）→ 落地结论 → 免责声明。A股候选给 6 位代码+交易所后缀。

【供应链图谱】报告最末尾必须附一个机器可读图谱块，格式严格如下（单独一行开始）：
```chain
{"layers":[{"name":"下游应用","nodes":["特斯拉","比亚迪 002594.SZ"]},{"name":"中游系统","nodes":[...]},{"name":"中游器件","nodes":[...]},{"name":"上游设备","nodes":[...]},{"name":"上游材料","nodes":[...]}],"edges":[["上游节点名","下游节点名"],...]}
```
节点名与正文一致（有代码带代码），edges 方向为供货方→采购方，每层 2-4 个节点。

【铁律】仅供研究教育，非投资建议，不给具体仓位和买卖指令。按框架不成立就直说不成立。"""


REVIEWER_SYSTEM = """你是独立复核员，立场是挑刺反驳，不是背书。对这份供应链卡点投研报告快速复核，输出必须简短（300字内）、大白话：

1. 【裁决】通过 / 有问题需注意（一句话）
2. 【最可疑的 2-3 处】：编造嫌疑的数字（没标注来源或时效的具体价格/市值/份额）、逻辑硬伤（判据命中没依据、结论与事实不符）、迎合用户倾向的地方
3. 【读者动手前必须自己核实的清单】：列 3 条以内最关键的待核实项

不复述报告内容。没发现大问题就说"未发现硬伤"再给核实清单。"""


def _stream_deepseek(system: str, user: str, max_tokens: int = 8000):
    """DeepSeek（OpenAI 兼容接口）流式生成"""
    res = requests.post(
        "https://api.deepseek.com/chat/completions",
        headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                 "Content-Type": "application/json"},
        json={"model": "deepseek-chat", "stream": True, "max_tokens": max_tokens,
              "messages": [{"role": "system", "content": system},
                           {"role": "user", "content": user}]},
        stream=True, timeout=300)
    res.raise_for_status()
    for line in res.iter_lines():
        if not line:
            continue
        line = line.decode("utf-8")
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        try:
            delta = json.loads(line[6:])["choices"][0]["delta"].get("content")
            if delta:
                yield delta
        except Exception:
            continue


def _stream_anthropic(system: str, user: str, max_tokens: int = 8000, effort: str = "medium"):
    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    with client.messages.stream(
        model="claude-opus-4-8",
        max_tokens=max_tokens,
        thinking={"type": "adaptive"},
        output_config={"effort": effort},
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user}],
    ) as stream:
        for text in stream.text_stream:
            yield text


def _llm_stream(system, user, max_tokens=8000, effort="medium"):
    """优先 DeepSeek（用户自备 key，便宜稳定），其次 Anthropic"""
    if DEEPSEEK_API_KEY:
        return _stream_deepseek(system, user, max_tokens)
    return _stream_anthropic(system, user, max_tokens, effort)


@router.get("/api/serenity/analyze")
def serenity_analyze(query: str, market: str = "A股"):
    """LLM 深度卡点分析，SSE 流式输出"""
    if not (DEEPSEEK_API_KEY or ANTHROPIC_API_KEY):
        def no_key():
            yield "data: " + json.dumps({"error": "未配置 AI 密钥。请在 Vercel 环境变量中添加 DEEPSEEK_API_KEY（或 ANTHROPIC_API_KEY）后重新部署；「查一只股」和「我的关注」不受影响。"}) + "\n\n"
        return StreamingResponse(no_key(), media_type="text/event-stream")

    def gen():
        try:
            report = []
            for text in _llm_stream(SERENITY_SYSTEM, f"市场范围：{market}。请分析：{query}"):
                report.append(text)
                yield "data: " + json.dumps({"text": text}) + "\n\n"

            # ── 独立复核（skill Step 7：挑刺立场，不是背书）──
            yield "data: " + json.dumps({"phase": "review"}) + "\n\n"
            try:
                for text in _llm_stream(REVIEWER_SYSTEM,
                                        f"用户的原始问题：{query}\n\n待复核的报告：\n{''.join(report)}",
                                        max_tokens=1800, effort="low"):
                    yield "data: " + json.dumps({"review": text}) + "\n\n"
            except Exception as re:
                yield "data: " + json.dumps({"review": f"（复核失败：{re}）"}) + "\n\n"

            yield "data: " + json.dumps({"done": True}) + "\n\n"
        except Exception as e:
            yield "data: " + json.dumps({"error": str(e)}) + "\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
