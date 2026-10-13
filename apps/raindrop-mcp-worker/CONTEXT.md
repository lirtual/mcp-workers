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

**Direct cleanup**:
An existing Raindrop cleanup tool name that executes its requested destructive operation on a single call, with no mandatory or optional preview in the target design.
_Avoid_: Treating the same name as guaranteeing compatibility with the old preview-default behavior.

**Unknown write result**:
A write that reached the upstream request boundary but did not return enough evidence to determine whether it took effect. Such writes are never automatically replayed.

## Settled boundaries

1. The current goal is to make existing capabilities reliable and add missing capabilities only when needed; exhaustive coverage of every public Raindrop API is not a release criterion.
2. The Worker remains stateless and uses the existing MCP Portal plus separate `MCP_ACCESS_TOKEN` and `RAINDROP_ACCESS_TOKEN` credentials. It does not add D1, R2, KV, Queues, Workflows, or a new credential system.
3. Existing tool names and invocation shapes are not compatibility constraints. The public contract may be replaced with resource/action tools grounded in official semantics and Worker limits.
4. List operations are paginated and bounded. Batch writes require one explicit source collection and a non-empty explicit ID list; they never imply an entire collection or cross-collection server-side scan.
5. Writes are not automatically retried or rolled back. Multi-request operations distinguish succeeded, failed, unknown, and not-executed scopes using available upstream evidence.
6. **Q14=B, Q17=A and Q18=A:** Keep established cleanup names `empty_trash`, `cleanup_collections`, `remove_duplicates`; after separately authorized migration each executes immediately, with no `confirm`, `dryRun` or preview tool. This is intentionally breaking. Preserve existing conservative duplicate/annotated-item selection, supported scope, bounded batches, partial/unknown outcomes and no blind retries. Before accepting release, refresh/reconnect the real ChatGPT MCP client and verify tool descriptions, schemas and destructive annotations reflect the new behavior. An old cached contract blocks acceptance; the current deployed version retains its old preview-default semantics until a separately approved release.
7. The Worker retains official Raindrop suggestions but does not orchestrate MCP Sampling or provide a pure AI tag tool. The conversation model owns inference; the Worker owns upstream query and mutation.
8. Live writes are accepted only against dedicated test collections and disposable test data. Account, sharing, import/export, backup, upload, and permanent-copy APIs remain out of scope until separately requested.

The approved specification is published as a GitHub specification issue rather than committed as a repository spec file. Application ADR-0001 records the resource/action tool-contract direction; ADR-0002 is superseded historical optional-preview context; **ADR-0003** is the binding target for direct cleanup, retained operation safeguards and real-client rediscovery under the original tool names. Implementation tickets own concrete tool schemas, limits, tests, and rollout work.
