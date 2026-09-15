# ADR-0006: Preserve native pagination semantics

Status: Accepted

## Decision
每个 tool 保留真实 continuation 字段，不引入万能 cursor。

## Consequences
调用方需要理解 tool-specific continuation，但避免丢失 `lastSort`、`synckey`、`maxIdx`、`sessionId` 等语义。
