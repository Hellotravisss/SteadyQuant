"""
Risk Control Layer (from personal-quant-trading skill)
三大红线：
1. 单笔仓位上限（默认 ≤10%）
2. 总亏损熔断线（默认 15% 就停）
3. 新策略先小资金隔离观察三个月
"""

from datetime import datetime, timedelta
from typing import Dict, Any, List

def risk_control(
    principal: float,
    proposed_position: float,
    current_drawdown: float = 0.0,
    strategy_age_days: int = 999,
    position_limit: float = 0.10,
    max_drawdown_limit: float = 0.15,
    isolation_days: int = 90
) -> Dict[str, Any]:
    """
    风控检查函数
    返回是否通过 + 原因
    """
    reasons = []
    passed = True

    # 1. 单笔仓位上限
    if proposed_position > principal * position_limit:
        passed = False
        reasons.append(f"单笔仓位超限（{proposed_position:.0f} > {principal*position_limit:.0f}）")

    # 2. 总亏损熔断
    if current_drawdown <= -max_drawdown_limit:
        passed = False
        reasons.append(f"触发熔断（回撤 {current_drawdown*100:.1f}% ≥ {max_drawdown_limit*100:.0f}%）")

    # 3. 隔离期
    if strategy_age_days < isolation_days:
        passed = False
        reasons.append(f"策略仍在隔离观察期（{strategy_age_days}天 < {isolation_days}天）")

    return {
        "passed": passed,
        "reasons": reasons,
        "proposed_position": proposed_position,
        "max_allowed": round(principal * position_limit, 2),
        "drawdown": current_drawdown,
        "strategy_age_days": strategy_age_days
    }


def ai_risk_reviewer(
    backtest_stats: Dict[str, Any],
    data_mode: str = "real"
) -> Dict[str, Any]:
    """
    AI 审查员角色（模拟技能中的 Reviewer）
    检查：过拟合、偷看未来、滑点未考虑、胜率异常等
    """
    flags = []
    score = 100

    # 常见问题检查
    if data_mode == "simulated":
        flags.append("数据为模拟生成（PE/dv 随机），真实性低")
        score -= 25

    total_return = backtest_stats.get("total_return", "0%")
    if "模拟" in str(total_return):
        flags.append("回测包含模拟数据，建议降低置信度")
        score -= 15

    win_rate = float(backtest_stats.get("win_rate", "0").replace("%", ""))
    if win_rate > 85:
        flags.append("胜率异常高（>85%），可能存在过拟合或幸存者偏差")
        score -= 20

    max_dd = backtest_stats.get("max_drawdown", "0%")
    if float(max_dd.replace("%", "")) < 5:
        flags.append("最大回撤极低，实盘中几乎不可能，检查是否有 lookahead bias")
        score -= 15

    if not flags:
        flags.append("未发现明显异常，但仍建议小资金实盘验证 3 个月")

    return {
        "review_score": max(0, score),
        "flags": flags,
        "recommendation": "通过" if score >= 70 else "需人工复核后小资金测试",
        "red_line": "AI 绝不能直接下单，所有决策必须经过本风控函数"
    }