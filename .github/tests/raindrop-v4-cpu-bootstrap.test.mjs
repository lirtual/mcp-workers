import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const file = readFileSync(
  new URL("../workflows/raindrop-v4-cpu-bootstrap.yml", import.meta.url),
  "utf8",
);
const pinned = "36e6864a7378ef20cdb97d52d4877972d888a2df";
const block = (from, to) => {
  const start = file.indexOf(from);
  const end = file.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, `Missing ordered workflow sections: ${from} / ${to}`);
  return file.slice(start, end);
};

test("separate main-discoverable workflow is manually dispatched and PR validation remains offline", () => {
  assert.match(file, /^name: Raindrop v4 Pinned CPU Bootstrap/m);
  assert.match(file, /^on:\n  workflow_dispatch:/m);
  assert.match(file, /^  pull_request:\n    paths:/m);
  assert.match(file, /\n  validate:\n[\s\S]*?if: github.event_name == 'pull_request'/);
  assert.match(file, /\n  evidence:\n[\s\S]*?if: github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(file, /^  push:/m);
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
