# WeRead tracer-bullet migration record

Ticket: `#02`  
Source repository: `lirtual/weread-mcp-worker`  
Frozen source commit: `8ab71db46b0298f3776a03fe48ffd49000477db4`  
Target app: `apps/weread-mcp-worker`

## Snapshot result

The 26 files from the frozen source tree were copied into `apps/weread-mcp-worker/` without modifying their contents. `SOURCE.md` is the only new app-local provenance file.

Git object verification confirmed that every copied source file has the same blob SHA as the frozen source. The copied `src/`, `test/`, `docs/adr/`, and nested `.github/workflows/` content therefore preserves the source snapshot byte-for-byte.

No dependency, SDK, TypeScript, Wrangler, compatibility date, auth flow, tool name/schema, or formatting change was made.

## Contract verification

Static contract result: **Pass**.

- `src/server.ts` blob remains `913ba21952b68924df02c18466ca90e54b2d61d0`.
- The frozen 10-tool registration source is unchanged.
- `package.json` remains `19aeb79f97195053310a3ca3c55ba7f744a8c127`.
- `wrangler.jsonc` remains `fdac63f718e9dd8b836efe386d70e0b616d31793`.

Live MCP `tools/list`: **Not run** until the target Worker can be built/deployed and Portal tested.

## Local verification

A temporary local verification directory was reconstructed from the same verified blobs.

Passed:

- Source hash check for package/config/runtime/test files.
- Dependency-free TypeScript compile using available TypeScript 5.8.3.
- Existing core protocol suite: **10/10 passing**.
- Standalone strict typecheck of `src/origin-auth.ts`.

Blocked by execution environment:

- `npm install --no-audit --no-fund` could not reach `registry.npmjs.org`; npm reported `EAI_AGAIN` and the command timed out.
- Because dependencies could not be installed, full `npm run check`, `npm run test:mcp`, and `wrangler deploy --dry-run` are **Not run** here.
- No GitHub Actions run/status exists for the frozen source commit, so CI is not used as substitute evidence.

## Cloudflare / Portal acceptance

Status: **Blocked — management surface unavailable in this session**.

Still required before ticket completion:

1. Configure the existing `weread-mcp-worker` Cloudflare Build to use repository `lirtual/mcp-workers` and Root Directory `apps/weread-mcp-worker`.
2. Ensure the old repository is no longer an active automatic production publishing source before enabling the new source, so there is never a dual publisher.
3. Preserve the current Worker name, route/custom hostname, secrets, compatibility date, and existing Portal/Gateway auth semantics.
4. Confirm Cloudflare Build succeeds.
5. Confirm direct MCP authentication behavior still matches the baseline.
6. Confirm Portal discovers the same 10 tools.
7. Run one explicitly safe read-only Portal call, preferably `weread_get_bookshelf`.
8. Review logs for credential leakage.

## Rollback

If the new source fails before acceptance:

1. Disable the new monorepo Build source for `weread-mcp-worker`.
2. Restore the previous Build source to `lirtual/weread-mcp-worker` at frozen commit `8ab71db46b0298f3776a03fe48ffd49000477db4` (or the exact previously deployed known-good commit if Cloudflare records show a different production source).
3. Keep the existing Worker name, routes/custom hostname, secrets and bindings unchanged.
4. Rebuild/redeploy from that known-good source and repeat direct MCP + Portal smoke checks.

Do not rotate or paste secret values as part of rollback unless a credential itself is the incident cause.

## License/provenance

The frozen WeRead source contains no root `LICENSE` file and no `license` field in `package.json`. This remains an explicit archival blocker, not something invented or silently fixed during snapshot migration.
