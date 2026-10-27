# OpenList MCP context

Owns the MCP-facing subset of OpenList virtual file-tree operations, scoped by canonical allowed roots, with authenticated Portal ingress and a Service Binding to the pre-existing `openlist-tsworkers`.

The underlying static OpenList token is admin-equivalent. The adapter's logical root restrictions are not an upstream security principal and do not guarantee isolation of physical mounts or storage aliases.

See [README.md](README.md) for the published tools, blocked candidate capabilities, configuration, and acceptance boundaries. Upstream driver and deployment are intentionally unchanged.
