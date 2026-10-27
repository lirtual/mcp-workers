import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RELEASE_WORKERS } from './select-affected-apps.mjs';
import { verifyReleaseWorkers, verifyStaticWorkflowReferences } from './verify-workflow-dispatch-gates.mjs';

const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('current production release choices, guarded allowlist and releasable Workers agree', () => {
  assert.doesNotThrow(() => verifyReleaseWorkers(release, RELEASE_WORKERS));
});

test('a missing or duplicated manual Worker choice fails', () => {
  assert.throws(() => verifyReleaseWorkers(release.replace('          - http-mcp-worker\n', ''), RELEASE_WORKERS), /Mismatched manual release choices/);
  assert.throws(() => verifyReleaseWorkers(release.replace('          - email-mcp-worker\n', '          - email-mcp-worker\n          - email-mcp-worker\n'), RELEASE_WORKERS), /Duplicate manual release choices/);
});

test('a missing allowed Worker or an unsafe gate bypass fails', () => {
  assert.throws(() => verifyReleaseWorkers(release.replace("           inputs.worker == 'openlist-mcp-worker' ||\n", ''), RELEASE_WORKERS), /Mismatched release allowlist/);
  assert.throws(() => verifyReleaseWorkers(release.replace("(inputs.worker == 'raindrop-mcp-worker' ||", "(true || inputs.worker == 'raindrop-mcp-worker' ||"), RELEASE_WORKERS), /Unsafe or unsupported Worker allowlist/);
  assert.throws(() => verifyReleaseWorkers(release.replace("needs.checks.result == 'success' &&", "true &&"), RELEASE_WORKERS), /Unsafe or unsupported release gate/);
});

test('existing static reusable workflows and local scripts pass', () => {
  const available = new Set([
    '.github/workflows/ci.yml',
    'scripts/example.sh',
    'scripts/first.test.mjs',
    'scripts/second.test.mjs',
    'apps/database-mcp-worker/scripts/setup-integration.mjs',
    'apps/workflow-mcp-worker/tests/check.mjs',
  ]);
  const source = [
    '    uses: ./.github/workflows/ci.yml',
    '      - run: bash scripts/example.sh',
    '        run: node --test scripts/first.test.mjs scripts/second.test.mjs',
    '        run: pnpm --filter database-mcp-worker exec node scripts/setup-integration.mjs',
    '        run: node --experimental-strip-types apps/workflow-mcp-worker/tests/check.mjs',
  ].join('\n');
  assert.doesNotThrow(() => verifyStaticWorkflowReferences({ 'test.yml': source }, path => available.has(path)));
});

test('missing static workflow or executable scripts fail with a useful location', () => {
  assert.throws(() => verifyStaticWorkflowReferences(
    { 'test.yml': '    uses: ./.github/workflows/retired.yml' }, () => false), /test.yml:1 missing workflow/);
  assert.throws(() => verifyStaticWorkflowReferences(
    { 'test.yml': '        run: node scripts/deleted.mjs' }, () => false), /test.yml:1 missing script scripts\/deleted.mjs/);
  assert.throws(() => verifyStaticWorkflowReferences(
    { 'test.yml': '        run: pnpm --filter database-mcp-worker exec node scripts/deleted.mjs' }, () => false),
  /test.yml:1 missing script apps\/database-mcp-worker\/scripts\/deleted.mjs/);
});

test('external actions and dynamic references are not mistaken for missing static files', () => {
  const source = [
    '      - uses: actions/checkout@v4',
    '      - uses: example/action@v1',
    '      - uses: ${{ inputs.action }}',
    '        run: node "${{ env.EXECUTABLE }}"',
  ].join('\n');
  assert.doesNotThrow(() => verifyStaticWorkflowReferences({ 'test.yml': source }, () => false));
});

test('a local workflow reference cannot traverse out of the workflow directory', () => {
  assert.throws(() => verifyStaticWorkflowReferences(
    { 'test.yml': '    uses: ./.github/workflows/../../other.yml' }, () => true),
  /invalid local workflow/);
});
