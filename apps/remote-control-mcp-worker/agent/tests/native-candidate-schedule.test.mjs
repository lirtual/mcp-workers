import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectionDetails, selectionForEvent } from '../../../../scripts/select-affected-apps.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (name) => readFileSync(path.join(root, name), 'utf8');

test('five native candidate jobs are scheduled only by a nested Agent change and do not publish', () => {
  const ci = read('.github/workflows/ci.yml');
  const candidates = read('.github/workflows/agent-native-candidates.yml');
  const release = read('.github/workflows/release.yml');

  assert.match(ci, /agent_native_changed: \$\{\{ steps\.scope\.outputs\.agent_native_changed \}\}/);
  assert.match(ci, /needs: checks\n    if: needs\.checks\.outputs\.agent_native_changed == 'true'\n    uses: \.\/\.github\/workflows\/agent-native-candidates\.yml\n    with:\n      candidate_tag: v0\.0\.0-ci/);
  assert.doesNotMatch(ci, /\bgh release create\b/);
  assert.doesNotMatch(release, /\bgh release create\b|agent-native-candidates|release-pins/);
  assert.doesNotMatch(candidates, /^  push:/m);
  assert.doesNotMatch(candidates, /\bgh release\b|wrangler deploy|uses: \.\/\.github\/workflows\/release\.yml|release-pins/);
  assert.match(candidates, /^  workflow_dispatch:$/m);
  assert.match(candidates, /Manual native candidates are built from main only/);

  for (const marker of [
    'ubuntu-24.04',
    'ubuntu-24.04-arm',
    'windows-2025',
    'macos-15',
    'macos-15-intel',
    'linux-x64-glibc',
    'linux-arm64-glibc',
    'windows-x64',
    'darwin-arm64',
    'darwin-x64',
    'validate-local-archive.py',
    'build-v2-release.mjs',
    'build-windows-preview.mjs',
    'darwin-session-supervisor',
  ]) {
    assert.ok(candidates.includes(marker), marker);
  }

  const agent = selectionDetails(['apps/remote-control-mcp-worker/agent/src/v2-main.ts']);
  assert.equal(agent.agentNativeChanged, true);
  assert.deepEqual(agent.apps, ['remote-control-mcp-worker']);

  const workerOnly = selectionDetails(['apps/remote-control-mcp-worker/src/worker.ts']);
  assert.equal(workerOnly.agentNativeChanged, false);
  assert.equal(workerOnly.remoteControlChanged, true);

  const candidateWorkflow = selectionDetails(['.github/workflows/agent-native-candidates.yml']);
  assert.equal(candidateWorkflow.agentNativeChanged, true);
  assert.deepEqual(candidateWorkflow.apps, ['remote-control-mcp-worker']);

  const publishWorkflow = selectionDetails(['.github/workflows/agent-release.yml']);
  assert.equal(publishWorkflow.agentNativeChanged, false);
  assert.deepEqual(publishWorkflow.apps, ['remote-control-mcp-worker']);

  const placeholder = selectionForEvent({
    EVENT_NAME: 'push',
    MANUAL_REF: 'refs/heads/main',
    BEFORE_SHA: 'abc',
  });
  assert.equal(selectionDetails(placeholder.changedFiles).agentNativeChanged, false);
  assert.ok(placeholder.selected.includes('ssh-mcp-worker'));

  const history = temporaryPushHistory();
  const previous = process.cwd();
  try {
    process.chdir(history.dir);
    const workerOnlyPush = selectionForEvent({
      EVENT_NAME: 'push',
      MANUAL_REF: 'refs/heads/main',
      BEFORE_SHA: history.base,
      GITHUB_SHA: history.worker,
    });
    assert.deepEqual(workerOnlyPush.changedFiles, ['apps/remote-control-mcp-worker/src/worker.ts']);
    assert.equal(selectionDetails(workerOnlyPush.changedFiles).agentNativeChanged, false);
    assert.ok(workerOnlyPush.selected.includes('remote-control-mcp-worker'));
    assert.ok(workerOnlyPush.selected.includes('ssh-mcp-worker'));

    const agentPush = selectionForEvent({
      EVENT_NAME: 'push',
      MANUAL_REF: 'refs/heads/main',
      BEFORE_SHA: history.worker,
      GITHUB_SHA: history.agent,
    });
    assert.deepEqual(agentPush.changedFiles, ['apps/remote-control-mcp-worker/agent/src/v2-main.ts']);
    assert.equal(selectionDetails(agentPush.changedFiles).agentNativeChanged, true);
  } finally {
    process.chdir(previous);
    rmSync(history.dir, { recursive: true, force: true });
  }
});

function temporaryPushHistory() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rca-native-schedule-'));
  const git = (args) => execFileSync('git', args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'rca-test',
      GIT_AUTHOR_EMAIL: 'rca-test@example.com',
      GIT_COMMITTER_NAME: 'rca-test',
      GIT_COMMITTER_EMAIL: 'rca-test@example.com',
    },
  });
  git(['init', '-q']);
  writeFileSync(path.join(dir, 'README'), 'base\n');
  git(['add', 'README']);
  git(['commit', '-q', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']).toString().trim();
  mkdirSync(path.join(dir, 'apps/remote-control-mcp-worker/src'), { recursive: true });
  writeFileSync(path.join(dir, 'apps/remote-control-mcp-worker/src/worker.ts'), 'export {}\n');
  git(['add', 'apps/remote-control-mcp-worker/src/worker.ts']);
  git(['commit', '-q', '-m', 'worker']);
  const worker = git(['rev-parse', 'HEAD']).toString().trim();
  mkdirSync(path.join(dir, 'apps/remote-control-mcp-worker/agent/src'), { recursive: true });
  writeFileSync(path.join(dir, 'apps/remote-control-mcp-worker/agent/src/v2-main.ts'), 'export {}\n');
  git(['add', 'apps/remote-control-mcp-worker/agent/src/v2-main.ts']);
  git(['commit', '-q', '-m', 'agent']);
  const agent = git(['rev-parse', 'HEAD']).toString().trim();
  return { dir, base, worker, agent };
}
