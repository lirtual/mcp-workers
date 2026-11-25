# Browser MCP

Personal browser MCP using a paired browser extension and signed Worker relay.

The [context](CONTEXT.md), [Skill](skills/browsermcp/SKILL.md), source and tests define the current authorization and operation contract. Spec #917 adds locally gated `browser_cdp` and `browser_cdp_events` alongside all fifteen existing tools; Chrome/Edge debugger permission, Owner-specific website effects, partial/Unknown receipts and ephemeral results remain separate concerns. The public extension download is not a grant to control a browser.
