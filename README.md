# QuantPro 量化交易系统 (Vercel 版)

这是一个部署在 Vercel 上的量化交易仪表盘。它通过 FastAPI (Python) 调用 Tushare 2100 积分接口，为用户提供深度价值选股分析。

## 部署说明

### 1. 环境变量配置
在 Vercel 项目设置中，请添加以下环境变量：
- `TUSHARE_TOKEN`: 您的 Tushare API Token (当前已配置为 2100 积分账号)。

### 2. 部署步骤
1. 将此文件夹内容推送到您的 GitHub 仓库。
2. 在 Vercel 中导入该 GitHub 仓库。
3. Vercel 会自动识别 `api/index.py` 并将其作为 Serverless Function 运行。
4. 访问生成的 Vercel URL 即可。

## 技术栈
- **前端**: HTML5, Tailwind CSS, Chart.js (UX Pro Max 风格)
- **后端**: Python FastAPI, Requests
- **数据源**: Tushare Pro (2100 积分)
