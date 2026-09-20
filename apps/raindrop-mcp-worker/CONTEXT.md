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
2. The Worker remains stateless and uses the existing MCP Portal plus separate `MCP_ACCESS_TOKEN` and `RAINDROP_ACCESS_TOKEN` credentials. It does not add D1, R2, KV, Queues, Workflows, or a new credential system.
3. Existing tool names and invocation shapes are not compatibility constraints. The public contract may be replaced with resource/action tools grounded in official semantics and Worker limits.
4. List operations are paginated and bounded. Batch writes require one explicit source collection and a non-empty explicit ID list; they never imply an entire collection or cross-collection server-side scan.
5. Writes are not automatically retried or rolled back. Multi-request operations distinguish succeeded, failed, unknown, and not-executed scopes using available upstream evidence.
6. Cleanup is preview-first and target-explicit. Official duplicate detection is reused; custom fuzzy or URL-normalization deduplication is out of scope. Duplicate copies with notes or highlights are skipped by automated cleanup.
7. The Worker retains official Raindrop suggestions but does not orchestrate MCP Sampling or provide a pure AI tag tool. The conversation model owns inference; the Worker owns upstream query and mutation.
8. Live writes are accepted only against dedicated test collections and disposable test data. Account, sharing, import/export, backup, upload, and permanent-copy APIs remain out of scope until separately requested.

The approved specification is published as a GitHub specification issue rather than committed as a repository spec file. The application ADR records the breaking public-contract decision; implementation tickets own concrete tool schemas, limits, tests, and rollout work.
