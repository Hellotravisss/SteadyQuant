#!/bin/bash
# One-shot Kronos finetune on AMD MI300X (ROCm). Run as root on the droplet:
#   bash run_all.sh
# Steps: deps -> clone Kronos -> patch multi-CSV dataset -> download pretrained
#        -> fetch market data -> train (tokenizer + predictor) -> print upload hint
# COST DISCIPLINE: shut the droplet down as soon as training + upload finish!
set -euo pipefail

BASE=/root/steady-finetune
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$BASE"

echo "=== [1/6] python deps ==="
python3 -c "import torch; print('torch', torch.__version__, 'gpu:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"
pip install -q pandas numpy einops safetensors huggingface_hub matplotlib tqdm pyyaml comet_ml

echo "=== [2/6] clone Kronos ==="
[ -d "$BASE/Kronos" ] || git clone --depth 1 https://github.com/shiyu-coder/Kronos.git "$BASE/Kronos"

echo "=== [3/6] patch multi-CSV dataset ==="
cp "$HERE/multi_dataset.py" "$BASE/Kronos/finetune_csv/"
# rename original class and import ours in its place (single surgical line)
sed -i 's/^class CustomKlineDataset(Dataset):/from multi_dataset import CustomKlineDataset\nclass _OrigCustomKlineDataset(Dataset):/' \
    "$BASE/Kronos/finetune_csv/finetune_base_model.py"
grep -q "from multi_dataset import CustomKlineDataset" "$BASE/Kronos/finetune_csv/finetune_base_model.py" && echo "patch OK"

echo "=== [4/6] download pretrained (base, 102M) ==="
python3 - << 'EOF'
from huggingface_hub import snapshot_download
snapshot_download("NeoQuasar/Kronos-Tokenizer-base", local_dir="/root/steady-finetune/pretrained/Kronos-Tokenizer-base")
snapshot_download("NeoQuasar/Kronos-base", local_dir="/root/steady-finetune/pretrained/Kronos-base")
print("pretrained ready")
EOF

echo "=== [5/6] fetch market data (~79 instruments, 5y daily) ==="
mkdir -p "$BASE/data"
# fetch_data.py writes to <script_dir>/data — symlink it to $BASE/data
ln -sfn "$BASE/data" "$HERE/data"
python3 "$HERE/fetch_data.py"
N=$(ls "$BASE/data"/*.csv 2>/dev/null | wc -l)
echo "instruments: $N"
[ "$N" -ge 40 ] || { echo "TOO FEW instruments, aborting"; exit 1; }

echo "=== [6/6] train (tokenizer then predictor) ==="
cd "$BASE/Kronos/finetune_csv"
cp "$HERE/config_steady.yaml" .
python3 train_sequential.py --config config_steady.yaml 2>&1 | tee "$BASE/train.log"

echo ""
echo "=== DONE. Best models: ==="
ls -la "$BASE/finetuned/steady_daily_v1/tokenizer/best_model/" "$BASE/finetuned/steady_daily_v1/basemodel/best_model/" || true
echo ""
echo "Next: export HF_TOKEN=<your write token>   (create at https://huggingface.co/settings/tokens)"
echo "Then: python3 $HERE/upload_to_hf.py"
echo "FINALLY: SHUT DOWN THIS DROPLET (billing is per hour while powered on)."
