# Remote Control MCP — v1 design archive

> Archived to `main` on 2026-10-13 from `docs/remote-desktop-grilling-20261012` to close [spec issue #2](https://github.com/lirtual/mcp-workers/issues/2). No runtime configuration or deployment is changed by this documentation-only archive.

## Current outcome

- **Approved and released:** restricted read-only ChatGPT → Portal → Cloudflare Worker → VPC Service/Tunnel → native Node.js Agent. Evidence and the owner's decision: [T10 release acceptance](./T10-RELEASE-ACCEPTANCE.md) / [issue #12](https://github.com/lirtual/mcp-workers/issues/12).
- **Not approved for production:** Shell (`REMOTE_CONTROL_ENABLE_SHELL=false`); the separate [T11 / issue #14](https://github.com/lirtual/mcp-workers/issues/14) covers privilege and process-ownership/TOCTOU risks.
- **Not approved for production:** file mutation (`REMOTE_CONTROL_ENABLE_FILE_WRITES=false`); this needs an independent approval and must not be inferred from the completed offline tickets.
- **Known limitations:** historical Invocation Logs containing an authorization header were risk-accepted, *not proven erased*; unattended auto-recovery, receipt expiry cleanup in production, and rollback drills remain unverified. See T10 for evidence and limits.

## Documents

- [SPEC.md](./SPEC.md) — canonical v1 design and acceptance criteria, with updated release/gating status.
- [CONTEXT.md](./CONTEXT.md) — accepted product and architecture context.
- [ADR directory](./adr/) — complete numbered decision history. ADR-0003, ADR-0005, ADR-0010 are superseded; ADR-0002 is partially superseded; later decisions prevail. **Do not implement superseded OAuth, container or project-path restrictions.**
- [T10 release evidence](./T10-RELEASE-ACCEPTANCE.md) — actual deployed read-only verification and outstanding risks.

Research and draft specs remain as historical references in the original [design branch](https://github.com/lirtual/mcp-workers/tree/docs%2Fremote-desktop-grilling-20261012/docs/remote-control). They are not canonical implementation instructions.
