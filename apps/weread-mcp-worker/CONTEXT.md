# Domain Context

## WeRead MCP
只读、无状态的 MCP 适配器，将领域级 MCP tools 映射到腾讯官方微信读书 Agent API。

## WeReadClient
唯一拥有腾讯协议细节的模块：API allowlist、Bearer 鉴权、`skill_version`、平铺请求格式、timeout/retry、`upgrade_info` 和稳定错误映射。

## bookId
书籍后续操作的 canonical identifier。只有书名时应先搜索获得 `bookId`。

## Notebook
有个人笔记的书籍概览项。统计笔记总数为 `reviewCount + noteCount + bookmarkCount`。

## Highlight
用户划线的原文。`/user/notebooks` 中对应 `noteCount`，它不是总笔记数。

## Thought / Personal Review
用户自己的想法或点评，对应 `reviewCount` 范畴，可包含关联原文 `abstract` / `range`。

## Bookmark
阅读位置标记。当前官方 Agent API 只提供统计数量，不导出其内容。

## Public Review
其他读者公开点评，与用户个人笔记严格区分。

## Continuation
下一页调用所需的 endpoint-specific 状态，例如 `lastSort`、`synckey`、`maxIdx`、`sessionId`；不是通用 opaque cursor。

## Skill Upgrade Required
腾讯响应包含 `upgrade_info` 时的 fail-closed 状态。不得继续分页或自动忽略。
