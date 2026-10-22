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
  assert.match(workflow, /node scripts\/select-affected-apps\.mjs/);
  assert.match(workflow, /pnpm --filter "\$app" check/);
  assert.equal(workflow.includes('\n          - ssh-mcp-worker\n'), true);
  for (const files of [['apps/ssh-mcp-worker/src/hosts.ts'], ['packages/portal-auth/src/index.ts'], ['pnpm-lock.yaml']]) {
    assert.equal(selectAffectedApps(files).includes('ssh-mcp-worker'), true, files.join(','));
  }
});

test('GitHub Actions MCP is CI-checked and manually deployable from main', async () => {
  assert.deepEqual(selectAffectedApps(['apps/github-actions-mcp-worker/src/index.ts']), ['github-actions-mcp-worker']);
  assert.equal(selectAffectedApps(['pnpm-lock.yaml']).includes('github-actions-mcp-worker'), true);
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.equal(workflow.includes('\n          - github-actions-mcp-worker\n'), true);
});

test('isolated Preview uses the existing CI checks without authorizing production branch deployments', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const preview = workflow.slice(workflow.indexOf('  deploy-preview:'),workflow.indexOf('  deploy:'));
  assert.match(preview,/environment:\s+name: remote-control-v2-preview/);
  assert.match(preview,/github.ref != 'refs\/heads\/main'/);
  assert.match(preview,/github.actor == 'lirtual'/);
  assert.match(preview,/--config wrangler.v2-preview.jsonc/);
  assert.match(preview,/secrets.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(preview,/secrets.RC_V2_PREVIEW_CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(preview,/wrangler.jsonc\s/);
  const run=(worker,ref)=>{
    return execFileSync(process.execPath,['scripts/select-affected-apps.mjs'],{
      cwd:new URL('../',import.meta.url),
      env:{...process.env,EVENT_NAME:'workflow_dispatch',MANUAL_WORKER:worker,MANUAL_REF:ref},
      encoding:'utf8'
    });
  };
  assert.match(run('remote-control-v2-preview','refs/heads/topic-review'),
    /Selected applications: remote-control-mcp-worker/);
  assert.throws(()=>run('remote-control-v2-preview','refs/heads/main'),/Unsupported manual Worker selection/);
  assert.throws(()=>run('remote-control-mcp-worker','refs/heads/topic-review'),/Unsupported manual Worker selection/);
  assert.match(run('remote-control-mcp-worker','refs/heads/main'),/Selected applications: remote-control-mcp-worker/);
});
