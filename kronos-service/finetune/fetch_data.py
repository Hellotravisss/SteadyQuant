# Fetch daily OHLCV for the steady universe (US / CA / A-share / crypto)
# Output: data/<code>.csv with columns timestamps,open,high,low,close,volume,amount
# Sources: Yahoo (overseas+crypto, 5y daily), Tencent (A-shares, ~8y daily, no key needed)
import csv
import json
import os
import time
import urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(OUT, exist_ok=True)

US = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AVGO", "BRK-B", "JPM",
      "V", "UNH", "XOM", "LLY", "COST", "HD", "PG", "NFLX", "AMD", "CRM",
      "KO", "PEP", "WMT", "DIS", "MCD", "CSCO", "INTC", "BA", "SPY", "QQQ"]
CA = ["SHOP.TO", "RY.TO", "TD.TO", "ENB.TO", "CNR.TO", "BN.TO", "CP.TO", "BMO.TO",
      "BNS.TO", "SU.TO", "CNQ.TO", "MFC.TO", "TRI.TO", "ATD.TO", "CSU.TO"]
CRYPTO = ["BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "ADA-USD",
          "DOGE-USD", "AVAX-USD", "LINK-USD", "LTC-USD"]
ASHARE = ["600519.SH", "601318.SH", "600036.SH", "601899.SH", "600900.SH", "601166.SH",
          "600030.SH", "600276.SH", "600887.SH", "601012.SH", "601888.SH", "600809.SH",
          "000858.SZ", "000333.SZ", "002594.SZ", "000651.SZ", "300750.SZ", "002475.SZ",
          "000001.SZ", "002415.SZ", "300059.SZ", "002714.SZ", "000568.SZ", "300760.SZ"]

UA = {"User-Agent": "Mozilla/5.0"}


def get(url, headers=UA, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            if i == retries - 1:
                print(f"  FAILED {url[:80]}: {e}")
                return None
            time.sleep(2)


def write_csv(code, rows):
    if len(rows) < 700:
        print(f"  SKIP {code}: only {len(rows)} rows")
        return False
    path = os.path.join(OUT, code.replace("/", "_") + ".csv")
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["timestamps", "open", "high", "low", "close", "volume", "amount"])
        w.writerows(rows)
    print(f"  OK {code}: {len(rows)} rows")
    return True


def yahoo(code):
    d = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{code}?range=5y&interval=1d")
    try:
        r = d["chart"]["result"][0]
        q = r["indicators"]["quote"][0]
        rows = []
        for i, ts in enumerate(r["timestamp"]):
            c = q["close"][i]
            if c is None:
                continue
            o = q["open"][i] or c
            h = q["high"][i] or c
            lo = q["low"][i] or c
            v = q["volume"][i] or 0
            day = time.strftime("%Y-%m-%d", time.gmtime(ts))
            rows.append([day, round(o, 6), round(h, 6), round(lo, 6), round(c, 6), v, 0])
        return rows
    except Exception:  # noqa: BLE001
        return []


def tencent(code):
    # API 单次约 640 行封顶 → 按 end 日期往前翻页拼 ~5 年
    sym = ("sh" if code.endswith(".SH") else "sz") + code[:6]
    end = time.strftime("%Y-%m-%d")
    all_rows, seen = [], set()
    for _ in range(4):  # 4 页 × ~640 ≈ 10 年，够用
        d = get(
            f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={sym},day,,{end},640,qfq",
            headers={**UA, "Referer": "https://web.ifzq.gtimg.cn/"},
        )
        try:
            node = d["data"][sym]
            rows_in = node.get("qfqday") or node.get("day") or []
        except Exception:  # noqa: BLE001
            break
        page = []
        for r in rows_in:
            day = r[0]
            if day in seen:
                continue
            seen.add(day)
            o, c, h, lo = float(r[1]), float(r[2]), float(r[3]), float(r[4])
            v = float(r[5]) if len(r) > 5 and r[5] else 0
            page.append([day, o, h, lo, c, v, 0])
        if not page:
            break
        all_rows = page + all_rows
        earliest = min(p[0] for p in page)
        end = earliest  # 下一页以最早日期为界继续往前
        time.sleep(0.3)
        if len(all_rows) >= 1300:
            break
    all_rows.sort(key=lambda r: r[0])
    return all_rows


def main():
    ok = 0
    for code in US + CA + CRYPTO:
        print(code)
        ok += write_csv(code, yahoo(code))
        time.sleep(0.5)
    for code in ASHARE:
        print(code)
        ok += write_csv(code, tencent(code))
        time.sleep(0.5)
    print(f"\nDONE: {ok} instruments saved to {OUT}")


if __name__ == "__main__":
    main()
