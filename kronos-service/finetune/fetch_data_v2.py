# V2 reinforced dataset: ~175 instruments, 10y daily bars.
# Same CSV format as fetch_data.py; writes to <script_dir>/data_v2/
import csv
import json
import os
import time
import urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data_v2")
os.makedirs(OUT, exist_ok=True)

US = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AVGO", "BRK-B", "JPM",
      "V", "UNH", "XOM", "LLY", "COST", "HD", "PG", "NFLX", "AMD", "CRM",
      "KO", "PEP", "WMT", "DIS", "MCD", "CSCO", "INTC", "BA", "SPY", "QQQ",
      "ORCL", "ADBE", "QCOM", "TXN", "IBM", "GE", "CAT", "GS", "MS", "BAC",
      "WFC", "C", "T", "VZ", "PFE", "MRK", "ABBV", "TMO", "NKE", "SBUX",
      "LOW", "UPS", "HON", "RTX", "LMT", "DE", "MMM", "GM", "F", "UBER",
      "ABNB", "PYPL", "PLTR", "COIN", "MSTR", "SNOW", "PANW", "ANET", "MU", "LRCX",
      "AMAT", "KLAC", "ASML", "TSM", "SMCI", "DIA", "IWM", "XLF", "XLE", "XLK",
      "GLD", "SLV", "TLT"]
CA = ["SHOP.TO", "RY.TO", "TD.TO", "ENB.TO", "CNR.TO", "BN.TO", "CP.TO", "BMO.TO",
      "BNS.TO", "SU.TO", "CNQ.TO", "MFC.TO", "TRI.TO", "ATD.TO", "CSU.TO",
      "T.TO", "BCE.TO", "CM.TO", "NA.TO", "FTS.TO", "WCN.TO", "DOL.TO", "QSR.TO",
      "L.TO", "MG.TO", "WSP.TO", "CAE.TO", "TFII.TO", "IFC.TO"]
CRYPTO = ["BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "ADA-USD",
          "DOGE-USD", "AVAX-USD", "LINK-USD", "LTC-USD",
          "DOT-USD", "TRX-USD", "SHIB-USD", "BCH-USD", "NEAR-USD", "ATOM-USD"]
ASHARE = ["600519.SH", "601318.SH", "600036.SH", "601899.SH", "600900.SH", "601166.SH",
          "600030.SH", "600276.SH", "600887.SH", "601012.SH", "601888.SH", "600809.SH",
          "000858.SZ", "000333.SZ", "002594.SZ", "000651.SZ", "300750.SZ", "002475.SZ",
          "000001.SZ", "002415.SZ", "300059.SZ", "002714.SZ", "000568.SZ", "300760.SZ",
          "601398.SH", "600028.SH", "601857.SH", "601988.SH", "600000.SH", "601628.SH",
          "601088.SH", "600585.SH", "601601.SH", "600031.SH", "601138.SH",
          "002352.SZ", "300015.SZ", "002304.SZ", "000725.SZ", "002142.SZ",
          "300124.SZ", "000002.SZ", "000625.SZ"]

UA = {"User-Agent": "Mozilla/5.0"}


def get(url, headers=UA, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=25) as r:
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
    d = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{code}?range=10y&interval=1d")
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
    sym = ("sh" if code.endswith(".SH") else "sz") + code[:6]
    end = time.strftime("%Y-%m-%d")
    all_rows, seen = [], set()
    for _ in range(6):  # ~6 x 640 ≈ 15y cap
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
        end = min(p[0] for p in page)
        time.sleep(0.3)
        if len(all_rows) >= 2500:
            break
    all_rows.sort(key=lambda r: r[0])
    return all_rows


def main():
    ok = 0
    for code in US + CA + CRYPTO:
        print(code, flush=True)
        ok += write_csv(code, yahoo(code))
        time.sleep(0.4)
    for code in ASHARE:
        print(code, flush=True)
        ok += write_csv(code, tencent(code))
        time.sleep(0.4)
    print(f"\nDONE: {ok} instruments saved to {OUT}")


if __name__ == "__main__":
    main()
