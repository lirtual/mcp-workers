import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { APPLICATIONS, RELEASE_WORKERS } from './select-affected-apps.mjs';
import { verifyDatabaseActivationGate, verifyDocumentationContracts, verifyReleaseWorkers, verifyStaticWorkflowReferences } from './verify-workflow-dispatch-gates.mjs';

const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('current production release choices, guarded allowlist and releasable Workers agree', () => {
  assert.doesNotThrow(() => verifyReleaseWorkers(release, RELEASE_WORKERS));
});

test('retired Email encryption secret is not referenced by production release', () => {
  assert.doesNotThrow(() => verifyReleaseWorkers(release, RELEASE_WORKERS));
  assert.throws(() => verifyReleaseWorkers(release + '\nMAIL_ENCRYPTION_KEY: ${{ secrets.MAIL_ENCRYPTION_KEY }}\n', RELEASE_WORKERS),
    /Retired Email Secret reference remains/);
});

test('a missing or duplicated manual Worker choice fails', () => {
  assert.throws(() => verifyReleaseWorkers(release.replace('          - http-mcp-worker\n', ''), RELEASE_WORKERS), /Mismatched manual release choices/);
  assert.throws(() => verifyReleaseWorkers(release.replace('          - http-mcp-worker\n', '          - http-mcp-worker\n          - http-mcp-worker\n'), RELEASE_WORKERS), /Duplicate manual release choices/);
});

test('a missing allowed Worker or an unsafe gate bypass fails', () => {
  assert.throws(() => verifyReleaseWorkers(release.replace("           inputs.worker == 'http-mcp-worker' ||\n", ''), RELEASE_WORKERS), /Mismatched release allowlist/);
  assert.throws(() => verifyReleaseWorkers(release.replace("(inputs.worker == 'raindrop-mcp-worker' ||", "(true || inputs.worker == 'raindrop-mcp-worker' ||"), RELEASE_WORKERS), /Unsafe or unsupported Worker allowlist/);
  assert.throws(() => verifyReleaseWorkers(release.replace("needs.checks.result == 'success' &&", "true &&"), RELEASE_WORKERS), /Unsafe or unsupported release gate/);
});

test('historical registry activation job is retired and cannot be dispatched', () => {
  assert.doesNotThrow(() => verifyDatabaseActivationGate(release));
  assert.throws(() => verifyDatabaseActivationGate(release + '\n  database-activate:\n'), /Historical Database activation/);
  assert.throws(() => verifyDatabaseActivationGate(release + '\n      database_activation_id:\n'), /Historical Database activation/);
  assert.throws(() => verifyDatabaseActivationGate(release + '\n        run: node scripts/activate-database-hyperdrive.mjs\n'), /Duplicate or missing protected Hyperdrive/);
  for (const unsafe of [
    ["github.actor == 'lirtual' &&", 'true &&'],
    ['inputs.database_hyperdrive_enable_approved == true', 'true'],
    ['inputs.deploy_to_production == false', 'true'],
    ['group: worker-release-database-mcp-worker', 'group: no-lock']
  ]) {
    const at = release.indexOf('\n  database-hyperdrive-enable:\n');
    const part = release.slice(at);
    assert.ok(at >= 0 && part.includes(unsafe[0]));
    const broken = release.slice(0, at) + part.replace(unsafe[0], unsafe[1]);
    assert.throws(() => verifyDatabaseActivationGate(broken), /Unsafe Hyperdrive activation/);
  }
  for (const retired of [
    '      database_restore_approved:', '  database-restore:',
    '      database_aiven_provision_approved:', '  database-aiven-provision:',
    '  database-prepare:', '  database-direct-preflight:'
  ]) assert.throws(() => verifyDatabaseActivationGate(release + '\n' + retired + '\n'),
    /Retired Database compatibility/);
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

test('Database lifecycle and Actions ingress dispatch preserve all twelve reviewed inputs',()=>{
  const inputs=release.slice(release.indexOf('    inputs:'),release.indexOf('\npermissions:'));
  const names=[...inputs.matchAll(/^      ([a-z][a-z0-9_]*):$/gm)].map(m=>m[1]);
  assert.ok(names.length===12,'release workflow_dispatch must have exactly twelve reviewed inputs');
  assert.equal(new Set(names).size,names.length);
  assert.ok(names.includes('database_expected_release_sha'));
  assert.ok(names.includes('actions_old_ingress_quiesced'));
  assert.ok(names.includes('actions_migration_prepare'));
  const deploy=release.slice(release.indexOf('\n  deploy:\n'));
  assert.match(deploy,/github.actor == 'lirtual'/);
  assert.match(deploy,/GITHUB_ACTOR.*lirtual/);
  assert.match(deploy,/GITHUB_SHA.*DATABASE_EXPECTED_RELEASE_SHA/);
  assert.match(deploy,/DATABASE_EXPECTED_RELEASE_SHA.*\^\[a-f0-9\]\{40\}/);
});


test('final apply job enforces exact gate, scopes, permissions and no conflicting deployment',async()=>{
  const {verifyDatabaseApplyGate}=await import('./verify-workflow-dispatch-gates.mjs');
  verifyDatabaseApplyGate(release);
  for(const [from,to] of [["inputs.database_hyperdrive_apply_id != ''","true"],
    ['checks: read','checks: write'],['statuses: read',''],
    ['group: worker-release-database-mcp-worker','group: another-lock'],
    ["inputs.database_hyperdrive_apply_id == ''",'true']]) {
    assert.throws(()=>verifyDatabaseApplyGate(release.replaceAll(from,to)));
  }
});


test('postrelease requires successful deploy and its pinned published version with read-only GitHub scope',async()=>{
  const {verifyDatabaseFinalizeGate}=await import('./verify-workflow-dispatch-gates.mjs');
  verifyDatabaseFinalizeGate(release);
  for(const [from,to] of [["needs.deploy.result == 'success'",'true'],
    ['needs: deploy','needs: checks'],['needs.deploy.outputs.version_id','steps.preflight.outputs.version_id'],
    ['steps.publish.outputs.version_id','steps.preflight.outputs.version_id'],
    ['actions: read','actions: write'],['ref: ${{ github.sha }}','ref: main'],
    ["inputs.deploy_to_production == true && needs.deploy.result", "inputs.deploy_to_production == false && needs.deploy.result"]])
    assert.throws(()=>verifyDatabaseFinalizeGate(release.replaceAll(from,to)));
});


test('existing CI candidate dispatch retains Owner/repo/provenance gates and no production secrets',async()=>{
  const {verifyCandidateCiGate}=await import('./verify-workflow-dispatch-gates.mjs');
  const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  verifyCandidateCiGate(ci);
  for(const [before,after] of [["github.actor == 'lirtual'",'true'],
    ["github.repository == 'lirtual/mcp-workers'",'true'],
    ['git diff --no-renames --name-status','git diff --stat'],
    ['git show -s --format=%P HEAD','git show -s --format=%H HEAD'],
    ['"$GITHUB_SHA" == "$CANDIDATE_SHA"','true'],
    ['contents: read','contents: write']]) {
    assert.throws(()=>verifyCandidateCiGate(ci.replace(before,after)));
  }
  assert.throws(()=>verifyCandidateCiGate(ci+'\n  environment: database-mcp-worker\n'));
  assert.throws(()=>verifyCandidateCiGate(ci+'\n  token: ${{ secrets.DATABASE_GITHUB_ACTIONS_TOKEN }}\n'));
});


test('candidate guards preserve reusable CI under manual release and acceptance caller events',()=>{
  const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const job=ci.match(/    if: \$\{\{ (.+) \}\}/)[1];
  const provenance=ci.match(/        if: (github.event_name == 'workflow_dispatch'.+)/)[1];
  const reusable=ci.match(/REUSABLE_WORKER: \$\{\{ (.+) \}\}/)[1];
  const evaluate=(expr,github,inputs)=>Function('github','inputs','contains','startsWith','return '+expr)(
    github,inputs,(value,part)=>value.includes(part),(value,part)=>value.startsWith(part));
  const github={repository:'lirtual/mcp-workers',actor:'lirtual',event_name:'workflow_dispatch',
    ref:'refs/heads/main',workflow_ref:'lirtual/mcp-workers/.github/workflows/release.yml@refs/heads/main'};
  for(const caller of ['release.yml','acceptance.yml']) {
    const context={...github,workflow_ref:'lirtual/mcp-workers/.github/workflows/'+caller+'@refs/heads/main'};
    const inputs={worker:'database-mcp-worker'};
    assert.equal(evaluate(job,context,inputs),true);
    assert.equal(evaluate(provenance,context,inputs),false);
    assert.equal(evaluate(reusable,context,inputs),'database-mcp-worker');
  }
  const direct={...github,workflow_ref:'lirtual/mcp-workers/.github/workflows/ci.yml@refs/heads/main'};
  assert.equal(evaluate(job,direct,{worker:'database-mcp-worker'}),false);
  const candidate={...direct,ref:'refs/heads/db476-12345678-1234-1234-1234-123456789abc'};
  assert.equal(evaluate(job,candidate,{worker:'database-mcp-worker'}),true);
  assert.equal(evaluate(provenance,candidate,{}),true);
  assert.equal(evaluate(reusable,candidate,{worker:'database-mcp-worker'}),'');
  assert.equal(evaluate(job,{...candidate,actor:'attacker'},{worker:'database-mcp-worker'}),false);
  assert.equal(evaluate(job,{...candidate,repository:'lirtual/fork'},{worker:'database-mcp-worker'}),false);
  assert.equal(evaluate(job,candidate,{worker:'unsupported-worker'}),false);
  for(const event_name of ['push','pull_request'])
    assert.equal(evaluate(job,{...direct,event_name},{}),true);
});

test('Hyperdrive retirement cannot merge or release a staged unbinding without separately proven isolation',async()=>{
  const {verifyDatabaseRetireStagingGate}=await import('./verify-workflow-dispatch-gates.mjs');
  const stage=readFileSync(new URL('./prepare-database-hyperdrive-unbind-476.mjs',import.meta.url),'utf8');
  verifyDatabaseRetireStagingGate(release,stage);
  for(const [from,to] of [
    ["inputs.database_hyperdrive_retire_approved == true",'true'],
    ["inputs.deploy_to_production == false",'true'],
    ["github.actor == 'lirtual'",'true'],
    ["if: steps.unbind.outputs.action == 'retire'",'if: always()'],
    ['run: node scripts/prepare-database-hyperdrive-unbind-476.mjs','run: node scripts/retire-database-hyperdrive.mjs'],
  ]) {
    const start=release.indexOf('\n  database-hyperdrive-retire:\n');
    const before=release.slice(0,start),after=release.slice(start);
    assert.throws(()=>verifyDatabaseRetireStagingGate(before+after.replace(from,to),stage));
  }
  for (const badScript of [
    stage+"\nawait github('/pulls/73/merge','PUT',{})",
    stage+"\nawait github('/actions/workflows/release.yml/dispatches','POST',{})",
    stage.replace("draft:true,body:","draft:false,body:")
  ])assert.throws(()=>verifyDatabaseRetireStagingGate(release,badScript));
});

test('Database CI preserves local-only Wrangler D1 drain regression without a second pipeline', () => {
  const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const testSource=readFileSync(new URL('../apps/database-mcp-worker/scripts/d1-drain-wrangler.test.mjs',import.meta.url),'utf8');
  assert.match(ci,/name: Verify isolated Wrangler D1 lifecycle and in-flight protection/);
  assert.match(ci,/run: node --test apps\/database-mcp-worker\/scripts\/d1-drain-wrangler\.test\.mjs/);
  assert.match(testSource,/'--local'/);
  assert.match(testSource,/syntheticId='00000000-0000-4000-8000-000000000476'/);
  assert.doesNotMatch(testSource,/'--remote'/);
  assert.match(release,/name: Verify Database D1 schema and fresh registry before publication \(read-only\)/);
});

test('Hyperdrive credentials and CA checks cannot mutate or start any other release job',async()=>{
  const {verifyDatabaseRotationGate}=await import('./verify-workflow-dispatch-gates.mjs');
  const script=readFileSync(new URL('./check-database-hyperdrive-rotation-476.mjs',import.meta.url),'utf8');
  verifyDatabaseRotationGate(release,script);
  const mutations=[
    release.replace("inputs.database_hyperdrive_rotation_mode == 'ca'", "inputs.database_hyperdrive_rotation_mode == 'unsafe'"),
    release.replace('run: node scripts/check-database-hyperdrive-rotation-476.mjs','run: node scripts/apply-database-hyperdrive-476.mjs'),
    release.replace("inputs.deploy_to_production == false &&\n          (inputs.database_hyperdrive_rotation_mode", "inputs.deploy_to_production == true &&\n          (inputs.database_hyperdrive_rotation_mode"),
    release.replace('name: Check Hyperdrive rotation safety (read-only, no deployment)','name: Check Hyperdrive rotation safety (read-only, no deployment)\n    permissions:\n      contents: write')
  ];
  for(const bad of mutations)assert.throws(()=>verifyDatabaseRotationGate(bad,script));
  assert.throws(()=>verifyDatabaseRotationGate(release,script+"\nconst bad={method:'PATCH'};"));
  assert.throws(()=>verifyDatabaseRotationGate(release,script+"\nawait query('DELETE FROM database_connections');"));
});


test('Owner password rotation dispatch cannot enable, retire, deploy, or bypass exact operation confirmation',()=>{
 const job=release.split('\n  database-hyperdrive-credentials:\n')[1]?.split('\n  database-hyperdrive-rotation-check:\n')[0];
 assert.ok(job);
 const expression=job.match(/    if: >-\n\s*\$\{\{([\s\S]*?)\}\}/)?.[1];
 assert.ok(expression);
 const evaluate=Function('github','inputs','return '+expression);
 const github={event_name:'workflow_dispatch',ref:'refs/heads/main',actor:'lirtual'};
 const inputs={worker:'database-mcp-worker',deploy_to_production:false,
  database_hyperdrive_rotation_mode:'credentials_apply',database_hyperdrive_prepare_id:'12345678-1234-1234-1234-123456789abc',
  database_hyperdrive_apply_id:'',database_hyperdrive_id:'',database_hyperdrive_revision:'',
  database_expected_release_sha:'',database_hyperdrive_enable_approved:false,
  database_hyperdrive_retire_approved:false};
 assert.equal(evaluate(github,inputs),true);
 for(const inputPatch of [{deploy_to_production:true},{database_hyperdrive_prepare_id:''},
  {database_hyperdrive_rotation_mode:'credentials'},
  {database_hyperdrive_rotation_mode:'ca'},{database_hyperdrive_enable_approved:true},
  {database_hyperdrive_retire_approved:true},{database_hyperdrive_apply_id:'other'},
  {database_hyperdrive_id:'other'}])assert.equal(evaluate(github,{...inputs,...inputPatch}),false);
 for(const contextPatch of [{actor:'untrusted'},{event_name:'pull_request'},
  {ref:'refs/heads/feature'}])assert.equal(evaluate({...github,...contextPatch},inputs),false);
 assert.match(job,/group: worker-release-database-mcp-worker/);
 assert.match(job,/run: node scripts\/rotate-database-hyperdrive-476.mjs/);
 assert.match(job,/contents: read/);
 assert.doesNotMatch(job,/contents: write|pull-requests: write|wrangler deploy/);
});
