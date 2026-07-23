#!/bin/bash
# Overnight driver: wait for v1 -> fetch v2 data -> train v2 -> eval all -> package.
# Runs INSIDE the rocm container. Log: /root/stage2.log
set -uo pipefail
BASE=/root/steady-finetune
PKG=/root/finetune-pkg

echo "=== [S2-0] waiting for v1 training to finish ==="
while ! grep -qE "All training completed|Sequential training completed|Basemodel training completed|Training pipeline completed" /root/train_all.log; do
  if grep -q "Training failed" /root/train_all.log && ! pgrep -f train_sequential >/dev/null; then
    echo "v1 marked failed and no process running; continuing with whatever exists"
    break
  fi
  # also break if the training process has exited (whatever the log says)
  if ! pgrep -f train_sequential >/dev/null; then
    echo "train_sequential no longer running; proceeding"
    break
  fi
  sleep 60
done
echo "v1 phase over. best v1 models:"
ls "$BASE/finetuned/steady_daily_v1/tokenizer/best_model" "$BASE/finetuned/steady_daily_v1/basemodel/best_model" 2>/dev/null || echo "(v1 missing!)"

echo "=== [S2-1] fetch v2 data (~175 instruments, 10y) ==="
mkdir -p "$BASE/data_v2"
ln -sfn "$BASE/data_v2" "$PKG/data_v2" 2>/dev/null || true
python3 "$PKG/fetch_data_v2.py" 2>&1 | tail -5
# fetch_data_v2 writes to <script_dir>/data_v2 which is the symlink above
N=$(ls "$BASE/data_v2"/*.csv 2>/dev/null | wc -l)
echo "v2 instruments: $N"
if [ "$N" -lt 100 ]; then
  echo "v2 fetch too thin ($N); falling back to v1 data copy + whatever fetched"
  cp -n "$BASE/data/"*.csv "$BASE/data_v2/" 2>/dev/null || true
fi

echo "=== [S2-2] train v2 (tokenizer 20 + predictor 20 epochs) ==="
cd "$BASE/Kronos/finetune_csv"
cp "$PKG/config_steady_v2.yaml" .
python3 train_sequential.py --config config_steady_v2.yaml 2>&1 | tee /root/train_v2.log | grep -E "Epoch .*completed|Validation Loss|Best model|Error|failed" | tail -200

echo "=== [S2-3] evaluate pretrained vs v1 vs v2 ==="
python3 "$PKG/eval_compare.py" 2>&1 | tail -50

echo "=== [S2-4] package weights for backup ==="
cd /root
tar czf /root/steady_kronos_weights.tar.gz \
  -C "$BASE/finetuned" steady_daily_v1 steady_daily_v2 2>/dev/null \
  || tar czf /root/steady_kronos_weights.tar.gz -C "$BASE/finetuned" steady_daily_v1
ls -lh /root/steady_kronos_weights.tar.gz
cp "$BASE/eval_results.json" /root/eval_results.json 2>/dev/null || true
echo "=== STAGE2 ALL DONE ==="
