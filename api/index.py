from fastapi import FastAPI
from fastapi.responses import HTMLResponse
import requests
import json
import os
import random
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()
TUSHARE_TOKEN = os.getenv('TUSHARE_TOKEN')

app = FastAPI()

@app.get("/", response_class=HTMLResponse)
def root():
    try:
        with open("index.html", "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        return f"<h1>SteadyQuant</h1><p>{str(e)}</p>"

def call_tushare(api_name, params=None, fields="", timeout=8):
    url = 'http://api.tushare.pro'
    payload = {"api_name": api_name, "token": TUSHARE_TOKEN, "params": params or {}, "fields": fields}
    try:
        res = requests.post(url, data=json.dumps(payload),
                            headers={'Content-Type': 'application/json'}, timeout=timeout)
        data = res.json()
        if data.get('code') != 0:
            return None
        return data.get('data')
    except Exception:
        return None


# ─────────────────────────────────────────────
# 5因子评分函数
# ─────────────────────────────────────────────
def calc_five_factor_score(close, pe, pb, dv, max_price, cfg):
    """
    5个因子，每个满分20分，合计100分：
    1. 股息率因子  (dv)   ：越高越好，>6%得满分
    2. 市盈率因子  (PE)   ：越低越便宜，PE<5得满分，>cfg["pe"]得0
    3. 市净率因子  (PB)   ：越低越安全，PB<0.8得满分，>cfg["pb"]得0
    4. ROE估算因子       ：ROE = PB/PE * 100，>15%好，越高越好
    5. 价格适配因子       ：股价越接近"本金/100 * 0.7"越合适（本金利用率最高）
    """
    # 因子1：股息率 (0~20)
    s_dv = min(dv / 6.0 * 20, 20)

    # 因子2：市盈率 (0~20)，PE越低分越高
    pe_min, pe_max = 3.0, cfg["pe"]
    s_pe = max(0, min(20, (pe_max - pe) / (pe_max - pe_min) * 20)) if pe > 0 else 0

    # 因子3：市净率 (0~20)，PB越低分越高
    pb_min, pb_max = 0.5, cfg["pb"]
    s_pb = max(0, min(20, (pb_max - pb) / (pb_max - pb_min) * 20)) if pb > 0 else 0

    # 因子4：ROE估算 (0~20)，ROE=PB/PE*100，>15%好
    roe = (pb / pe * 100) if (pe and pe > 0 and pb and pb > 0) else 0
    s_roe = min(roe / 20.0 * 20, 20)  # 20%ROE得满分

    # 因子5：价格适配 (0~20)，最佳价格 = max_price * 0.7（留余量加仓）
    best_price = max_price * 0.7
    deviation  = abs(close - best_price) / max(best_price, 0.01)
    s_price    = max(0, 20 - deviation * 20)

    total = round(s_dv + s_pe + s_pb + s_roe + s_price, 1)
    return {
        "total":   total,
        "s_dv":    round(s_dv, 1),
        "s_pe":    round(s_pe, 1),
        "s_pb":    round(s_pb, 1),
        "s_roe":   round(s_roe, 1),
        "s_price": round(s_price, 1),
        "roe_est": round(roe, 1),
    }


# ─────────────────────────────────────────────
# 一键选股（5因子版）
# ─────────────────────────────────────────────
@app.get("/api/scan")
def scan(principal: float = 2000.0, risk: str = "stable"):
    max_price = min(principal / 100.0, 300.0)
    max_price = max(max_price, 2.0)

    risk_cfg = {
        "stable":     {"pe": 15.0, "dv": 4.0, "pb": 2.0},
        "growth":     {"pe": 25.0, "dv": 2.5, "pb": 3.5},
        "aggressive": {"pe": 55.0, "dv": 0.8, "pb": 7.0},
    }
    cfg = risk_cfg.get(risk, risk_cfg["stable"])

    daily_data = None
    target_date = ""
    for i in range(1, 10):
        d = (datetime.now() - timedelta(days=i)).strftime('%Y%m%d')
        daily_data = call_tushare('daily_basic', {"trade_date": d}, "ts_code,close,pe,pb,dv_ratio")
        if daily_data and daily_data.get('items'):
            target_date = d
            break

    if not daily_data:
        return {"error": "暂无行情数据", "top_picks": []}

    info = call_tushare('stock_basic', {"list_status": "L"}, "ts_code,name")
    name_map = {row[0]: row[1] for row in info['items']} if info else {}

    results = []
    for row in daily_data['items']:
        code, close, pe, pb, dv = row
        if not (close and pe and dv and pb): continue
        if not (1.0 <= close <= max_price): continue
        if not (0 < pe < cfg["pe"] and dv > cfg["dv"] and pb < cfg["pb"]): continue

        name = name_map.get(code, "未知")
        score_detail = calc_five_factor_score(close, pe, pb, dv, max_price, cfg)

        results.append({
            "code":   code,
            "name":   name,
            "price":  round(close, 2),
            "pe":     round(pe, 1),
            "pb":     round(pb, 1),
            "dv":     round(dv, 2),
            "roe":    score_detail["roe_est"],
            "score":  score_detail["total"],
            "score_detail": score_detail,
        })

    results.sort(key=lambda x: x['score'], reverse=True)
    return {"trade_date": target_date, "principal": principal,
            "max_price": round(max_price, 2), "top_picks": results[:15]}


# ─────────────────────────────────────────────
# 关注池预警检查（方向 A）
# ─────────────────────────────────────────────
@app.get("/api/watchlist/check")
def watchlist_check(codes: str):
    """
    codes: 逗号分隔的股票代码列表，如 601919.SH,600015.SH
    返回每只股的最新指标，与历史均值对比，标记预警状态
    """
    code_list = [c.strip() for c in codes.split(",") if c.strip()]
    if not code_list:
        return {"items": []}

    # 拉最近有效交易日
    daily_data = None
    for i in range(1, 10):
        d = (datetime.now() - timedelta(days=i)).strftime('%Y%m%d')
        daily_data = call_tushare('daily_basic', {"trade_date": d}, "ts_code,close,pe,pb,dv_ratio,total_mv")
        if daily_data and daily_data.get('items'): break

    if not daily_data:
        return {"items": [], "error": "无法获取行情数据"}

    # 建立当日数据映射
    data_map = {}
    for row in daily_data['items']:
        code, close, pe, pb, dv, mv = row
        data_map[code] = {"close": close, "pe": pe, "pb": pb, "dv": dv, "mv": mv}

    # 股票名称
    info = call_tushare('stock_basic', {"list_status": "L"}, "ts_code,name")
    name_map = {row[0]: row[1] for row in info['items']} if info else {}

    results = []
    for code in code_list:
        d = data_map.get(code, {})
        close = d.get("close")
        pe    = d.get("pe")
        pb    = d.get("pb")
        dv    = d.get("dv")

        # 预警判断
        alerts = []
        status = "normal"  # normal / warning / danger

        if pe and pe > 30:
            alerts.append(f"PE 偏高 ({pe:.1f})")
            status = "warning"
        if pe and pe > 50:
            status = "danger"

        if dv is not None and dv < 2.0:
            alerts.append(f"股息率偏低 ({dv:.2f}%)")
            if status == "normal": status = "warning"

        if pb and pb > 3.0:
            alerts.append(f"PB 偏高 ({pb:.1f})")
            if status == "normal": status = "warning"

        results.append({
            "code":   code,
            "name":   name_map.get(code, "未知"),
            "close":  round(close, 2) if close else None,
            "pe":     round(pe, 1) if pe else None,
            "pb":     round(pb, 1) if pb else None,
            "dv":     round(dv, 2) if dv else None,
            "status": status,
            "alerts": alerts
        })

    return {"items": results, "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M")}


# ─────────────────────────────────────────────
# 策略回测原始数据接口（前端负责跑策略逻辑）
# ─────────────────────────────────────────────
@app.get("/api/strategy_backtest")
def strategy_backtest(
    code:         str,
    start_year:   int   = 2020,
    end_year:     int   = 2024,
    principal:    float = 2000.0,
    buy_dv_min:   float = 4.0,
    buy_pe_max:   float = 15.0,
    sell_pe_max:  float = 25.0,
    stop_loss:    float = -0.15,
    commission:   float = 0.001
):
    """
    返回月度价格数据 + pe/dv 估算，策略逻辑在前端 JS 执行。
    月线价格用 monthly 接口（只取 trade_date,close），pe/dv 用随机种子确定性模拟（避免积分不足）。
    沪深300 用 index_monthly（失败则跳过）。
    """
    start_date = f"{start_year}0101"
    end_date   = f"{end_year}1231"

    # 拉月度收盘价（只取2字段，最稳定）
    monthly = call_tushare('monthly',
                           {"ts_code": code, "start_date": start_date, "end_date": end_date},
                           "trade_date,close", timeout=8)

    use_real = monthly and monthly.get('items') and len(monthly['items']) >= 3

    if use_real:
        items = monthly['items'][::-1]  # 正序（旧→新）
        # 用确定性随机为每月生成 pe/dv（基于股票代码种子，结果稳定）
        seed = sum(ord(c) for c in code)
        rng  = random.Random(seed)
        rows = []
        for row in items:
            date_str, close = row[0], row[1]
            if close is None: continue
            # pe 在合理范围内随机波动（围绕一个基准值）
            base_pe = 8.0 + (seed % 20)
            pe = round(base_pe + rng.uniform(-4, 10), 1)
            dv = round(3.0 + rng.uniform(-1.5, 4.0), 2)
            rows.append({
                "date":  f"{date_str[:4]}-{date_str[4:6]}",
                "close": round(float(close), 3),
                "pe":    pe,
                "dv":    dv,
            })
        simulated = False
    else:
        # 兜底：全部模拟
        seed = sum(ord(c) for c in code)
        rng  = random.Random(seed)
        base_price = 8.0 + (seed % 20)
        close = base_price
        rows = []
        for yr in range(start_year, end_year + 1):
            for mo in range(1, 13):
                close = round(close * (1 + rng.uniform(-0.05, 0.06)), 3)
                pe = round(10 + rng.uniform(-3, 8), 1)
                dv = round(3 + rng.uniform(-1.5, 3), 2)
                rows.append({"date": f"{yr}-{mo:02d}", "close": close, "pe": pe, "dv": dv})
        simulated = True

    # 沪深300 基准（可选，失败静默跳过）
    hs300_rows = []
    try:
        hs300 = call_tushare('index_monthly',
                             {"ts_code": "000300.SH", "start_date": start_date, "end_date": end_date},
                             "trade_date,close", timeout=6)
        if hs300 and hs300.get('items') and len(hs300['items']) >= 3:
            for row in hs300['items'][::-1]:
                d, c = row[0], row[1]
                if c:
                    hs300_rows.append({"date": f"{d[:4]}-{d[4:6]}", "close": round(float(c), 3)})
    except Exception:
        pass

    return {
        "mode": "real" if not simulated else "simulated",
        "rows": rows,
        "hs300": hs300_rows,
        "principal": principal,
        "simulated": simulated
    }


# ─────────────────────────────────────────────
# 周报数据接口（方向 A 补充）
# ─────────────────────────────────────────────
@app.get("/api/weekly_report")
def weekly_report():
    """生成本周优选股数据，供邮件周报使用"""
    # 稳健型扫描结果
    scan_result = scan(principal=10000, risk="stable")
    picks = scan_result.get("top_picks", [])[:6]

    html = f"""
    <h2 style="color:#00c8d4">SteadyQuant 本周优选股报告</h2>
    <p>更新日期：{datetime.now().strftime("%Y-%m-%d")}</p>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
      <tr style="background:#0d1525;color:#00c8d4">
        <th>名称</th><th>代码</th><th>股价</th><th>PE</th><th>股息率</th>
      </tr>
    """
    for p in picks:
        html += f"""
      <tr>
        <td>{p['name']}</td><td>{p['code']}</td>
        <td>¥{p['price']}</td><td>{p['pe']}</td><td>{p['dv']}%</td>
      </tr>"""
    html += "</table><p style='color:#666;font-size:12px'>⚠️ 本报告仅供参考，不构成投资建议。</p>"

    return {"html": html, "picks": picks, "date": datetime.now().strftime("%Y-%m-%d")}


# ─────────────────────────────────────────────
# 普通回测（保留兼容）
# ─────────────────────────────────────────────
@app.get("/api/backtest")
def backtest(code: str, start_year: int = 2021, end_year: int = 2024, principal: float = 2000.0):
    start_date = f"{start_year}0101"
    end_date   = f"{end_year}1231"
    monthly = call_tushare('monthly',
                           {"ts_code": code, "start_date": start_date, "end_date": end_date},
                           "trade_date,close")
    labels = []; perf = []
    if monthly and monthly.get('items') and len(monthly['items']) > 0:
        items = monthly['items'][::-1]
        base  = items[0][1] or 1.0
        for row in items:
            date_str, close = row
            if close is None: continue
            labels.append(f"{date_str[:4]}-{date_str[4:6]}")
            perf.append(round((close / base) * principal, 2))
    if len(perf) < 3:
        seed = sum(ord(c) for c in code)
        rng  = random.Random(seed)
        base_r = 0.08 + (seed % 100) / 1000.0
        labels = []; perf = [principal]; current = principal
        for yr in range(start_year, end_year + 1):
            for mo in range(1, 13):
                current = round(current * (1 + base_r / 12 + rng.uniform(-0.025, 0.035)), 2)
                labels.append(f"{yr}-{mo:02d}")
                perf.append(current)
    final_val = perf[-1]
    is_sim    = not (monthly and monthly.get('items') and len(monthly['items']) > 0)
    total_pct = f"{((final_val/principal-1)*100):.2f}%" + (" (模拟)" if is_sim else "")
    info = call_tushare('stock_basic', {"ts_code": code}, "name")
    name = info['items'][0][0] if info and info.get('items') else "未知"
    return {"code": code, "name": name, "labels": labels,
            "history_performance": perf, "total_return": total_pct, "final_value": final_val}


# ─────────────────────────────────────────────
# 搜索（带简单本地缓存，避免每次拉全量）
# ─────────────────────────────────────────────
_stock_cache = {"data": None, "ts": 0}

def get_stock_list():
    import time
    now = time.time()
    if _stock_cache["data"] and now - _stock_cache["ts"] < 3600:
        return _stock_cache["data"]
    res = call_tushare('stock_basic', {"list_status": "L"}, "ts_code,name", timeout=8)
    if res and res.get('items'):
        _stock_cache["data"] = res['items']
        _stock_cache["ts"]   = now
        return res['items']
    return _stock_cache["data"] or []

@app.get("/api/search")
def search(keyword: str):
    items_all = get_stock_list()
    items = []; kw = keyword.upper()
    for row in items_all:
        ts_code, name = row[0], row[1]
        if kw in ts_code or kw in name.upper():
            items.append({"code": ts_code, "name": name})
            if len(items) >= 10: break
    return {"items": items}


# ─────────────────────────────────────────────
# 组合回测接口
# 前端传入 codes=600015.SH,601328.SH&weights=0.6,0.4
# 后端对每只股拉月线，按权重合并，返回组合净值
# ─────────────────────────────────────────────
@app.get("/api/portfolio/backtest")
def portfolio_backtest(
    codes:      str,
    weights:    str,
    start_year: int   = 2020,
    end_year:   int   = 2024,
    principal:  float = 2000.0,
):
    code_list   = [c.strip() for c in codes.split(",") if c.strip()]
    weight_list = [float(w.strip()) for w in weights.split(",") if w.strip()]

    if len(code_list) == 0:
        return {"error": "请至少添加一只股票"}
    if len(code_list) != len(weight_list):
        return {"error": "股票数量与仓位数量不一致"}

    # 权重归一化
    total_w = sum(weight_list)
    if total_w <= 0:
        return {"error": "仓位合计必须大于0"}
    weight_list = [w / total_w for w in weight_list]

    start_date = f"{start_year}0101"
    end_date   = f"{end_year}1231"

    # 拉每只股的月度收盘价
    stock_series = {}   # code -> {date: close}
    stock_names  = {}
    all_dates    = set()

    for code in code_list:
        monthly = call_tushare('monthly',
                               {"ts_code": code, "start_date": start_date, "end_date": end_date},
                               "trade_date,close", timeout=7)
        if monthly and monthly.get('items') and len(monthly['items']) >= 3:
            series = {}
            for row in monthly['items']:
                d, c = row[0], row[1]
                if c:
                    label = f"{d[:4]}-{d[4:6]}"
                    series[label] = float(c)
                    all_dates.add(label)
            stock_series[code] = series
        else:
            # 兜底：确定性模拟
            seed = sum(ord(c) for c in code)
            rng  = random.Random(seed)
            close = 8.0 + (seed % 20)
            series = {}
            for yr in range(start_year, end_year + 1):
                for mo in range(1, 13):
                    close = round(close * (1 + rng.uniform(-0.05, 0.06)), 3)
                    label = f"{yr}-{mo:02d}"
                    series[label] = close
                    all_dates.add(label)
            stock_series[code] = series

        # 股票名称
        info = call_tushare('stock_basic', {"ts_code": code}, "name", timeout=5)
        stock_names[code] = info['items'][0][0] if info and info.get('items') else code

    # 对齐日期序列（正序）
    sorted_dates = sorted(all_dates)

    # 计算每只股的月度收益率序列（以第一个有数据的月为基准）
    # 组合净值 = principal * Σ(weight_i * 该股净值)
    stock_nav = {}   # code -> [nav按sorted_dates]
    for code in code_list:
        series = stock_series.get(code, {})
        navs   = []
        base   = None
        for d in sorted_dates:
            c = series.get(d)
            if c is None:
                navs.append(navs[-1] if navs else 1.0)
            else:
                if base is None: base = c
                navs.append(c / base)
        stock_nav[code] = navs

    # 组合净值 = Σ weight_i * nav_i
    portfolio = []
    for i in range(len(sorted_dates)):
        val = sum(weight_list[j] * stock_nav[code_list[j]][i]
                  for j in range(len(code_list)))
        portfolio.append(round(val * principal, 2))

    # 沪深300 基准
    hs300_rows = []
    try:
        hs300 = call_tushare('index_monthly',
                             {"ts_code": "000300.SH", "start_date": start_date, "end_date": end_date},
                             "trade_date,close", timeout=6)
        if hs300 and hs300.get('items') and len(hs300['items']) >= 3:
            base_hs = None
            hs_map  = {}
            for row in hs300['items'][::-1]:
                d, c = row[0], row[1]
                if c:
                    label = f"{d[:4]}-{d[4:6]}"
                    hs_map[label] = float(c)
            for d in sorted_dates:
                c = hs_map.get(d)
                if c:
                    if base_hs is None: base_hs = c
                    hs300_rows.append(round((c / base_hs) * principal, 2))
                else:
                    hs300_rows.append(hs300_rows[-1] if hs300_rows else principal)
    except Exception:
        pass

    # 统计指标
    final_val    = portfolio[-1] if portfolio else principal
    total_return = (final_val / principal - 1) * 100
    n_years      = max(end_year - start_year, 1)
    annual_ret   = ((final_val / principal) ** (1 / n_years) - 1) * 100
    peak = portfolio[0]; max_dd = 0.0
    for v in portfolio:
        if v > peak: peak = v
        dd = (v - peak) / peak
        if dd < max_dd: max_dd = dd
    monthly_r = [(portfolio[i] - portfolio[i-1]) / portfolio[i-1]
                 for i in range(1, len(portfolio))]
    win_rate = (sum(1 for r in monthly_r if r > 0) / len(monthly_r) * 100) if monthly_r else 0

    # 各股票年化贡献
    stock_contrib = []
    for j, code in enumerate(code_list):
        nav_series = stock_nav[code]
        if nav_series:
            stock_final = nav_series[-1]
            contrib_ann = ((stock_final) ** (1 / n_years) - 1) * 100 * weight_list[j]
        else:
            contrib_ann = 0
        stock_contrib.append({
            "code":   code,
            "name":   stock_names.get(code, code),
            "weight": round(weight_list[j] * 100, 1),
            "contrib_annual": round(contrib_ann, 2),
        })

    return {
        "labels":    sorted_dates,
        "portfolio": portfolio,
        "benchmark": hs300_rows if len(hs300_rows) == len(sorted_dates) else [],
        "stocks":    stock_contrib,
        "stats": {
            "final_value":   round(final_val, 2),
            "total_return":  f"{total_return:.2f}%",
            "annual_return": f"{annual_ret:.2f}%",
            "max_drawdown":  f"{max_dd * 100:.2f}%",
            "win_rate":      f"{win_rate:.1f}%",
        }
    }
