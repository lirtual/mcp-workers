import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  for (const file of ['packages/portal-auth/src/index.ts', 'pnpm-lock.yaml']) {
    const selection = selectionDetails([file]);
    assert.ok(selection.apps.includes('ssh-mcp-worker'), file);
    assert.equal(selection.portalAuthChanged, file.startsWith('packages/portal-auth/'));
  }
});

test('the existing workflow runs ssh-mcp-worker check for both selector results and does not release it', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node scripts\/select-affected-apps\.mjs/);
  assert.match(workflow, /pnpm --filter "\$app" check/);
  assert.equal(workflow.includes('\n          - ssh-mcp-worker\n'), false);
  for (const files of [['apps/ssh-mcp-worker/src/hosts.ts'], ['packages/portal-auth/src/index.ts'], ['pnpm-lock.yaml']]) {
    assert.equal(selectAffectedApps(files).includes('ssh-mcp-worker'), true, files.join(','));
  }
});
