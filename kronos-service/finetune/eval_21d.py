# Holdout evaluation: pretrained vs finetuned (v1/v2) Kronos on the LAST 60 days
# (never part of any train split's prediction targets... v1/v2 val used walk-forward
# tails, so this is a fair comparison of relative skill, not an absolute benchmark).
# Metrics per model, averaged over test tickers:
#   - MAPE% of predicted close path vs actual
#   - terminal direction hit (sign of 60d move)
# Baseline: naive "price stays flat".
import json
import os
import sys

sys.path.insert(0, "/root/steady-finetune/Kronos")

import numpy as np
import pandas as pd

from model import Kronos, KronosTokenizer, KronosPredictor  # noqa: E402

DATA = "/root/steady-finetune/data_v2"
if not os.path.isdir(DATA):
    DATA = "/root/steady-finetune/data"
TEST = ["NVDA", "AAPL", "SPY", "SHOP.TO", "RY.TO", "BTC-USD", "ETH-USD",
        "600519.SH", "300750.SZ", "000858.SZ", "0700.HK", "9988.HK", "3690.HK"]
H = 21
LOOK = 512

MODELS = {
    "pretrained": ("/root/steady-finetune/pretrained/Kronos-Tokenizer-base",
                   "/root/steady-finetune/pretrained/Kronos-base"),
    "v1": ("/root/steady-finetune/finetuned/steady_daily_v1/tokenizer/best_model",
           "/root/steady-finetune/finetuned/steady_daily_v1/basemodel/best_model"),
    "v2": ("/root/steady-finetune/finetuned/steady_daily_v2/tokenizer/best_model",
           "/root/steady-finetune/finetuned/steady_daily_v2/basemodel/best_model"),
    "21d": ("/root/steady-finetune/finetuned/steady_daily_21d/tokenizer/best_model",
            "/root/steady-finetune/finetuned/steady_daily_21d/basemodel/best_model"),
}

results = {}
for name, (tok_path, mdl_path) in MODELS.items():
    if not (os.path.isdir(tok_path) and os.path.isdir(mdl_path)):
        print(f"skip {name}: weights not found")
        continue
    tok = KronosTokenizer.from_pretrained(tok_path)
    mdl = Kronos.from_pretrained(mdl_path)
    pred = KronosPredictor(mdl, tok, device="cuda:0", max_context=LOOK)
    mapes, hits, naive_mapes = [], [], []
    for code in TEST:
        fp = os.path.join(DATA, code + ".csv")
        if not os.path.exists(fp):
            continue
        df = pd.read_csv(fp)
        df["timestamps"] = pd.to_datetime(df["timestamps"])
        df = df.sort_values("timestamps").reset_index(drop=True)
        if len(df) < LOOK + H + 5:
            continue
        hist = df.iloc[-(LOOK + H):-H]
        actual = df["close"].iloc[-H:].to_numpy()
        x_df = hist[["open", "high", "low", "close", "volume"]].copy()
        x_ts = pd.Series(hist["timestamps"].values)
        y_ts = pd.Series(df["timestamps"].iloc[-H:].values)
        # average 5 sampled paths for a stable point estimate
        paths = []
        for _ in range(5):
            p = pred.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts,
                             pred_len=H, T=1.0, top_p=0.9, sample_count=1)
            paths.append(p["close"].to_numpy())
        est = np.mean(np.stack(paths), axis=0)
        last = hist["close"].iloc[-1]
        mapes.append(float(np.mean(np.abs(est - actual) / actual)) * 100)
        naive_mapes.append(float(np.mean(np.abs(last - actual) / actual)) * 100)
        hits.append(int(np.sign(est[-1] - last) == np.sign(actual[-1] - last)))
        print(f"  [{name}] {code}: mape={mapes[-1]:.2f}% naive={naive_mapes[-1]:.2f}% "
              f"dir_hit={hits[-1]}", flush=True)
    results[name] = {
        "mape_avg": round(float(np.mean(mapes)), 3),
        "naive_mape_avg": round(float(np.mean(naive_mapes)), 3),
        "direction_hit_rate": round(float(np.mean(hits)), 3),
        "n_tickers": len(mapes),
    }

with open("/root/steady-finetune/eval_results_21d.json", "w") as f:
    json.dump(results, f, indent=2)
print(json.dumps(results, indent=2))
