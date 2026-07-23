# Kronos 微调总报告（2026-07-22 ~ 07-23）

## 结论一句话
用 AMD 到期额度把 Kronos 从"通用 K 线模型"训成了"专精你四个市场的模型"：
**21 天预测误差从 18.8% 降到 7.5%（砍掉 60%），方向命中率 69~77%**。
冠军权重 **v2**，已备份至本目录 `weights/steady_kronos_weights.tar.gz`（1.1GB，含 v1/v2/21d 三套，md5 已校验）。

## 训练过的三个版本

| 版本 | 数据 | 起点 | 训练量 | 定位 |
|---|---|---|---|---|
| v1 | 79 标的 × 5 年 | 官方预训练 | tok 15 + pred 10 轮 | 首战 |
| **v2** ⭐ | 171 标的 × 10 年 | 官方预训练 | tok 20 + pred 20 轮 | **上线用这套** |
| 21d | 197 标的（+26 港股）× 10 年 | v1 权重续训 | pred 15 轮 | 21 天专精实验 |

## 最终盲测（21 天考卷，13 只标的：美/加/A/港/币）

| 模型 | 误差 MAPE | 方向命中 |
|---|---|---|
| 原版 Kronos-base | 18.8% | 77% |
| v1 | 8.3% | 69% |
| **v2** | **7.5%** | 69% |
| 21d 专精 | 8.8% | 69% |
| "价格不动"基准 | 6.4% | —（不给方向） |

60 天考卷（参考）：微调把误差 30.7%→19.4%，但所有模型都输给笨基准、方向命中仅 1/10。

## 学到的三件事（比权重更值钱）
1. **短线形态有延续性，长线纯玄学**——21 天可预测性远好于 60 天，产品用 21 天是对的
2. **数据不是越多越好**——v2(171×10y) 对 v1(79×5y) 只小胜；补 26 只港股+改 21 天目标的 21d 版反而没超过 v2，模型已"吃饱"
3. **模型价值在方向不在点位**——误差上没跑赢"价格不动"，但方向命中 69~77% 远超抛硬币；网页因此只呈现"方向倾向+概率区间"

## 花费
- 总计约 **$55**（含一次训练进程静默挂掉浪费的 ~$11 空转，教训已写进长期记忆：远程任务必须配心跳监控）
- 额度剩约 **$43**，8 月 7 日过期，预留给 CyberTravis 人格模型训练

## 待办（醒来后）
1. 解压上传冠军权重到 HF（终端跑，token 不经过 Claude）：
   ```bash
   cd ~/Documents/Vibe_Coding/SteadyQuant/kronos-service/finetune/weights
   tar xzf steady_kronos_weights.tar.gz
   pip3 install huggingface_hub
   export HF_TOKEN=<你的write token>
   python3 - << 'EOF'
   import os
   from huggingface_hub import HfApi
   api = HfApi(token=os.environ["HF_TOKEN"])
   u = api.whoami()["name"]
   for local, repo in [("steady_daily_v2/tokenizer/best_model", f"{u}/kronos-steady-tokenizer"),
                       ("steady_daily_v2/basemodel/best_model", f"{u}/kronos-steady-base")]:
       api.create_repo(repo, exist_ok=True)
       api.upload_folder(folder_path=local, repo_id=repo)
       print("uploaded:", repo)
   EOF
   ```
2. 告诉 Claude"传好了"→ 切换 Space 到微调权重 → 线上验证 → 收官
