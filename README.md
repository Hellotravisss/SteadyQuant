# 省心量化 (SteadyQuant) 量化交易系统 (Vercel 版)

这是一个部署在 Vercel 上的量化交易仪表盘，严格遵循 **5层积木架构**（数据 → 研究 → 回测 → 风控 → 执行）。

## 5层架构（来自 personal-quant-trading 技能）
1. **数据**：Tushare Pro（A股主力） + 可扩展 OpenBB/AkShare
2. **研究**：5因子评分 + TradingAgents 风格多代理报告
3. **回测**：backtesting.py + vectorbt 风格（当前前端+服务端混合）
4. **风控**：三大红线（单笔≤10%、15%熔断、3个月隔离观察）
5. **执行**：Alpaca 模拟盘优先（真实下单必须经过风控）

**AI 角色边界**：研究员 / 程序员 / 审查员（绝不直接下单）

## 部署说明

### 1. 环境变量配置
在 Vercel 项目设置中，请添加以下环境变量：
- `TUSHARE_TOKEN`: 您的 Tushare API Token (当前已配置为 2100 积分账号)。

### 2. 部署步骤
1. 将此文件夹内容推送到您的 GitHub 仓库。
2. 在 Vercel 中导入该 GitHub 仓库。
3. Vercel 会自动识别 `api/index.py` 并将其作为 Serverless Function 运行。
4. 访问生成的 Vercel URL 即可。

- **项目名称**: 省心量化 (SteadyQuant)
- **前端**: HTML5, Tailwind CSS, Chart.js
- **后端**: Python FastAPI, Requests, backtesting
- **数据源**: Tushare Pro (2100 积分)
- **风控红线**: AI 绝不能直接下单；所有指令必须经过写死的风控规则。

**免责声明**：本系统不会让你一夜暴富。普通人与机构的差距主要在于独家数据、执行速度和试错本钱。