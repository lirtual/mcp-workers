# MCP Workers Post-Migration Pruning Specification

**Status:** Ready for ticket decomposition
**Repository:** `lirtual/mcp-workers`
**Target branch:** `feat/mcp-workers-monorepo`
**Scope:** six migrated MCP applications only

## 1. Problem

The monorepo migration successfully established a single private source repository for six independently deployed MCP applications, preserved source provenance, introduced the shared workspace/CI model, and converged application ingress on Cloudflare MCP Portal.

However, several application directories still reflect their source repositories rather than their intended long-term role inside this monorepo. The migration snapshot phase intentionally favored fidelity, but that fidelity has left active-tree maintenance debt:

- standalone-repository CI workflows remain nested under application directories even though CI is now centralized at the monorepo root;
- historical design documents, implementation reports, superseded specifications, editor/agent configuration, release automation, generated documentation, and unrelated packaging assets remain in active application trees;
- some retained documentation contradicts the current monorepo runtime contract;
- Raindrop still carries a multi-runtime npm/Bun/Node HTTP/STDIO/public-release architecture even though this repository needs a Cloudflare Worker application;
- Raindrop production code still contains Node/Bun runtime assumptions in logging and diagnostics;
- source-provenance files sometimes mix immutable source facts with mutable deployment-state claims.

If left as-is, the repository is structurally unified but still forces maintainers and coding agents to reason through obsolete architectures and irrelevant files. That defeats the migration objective of reducing maintenance cost and making future extension safer.

## 2. Solution

Add a formal **post-migration pruning gate** to the migration process and apply it to all six migrated applications.

A frozen source snapshot remains valuable as migration evidence, but it is an intermediate state rather than the final repository shape. The final active tree keeps only files with a current, explicit responsibility:

1. runtime source;
2. tests that protect current behavior;
3. build, typecheck, lint, and deployment configuration required by the current application;
4. operational documentation that describes the current runtime;
5. legal/license and source-provenance material;
6. narrowly justified developer utilities that are still used.

Historical material remains recoverable from Git history and source repository references. It does not need to remain duplicated in the active tree.

Raindrop receives an additional Worker-only reduction because its migrated source repository still combines several product/runtime/distribution modes that are outside this monorepo's target architecture.

## 3. Scope

Exactly these six applications are in scope:

- `apps/ima-mcp-worker`
- `apps/openlist-mcp-worker`
- `apps/weread-mcp-worker`
- `apps/database-mcp-worker`
- `apps/raindrop-mcp-worker`
- `apps/instapaper-mcp-worker`

`packages/portal-auth`, the root workspace, root CI, and root smoke runner may be updated only where required to support or verify the pruning work.

Quark MCP is explicitly excluded.

## 4. Goals

1. Make every file in each application directory defensible by a current runtime, verification, deployment, legal, provenance, or maintenance responsibility.
2. Remove standalone-repository artifacts that are redundant after monorepo consolidation.
3. Establish one current documentation truth source per application rather than preserving contradictory generations of architecture documents.
4. Preserve legal attribution and immutable source provenance without preserving unrelated source-repository baggage.
5. Reduce Raindrop to a Cloudflare Worker application while preserving its MCP capability surface.
6. Remove Node/Bun/STDIO assumptions from Raindrop's Worker runtime path.
7. Reduce Raindrop's direct and development dependency graph to what the Worker and its active tests actually use.
8. Keep centralized root CI as the only repository CI workflow authority.
9. Preserve the existing independent deployment/failure boundaries between applications.
10. Preserve current production data and avoid destructive live acceptance operations.
11. Add pruning as a repeatable completion criterion for any future source migration into this monorepo.

## 5. Non-Goals

The following are explicitly out of scope:

- redesigning MCP tools unrelated to pruning;
- changing application product scope;
- merging application runtimes or Cloudflare resources;
- creating a generic shared `worker-core` package;
- moving application-specific domain logic into shared packages;
- adding new MCP tools;
- removing existing Raindrop tool names as part of cleanup;
- changing IMA business behavior such as signed-download semantics beyond already approved work;
- debugging the known WeRead upstream platform error;
- replacing the current OpenList production Tunnel/service topology as part of cleanup;
- creating placeholder Workers for applications without a live deployment;
- changing database authorization architecture or introducing write support;
- publishing Raindrop to npm, Smithery, MCPB, Gemini, Vercel Skills, or another public registry;
- retaining historical files merely because they existed in a frozen source repository;
- rewriting Git history to erase the original migration snapshots;
- retiring old source repositories before the monorepo's final acceptance/cutover phase.

## 6. User Stories

1. As a monorepo maintainer, I want each application directory to contain only currently useful files, so that I can understand an application without filtering source-repository noise.
2. As a monorepo maintainer, I want the frozen source commit recorded even after pruning, so that I can trace the migrated implementation back to its exact origin.
3. As a monorepo maintainer, I want historical migration content recoverable from Git history rather than duplicated in the active tree, so that provenance does not create ongoing maintenance burden.
4. As a monorepo maintainer, I want one current documentation contract per application, so that conflicting specifications cannot steer future changes in opposite directions.
5. As a coding agent, I want obsolete CI, editor, agent, release, and packaging instructions removed from application directories, so that repository navigation exposes the real maintenance path first.
6. As a coding agent, I want superseded documents clearly removed or consolidated, so that I do not implement against historical architecture by mistake.
7. As an operator, I want cleanup changes to preserve Worker identity, secrets, bindings, and independently managed Cloudflare resources, so that repository hygiene does not accidentally become an infrastructure migration.
8. As an operator, I want current Worker ingress documentation to match actual monorepo policy, so that MCP Portal configuration is not based on stale route assumptions.
9. As an application maintainer, I want application-level CI workflows removed after root CI takes ownership, so that checks have one authoritative implementation.
10. As an application maintainer, I want useful application tests retained even when their original repository support files are removed, so that pruning does not reduce behavioral confidence.
11. As a Raindrop maintainer, I want the application to be Worker-only, so that I do not need to maintain npm CLI, STDIO, Bun, Node HTTP server, MCPB, Smithery, public-release, and Worker modes simultaneously.
12. As a Raindrop maintainer, I want the existing MCP tool names preserved, so that cleanup does not become an accidental API redesign.
13. As a Raindrop maintainer, I want diagnostics to describe the actual Cloudflare Worker runtime, so that operational metadata does not claim Node/Bun process characteristics that the production runtime does not own.
14. As a Raindrop maintainer, I want logging to use Worker-native primitives, so that production code does not depend on `process.stderr` or Node process globals.
15. As a Raindrop maintainer, I want only actively imported runtime dependencies retained, so that the lockfile and workspace overrides do not encode unused runtime families.
16. As a Raindrop maintainer, I want one reproducible OpenAPI type-generation path retained if generated API types remain part of the source contract, so that type regeneration remains possible without preserving duplicate generators.
17. As an IMA maintainer, I want old skill/reference copies removed after their behavior has been incorporated into the Worker, so that the Worker repository does not permanently carry unrelated skill package trees.
18. As an IMA maintainer, I want obsolete D1/OAuth/per-user architecture history removed from current documentation, so that the single-user Portal-only architecture is unambiguous.
19. As a WeRead maintainer, I want superseded Service Binding design documents removed or consolidated, so that Portal-only ingress remains the only active architecture.
20. As an OpenList maintainer, I want current README/deployment guidance to match the monorepo ingress policy while preserving the separate production cutover boundary, so that documentation changes do not imply an unauthorized production replacement.
21. As a Database maintainer, I want current Portal-only and read-only architecture to remain authoritative while historical OAuth/resource-server design files leave the active tree, so that future work starts from the implemented security model.
22. As an Instapaper maintainer, I want its already-clean Worker-only structure used as the minimum reference shape, so that cleanup does not add unnecessary scaffolding to the cleanest application.
23. As a CI maintainer, I want the existing affected-application root CI seam to remain authoritative, so that cleanup verification uses real application checks instead of new mock-heavy test harnesses.
24. As an operator, I want live acceptance to use explicitly selected safe/read-only tools, so that verification cannot mutate user data by inference or tool annotation alone.
25. As a future migration author, I want pruning review to be a required migration-completion gate, so that another complete source snapshot cannot silently become permanent repository structure.

## 7. Architectural Decisions

### 7.1 Snapshot fidelity is an intermediate migration state

The previous frozen source snapshots remain valid evidence that migration began from known baselines. They are not the required final directory shape.

Pruning is allowed after the snapshot has been verified provided that:

- `SOURCE.md` identifies the source repository and frozen commit;
- required license/attribution is preserved;
- behavioral verification protects the runtime contract;
- removed files remain recoverable from Git history and/or the referenced source commit.

No acceptance criterion requires the final active application subtree to hash-match the source repository.

### 7.2 File retention classification

Every tracked application file must belong to at least one category below.

**A. Runtime**

Files imported or loaded by the deployed Worker or required at runtime.

**B. Verification**

Tests, fixtures, and narrowly scoped test configuration that protect current behavior.

**C. Build/deploy**

Package metadata, TypeScript/lint/test configuration, Wrangler configuration, and developer utilities that are actively invoked by the current package scripts or deployment workflow.

**D. Current operations/documentation**

README, deployment instructions, domain context, current ADRs, or runbooks that describe the implemented architecture.

**E. Legal/provenance**

License, required attribution, and `SOURCE.md`.

Files outside these categories are removed unless a ticket documents a concrete current responsibility.

### 7.3 Standalone repository metadata does not survive by default

Application-local `.github` workflows, issue templates, release workflows, agent instructions, editor settings, public registry manifests, release automation, generated documentation, and archived implementation planning do not survive automatically after migration.

The root repository owns shared repository automation. Application-specific files remain only when they are invoked by the current monorepo workflow.

### 7.4 Documentation has one current truth source

Each app should converge on this documentation model where applicable:

- `README.md`: current architecture, tools/capabilities, local verification, and concise operation guidance;
- `CONTEXT.md`: only durable domain terminology/invariants that materially help maintainers or agents;
- one deployment/runbook document only when the deployment procedure is too detailed for README;
- current ADRs only for decisions whose rationale is still useful and not already obvious from the current architecture;
- `SOURCE.md`: immutable provenance only;
- `LICENSE`: where required.

Historical specs, migration reports, superseded ADRs, refactoring summaries, and generated API docs are not current truth sources.

### 7.5 `SOURCE.md` is provenance, not deployment state

`SOURCE.md` may state:

- source repository;
- frozen source commit;
- source license/attribution where relevant;
- brief statement that the app was migrated and subsequently adapted to the monorepo.

It must not claim mutable current facts such as current Worker routing, current `workers_dev` value, production hostname, or that no post-migration runtime changes occurred.

### 7.6 Root CI remains authoritative

The existing root `.github/workflows/ci.yml` remains the CI authority. It already:

- detects affected applications;
- installs Node 24 and pinned pnpm;
- performs a frozen workspace install;
- executes each affected application's `check` script;
- runs real PostgreSQL/MySQL integration tests when Database changes;
- checks the shared Portal auth package when affected.

Cleanup must strengthen or simplify those app-level `check` scripts where necessary rather than adding application-local GitHub Actions workflows.

### 7.7 Existing root MCP smoke seam remains the live verification seam

The root `smoke:mcp` runner remains the preferred live MCP verification seam. The caller must explicitly select a known-safe tool. Tool annotations alone must never cause automatic tool selection.

No new general-purpose live MCP framework is required by this spec.

## 8. Application-Specific Decisions

### 8.1 Instapaper

Instapaper is the reference for a clean Worker-only application directory.

Retain:

- runtime source;
- current tests;
- Instapaper credential bootstrap helper if still invoked by package scripts/README;
- package/TypeScript/Wrangler configuration;
- README;
- LICENSE;
- SOURCE provenance.

Remove:

- application-local `.github` repository automation that is superseded by root CI.

Update any ingress/deployment language that conflicts with current monorepo policy.

Do not add new framework or documentation layers simply to make Instapaper look like more complex apps.

### 8.2 WeRead

Retain:

- runtime source;
- active test/self-test scripts;
- ESLint/TypeScript/Wrangler configuration;
- README;
- concise domain context;
- SOURCE provenance.

Remove or consolidate:

- application-local `.github` workflow;
- `IMPLEMENTATION.md` once any unique current facts are merged into README/CONTEXT;
- the superseded `docs/spec.md` Service Binding contract;
- ADRs that merely restate current README/CONTEXT or document superseded ingress.

If an ADR contains a durable, non-obvious rationale that is not represented elsewhere, preserve that rationale in a current ADR or merge it into `CONTEXT.md`; do not keep a full ADR directory solely for migration history.

The known `WEREAD_UPSTREAM_ERROR` remains explicitly out of scope.

### 8.3 OpenList

Retain:

- runtime source and tests;
- TypeScript/Wrangler/package configuration;
- README;
- domain context;
- deployment guidance if it still contains unique operator steps;
- current ADRs whose rationale remains useful;
- SOURCE provenance.

Remove or consolidate:

- application-local `.github` workflow;
- stale `SPEC.md` once current invariants are captured in README/CONTEXT;
- redundant documentation.

Current docs must not claim `workers_dev=false` if the application configuration and monorepo ingress policy use `workers_dev=true`.

Repository documentation cleanup must not itself replace the separately operating OpenList Tunnel/service production topology. Production cutover remains a distinct acceptance action outside this spec.

### 8.4 Database

Retain:

- runtime source and unit/integration tests;
- integration database setup helper;
- read-only PostgreSQL/MySQL hardening SQL templates;
- current package/TypeScript/ESLint/Wrangler example configuration;
- README;
- current Portal migration/deployment guidance where it adds operational detail;
- LICENSE;
- SOURCE provenance.

Remove or consolidate:

- application-local `.github` workflow after root CI is confirmed to run the same real database integration coverage;
- the historical original resource-server `docs/spec.md`;
- historical architecture-review documents whose accepted conclusions are already incorporated into README/current runtime.

Do not remove database integration coverage merely because its original standalone workflow is removed.

### 8.5 IMA

Retain:

- current Worker runtime source;
- current tests;
- package/TypeScript/Wrangler configuration;
- `.dev.vars.example` if it reflects the current secret contract;
- README;
- concise domain context;
- one current deployment guide;
- current Portal documentation only when it adds material information not already in the deployment guide;
- LICENSE;
- SOURCE provenance.

Remove or consolidate:

- application-local `.github` workflow;
- `original-skill/` after confirming it is not imported or used by active verification;
- `companion-skill/` after confirming it is not imported or used by active verification;
- historical/superpower design materials used to create the Worker;
- obsolete changelog entries that describe retired D1/per-user OAuth architecture;
- duplicate migration/implementation documents.

Removing source-skill copies does not remove provenance: the frozen source commit and Git history remain the historical evidence.

No IMA tool behavior or signed-download security contract is changed merely for repository cleanup.

### 8.6 Raindrop

Raindrop requires both repository pruning and runtime convergence.

#### 8.6.1 Target role

`apps/raindrop-mcp-worker` is a private Cloudflare Worker application inside this monorepo. It is not simultaneously maintained here as:

- a public npm CLI package;
- a STDIO server;
- a standalone Node/Express HTTP server;
- a Bun application;
- an MCPB/DXT package;
- a Smithery package;
- a Gemini extension;
- a Vercel Skill package;
- a semantic-release/npm publishing project;
- a generated TypeDoc website.

#### 8.6.2 MCP capability contract

The existing Raindrop MCP tool-name set remains intact during this cleanup. In particular, `diagnostics` remains a tool rather than being removed as an easy way to eliminate Node assumptions.

Behavioral cleanup may correct diagnostics metadata so that it describes Cloudflare Workers rather than Node/Bun process state, but it must remain recognizable as the diagnostics capability and continue reporting server/tool/library health information.

No destructive live tool is called merely to validate this refactor.

#### 8.6.3 Worker runtime path

The Worker entrypoint remains the sole production entrypoint.

Production source must not require:

- Node process lifecycle APIs;
- `process.stderr` logging;
- Bun globals/types;
- Express/Node HTTP server infrastructure;
- STDIO transport infrastructure.

Standalone Node/STDIO entrypoints are removed when they are no longer imported by Worker tests or required to preserve current Worker behavior.

#### 8.6.4 Worker-native logging

Logging must use Cloudflare Worker-compatible primitives. The implementation must not depend on `process.env`, `process.stderr`, Node streams, or Bun globals.

If configurable log level remains useful, its value comes through the Worker environment/configuration boundary rather than a Node global process environment.

Sensitive values remain excluded from logs.

#### 8.6.5 Worker-native diagnostics

The diagnostics tool must report data that exists meaningfully in the Cloudflare Worker runtime.

It must not require fabricated or compatibility-layer values solely to preserve fields such as Node version, process uptime, process platform, process memory, or Bun version.

The diagnostics schema and tests may be updated to describe the Worker-native contract. The tool name, operational purpose, enabled-tool reporting, protocol/server version reporting, and useful library-health reporting remain preserved.

#### 8.6.6 Dependency reduction

After dead runtime paths are removed, `package.json`, `pnpm-lock.yaml`, and workspace overrides must be pruned based on actual imports/scripts/tests.

Dependencies associated only with removed npm/Node/Bun/STDIO/Express/public-release/documentation paths must not remain as historical baggage.

Expected removal candidates include the families associated with:

- Node-specific MCP client/server adapters not used by Worker runtime;
- Express/Node HTTP testing;
- Bun typings/tooling;
- dotenv-only local process loading;
- semantic-release/npm publication;
- MCPB/DXT packaging;
- TypeDoc generation;
- Husky/lint-staged local release workflow;
- OpenAPI Axios client generation if unused by the Worker.

A candidate is removed only after repository import/script verification confirms it has no current responsibility.

#### 8.6.7 OpenAPI source/type generation

If `src/types/raindrop.schema.d.ts` remains an active source dependency, preserve one canonical, reproducible OpenAPI-to-TypeScript generation path.

Do not retain multiple API schema files or multiple client generators solely because the source repository had them.

The chosen canonical schema/generator must be documented by the package script or README and must produce the type artifact expected by current Worker source.

#### 8.6.8 Repository artifacts to remove

Unless a ticket demonstrates a current monorepo responsibility, remove Raindrop's source-repository-only assets, including categories such as:

- editor-specific configuration;
- agent-specific local configuration/instructions;
- archived scratch/conductor planning content;
- application-local GitHub issue/release workflows;
- public package/registry manifests;
- public release automation;
- MCPB/Skill/Gemini/Smithery packaging;
- generated TypeDoc HTML/assets;
- superseded refactoring/diagnostics implementation reports;
- standalone release changelog material that is not the monorepo's current history source.

README is rewritten around the Worker/Portal deployment rather than preserving public CLI installation instructions.

## 9. Root Workspace Decisions

The root workspace remains Node 24 + pnpm 10.

The cleanup must reduce `pnpm-workspace.yaml` overrides when Raindrop dependencies that required those pins have been removed. An override remains only if the retained dependency graph still needs it.

Do not use dependency cleanup as an excuse for broad dependency upgrades across unrelated applications.

The root lockfile is regenerated only as a consequence of approved package/dependency changes and must pass a frozen reinstall afterward.

## 10. Testing and Verification Decisions

Testing uses the highest existing seam that protects behavior.

### 10.1 All repository cleanup changes

Required:

- root frozen pnpm install succeeds;
- root CI selects the correct affected applications;
- every affected application's existing `check` command succeeds;
- no removed nested workflow is needed for required coverage that root CI fails to reproduce.

### 10.2 Documentation-only/hygiene deletions

Do not create mock-heavy tests for file deletion.

Verification is:

- remaining links/references resolve;
- package scripts do not reference removed paths;
- CI does not reference removed paths;
- repository search does not reveal stale active instructions that contradict the retained current docs.

### 10.3 Database

When Database files or scripts change, retain root CI's real PostgreSQL/MySQL integration tests. Deleting the standalone `.github` workflow is accepted only if root CI still prepares fixtures and runs the same current integration suite.

### 10.4 Raindrop

Use three layers:

1. package `check` through root CI;
2. Worker-focused tests verifying tool registration and high-value tool/service behavior without requiring Node/STDIO paths;
3. Wrangler dry-run proving the Worker bundle no longer needs removed Node/Bun application infrastructure.

Tests tied only to deleted Node HTTP/STDIO/public-package behavior are deleted with those behaviors; they are not retained as artificial blockers.

Raindrop acceptance must explicitly assert the expected MCP tool-name set so cleanup cannot silently drop capabilities.

### 10.5 Live MCP acceptance

For applications with an approved live Worker/Portal target, use the root smoke runner with an explicitly named safe/read-only tool.

Do not automatically choose tools from annotations.

Do not perform destructive Raindrop operations, mutate user bookmarks, or create cleanup data merely for acceptance.

For applications without a live deployment, source/CI/dry-run acceptance is sufficient until the separate final deployment phase.

OpenList's existing Tunnel-backed production service is not replaced as a side effect of this spec.

## 11. Documentation Acceptance Rules

After cleanup:

1. no retained current document may direct maintainers to a removed runtime mode;
2. no current document may state `workers_dev=false` when the retained Wrangler configuration uses `workers_dev=true`;
3. no IMA current document may describe D1 credential storage or Worker-owned OAuth as current architecture;
4. no WeRead current document may describe Service Binding/Gateway ingress as the current production contract;
5. no Database current document may present old client OAuth/JWT resource-server handling as current ingress;
6. no Raindrop current README may present npm/STDIO/Bun/MCPB/Smithery/public release as the monorepo's supported production mode;
7. `SOURCE.md` files must describe immutable provenance rather than mutable current routing/deployment state.

## 12. Migration Completion Gate for Future Apps

Any future source migration into this monorepo is incomplete until all of the following are true:

1. frozen baseline is recorded and integrity is verified;
2. application runs/checks from the monorepo;
3. every active file passes the retention classification;
4. standalone repository automation is removed or explicitly justified;
5. documentation is consolidated to the current truth source;
6. provenance/license obligations are preserved;
7. dependencies/scripts that served removed source-repository modes are pruned;
8. live acceptance is performed where a live service exists and is authorized;
9. source repository retirement is still a separate final action.

This gate prevents "copy everything and stop" from being considered a completed migration.

## 13. Implementation Ordering

Implement in risk-separated phases.

### Phase A — Low-risk repository hygiene and truth-source cleanup

Apply to all six apps and the root scratch area:

- remove nested standalone CI/repository artifacts;
- remove superseded historical documents and generated documentation;
- consolidate current docs;
- normalize `SOURCE.md` provenance semantics;
- remove root migration scratch material that is no longer an active implementation input.

Phase A must not intentionally change application runtime behavior.

### Phase B — Raindrop Worker-only source/package reduction

- remove public-package, STDIO, Bun, Node HTTP, release, MCPB, registry, TypeDoc, and duplicate generator paths;
- remove tests that exist only for retired runtime modes;
- simplify `package.json` and workspace overrides;
- retain the Worker tool/service path and one reproducible schema-generation path;
- preserve the Raindrop MCP tool-name set.

### Phase C — Raindrop Worker-native runtime cleanup

- replace Node/STDIO logging assumptions;
- make diagnostics Worker-native;
- remove residual Node/Bun runtime types/dependencies made unnecessary by the cleanup;
- update tests to the corrected Worker-native diagnostics contract.

### Phase D — Final pruning acceptance

- run frozen workspace install;
- run root CI-equivalent checks for all affected apps;
- run Database integration when applicable;
- run safe live MCP smoke where authorized/live;
- perform repository-wide stale-reference search;
- confirm no production cutover or user-data mutation was smuggled into cleanup.

Only after this spec is accepted should the broader monorepo final acceptance/old-repository retirement phase proceed.

## 14. Acceptance Criteria

The specification is implemented when all of the following are true:

1. All six app directories have completed the retention review.
2. Application-local GitHub CI/release workflows that duplicate root ownership are removed.
3. Root `.scratch` migration artifacts that are no longer active inputs are removed or moved out of the maintained source tree.
4. IMA no longer carries unused source-skill/reference trees or obsolete D1/OAuth current-history documents.
5. WeRead no longer carries a current-looking Service Binding specification or redundant implementation report.
6. OpenList current docs agree with retained Wrangler/monorepo ingress policy while explicitly preserving the separate production cutover boundary.
7. Database current docs no longer present superseded OAuth resource-server architecture as authoritative, while read-only integration coverage and SQL hardening assets remain.
8. Instapaper remains minimal and gains no unnecessary scaffolding.
9. Raindrop no longer presents itself inside this monorepo as a multi-runtime public npm/Bun/STDIO/Node HTTP/MCPB/Smithery release project.
10. Raindrop's deployed Worker source path has no production dependency on `process.stderr`, Node process lifecycle/environment APIs, or Bun globals.
11. Raindrop retains the expected MCP tool-name set, including `diagnostics`.
12. Raindrop diagnostics describe Worker-native runtime state rather than pretending to run as Node/Bun.
13. Raindrop retains one documented, reproducible OpenAPI type-generation path if generated API types remain imported.
14. Raindrop package dependencies and root workspace overrides contain no entries solely needed by removed runtime/release modes.
15. Each `SOURCE.md` contains immutable provenance and does not claim mutable production routing/runtime state.
16. Every affected app `check` passes through the root workspace.
17. A frozen `pnpm install` succeeds after lockfile updates.
18. Database real integration tests still pass when Database cleanup touches its test/build surface.
19. Wrangler dry-run succeeds for all applications whose package check includes deployment validation.
20. Safe live smoke checks pass for authorized live targets without invoking destructive tools or mutating user data.
21. Repository search finds no active documentation that instructs maintainers to use retired runtime modes or contradicts current ingress policy.
22. No cleanup ticket performs an OpenList production cutover, source-repository retirement, WeRead upstream debugging, or unrelated tool redesign.

## 15. Ticket Decomposition Guidance

Downstream ticketing should preserve the risk separation in Section 13 rather than creating one giant deletion/refactor ticket.

At minimum, ticket boundaries should isolate:

- cross-app repository hygiene/documentation cleanup;
- Raindrop Worker-only structural/package reduction;
- Raindrop Worker-native logger/diagnostics behavior correction;
- final pruning acceptance and stale-reference verification.

Application-specific cleanup may be split further when doing so allows independent review or avoids mixing unrelated runtime behavior.

The next workflow after approval is `to-tickets`; implementation must not begin from this document by collapsing all phases into one unreviewable change set.
