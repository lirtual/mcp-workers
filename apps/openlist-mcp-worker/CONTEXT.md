# Domain Context

## MCP Identity
The human identity authenticated by Cloudflare Access before the client can invoke `/mcp`.

## OpenList Identity
The single dedicated OpenList account represented by `OPENLIST_TOKEN`. It is intentionally separate from MCP identity.

## Allowed Path
A normalized OpenList path root. Every path-bearing tool validates against `OPENLIST_ALLOWED_PATHS`; copy/move validate both source and destination.

## Read-only Mode
Deployment policy controlled by `OPENLIST_READONLY`. When enabled, mutation tools are not registered.

## Destructive Operation
An operation that removes/cancels persistent state. V1 destructive operations require `confirm=true`, but confirmation is not an authorization boundary.

## Small-file Upload
A base64 MCP upload bounded by `OPENLIST_UPLOAD_MAX_BYTES`, default 5 MiB decoded. V1 does not chunk, stage in R2, or proxy large files.

## OpenList Task
An async task owned by OpenList itself. This is not the MCP Tasks protocol feature.

## Invariants
- Worker remains stateless for MCP transport.
- No arbitrary user-supplied upstream origin is fetched.
- Download bodies never transit the Worker.
- No recursive filesystem aggregation in V1.
- Sensitive tokens, Access assertions, upload contents and raw download URLs must not be logged.
