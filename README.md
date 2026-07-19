# steady · 定风波（原 SteadyQuant / 省心量化）

这是一个部署在 Vercel 上的量化交易仪表盘，严格遵循 **5层积木架构**（数据 → 研究 → 回测 → 风控 → 执行）。

## 5层架构（来自 personal-quant-trading 技能）
1. **数据**：Tushare Pro（A股主力） + 可扩展 OpenBB/AkShare
2. **研究**：5因子评分 + TradingAgents 风格多代理报告
3. **回测**：backtesting.py + vectorbt 风格（当前前端+服务端混合）
4. **风控**：三大红线（单笔≤10%、15%熔断、3个月隔离观察）
5. **执行**：Alpaca 模拟盘优先（真实下单必须经过风控）

**AI 角色边界**：研究员 / 程序员 / 审查员（绝不直接下单）

## Serenity 供应链卡点模块（v5 新增）

融合两个 GitHub skill 的方法论落地为可用功能：
- [serenity-bottleneck-hunter](https://github.com/Mrjie7205/serenity-bottleneck-hunter)：水位标尺、二轴判定、证伪条件、价格纪律
- [BestSerenitySkillFromAT](https://github.com/yux1azhengye/BestSerenitySkillFromAT)：九步工作流、9条卡点判据、红旗扫描、反确认偏误

| 功能 | 说明 | 依赖 |
|---|---|---|
| 🎯 卡点体检 | 真实价格算水位/动量/stage + 红旗自动扫描 + 判据打分 + 二轴🟢🟡🔴判定 + 机器可读证伪条件 | 仅 Tushare |
| 👁️ 观察池 | 入池记录入场价/止损线，每次打开自动检查证伪是否触发 | 仅 Tushare（数据存浏览器 localStorage） |
| 🧠 AI 深度报告 | 主题→供应链逆向拆链→上游卡点候选→红队四问→证伪条件，流式输出 | 需 `ANTHROPIC_API_KEY` |

## 部署说明

### 1. 环境变量配置
在 Vercel 项目设置中，请添加以下环境变量：
- `TUSHARE_TOKEN`: 您的 Tushare API Token (当前已配置为 2100 积分账号)。
- `DEEPSEEK_API_KEY`（推荐）或 `ANTHROPIC_API_KEY`: 用于「帮我找股票」AI 功能，配一个即可（优先用 DeepSeek）；不配置时其余功能不受影响。

### 三市场支持
- **A股**：Tushare（名称搜索 + 估值 + 红旗全量）
- **美股**：直接输代码（AAPL / NVDA），行情走 Yahoo 免 key；大盘对照标普500
- **加拿大**：代码加 `.TO`（SHOP.TO / RY.TO）；大盘对照多伦多综指

### 2. 部署步骤
1. 将此文件夹内容推送到您的 GitHub 仓库。
2. 在 Vercel 中导入该 GitHub 仓库。
3. Vercel 会自动识别 `api/index.py` 并将其作为 Serverless Function 运行。
4. 访问生成的 Vercel URL 即可。

- **项目名称**: steady · 定风波（steady.lowbattery.studio）
- **前端**: HTML5, Tailwind CSS, Chart.js
- **后端**: Python FastAPI, Requests, backtesting
- **数据源**: Tushare Pro (2100 积分)
- **风控红线**: AI 绝不能直接下单；所有指令必须经过写死的风控规则。

**免责声明**：本系统不会让你一夜暴富。普通人与机构的差距主要在于独家数据、执行速度和试错本钱。