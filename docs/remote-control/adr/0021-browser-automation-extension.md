# ADR-0021 — Browser automation is a scoped Remote Control capability

Status: **accepted design boundary (Grill With Docs round 1, 2026-10-20); documentation only, no implementation or release approval**.

Remote browser automation belongs to the existing **Remote Control MCP** product rather than a new `browser-mcp-worker`. It reuses the existing authorized device identity, explicit device routing, authenticated Agent transport, and ownership boundaries. The browser-specific runtime is an Agent-side capability, not a second device registration, Worker, Durable Object, public CDP endpoint, or browser-wide permission implied by pairing.

The first delivery **prioritizes an independently managed automation browser**. Attaching to an owner's already-open Chrome/Edge and reusing an existing login session is a **later, separately designed capability**; it must not be represented as available by this ADR alone.

The scope is **browser automation only**: navigation, page/element inspection, tab and browser-session management, webpage interactions, and browser-scoped file transfers as subsequently specified. Full desktop screen sharing, arbitrary OS mouse/keyboard control, and other native GUI applications remain out of scope. This does **not** supersede the first-release exclusion of graphical desktop control in the v1 Remote Control spec.

Existing **device pairing is necessary but insufficient as blanket browser authorization**. Operations must target an explicitly authorized `device_id` and identified browser session/tab as applicable. Access to an existing personal browser profile/tab requires the owner's explicit scope selection; sensitive external actions must have an explicit confirmation boundary. The precise approval UX, supported operations and action classes remain unsettled.

**Why:** reusing the established device trust and WSS/DO route avoids duplicating authentication and fleet coordination. Isolated automation sessions reduce interference and exposure before enabling the riskier existing-profile path. Restricting scope prevents browser support from becoming a general remote-desktop product.

**Follow-on decision:** [ADR-0022](./0022-playwright-managed-browser-sessions.md) selects direct Playwright integration, Linux + native Windows as first targets (WSL2 under Linux), a dedicated persistent local automation profile, and explicit idle-bounded browser sessions. These are design choices, not delivered capabilities.

**Follow-on decision (round 3):** [ADR-0023](./0023-browser-runtime-profile-interruption.md) chooses on-demand Chromium provisioning, single active session per profile, one dedicated automation profile per device initially, and local session retention until timeout across caller disconnection with best-effort stop upon device revocation.

**Follow-on decision (round 4):** [ADR-0024](./0024-browser-observation-and-confirmation.md) fixes 30-minute idle cleanup, headless by default, semantic-first observation with screenshot fallback, and action-specific confirmation for externally consequential high-impact browser effects.

**Follow-on decision (round 5):** [ADR-0025](./0025-atomic-browser-actions-and-receipts.md) chooses curated atomic tools, semantic-first unique element targeting, local-only browser file transfers using authorized Agent paths, and existing operation IDs/Agent receipts for potentially effectful actions without claiming remote website success.

**Follow-on decision (round 6):** [ADR-0026](./0026-browser-capabilities-tab-and-approval-scope.md) establishes first-release common browser workflow categories, stable tab IDs for explicit device/session targeting, one-use action-bound approval, and owner-only Profile clearing after safe-state checks.

**Follow-on decision (round 7):** [ADR-0027](./0027-browser-tools-visual-consent-and-recovery.md) fixes the compact tool inventory, fresh visual fallback when semantics are insufficient, fail-closed prepare/confirm/execute for high-impact actions, and verified non-destructive Profile-lock recovery.

**Follow-on decision (round 8):** [ADR-0028](./0028-browser-data-files-provenance-platform-acceptance.md) selects minimized page output without routine credential extraction, existing Agent-local file authority, trusted compatible Chromium with real provenance/integrity verification, and independent real-device acceptance by platform.

**Follow-on decision (round 9):** [ADR-0029](./0029-browser-results-outcomes-downloads-gated-release.md) establishes compact browser results, separated execution/website-effect evidence, seven-day unreferenced-download retention and the ability to stage proven safe low-impact capabilities independently while unverified high-impact operations remain disabled.

**Still open:** browser artifact/source verification and OS dependencies, numeric page/screenshot limits, download reference cleanup, idle accounting, safe recovery and offline cleanup, personal-profile attach authorization, concrete one-use approval transport and low-impact classifier, tool schemas and effect reconciliation, packaging/rollout gates. No coding, Issue creation, production change, or deployment is authorized by this ADR.

Related: [Remote Control Domain Context](../CONTEXT.md), [v2 multi-device transport ADR-0014](./0014-v2-multi-device-ws-do.md), [local mutation receipts ADR-0007](./0007-local-receipts-and-no-blind-replay.md).
