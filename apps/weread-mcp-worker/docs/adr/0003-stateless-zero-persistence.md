# ADR-0003: Stateless and zero persistence

Status: Accepted

## Decision
Worker 不持久化用户阅读数据，不引入 D1、KV、R2、Durable Objects、Queue、Cron。

## Consequences
每次 tool call 独立执行；跨页状态由调用方显式传 continuation。
