import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { selectAffectedApps, selectionDetails, APPLICATIONS, RELEASE_WORKERS, selectionForEvent } from './select-affected-apps.mjs';

test('an ssh-mcp-worker-only change selects and schedules its app check', () => {
  const selection = selectionDetails(['apps/ssh-mcp-worker/src/hosts.ts']);
  assert.deepEqual(selection.apps, ['ssh-mcp-worker']);
  assert.equal(selection.apps.includes('ssh-mcp-worker'), true);
});

test('pinned public Agent staging selects existing Remote Control Worker compatibility checks', () => {
  const selection = selectionDetails(['scripts/stage-public-remote-control-agent.sh']);
  assert.deepEqual(selection.apps, ['remote-control-mcp-worker']);
  assert.equal(selection.remoteControlChanged, true);
  assert.equal(selection.apps.includes('ssh-mcp-worker'), false);
});

test('shared package and lockfile changes select every app, including ssh-mcp-worker', () => {
  for (const file of ['packages/portal-auth/src/index.ts', 'pnpm-lock.yaml', 'scripts/worker-release-variables.mjs', 'scripts/bootstrap-worker-secrets.mjs']) {
    const selection = selectionDetails([file]);
    assert.ok(selection.apps.includes('ssh-mcp-worker'), file);
    assert.equal(selection.portalAuthChanged, file.startsWith('packages/portal-auth/'));
  }
});

test('SSH remains CI-checked and can be manually selected for production release', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node scripts\/select-affected-apps\.mjs/);
  assert.match(workflow, /pnpm --filter "\$app" check/);
  assert.equal(release.includes('\n          - ssh-mcp-worker\n'), true);
  for (const files of [['apps/ssh-mcp-worker/src/hosts.ts'], ['packages/portal-auth/src/index.ts'], ['pnpm-lock.yaml']]) {
    assert.equal(selectAffectedApps(files).includes('ssh-mcp-worker'), true, files.join(','));
  }
});

test('GitHub Actions MCP is CI-checked and manually deployable from main', async () => {
  assert.deepEqual(selectAffectedApps(['apps/github-actions-mcp-worker/src/index.ts']), ['github-actions-mcp-worker']);
  assert.equal(selectAffectedApps(['pnpm-lock.yaml']).includes('github-actions-mcp-worker'), true);
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.equal(workflow.includes('\n          - github-actions-mcp-worker\n'), true);
});

test('retired Preview cannot be redeployed, and production still requires main', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /remote-control-v2-preview|deploy-preview:|wrangler\\.v2-preview/);
  const run=(worker,ref)=>'Selected applications: '+selectionForEvent({EVENT_NAME:'workflow_dispatch',
    MANUAL_WORKER:worker,MANUAL_REF:ref}).selected.join(' ');
  assert.throws(()=>run('remote-control-v2-preview','refs/heads/topic-review'),/Unsupported manual Worker selection/);
  assert.throws(()=>run('remote-control-v2-preview','refs/heads/main'),/Unsupported manual Worker selection/);
  assert.throws(()=>run('remote-control-mcp-worker','refs/heads/topic-review'),/Unsupported manual Worker selection/);
  assert.match(run('remote-control-mcp-worker','refs/heads/main'),/Selected applications: remote-control-mcp-worker/);
});

test('Workflow MCP Workflow is CI-checked and may only be manually released from main', async () => {
  assert.deepEqual(selectAffectedApps(['apps/workflow-mcp-worker/src/index.ts']), ['workflow-mcp-worker']);
  assert.ok(selectAffectedApps(['pnpm-lock.yaml']).includes('workflow-mcp-worker'));
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.equal(workflow.includes('\n          - workflow-mcp-worker\n'), true);
});


test('HTTP MCP is CI-selected',()=>{
  assert.deepEqual(selectAffectedApps(['apps/http-mcp-worker/src/http.ts']),['http-mcp-worker']);
  assert.equal(selectAffectedApps(['pnpm-lock.yaml']).includes('http-mcp-worker'),true);
});

test('Browser MCP Worker and packaging changes select CI and the existing manual release gate', () => {
  assert.deepEqual(selectAffectedApps(['apps/browser-mcp-worker/src/worker.ts']), ['browser-mcp-worker']);
  assert.deepEqual(selectAffectedApps(['apps/browser-mcp-worker/extension/background.js']), ['browser-mcp-worker']);
  assert.ok(selectAffectedApps(['pnpm-lock.yaml']).includes('browser-mcp-worker'));
  assert.ok(RELEASE_WORKERS.includes('browser-mcp-worker'));
  for (const file of ['scripts/build-browser-extension.py','scripts/browser-extension-manifest.json','docs/browser-extension/INSTALL.md','docs/browser-extension/NOTICES.md'])
    assert.deepEqual(selectAffectedApps([file]), ['browser-mcp-worker']);
});

test('retired Email Worker is neither test-selected nor deployable', async () => {
 assert.ok(!APPLICATIONS.includes('email-mcp-worker'));
 assert.ok(!RELEASE_WORKERS.includes('email-mcp-worker'));
 assert.deepEqual(selectAffectedApps(['apps/email-mcp-worker/src/index.ts']),[]);
 const run=event=>selectionForEvent({EVENT_NAME:event,MANUAL_WORKER:'email-mcp-worker',
   REUSABLE_WORKER:event==='workflow_call'?'email-mcp-worker':'',MANUAL_REF:'refs/heads/main'});
 assert.throws(()=>run('workflow_dispatch'),/Unsupported manual Worker selection/);
 assert.throws(()=>run('workflow_call'),/Unsupported reusable Worker selection/);
 const release=await readFile(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
 assert.ok(!release.includes('\n          - email-mcp-worker\n'));
});

test('retired Weixin Worker is neither test-selected nor deployable',async()=>{
 assert.ok(!APPLICATIONS.includes('weixin-mcp-worker'));
 assert.ok(!RELEASE_WORKERS.includes('weixin-mcp-worker'));
 assert.deepEqual(selectAffectedApps(['apps/weixin-mcp-worker/poc/protocol.mjs']),[]);
 const run=event=>selectionForEvent({EVENT_NAME:event,MANUAL_WORKER:'weixin-mcp-worker',
    REUSABLE_WORKER:event==='workflow_call'?'weixin-mcp-worker':'',MANUAL_REF:'refs/heads/main'});
 assert.throws(()=>run('workflow_dispatch'),/Unsupported manual Worker selection/);
 assert.throws(()=>run('workflow_call'),/Unsupported reusable Worker selection/);
 const release=await readFile(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
 assert.ok(!release.includes('\n          - weixin-mcp-worker\n'));
});


test('candidate CI selects full Database checks only for Owner/repo and exact db476 UUID branch',()=>{
  const env={EVENT_NAME:'workflow_dispatch',MANUAL_WORKER:'database-mcp-worker',
    MANUAL_REF:'refs/heads/db476-12345678-1234-1234-1234-123456789abc',
    GITHUB_REPOSITORY:'lirtual/mcp-workers',GITHUB_ACTOR:'lirtual'};
  const result=selectionForEvent(env);
  assert.deepEqual(result.selected,['database-mcp-worker']);
  assert.equal(selectionDetails(['apps/database-mcp-worker/wrangler.jsonc']).databaseChanged,true);
  for(const [key,value] of [['GITHUB_ACTOR','attacker'],['GITHUB_REPOSITORY','lirtual/fork'],
    ['MANUAL_REF','refs/heads/db476-invalid'],['MANUAL_WORKER','retired-worker']])
    assert.throws(()=>selectionForEvent({...env,[key]:value}),/Unsupported manual Worker selection/);
});
