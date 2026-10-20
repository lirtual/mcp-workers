# GitHub Actions MCP context

An independently deployed, stateless MCP ingress that manages GitHub Actions exclusively through GitHub REST. There is no Session Deck dependency or separate runner state.

Authentication is the existing owner-only Portal Bearer plus a required `GH_TOKEN` and optional `GH_TOKEN_SECONDARY`. Each GitHub fine-grained PAT independently defines the accessible repositories. There is **no repository allowlist variable or manually maintained repository-to-credential mapping**.

Repository discovery uses `GET /user/repos` authenticated independently by each PAT; results are bounded. The union appears in `repositories_list`; overlaps are marked ambiguous and rejected. A tool request resolves an exact repository to exactly one PAT via read-only discovery **before** contacting the requested GitHub Actions endpoint. Invalid requests, unavailable discovery, ambiguous access, revoked permissions, and upstream failures fail closed. No write request is retried with another PAT; credential values and upstream response bodies are never returned.

MCP tools are workflow/run discovery, metadata-only jobs/artifacts, explicit-ref workflow dispatch, repository dispatch, cancel/force-cancel and reruns. Acknowledgement of a dispatched or cancelled run is not proof of completion; inspect `run_get` for final status. This MCP does not fetch raw logs or artifacts, expose GitHub PATs, decrypt session credentials, or manage runner connections.

Runtime needs no database, queue, background state, account selector, JSON secrets, GitHub App or new external dependency. Publishing code is separate from selected-Worker production deployment and needs explicit review.
