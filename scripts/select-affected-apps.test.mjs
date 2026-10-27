import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { selectAffectedApps, selectionDetails } from './select-affected-apps.mjs';

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
  const run=(worker,ref)=>execFileSync(process.execPath,['scripts/select-affected-apps.mjs'],{
    cwd:new URL('../',import.meta.url),
    env:{...process.env,EVENT_NAME:'workflow_dispatch',MANUAL_WORKER:worker,MANUAL_REF:ref},
    encoding:'utf8'
  });
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

test('Email MCP is CI-checked but cannot be selected for production until Spec #279 acceptance', async () => {
  assert.deepEqual(selectAffectedApps(['apps/email-mcp-worker/src/index.ts']), ['email-mcp-worker']);
  assert.ok(selectAffectedApps(['pnpm-lock.yaml']).includes('email-mcp-worker'));
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.equal(release.includes('\n          - email-mcp-worker\n'), true);
  const run = (ref) => execFileSync(process.execPath, ['scripts/select-affected-apps.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, EVENT_NAME: 'workflow_dispatch', MANUAL_WORKER: 'email-mcp-worker', MANUAL_REF: ref },
    encoding: 'utf8',
  });
  assert.match(run('refs/heads/main'), /email-mcp-worker/);
  assert.throws(() => run('refs/heads/other'), /Unsupported manual Worker selection/);
});

test('HTTP MCP is CI-selected',()=>{
  assert.deepEqual(selectAffectedApps(['apps/http-mcp-worker/src/http.ts']),['http-mcp-worker']);
  assert.equal(selectAffectedApps(['pnpm-lock.yaml']).includes('http-mcp-worker'),true);
});

test('Weixin production release remains main-only and explicitly selected', () => {
  assert.deepEqual(selectAffectedApps(['apps/weixin-mcp-worker/poc/protocol.mjs']), ['weixin-mcp-worker']);
  assert.ok(selectAffectedApps(['pnpm-lock.yaml']).includes('weixin-mcp-worker'));
  const run=(ref)=>execFileSync(process.execPath, ['scripts/select-affected-apps.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, EVENT_NAME: 'workflow_dispatch', MANUAL_WORKER: 'weixin-mcp-worker', MANUAL_REF: ref },
    encoding: 'utf8'
  });
  const release=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.ok(release.includes('\n          - weixin-mcp-worker\n'));
  assert.match(run('refs/heads/main'),/Selected applications: weixin-mcp-worker/);
  assert.throws(()=>run('refs/heads/draft'),/Unsupported manual Worker selection/);
});
