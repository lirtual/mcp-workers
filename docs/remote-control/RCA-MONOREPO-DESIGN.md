# RCA Monorepo consolidation — Grill With Docs decision record

**Status:** Design in progress; Q1 accepted (2026-11-10). Q2–Q4 and dependent migration/acceptance decisions are open. This document records *design only*. It authorizes no implementation, merge, GitHub Release, Worker deployment, device upgrade, pairing, configuration or credential change.

## Purpose and current facts

- `lirtual/mcp-workers` already owns the `apps/remote-control-mcp-worker` Cloudflare Worker and the canonical `docs/remote-control/CONTEXT.md` bounded context.
- `lirtual/remote-control-agent` separately owns native Agent source, five-target candidate CI, immutable GitHub Release artifacts, and installer/upgrade source.
- Current Worker CI stages a pinned public Agent commit into `apps/remote-control-agent` using `scripts/stage-public-remote-control-agent.sh`; release verification therefore crosses repositories.
- Browser MCP has Worker and browser-extension source in one repository. This is a source-management precedent, **not** a reason to unify runtime or production authority.
- Existing devices use signed WSS, owner grants, durable operation receipts, and owner-controlled upgrades. The move must not invalidate these semantics or historical audit records.

## Decisions

### Q1 — Consolidation boundary: **A (accepted)**

**Decision:** Consolidate Agent **source and engineering management** into the `mcp-workers` monorepo. Preserve the distinct Agent runtime, native distribution artifact, Worker runtime, release approvals, and device-upgrade authority. Do not require lockstep Agent/Worker versions or add a new service/orchestrator.

**Why:** Removes duplicated workspace management and the cross-repository pinned-source staging loop while permitting review of Agent/Worker compatibility from the same source revision. Alternative B (fully coupled runtime/version/release) adds unnecessary operational coupling. Alternative C (keep two source repos with synchronization) retains the source-management overhead.

**Release boundary:** A source merge must not by itself publish a Worker, publish an Agent Release, or upgrade a device. Preserve existing authenticity and immutable-asset checks; keep signed pairing identity, stop state, receipts, Unknown/no-replay, and rollback behavior unchanged.

## Second-round design frontier (not yet decided)

- **Q2 — Directory ownership:** Keep `apps/remote-control-agent/` as a peer of `apps/remote-control-mcp-worker/` (recommended, minimal existing-path churn), or nest Agent under the Worker.
- **Q3 — New Release location:** Put *new* native Agent Releases under `mcp-workers` while keeping all existing artifacts at their original immutable URLs (recommended), or continue publishing Agent Releases at the legacy repository.
- **Q4 — Git history migration:** Import the current Agent source snapshot into `mcp-workers` and preserve old Git history by retaining the old read-only repository/links (recommended), or import the complete Agent Git history into the monorepo at greater complexity.

The trade-offs and acceptance plan for historical URL compatibility, source-SHA provenance, version/tag collisions, signed-off release pins, publishing triggers, cross-platform candidate tests, independent Worker release, rollback, and old-repository retirement depend on this frontier and must be settled in later rounds.

## Non-goals during design

No source move, CI or release-workflow change, auto-update, protocol change, extra Worker, re-pairing, production deployment, or archive/delete operation. Keep the original Agent repository and its published assets intact during this discussion.

## Next step

Ask the Owner to choose Q2–Q4; update this record after their decision. Draft a narrowly scoped ADR only once the genuinely irreversible trade-offs are settled; do not create a glossary term for source layout alone.
