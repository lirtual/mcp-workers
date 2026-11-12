# Workflow MCP Worker

Personal durable Workflow orchestration for approved MCP, GitHub and Cloudflare Actions.

The compiler and immutable Published Plan determine valid steps, inputs, grants and runtime behavior. Action/tool discovery provides current reviewed contracts; a Draft or old documentation is not authority for an already published version. The [Workflow Skill](skills/workflow/SKILL.md) describes the shortest safe operator path.

**Operational boundaries**

- Validate a definition before creating or updating a Draft. Publish and trigger changes require independent review of the actual effects and explicit authorization.
- Ordinary known Published runs use `workflow_run` and `workflow_result`; inspect `workflow_get` when the Published input contract is unknown.
- Durable Run/Step and physical GitHub Session outcomes are distinct. A queued result, cancellation acknowledgment or CI success is not confirmed effect completion.
- Preserve immutable Plan grants, original Invocation identity and D1 admission receipts. Indeterminate/Unknown effects must not be blindly retried or reclassified.
- GitHub Runner Sessions are temporary and bounded; Agent pairing is a separate device-level permission. Source merges do not automatically change a published Plan, active Runner or Cloudflare production deployment.

For current accepted values and input schemas, use the live Workflow MCP tools, compiler and Action manifests rather than copying example payloads from README.
