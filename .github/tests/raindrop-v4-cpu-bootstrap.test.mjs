import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const file = readFileSync(
  new URL("../workflows/raindrop-v4-cpu-bootstrap.yml", import.meta.url),
  "utf8",
);
const pinned = "852ace324b0db7ef58d89172ce4896d623a304f1";
const block = (from, to) => {
  const start = file.indexOf(from);
  const end = file.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, `Missing ordered workflow sections: ${from} / ${to}`);
  return file.slice(start, end);
};

test("main manual dispatch and narrowly scoped branch/PR validation remain isolated", () => {
  assert.match(file, /^name: Raindrop v4 Pinned CPU Bootstrap/m);
  assert.match(file, /^on:\n  workflow_dispatch:/m);
  assert.match(file, /^  pull_request:\n    paths:/m);
  assert.match(file, /^  push:\n    branches:\n      - feat\/raindrop-v4-cpu-bootstrap\n    paths:/m);
  assert.match(file, /\n  validate:\n[\s\S]*?if: github.event_name == 'pull_request' \|\| github.event_name == 'push'/);
  assert.match(file, /\n  evidence:\n[\s\S]*?if: github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(file, /^      - main$/m);
});

test("source is frozen before any checkout or privileged step", () => {
  const evidence = block("  evidence:\n", "  cleanup:\n");
  const gate = block("Validate pinned source and explicit production confirmation", "uses: actions/checkout@v4");
  assert.match(gate, /SOURCE_SHA_INPUT: \$\{\{ inputs.source_sha \}\}/);
  assert.match(gate, /PINNED_SHA: \$\{\{ env.RAINDROP_EVIDENCE_PINNED_SHA \}\}/);
  assert.match(gate, /\$SOURCE_SHA_INPUT" != "\$PINNED_SHA/);
  assert.match(gate, /\$PRODUCTION_CONFIRMATION" != "\$RAINDROP_EVIDENCE_WORKER/);
  assert.match(file, new RegExp(`RAINDROP_EVIDENCE_PINNED_SHA: ${pinned}`));
  assert.match(evidence, new RegExp(`RAINDROP_EVIDENCE_SOURCE_SHA: ${pinned}`));
  assert.match(evidence, new RegExp(`RAINDROP_EVIDENCE_WORKFLOW_SHA: ${pinned}`));
  assert.match(evidence, /ref: \$\{\{ env.RAINDROP_EVIDENCE_PINNED_SHA \}\}/);
  assert.doesNotMatch(evidence, /ref: \$\{\{ inputs.source_sha \}\}/);
  assert.match(evidence, /v4-cpu-evidence\.mjs verify-source/g);
});

test("cleanup independently checks out the same frozen source after timeout and fails closed", () => {
  const cleanup = file.slice(file.indexOf("  cleanup:\n"));
  assert.match(cleanup, /needs: evidence/);
  assert.match(cleanup, /always\(\).*github.event_name == 'workflow_dispatch'.*needs.evidence.result != 'success'/);
  assert.match(cleanup, new RegExp(`RAINDROP_EVIDENCE_SOURCE_SHA: ${pinned}`));
  assert.match(cleanup, /ref: \$\{\{ env.RAINDROP_EVIDENCE_PINNED_SHA \}\}/);
  assert.match(cleanup, /v4-cpu-evidence\.mjs rollback/);
  assert.doesNotMatch(cleanup, /ref: \$\{\{ github.sha \}\}|ref: \$\{\{ inputs.source_sha \}\}/);
});

test("production rollback preflight requires two explicit identities with no stale defaults", () => {
  const inputs = block("  workflow_dispatch:\n", "permissions:\n");
  assert.match(inputs, /expected_rollback_deployment:/);
  assert.match(inputs, /expected_rollback_version:/);
  assert.doesNotMatch(inputs, /default:\s*[0-9a-f]{8}-[0-9a-f-]{27}/i);
  assert.match(file, /Active deployment differs from approved rollback point/);
  assert.match(file, /Active version differs from approved rollback point/);
  assert.match(file, /--keep-vars/);
  const evidenceJobEnv = block("  evidence:\n", "    steps:\n");
  assert.doesNotMatch(evidenceJobEnv, /\$\{\{ runner\.temp \}\}/, "runner context is invalid in job-level env");
  assert.match(file, /ROLLBACK_PATH: \$\{\{ github\.workspace \}\}\/raindrop-v4-rollback\.json/);
  assert.match(file, /issue-129 source=\$RAINDROP_EVIDENCE_SOURCE_SHA/);
});

test("pull_request checks are unauthenticated; deploy and rollback require manual main dispatch", () => {
  const validation = block("  validate:\n", "  evidence:\n");
  assert.match(validation, /node --test .github\/tests\/raindrop-v4-cpu-bootstrap.test.mjs/);
  assert.doesNotMatch(validation, /CLOUDFLARE_API_TOKEN|MCP_ACCESS_TOKEN|wrangler deploy/);
  const evidence = block("  evidence:\n", "  cleanup:\n");
  assert.match(evidence, /pnpm exec wrangler deploy/);
  assert.match(evidence, /RAINDROP_EVIDENCE_ROLLBACK_PATH/);
  assert.match(evidence, /status:.*blocked|record-blocked/);
  assert.match(evidence, /RAINDROP_EVIDENCE_WORKER: raindrop-mcp-worker/);
});

test("recorded evidence distinguishes default-branch runner SHA from reviewed source SHA", () => {
  const metadata = block(
    "Record distinct bootstrap and immutable source identities (non-secret)",
    "uses: actions/checkout@v4",
  );
  assert(metadata.includes("BOOTSTRAP_SHA: ${{ github.sha }}"));
  assert(metadata.includes("PINNED_SOURCE_SHA: ${{ env.RAINDROP_EVIDENCE_PINNED_SHA }}"));
  assert(metadata.includes("bootstrapSha,"));
  assert(metadata.includes("sourceSha,"));
  assert(metadata.includes("RUNNER_TEMP}/raindrop-v4-bootstrap-provenance.json"));
  const evidence = block("  evidence:\n", "  cleanup:\n");
  assert(evidence.includes("${{ runner.temp }}/raindrop-v4-bootstrap-provenance.json"));
  assert.doesNotMatch(metadata, /CLOUDFLARE_API_TOKEN|MCP_ACCESS_TOKEN|RAINDROP_ACCESS_TOKEN/);
});

test("restores the recorded production version even when evidence collection succeeds", () => {
  const evidence = block("  evidence:\n", "  cleanup:\n");
  const restore = block("      - name: Restore recorded production version", "      - name: Upload sanitized evidence");
  assert(restore.includes("if: ${{ always() && steps.deploy.outcome != 'skipped' }}"));
  assert.match(restore, /v4-cpu-evidence\.mjs rollback/);
  assert.match(evidence, /RAINDROP_EVIDENCE_ROLLBACK_PATH: \$\{\{ env\.ROLLBACK_PATH \}\}/);
  const cleanup = file.slice(file.indexOf("  cleanup:\n"));
  assert.match(cleanup, /needs\.evidence\.result != 'success'/);
});
