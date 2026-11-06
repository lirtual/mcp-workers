import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { APPLICATIONS, RELEASE_WORKERS } from './select-affected-apps.mjs';
import { verifyDocumentationContracts, verifyReleaseWorkers, verifyStaticWorkflowReferences } from './verify-workflow-dispatch-gates.mjs';

const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('current production release choices, guarded allowlist and releasable Workers agree', () => {
  assert.doesNotThrow(() => verifyReleaseWorkers(release, RELEASE_WORKERS));
});

test('Spec #733 keeps exactly one scoped GitHub Secret source per SSH/Workflow runtime binding',()=>{
  assert.doesNotThrow(()=>verifyReleaseWorkers(release,RELEASE_WORKERS));
  for(const [oldSource,newSource] of [
    ['secrets.ENCRYPTION_KEY','secrets.SSH_ENCRYPTION_KEY'],
    ['secrets.MCP_PORTAL_CLIENT_SECRET','secrets.WORKFLOW_MCP_PORTAL_CLIENT_SECRET'],
    ['secrets.SESSION_RUNTIME_DATA_KEY','secrets.WORKFLOW_SESSION_RUNTIME_DATA_KEY'],
    ["inputs.worker == 'ssh-mcp-worker' && secrets.ENCRYPTION_KEY",
     "inputs.worker == 'workflow-mcp-worker' && secrets.ENCRYPTION_KEY"],
  ]) {
    assert.throws(()=>verifyReleaseWorkers(release.replace(oldSource,newSource),RELEASE_WORKERS),
      /GitHub Secret source|Wrong GitHub Secret source|Parallel canonical GitHub Secret source/);
  }
  assert.throws(()=>verifyReleaseWorkers(release.replace(
    '          SSH_ENCRYPTION_KEY:',"          ENCRYPTION_KEY: ${{ secrets.ENCRYPTION_KEY }}\n          SSH_ENCRYPTION_KEY:"),RELEASE_WORKERS),
    /Old GitHub name may not be added as a runtime binding/);
});

test('retired Email encryption secret is not referenced by production release', () => {
  assert.doesNotThrow(() => verifyReleaseWorkers(release, RELEASE_WORKERS));
  assert.throws(() => verifyReleaseWorkers(release + '\nMAIL_ENCRYPTION_KEY: ${{ secrets.MAIL_ENCRYPTION_KEY }}\n', RELEASE_WORKERS),
    /Retired Email Secret reference remains/);
});

test('a missing or duplicated manual Worker choice fails', () => {
  assert.throws(() => verifyReleaseWorkers(release.replace('          - github-actions-mcp-worker\n', ''), RELEASE_WORKERS), /Mismatched manual release choices/);
  assert.throws(() => verifyReleaseWorkers(release.replace('          - github-actions-mcp-worker\n', '          - github-actions-mcp-worker\n          - github-actions-mcp-worker\n'), RELEASE_WORKERS), /Duplicate manual release choices/);
});

test('a missing allowed Worker or an unsafe gate bypass fails', () => {
  assert.throws(() => verifyReleaseWorkers(release.replace("           inputs.worker == 'github-actions-mcp-worker' ||\n", ''), RELEASE_WORKERS), /Mismatched release allowlist/);
  assert.throws(() => verifyReleaseWorkers(release.replace("(inputs.worker == 'raindrop-mcp-worker' ||", "(true || inputs.worker == 'raindrop-mcp-worker' ||"), RELEASE_WORKERS), /Unsafe or unsupported Worker allowlist/);
  assert.throws(() => verifyReleaseWorkers(release.replace("needs.checks.result == 'success' &&", "true &&"), RELEASE_WORKERS), /Unsafe or unsupported release gate/);
});

test('retired HTTP MCP cannot enter the release allowlist', () => {
  assert.ok(!RELEASE_WORKERS.includes('http-mcp-worker'));
  assert.doesNotMatch(release, /http-mcp-worker|HTTP_CREDENTIALS_JSON|register-http-portal/);
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

test('release documentation contracts reject wrong Worker and Secret/Variable drift', () => {
  const docs = {
    imaContext: '`IMA_CLIENT_ID` 是 GitHub Environment Variable；`IMA_API_KEY` 是 GitHub Environment Secret。',
    raindropReadme: 'Production uses Release Worker.',
    githubActionsReadme: 'inputs={"worker":"github-actions-mcp-worker","deploy_to_production":"true"}',
  };
  assert.doesNotThrow(() => verifyDocumentationContracts(docs));
  assert.throws(() => verifyDocumentationContracts({
    ...docs, imaContext: '`IMA_CLIENT_ID` and `IMA_API_KEY` are 单用户 Worker Secrets。',
  }), /IMA Client ID must be documented as a Variable/);
  assert.throws(() => verifyDocumentationContracts({
    ...docs, raindropReadme: docs.raindropReadme + '\\nwrangler secret put RAINDROP_ACCESS_TOKEN',
  }), /Raindrop must not recommend direct production secret writes/);
  assert.throws(() => verifyDocumentationContracts({
    ...docs, githubActionsReadme: 'inputs={"worker":"remote-control-mcp-worker","deploy_to_production":"true"}',
  }), /GitHub Actions MCP example must select its own Worker/);
});

test('retired Weixin publishing is impossible through the old manual release', () => {
  assert.ok(!APPLICATIONS.includes('weixin-mcp-worker'), 'Retired Weixin app is absent from CI');
  assert.ok(!RELEASE_WORKERS.includes('weixin-mcp-worker'), 'Retire Weixin as an old release target');
  assert.doesNotMatch(release, /weixin-mcp-worker/, 'No Weixin Worker target, D1 migration, or smoke step in old release');
  assert.match(release, /GITHUB_SHA.*git ls-remote origin refs\/heads\/main/, 'Historical reruns must compare to current main');
  assert.match(release, /Stage selected Worker Secrets for every release/);
});
