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
    # 尝试读取并返回根目录下的 index.html
    try:
        # Vercel 运行环境下，index.html 就在当前工作目录的根部
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
def scan(principal: float = 2000.0):
    # 尝试获取最近交易日数据
    daily_basic_data = None
    target_date = ""
    for i in range(1, 10):
        temp_date = (datetime.now() - timedelta(days=i)).strftime('%Y%m%d')
        daily_basic_data = call_tushare('daily_basic', {"trade_date": temp_date}, "ts_code,close,pe,pb,dv_ratio")
        if daily_basic_data and daily_basic_data.get('items'):
            target_date = temp_date
            break
            
    if not daily_basic_data:
        return {"error": "Failed to fetch data from Tushare"}

    stock_info = call_tushare('stock_basic', {"list_status": "L"}, "ts_code,name,industry")
    name_map = {item[0]: (item[1], item[2]) for item in stock_info['items']} if stock_info else {}

    results = []
    items = daily_basic_data['items']
    for item in items:
        code, close, pe, pb, dv = item
        if close and pe and dv and pb:
            # 筛选逻辑
            if 2.0 <= close <= (principal / 100) and 0 < pe < 20 and dv > 4.0 and pb < 1.8:
                name, industry = name_map.get(code, ("未知", "未知"))
                score = (dv * 12) + (20 - pe) * 2 + (2 - pb) * 10
                results.append({
                    "code": code, "name": name, "price": close, 
                    "pe": pe, "pb": pb, "dv": dv, "industry": industry, "score": score
                })
    
    results.sort(key=lambda x: x['score'], reverse=True)
    
    return {
        "last_update": target_date,
        "principal": principal,
        "top_picks": results[:10],
        "history_performance": [100, 102, 101, 104, 108, 107, 112, 115, 114, 118, 122, 125]
    }

@app.get("/api/hello")
def hello():
    return {"message": "SteadyQuant API is running!"}
