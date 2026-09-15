# 06 — Database documentation and repository convergence

**Status:** ready  
**Blocked by:** none

## Goal
Make the implemented Portal-only/read-only Database architecture authoritative while preserving real integration coverage and hardening assets.

## In scope
- Remove app-local `.github` workflow after confirming root CI owns equivalent PostgreSQL/MySQL integration.
- Remove historical OAuth resource-server `docs/spec.md` and superseded architecture-review material whose accepted decisions are already implemented/currently documented.
- Keep integration setup script and PostgreSQL/MySQL read-only SQL templates.
- Normalize SOURCE provenance/current docs.

## Out of scope
- No database authorization redesign, write support, Hyperdrive model change, or credential changes.

## Acceptance criteria
- [ ] No current doc presents old client OAuth/JWT handling as current ingress.
- [ ] Root CI still prepares fixtures and runs real PostgreSQL/MySQL integration.
- [ ] SQL hardening templates and setup helper remain.
- [ ] Database `check` and integration pass.

## Verification
PR-base root CI Application checks + Database integration must both be green.
