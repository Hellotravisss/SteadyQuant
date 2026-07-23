#!/bin/bash
# Final driver: wait 21d training -> 21-day-horizon eval (4 models) -> repackage all weights
set -uo pipefail
echo "=== [S3-0] waiting for 21d training ==="
while pgrep -f "config_steady_21d" >/dev/null; do sleep 60; done
echo "21d training process ended"
grep -E "completed! Best|Training completed" /root/train_21d.log | tail -2
echo "=== [S3-1] eval at 21-day horizon ==="
python3 /root/finetune-pkg/eval_21d.py 2>&1 | tail -60
echo "=== [S3-2] repackage all weights ==="
cd /root
tar czf /root/steady_kronos_weights.tar.gz -C /root/steady-finetune/finetuned steady_daily_v1 steady_daily_v2 steady_daily_21d 2>/dev/null || tar czf /root/steady_kronos_weights.tar.gz -C /root/steady-finetune/finetuned steady_daily_v1 steady_daily_v2
ls -lh /root/steady_kronos_weights.tar.gz
cp /root/steady-finetune/eval_results_21d.json /root/ 2>/dev/null || true
echo "=== STAGE3 ALL DONE ==="
