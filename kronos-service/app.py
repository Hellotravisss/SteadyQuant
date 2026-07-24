# Kronos inference service for steady.lowbattery.studio
# Target: Hugging Face Space (Gradio SDK, ZeroGPU). Model: NeoQuasar/Kronos-small (24.7M)
# Input: recent OHLC daily bars as JSON. Output: p10/p50/p90 quantiles of sampled future paths.
# Call protocol (gradio two-step REST):
#   POST /gradio_api/call/forecast  {"data": ["<request JSON string>"]}  -> {"event_id": "..."}
#   GET  /gradio_api/call/forecast/<event_id>                           -> SSE, data: ["<result JSON string>"]
# NOTE: experimental forecast, NOT investment advice; frontend must show a disclaimer.
import json
import os
import subprocess
import sys

# ZeroGPU requires `spaces` imported before torch, and at least one @spaces.GPU function.
try:
    import spaces
except ImportError:
    spaces = None

# Kronos model code is not on PyPI -- clone the official repo at startup
KRONOS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kronos_repo")
if not os.path.isdir(os.path.join(KRONOS_DIR, "model")):
    subprocess.run(
        ["git", "clone", "--depth", "1", "https://github.com/shiyu-coder/Kronos.git", KRONOS_DIR],
        check=True,
    )
sys.path.insert(0, KRONOS_DIR)

import gradio as gr
import numpy as np
import pandas as pd

from model import Kronos, KronosTokenizer, KronosPredictor  # noqa: E402

MAX_CTX = 512
PRED_MAX = 60
SAMPLES = int(os.environ.get("KRONOS_SAMPLES", "8"))

# 微调权重 v2（171标的×10年，21天盲测误差 7.5% vs 原版 18.8%）；环境变量可覆盖回退官方权重
TOK_REPO = os.environ.get("KRONOS_TOKENIZER", "Travisss/kronos-steady-tokenizer")
MDL_REPO = os.environ.get("KRONOS_MODEL", "Travisss/kronos-steady-base")
print(f"loading {MDL_REPO} ...", flush=True)
tokenizer = KronosTokenizer.from_pretrained(TOK_REPO)
model = Kronos.from_pretrained(MDL_REPO)
print("model ready", flush=True)


def _sample_paths(x_df, x_ts, y_ts, pred_len):
    """Run SAMPLES stochastic forecasts; on ZeroGPU this runs on GPU, else CPU."""
    device = "cuda:0" if spaces is not None else "cpu"
    predictor = KronosPredictor(model, tokenizer, device=device, max_context=MAX_CTX)
    paths = []
    for _ in range(SAMPLES):
        pred = predictor.predict(
            df=x_df, x_timestamp=x_ts, y_timestamp=y_ts,
            pred_len=pred_len, T=1.0, top_p=0.9, sample_count=1,
        )
        paths.append(pred["close"].to_numpy())
    return np.stack(paths)


if spaces is not None:
    _sample_paths = spaces.GPU(duration=120)(_sample_paths)


def forecast(payload: str) -> str:
    """payload: {"bars":[{date,open?,high,low,close,volume?}...], "pred_len":21}"""
    try:
        req = json.loads(payload)
        bars = req.get("bars") or []
        pred_len = min(max(int(req.get("pred_len", 21)), 1), PRED_MAX)
        if len(bars) < 64:
            return json.dumps({"ok": False, "reason": "too_short"})
        bars = bars[-MAX_CTX:]

        df = pd.DataFrame(bars)
        df["date"] = pd.to_datetime(df["date"].astype(str).str.replace("-", ""), format="%Y%m%d")
        df = df.sort_values("date").reset_index(drop=True)
        for col in ("high", "low", "close"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df = df.dropna(subset=["close"])
        # missing open -> previous close (some data sources only provide HLC)
        if "open" not in df or df["open"].isna().any():
            df["open"] = pd.to_numeric(df.get("open"), errors="coerce")
            df["open"] = df["open"].fillna(df["close"].shift(1)).fillna(df["close"])
        x_df = df[["open", "high", "low", "close"]].copy()
        if "volume" in df and df["volume"].notna().all():
            x_df["volume"] = pd.to_numeric(df["volume"], errors="coerce")
        x_ts = pd.Series(df["date"])
        y_ts = pd.Series(
            pd.date_range(start=df["date"].iloc[-1], periods=pred_len + 1, freq="B")[1:]
        )

        # temperature sampling x N -> probabilistic paths (band, not a point estimate)
        arr = _sample_paths(x_df, x_ts, y_ts, pred_len)
        q = lambda p: np.round(np.quantile(arr, p, axis=0), 4).tolist()  # noqa: E731
        return json.dumps({
            "ok": True,
            "dates": [d.strftime("%Y%m%d") for d in y_ts],
            "p10": q(0.10), "p50": q(0.50), "p90": q(0.90),
            "samples": SAMPLES,
            "last_close": float(df["close"].iloc[-1]),
            "note": "experimental forecast, not investment advice",
        })
    except Exception as e:  # noqa: BLE001
        return json.dumps({"ok": False, "reason": "service_error", "detail": str(e)})


demo = gr.Interface(
    fn=forecast,
    inputs=gr.Textbox(label="request JSON ({bars:[...], pred_len:21})", lines=8),
    outputs=gr.Textbox(label="forecast JSON"),
    title="kronos-service",
    description="K-line probabilistic forecast for steady.lowbattery.studio - "
                "experimental, not investment advice",
    api_name="forecast",
    flagging_mode="never",
)
demo.queue(max_size=8).launch()
