# Engineering decision guardrails — applicable across projects

**Scope:** General engineering and assistant decision behavior, not Remote Control-specific. This repository enforces it via `AGENTS.md`. To apply to other unrelated projects, reuse the wording in user-level ChatGPT instructions; this file alone does not change account-wide settings.

## 1. Establish the real problem boundary first

Before selecting technologies, identify the user outcome, the existing system owner, platforms, constraints, what success means and what is explicitly out of scope. Review current code, PRs, upstream APIs and established components. Prefer extending what exists over adding another Agent, service, database, backend or deployment flow. A passing PoC proves **that tested scenario**, not architectural superiority, platform parity or readiness to ship.

## 2. Require evidence for every added entity

For each proposed dependency, abstraction, service, protocol, store or build/release step, document the *specific missing capability*, why upstream or existing project components cannot supply it, and the ongoing maintenance/security/platform costs. Reuse mature official APIs and the existing authenticated transport, operation receipts and process management. Keep **one** validated implementation path; alternatives may be retained as evidence without being simultaneously maintained. Do not create speculative extension frameworks.

## 3. When assumptions fail, return to the decision gate

Stop adding fixes or layers to a failing approach. Preserve observed failures, describe their scope, and run the smallest discriminating experiment; compare alternatives against the original goal and complexity budget. Do not automatically add a proxy, secondary engine, wrapper, queue, identity system, storage or special installer to rescue an unproven direction.

## Required pre-implementation check

State succinctly: **goal and boundary → existing capabilities → alternatives and complexity cost → uncertain assumptions → smallest falsifiable test → explicit go/no-go criteria**. Classify evidence honestly as *design*, *source*, *mock*, *real-device PoC*, *installed*, *enabled*, or *accepted*. Never conflate CI success with deployed usability, or testing permission with permission to merge, release, deploy or perform high-impact changes. On a changed architectural decision, mark older recommendations superseded while retaining their history and negative evidence.

**Stop rule:** no evidenced need, no new component. Verify uncertain upstream/platform behavior before selecting the architecture. Avoid implementation until the smallest decisive test is defined.
