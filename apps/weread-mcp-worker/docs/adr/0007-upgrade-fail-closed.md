# ADR-0007: Skill upgrades fail closed

Status: Accepted

## Decision
上游出现 `upgrade_info` 时立即返回 `WEREAD_SKILL_UPGRADE_REQUIRED`，不重试、不继续分页。

## Consequences
协议升级期间宁可显式失败，也不以旧假设静默产生错误数据。
