# RCA GUI Tool Retirement — Grill With Docs (2026-10-31)

**Status:** Design in progress; no runtime implementation, merge, Agent release, production deployment, device upgrade, or on-device deletion is authorized by this document. Decisions below record Owner's confirmed direction, not the current production state.

**Context:** [Remote Control MCP](./CONTEXT.md), [ADR-0008 curated MCP surface](./adr/0008-curated-mcp-tool-surface.md), [Computer Use Spec #505 — not planned](https://github.com/lirtual/mcp-workers/issues/505), [independent Browser MCP #418](https://github.com/lirtual/mcp-workers/issues/418), and public Agent repository `lirtual/remote-control-agent`.

## Accepted decisions — first round

1. **Q1=A — Retire only the RCA-owned GUI capabilities.** Remove the ten Agent-owned `browser_*` tools and the RCA `computer_*` tool family, including their Worker dispatch, Agent executors, related packaging and active contracts. **Do not retire** the independently deployed Browser MCP #418 Worker, Chrome/Edge extension, distribution, Profile grants or its operational resources. Continue the RCA file, search, Shell, managed-session, device-pairing, signed-WSS and operation-receipt functions.
2. **Q2=A — Clean up RCA-only GUI state, preserving shared identity and evidence.** The intended retirement includes RCA's Agent-private automation Browser Profiles, desktop grant/stop settings and GUI-specific runtime components. Leave existing paired device identities/keys, authorization boundaries, shared local operation receipts and audit history intact. Device-local deletion is a separate destructive action requiring explicit authorization at execution time; do not interpret a design choice as permission to perform it. Do not delete the ordinary owner's Chrome/Edge Profiles or independent Browser MCP Profile state.

## Verified implementation facts (not yet retirement completion)

- `apps/remote-control-mcp-worker/src/browser-tools.ts` registers ten RCA Browser tools; `src/worker.ts` also exposes `computer_status`, `computer_observe` and `computer_stop`. The shared Worker and Durable Object still route these tools.
- `lirtual/remote-control-agent` contains Browser Playwright gateway, optional Windows Browser bundling and private Profile, plus desktop grant, screenshot capture and related Windows CLI paths. Removing public tools alone does not remove those on-device components.
- The existing release archives are versioned historical artifacts; no decision proposes rewriting past immutable releases. Current running Agent versions must be assessed independently of changes in the Worker source.
- Existing `CONTEXT.md` documents the currently/historically active GUI behavior; it is not evidence of removal.

## Still open for subsequent Grill rounds

- Safe compatibility and release order between Worker and Agent; handling of previously advertised MCP tools and historical immutable releases.
- Removal of local GUI CLI, executable dependencies, tests, docs and packaging, while retaining necessary non-GUI security/receipt behavior.
- Production rollout and device-local cleanup verification, keeping the independent Browser MCP unaffected.

**Guardrails:** Do not introduce a new Worker, database, feature flag, parallel migration service, CI pipeline, or compatibility layer merely to retire the GUI tools. Use existing tests and official release workflows. A completed design is not production acceptance.
