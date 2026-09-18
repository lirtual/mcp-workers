# ADR 0026: Upload executor artifacts directly with short-lived presigned URLs

- Status: Accepted
- Date: 2026-09-17

## Context

Large executor-produced artifacts should not transit through the Workflow Worker request body. Doing so would make the Worker a data-plane bottleneck and couple artifact size to Worker request limits. External executors also must not receive durable R2 credentials.

## Decision

The canonical Artifact Store remains R2, but external executors upload artifact bytes directly to R2 using short-lived, single-purpose presigned upload URLs issued through the Workflow service.

An authorized executor first proves its Step Attempt identity through its Credential Lease, requests an artifact-upload allocation, receives a server-generated object key plus a short-lived presigned PUT URL, uploads bytes directly to R2, and then returns artifact metadata (including artifact identity, size, and content digest) in the Execution Result.

The Workflow Worker owns the R2 API credentials used to create presigned URLs. Those credentials are platform secrets scoped to the workflow artifact bucket and are never delegated to the executor.

## Consequences

### Positive

- Large artifacts bypass Worker request-body limits and Worker data transfer processing.
- Executors receive only temporary object-specific upload authority.
- Artifact storage remains executor-independent and canonical.
- The same protocol can support future non-GitHub executors.

### Negative

- Artifact finalization must verify expected object metadata and associate the upload with the authorized attempt.
- Expired or abandoned upload allocations require cleanup/retention handling.
- Presigned URLs are bearer capabilities during their short validity window and must not be logged.

## Rejected alternatives

- Proxy artifact bytes through the Worker: unnecessary size/bandwidth bottleneck.
- Give GitHub long-lived R2 API credentials: widens the executor trust boundary.
- Treat GitHub Actions artifacts as canonical storage: ties workflow identity and retention to one executor.
