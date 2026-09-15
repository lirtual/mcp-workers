# MCP Workers Post-Migration Pruning DAG

Spec: `.scratch/mcp-workers-post-migration-pruning/spec.md`

```text
01 -> 08 -> 09 -> 10 -> 11 -> 12 -> 13 --\
                                              \
02 --------------------------------------------\
03 ---------------------------------------------\
04 -----------------------------------------------> 14
05 ---------------------------------------------/
06 --------------------------------------------/
07 -------------------------------------------/
```

## Frontier

Initial unblocked tickets: 01, 02, 03, 04, 05, 06, 07.

## Dependency rules

- 08 is blocked by 01.
- 09 is blocked by 08.
- 10 is blocked by 09.
- 11 is blocked by 10.
- 12 is blocked by 11.
- 13 is blocked by 12.
- 14 is blocked by 02, 03, 04, 05, 06, 07, and 13.
- No production cutover, source-repository retirement, or destructive user-data operation is authorized by these tickets.
