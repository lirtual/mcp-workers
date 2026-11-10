import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { APPLICATIONS, RELEASE_WORKERS } from './select-affected-apps.mjs';
import { verifyDocumentationContracts, verifyReleaseWorkers, verifyStaticWorkflowReferences } from './verify-workflow-dispatch-gates.mjs';

const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('current production release choices, guarded allowlist and releasable Workers agree', () => {
  assert.doesNotThrow(() => verifyReleaseWorkers(release, RELEASE_WORKERS));
});

test('canonical SSH and Workflow GitHub Secret inputs are scoped, single-source and reject legacy names',()=>{
  assert.doesNotThrow(()=>verifyReleaseWorkers(release,RELEASE_WORKERS));
  for(const [canonical,legacy,worker] of [
    ['SSH_ENCRYPTION_KEY','ENCRYPTION_KEY','ssh-mcp-worker'],
    ['WORKFLOW_MCP_PORTAL_CLIENT_SECRET','MCP_PORTAL_CLIENT_SECRET','workflow-mcp-worker'],
  ]) {
    assert.throws(()=>verifyReleaseWorkers(
      release.replace('secrets.'+canonical, 'secrets.'+legacy),RELEASE_WORKERS),
      /Wrong GitHub Secret source|Legacy GitHub Secret source forbidden/);
    assert.throws(()=>verifyReleaseWorkers(
      release.replace("inputs.worker == '"+worker+"' && secrets."+canonical,
        "inputs.worker == 'raindrop-mcp-worker' && secrets."+canonical),RELEASE_WORKERS),
      /Wrong GitHub Secret source/);
    assert.throws(()=>verifyReleaseWorkers(
      release.replace('          '+canonical+':',
        '          '+legacy+': ${{ secrets.'+legacy+' }}\n          '+canonical+':'),RELEASE_WORKERS),
      /Legacy GitHub Secret source forbidden|Legacy runtime binding forbidden/);
  }
});

test('Spec #804 Browser candidate stage receives canonical account ID', () => {
  const stage = release.split('      - name: Stage approved Worker variables\n')[1]
    ?.split('      - name: Pin the reviewed unified Actions Worker')[0];
  assert.ok(stage);
  assert.ok(stage.includes('CLOUDFLARE_ACCOUNT_ID: ' + '$' + '{{ vars.CLOUDFLARE_ACCOUNT_ID }}'));
  assert.match(stage, /OWNER_EMAIL:/);
  assert.match(stage, /node scripts\/worker-release-variables\.mjs/);
});

test('Spec #804 Browser protected Runner probe excludes any production release',()=>{
  assert.match(release,/browser_access_readonly:/);
  assert.match(release,/inputs\.browser_access_readonly != true/);
  const probe=release.split('  browser-access-readonly:\n')[1]?.split('\n  deploy:\n')[0];
  assert.ok(probe);
  assert.match(probe,/inputs\.deploy_to_production == false/);
  assert.match(probe,/node scripts\/manual-worker-release\.mjs preflight browser-mcp-worker/);
  assert.doesNotMatch(probe,/wrangler|pnpm exec wrangler|gh secret|cloudflare.*(?:POST|PUT|DELETE)/);
});

test('Spec #804 read-only mode cannot trigger any mutation branch',()=>{
  for(const name of ['deploy','workflow-actions-migration-prepare',
    'workflow-actions-gate-reopen','workflow-uu-table-retirement','legacy-secret-cleanup']){
    const start=release.indexOf('  '+name+':\n');
    assert.ok(start>=0);
    const text=release.slice(start,release.indexOf('    runs-on:',start));
    assert.match(text,/inputs\.browser_access_readonly != true/,
      'Mutating job must reject browser_access_readonly: '+name);
  }
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
  assert.throws(() => verifyReleaseWorkers(release.replace("inputs.browser_access_readonly != true &&\n          inputs.legacy_secret_cleanup_mode", "true &&\n          inputs.legacy_secret_cleanup_mode"), RELEASE_WORKERS), /Unsafe or unsupported release gate/);
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
