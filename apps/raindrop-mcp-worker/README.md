# Raindrop MCP

Personal Raindrop.io MCP for bookmarks, collections, tags and highlights.

The [Skill](skills/raindrop/SKILL.md), MCP tool schemas and tests are the current contract. Preserve Free-plan limits, scoped operations, soft deletion and existing high-impact confirmation boundaries; do not introduce permanent Trash deletion or public-collection exposure through documentation.

An optional Clerk read-only pilot at `/clerk/mcp` exposes only `collection_list` with verified Owner, issuer, resource Audience and scope, and returns 404 unless separately configured. The current code and tests define its exact bindings; source support is not production activation.

Deploy only through the existing reviewed **Release Worker** flow; a source change or test run does not update production. The original MIT-licensed source provenance is in [SOURCE.md](SOURCE.md), with its [LICENSE](LICENSE).
