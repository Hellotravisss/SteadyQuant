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
        return f"<h1>SteadyQuant Backend is Running</h1><p>index.html not found: {str(e)}</p>"

def call_tushare(api_name, params=None, fields=""):
    url = 'http://api.tushare.pro'
    payload = {"api_name": api_name, "token": TUSHARE_TOKEN, "params": params or {}, "fields": fields}
    try:
        res = requests.post(url, data=json.dumps(payload),
                            headers={'Content-Type': 'application/json'}, timeout=20)
        data = res.json()
        if data.get('code') != 0:
            return None
        return data.get('data')
    except Exception:
        return None


@app.get("/api/scan")
def scan(principal: float = 2000.0, risk: str = "stable"):
    """
    选股逻辑（修正版）：
    - 本金决定的是"每手（100股）买入成本上限"，即 最高单价 = principal / 100
      例：本金 2000 → 最高股价 20 元；本金 10000 → 最高股价 100 元
    - 但为了保证至少能买 1 手，上限做硬性截断：最低 3 元，最高 50 元
    - 风险偏好影响 PE / 股息率门槛
    """
    max_price = min(max(principal / 100.0, 3.0), 50.0)   # 单价上限
    min_price = 2.0

    pe_limit  = 15.0 if risk == "stable" else 25.0
    dv_min    = 4.0  if risk == "stable" else 2.5
    pb_limit  = 2.0  if risk == "stable" else 3.5

    # 拉最近有效交易日数据
    daily_data = None
    trade_date = ""
    for i in range(1, 10):
        d = (datetime.now() - timedelta(days=i)).strftime('%Y%m%d')
        daily_data = call_tushare('daily_basic', {"trade_date": d},
                                  "ts_code,close,pe,pb,dv_ratio")
        if daily_data and daily_data.get('items'):
            trade_date = d
            break

    if not daily_data:
        return {"error": "Tushare 数据获取失败，请稍后再试", "top_picks": []}

    # 股票名称映射
    info = call_tushare('stock_basic', {"list_status": "L"}, "ts_code,name")
    name_map = {row[0]: row[1] for row in info['items']} if info else {}

    results = []
    for row in daily_data['items']:
        code, close, pe, pb, dv = row
        # 过滤空值
        if close is None or pe is None or dv is None or pb is None:
            continue
        if not (min_price <= close <= max_price):
            continue
        if not (0 < pe < pe_limit):
            continue
        if dv < dv_min:
            continue
        if pb > pb_limit:
            continue
        name = name_map.get(code, "未知")
        # 综合评分：股息权重最高
        score = round(dv * 12 + (pe_limit - pe) * 1.5 + (pb_limit - pb) * 5, 2)
        results.append({
            "code": code,
            "name": name,
            "price": round(close, 2),
            "pe":    round(pe, 2),
            "pb":    round(pb, 2),
            "dv":    round(dv, 4),
            "score": score
        })

    results.sort(key=lambda x: x['score'], reverse=True)

    return {
        "trade_date": trade_date,
        "principal":  principal,
        "max_price":  max_price,
        "risk":       risk,
        "top_picks":  results[:12]
    }


@app.get("/api/backtest")
def backtest(code: str, start_year: int = 2021, end_year: int = 2024, principal: float = 2000.0):
    """
    回测逻辑（修正版）：
    1. 优先用 Tushare monthly 接口拉真实月线
    2. 若接口无权限或无数据，用确定性模拟（seed = code）给出合理波动曲线
    3. 保证 labels 和 history_performance 始终有值
    """
    start_date = f"{start_year}0101"
    end_date   = f"{end_year}1231"

    monthly = call_tushare('monthly',
                           {"ts_code": code, "start_date": start_date, "end_date": end_date},
                           "trade_date,close")

    labels = []
    perf   = []

    if monthly and monthly.get('items') and len(monthly['items']) > 0:
        # 真实数据路径：Tushare 返回倒序，翻转为正序
        items = monthly['items'][::-1]
        base  = items[0][1] if items[0][1] else 1.0
        for row in items:
            date_str, close = row
            if close is None:
                continue
            labels.append(f"{date_str[:4]}-{date_str[4:6]}")
            perf.append(round((close / base) * principal, 2))

    # 模拟数据路径（Tushare 无数据时兜底，保证曲线可见）
    if len(perf) < 3:
        seed = sum(ord(c) for c in code)
        rng  = random.Random(seed)
        # 根据股票代码决定基准年化收益（8%~18%之间，确定性）
        base_return = 0.08 + (seed % 100) / 1000.0  # 8%~18%

        labels = []
        perf   = [principal]
        current = principal
        for yr in range(start_year, end_year + 1):
            for mo in range(1, 13):
                monthly_r = base_return / 12 + rng.uniform(-0.025, 0.035)
                current   = round(current * (1 + monthly_r), 2)
                labels.append(f"{yr}-{mo:02d}")
                perf.append(current)

    final_val   = perf[-1]
    total_pct   = f"{((final_val / principal - 1) * 100):.2f}%"
    is_simulated = not (monthly and monthly.get('items') and len(monthly['items']) > 0)
    if is_simulated:
        total_pct += " (模拟)"

    # 股票名称
    info = call_tushare('stock_basic', {"ts_code": code}, "name")
    name = "未知个股"
    if info and info.get('items'):
        name = info['items'][0][0]

    return {
        "code":                code,
        "name":                name,
        "labels":              labels,
        "history_performance": perf,
        "total_return":        total_pct,
        "final_value":         final_val
    }


@app.get("/api/search")
def search(keyword: str):
    res = call_tushare('stock_basic', {"list_status": "L"}, "ts_code,name")
    if not res:
        return {"items": []}
    items = []
    kw = keyword.upper()
    for row in res['items']:
        ts_code, name = row
        if kw in ts_code or kw in name.upper():
            items.append({"code": ts_code, "name": name})
            if len(items) >= 8:
                break
    return {"items": items}
