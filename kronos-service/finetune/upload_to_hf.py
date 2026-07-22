# Upload finetuned Kronos weights to the user's HF account.
# Requires: export HF_TOKEN=<write token>  (create at https://huggingface.co/settings/tokens)
# Creates: Travisss/kronos-steady-tokenizer and Travisss/kronos-steady-base
import os

from huggingface_hub import HfApi

TOKEN = os.environ.get("HF_TOKEN")
assert TOKEN, "export HF_TOKEN=<write token> first"

BASE = "/root/steady-finetune/finetuned/steady_daily_v1"
api = HfApi(token=TOKEN)
user = api.whoami()["name"]
print("uploading as:", user)

for local, repo in [
    (f"{BASE}/tokenizer/best_model", f"{user}/kronos-steady-tokenizer"),
    (f"{BASE}/basemodel/best_model", f"{user}/kronos-steady-base"),
]:
    assert os.path.isdir(local), f"missing {local}"
    api.create_repo(repo, exist_ok=True, repo_type="model")
    api.upload_folder(folder_path=local, repo_id=repo, repo_type="model")
    print("uploaded:", repo)

print("\nDone. Now update the Space app.py:")
print(f'  KronosTokenizer.from_pretrained("{user}/kronos-steady-tokenizer")')
print(f'  Kronos.from_pretrained("{user}/kronos-steady-base")')
print("AND REMEMBER: shut down this droplet now.")
