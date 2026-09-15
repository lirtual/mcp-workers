# 02 — Root migration hygiene and pruning completion gate

**Status:** ready  
**Blocked by:** none

## Goal
Remove obsolete root migration scratch material and make post-migration pruning an explicit completion rule for future migrations.

## In scope
- Remove `.scratch/mcp-workers` historical implementation material once no active automation references it.
- Keep the current `.scratch/mcp-workers-post-migration-pruning` spec/tickets until ticket 14.
- Update root documentation with the rule that a verified snapshot is an intermediate state and final migration requires retention review/pruning.

## Out of scope
- No application runtime changes.
- No CI/smoke behavior redesign.
- No source-repository retirement.

## Acceptance criteria
- [ ] Old root migration scratch files are gone.
- [ ] Current pruning spec/tickets remain.
- [ ] Root docs state the migration completion gate without duplicating app-level docs.
- [ ] Root smoke runner and CI behavior are unchanged.

## Verification
Repository search finds no active references to removed scratch paths; root smoke-runner tests remain green if touched.
