from fastapi import FastAPI
from fastapi.responses import HTMLResponse
import requests
import json
import os
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
        return f"<h1>SteadyQuant Backend is Running</h1><p>Frontend file (index.html) not found: {str(e)}</p>"

def call_tushare(api_name, params=None, fields=""):
    url = 'http://api.tushare.pro'
    payload = {"api_name": api_name, "token": TUSHARE_TOKEN, "params": params or {}, "fields": fields}
    try:
        res = requests.post(url, data=json.dumps(payload), headers={'Content-Type': 'application/json'}, timeout=15)
        data = res.json()
        if data.get('code') != 0: return None
        return data.get('data')
    except: return None

@app.get("/api/scan")
def scan(principal: float = 2000.0, risk: str = "stable"):
    daily_basic_data = None
    target_date = ""
    for i in range(1, 10):
        temp_date = (datetime.now() - timedelta(days=i)).strftime('%Y%m%d')
        daily_basic_data = call_tushare('daily_basic', {"trade_date": temp_date}, "ts_code,close,pe,pb,dv_ratio")
        if daily_basic_data and daily_basic_data.get('items'):
            target_date = temp_date
            break
            
    if not daily_basic_data:
        return {"error": "Failed to fetch data"}

    stock_info = call_tushare('stock_basic', {"list_status": "L"}, "ts_code,name")
    name_map = {item[0]: item[1] for item in stock_info['items']} if stock_info else {}

    results = []
    pe_limit = 15 if risk == "stable" else 30
    dv_limit = 4.5 if risk == "stable" else 2.5
    
    for item in daily_basic_data['items']:
        code, close, pe, pb, dv = item
        if close and pe and dv:
            # 筛选逻辑：价格适合1手(100股), 低PE, 高分红
            if 2.0 <= close <= (principal / 100.0) and 0 < pe < pe_limit and dv > dv_limit:
                name = name_map.get(code, "未知")
                score = (dv * 10) + (pe_limit - pe)
                results.append({"code": code, "name": name, "price": close, "pe": pe, "dv": dv, "score": score})
    
    results.sort(key=lambda x: x['score'], reverse=True)
    return {"top_picks": results[:12]}

@app.get("/api/search")
def search(keyword: str):
    res = call_tushare('stock_basic', {"list_status": "L"}, "ts_code,name")
    if not res: return {"items": []}
    items = []
    kw = keyword.upper()
    for item in res['items']:
        if kw in item[0] or kw in item[1]:
            items.append({"code": item[0], "name": item[1]})
            if len(items) >= 8: break
    return {"items": items}

@app.get("/api/backtest")
def backtest(code: str, start_year: int, end_year: int, principal: float):
    start_date = f"{start_year}0101"
    end_date = f"{end_year}1231"
    
    monthly_data = call_tushare('monthly', {"ts_code": code, "start_date": start_date, "end_date": end_date}, "trade_date,close")
    
    perf = []
    labs = []
    if monthly_data and monthly_data.get('items'):
        items = monthly_data['items'][::-1]
        base = items[0][1]
        for it in items:
            labs.append(f"{it[0][:4]}-{it[0][4:6]}")
            perf.append(round((it[1] / base) * principal, 2))
        return {
            "labels": labs,
            "history_performance": perf,
            "total_return": f"{((perf[-1]/principal - 1) * 100):.2f}%"
        }
    
    return {"error": "No data"}
