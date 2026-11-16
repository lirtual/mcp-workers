# Raindrop MCP

Personal Raindrop.io MCP for bookmarks, collections, tags and highlights.

The [Skill](skills/raindrop/SKILL.md), MCP tool schemas and tests are the current contract. Preserve Free-plan limits, scoped operations, soft deletion and existing high-impact confirmation boundaries; do not introduce permanent Trash deletion or public-collection exposure through documentation.

The former Clerk read-only pilot at `/clerk/mcp` has been removed from current source. Existing production versions and the standalone Clerk Resource are retired only by a separately authorized deployment/configuration change; see [Spec #878](https://github.com/lirtual/mcp-workers/issues/878).

Deploy only through the existing reviewed **Release Worker** flow; a source change or test run does not update production. The original MIT-licensed source provenance is in [SOURCE.md](SOURCE.md), with its [LICENSE](LICENSE).
