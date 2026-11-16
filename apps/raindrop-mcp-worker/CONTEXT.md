# Raindrop MCP Worker

This bounded context exposes a private, lightweight Raindrop.io MCP Worker. It prioritizes correct official API semantics and bounded Cloudflare Worker execution over exhaustive API coverage.

## Language

**Raindrop**:
A bookmark or saved item in Raindrop.io. Public tool and response fields follow the upstream name and field semantics.
_Avoid_: Generic item when the distinction matters

**Official API semantics**:
The upstream operation meanings, parameters, paths, and results that the Worker maps into MCP tools. Source code or a local OpenAPI file is not proof that an upstream behavior is valid.

**MCP tool contract**:
The client-visible tool name, input, output, side effects, and error behavior. Tools are organized by resource and explicit action; read, write, delete, and batch operations remain distinct.

**Capability acceptance state**:
The independently recorded states of implementation complete, contract tests passed, and live invocation accepted. Local tests never substitute for live acceptance.

**Preview**:
A read-only description of the current destructive target and expected impact. It is not a lock, transaction, approval system, or guarantee that upstream state will remain unchanged.

**Unknown write result**:
A write that reached the upstream request boundary but did not return enough evidence to determine whether it took effect. Such writes are never automatically replayed.

## Settled boundaries

1. The current goal is to make existing capabilities reliable and add missing capabilities only when needed; exhaustive coverage of every public Raindrop API is not a release criterion.
2. The Worker remains stateless and retains its existing MCP Portal `/mcp` path with separate `MCP_ACCESS_TOKEN` and `RAINDROP_ACCESS_TOKEN` credentials. The former Clerk direct pilot `/clerk/mcp` is removed from current source; the production version may still expose it until the separately authorized release. No D1, R2, KV, Queues, Workflows, or self-issued OAuth credentials are added.
3. Existing tool names and invocation shapes are not compatibility constraints. The public contract may be replaced with resource/action tools grounded in official semantics and Worker limits.
4. List operations are paginated and bounded. Batch writes require one explicit source collection and a non-empty explicit ID list; they never imply an entire collection or cross-collection server-side scan.
5. Writes are not automatically retried or rolled back. Multi-request operations distinguish succeeded, failed, unknown, and not-executed scopes using available upstream evidence.
6. Cleanup is preview-first and target-explicit. The Pro-only duplicate tool and filters are removed; custom automatic deduplication is out of scope. The Agent-facing contract does not perform automatic duplicate deletion.
7. The Agent-facing tool contract excludes official suggestions and MCP Sampling / pure AI tag wrappers (historical Spec #145; final Free-plan reduction in PR #148). The conversation model owns inference; the Worker owns its 24 published Raindrop query and mutation operations. Historical suggestion code does not imply a published Agent tool.
8. Live writes are accepted only against dedicated test collections and disposable test data. Account, sharing, import/export, backup, upload, and permanent-copy APIs remain out of scope until separately requested.
9. Spec #853's former read-only Clerk direct pilot exposed only `collection_list` and required `raindrop:read`; this code is retired from source under [Spec #878](https://github.com/lirtual/mcp-workers/issues/878), not silently remapped to the Gateway's broader tool set. An older production Worker and Clerk Resource can remain active until a separately approved, verified cutover. The independent Gateway now handles Clerk OAuth for per-Resource connections; the Portal `/mcp` entry and its 24 Raindrop tools are unchanged.

The approved specification is published as a GitHub specification issue rather than committed as a repository spec file. The application ADR records the breaking public-contract decision; implementation tickets own concrete tool schemas, limits, tests, and rollout work.
