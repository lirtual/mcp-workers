# Browser MCP distribution notices — 0.1.0

Scope: the Chrome/Edge unpacked ZIP and the Browser Worker source at its recorded
build revision, including the existing local T1–T3 slice. No new third-party
runtime dependency is introduced by T8.

The ZIP contains only repository-authored JavaScript, HTML, manifest and documentation.
It has no npm bundle, remote script, vendored Browser Pilot source or copied upstream
extension code. Browser Pilot is an architectural reference only; no claim is made
about its current license. Any future copying requires a versioned license review.
Chrome extension APIs and the fixed internal CDP call are browser-provided interfaces,
not redistributed implementations. Documentation links do not redistribute their samples.

The Worker imports the repository's `@mcp-workers/portal-auth` workspace source; that
module uses platform APIs and introduces no third-party runtime import. TypeScript
6.0.3 (Apache-2.0), @types/node 24.19.2 (MIT), @cloudflare/workers-types 5.20261006.1
(MIT/Apache-2.0), and Wrangler 4.151.0 (MIT/Apache-2.0) are build/check dependencies,
not included in this unpacked ZIP. Their installed package LICENSE files and the pinned
pnpm lockfile are the authority for any future redistribution of those tools.

The repository currently supplies no root LICENSE grant for its own sources. This
notice does not invent a license or grant third-party redistribution rights; public
redistribution terms remain a maintainer decision before public publication. Downstream
runtime dependencies or copied code added by later tickets must update these notices
and include any required upstream license text in the distributed artifact.
