# Weixin Provider version pin — no additional credentials

The independent `lirtual/cloudflare-actions` Provider keeps its existing
main-only, approved `Release Weixin Provider` publisher. This Workflow
consumer requires **zero new GitHub Secrets** and **no cross-repository
dispatch**. It never automatically deploys a Worker after a Provider release.

## Routine manual Workflow release

1. Review and publish `weixin-mcp-worker` through its existing protected
   main-only GitHub Actions release. Confirm the Provider deployment readback.
2. Start the existing `lirtual/mcp-workers` **Release Worker** workflow,
   with `worker=workflow-mcp-worker` and
   `deploy_to_production=true`. Existing GitHub Environment approvals
   still apply. Other Workers are unchanged.
3. Under the approved Worker release, the new
   `scripts/reviewed-weixin-provider-pin.mjs` queries Cloudflare with
   **the existing CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID**.
   The script accepts only one 100% active Provider Version ID, the original
   Provider D1 and Owner management host, original encryption Secret,
   CF version metadata, and absence of retired Bearer/host bindings.
   It stages one exact `WEIXIN_ACTION_DEPLOYMENT_ID` non-secret variable
   into Wrangler's protected temporary variable file; it **does not**
   write GitHub Environment variables.
4. Immediately before the existing Wrangler deploy, the release checks that
   the Provider has not changed. After the existing readback confirms the
   Workflow's deployed version and bindings, an additional check confirms
   that the live Workflow pin **equals** the checked current Provider version.
   Any mismatch blocks the release; it never retries a message or rewrites D1.
5. Existing historical `unknown` evidence checks, Github Session physical
   termination checks, migration safety, Environment approval and original
   main-only publication controls remain intact.

The old GitHub Environment variable `WEIXIN_ACTION_DEPLOYMENT_ID` is
**no longer used as an input** to the Worker release. It may be removed in
a separately approved GitHub Settings cleanup, but its presence cannot
override the Cloudflare-read version. The variable **still exists in the
deployed Worker runtime** as an exact immutable version pin.

## Safety and limitations

This chooses the active Provider at the time of the **manually approved**
Workflow release. It therefore relies on Cloudflare's deployed-version
integrity and the existing Provider publishing approval. This is less
independent than verifying Provider source SHA with a separate GitHub
read-only token; reviewers should confirm the Provider version was
deployed through the trusted publisher before approving Workflow release.

A new Provider version does not retroactively modify already published
Workflow grants, frozen immutable versions, or historical invocation
receipts. A workflow compiled with the previous Provider grant still needs
a reviewed new published version with the exact grant to execute. No
message is sent automatically during either release.

This is the source-only replacement for the unactivated PR #441 three-Secret
cross-repository handoff. Do **not** create `WEIXIN_WORKFLOW_DISPATCH_TOKEN`,
`WEIXIN_PROVIDER_PROOF_TOKEN`, or `WEIXIN_ENVIRONMENT_WRITE_TOKEN`.
No Cloudflare Worker, Owner binding, D1 data, or existing Secret is changed
by removing the unused handoff.
