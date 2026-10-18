# ADR-0020 — Public Remote Control Agent repository boundary

**Status:** Accepted architecture direction (2026-10-17); migration and release remain staged and independently verified.

**Decision.** Keep `lirtual/mcp-workers` **Private**, as the Cloudflare Worker, Portal-auth and server-side Durable Object authority. Create `lirtual/remote-control-agent` **Public**, containing only reviewed Linux/WSL2 Agent source, installer, native Supervisor, standalone tests and reproducible release assets. The Agent repository is the sole intended publication origin for future immutable GitHub Release archives and version-pinned Python-free Node bootstrap.

**Reason.** Anonymous requests to the private repository's GitHub API and Releases return HTTP 404; repository-level Release Immutability does not grant anonymous read access. Public source + public release together avoid a permanent cross-repository artifact-publisher workflow. No GitHub bearer token in end-device installer; no Cloudflare Worker source/Portal token/device keys/private receipt data in the public repository.

**Compatibility and migration.**
1. Keep the **v2 WSS/Ed25519 protocol unchanged**. Agent code has no production runtime import of Worker source; the Worker tests currently use direct relative imports from the Agent.
2. During a staged transition, preserve Agent source and **existing versioned archive's internal path layout** to minimize runtime/artifact ABI changes. A flatter public source tree may follow only with a separately tested archive migration, not as a simultaneous protocol change.
3. In the private Worker CI, reuse existing tests and fetch the **exact public Agent commit SHA** into the existing test-only workspace path; never track a mutable public branch for trusted builds. No new workflow required.
4. Move and publish only a **clean initial import of tracked, audited Agent files**, not a git clone/mirror of private history. Exclude private source, .env, credentials, identity PEM files, SQLite/receipt state, .build, node_modules, local machine files, and git history.
5. Replace existing hard-coded private `lirtual/mcp-workers` Release URLs and related tests with `lirtual/remote-control-agent`. Pin tag/commit and official asset SHA256; enable **and verify** Release Immutability in the public repository. A newly public repository alone is not a published, verified release.
6. Preserve `mcp-workers` Agent code until the new public Agent passes clean x64 and native ARM64 builds, dependency tests, the current private Worker CI with pinned Agent and final review. The duplicate private Agent source has now been removed **from implementation Draft PR #79 only** (2026-10-18, commit `04f06e6f591371081cbb91fa65b282b1df4f545e`, followed by CI fixture adjustment). The existing Workflow now stages exact public Agent v0.1.8 for private Worker integration testing. Preserve the verified v1 private Git commit `bec926ddf066d1da9e55cb88fea7290b62675cc2` and its separate on-host program directory for independent recovery; do not merge source deletion until new-layout CI and v1 recovery boundary are accepted. Keep **v1 production** unchanged.
7. No third protocol package, npm publishing requirement, separate artifact mirror, new Cloudflare component, auto-updater or duplicate CI system.

**Open release gates.** Independent release-publish authorization; both-architecture native smoke; real immutable Release digests; authenticated owner+target local pairing; real clean-host CLI; one device's actual 48-hour observation and separate production approval.

**Release governance.** Creation of a public source repository is distinct from publishing executable Release assets, merging the private Worker PR, or modifying live v1/v2 services. Any source-publication scope must be checked for secrets and private internal details immediately before push.
