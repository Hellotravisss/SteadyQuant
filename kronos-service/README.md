---
title: kronos-service
emoji: 🔮
colorFrom: red
colorTo: yellow
sdk: gradio
sdk_version: 5.49.1
app_file: app.py
pinned: false
---

# Kronos 推理服务（steady 专用）

给 steady.lowbattery.studio 提供 K 线概率预测的后端。模型：[Kronos-small](https://huggingface.co/NeoQuasar/Kronos-small)（24.7M 参数，MIT 协议，CPU 可跑）。

## 部署（Hugging Face Space · Gradio SDK · 免费 CPU）

1. New Space → SDK 选 **Gradio**（Docker 现在要付费，Gradio 免费）→ Blank 模板 → CPU basic → Public
2. 上传本目录的 `app.py` / `requirements.txt` / `README.md`（README 顶部的 frontmatter 会配置 Space）
3. 等构建完成（首次约 10 分钟：装 torch + clone Kronos 仓库 + 下载模型权重）
4. 回 SteadyQuant 仓库配置地址：
   ```bash
   npx wrangler secret put KRONOS_API_URL
   # 粘贴 https://<用户名>-kronos-service.hf.space
   ```
5. `npx wrangler deploy` — 查股页自动出现「Kronos 预测」按钮

## API 协议（gradio 两步 REST）

```
POST {base}/gradio_api/call/forecast   body: {"data": ["{\"bars\":[...],\"pred_len\":21}"]}
  → {"event_id": "..."}
GET  {base}/gradio_api/call/forecast/{event_id}
  → SSE 流，最后一行 data: ["{...结果JSON...}"]
```

## 权重私有时的配置

微调权重仓库设为 Private 后，Space 需要读取令牌：
1. https://huggingface.co/settings/tokens 创建一个 **Read** token
2. Space Settings → Variables and secrets → New **secret**，Name 填 `HF_TOKEN`，Value 粘贴 token
3. Space 自动重启后即可读取私有权重

## 注意

- 免费 CPU 一次预测（8 条路径 × 21 天）约 1~2 分钟；Space 休眠后首次调用要再等约 1 分钟冷启动
- 输出是 p10/p50/p90 分位区间，不是单点——呈现时永远带免责声明
