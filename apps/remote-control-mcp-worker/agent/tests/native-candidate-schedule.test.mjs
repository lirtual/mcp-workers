import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.match(ci, /needs: checks\n    if: needs\.checks\.outputs\.agent_native_changed == 'true'\n    uses: \.\/\.github\/workflows\/agent-native-candidates\.yml\n    with:\n      candidate_tag: v0\.1\.61/);
  assert.doesNotMatch(ci, /\bgh release create\b/);
  assert.doesNotMatch(release, /\bgh release create\b|agent-native-candidates|release-pins/);
  assert.doesNotMatch(candidates, /^  push:/m);
  // Explicit Agent test entrypoints must exist after runtime/test retirement.
  for (const line of candidates.split('\n').filter(line => line.includes('node --experimental-strip-types --test tests/'))) {
    for (const file of line.trim().split(/\s+/).filter(part => part.startsWith('tests/'))) {
      assert.ok(existsSync(path.join(root, 'apps/remote-control-mcp-worker/agent', file)), `missing candidate test: ${file}`);
    }
  }

  assert.match(candidates, /rust_agent="\$RCA_TEST_TEMP\/build\/rca-standard-linux-candidate"/);
  assert.match(candidates, /--out "\$RCA_TEST_TEMP\/native-only"/);
  assert.doesNotMatch(candidates, /RCA_TEST_TEMP\/package|linux-systemd-upgrade-recovery\.integration\.mjs/);
  assert.match(candidates, /linux-native-only-systemd\.integration\.mjs/);
  assert.doesNotMatch(candidates, /\bgh release (?:create|edit|upload|delete)\b|wrangler deploy|uses: \.\/\.github\/workflows\/release\.yml|release-pins/);
  assert.match(candidates, /^  workflow_dispatch:$/m);
  assert.match(candidates, /Manual native candidates are built from main only/);
  // New manual candidates use the intended stable tag only; old releases remain historical.
  assert.doesNotMatch(candidates, /rust-candidate|Save unpublished Linux Node-free review artifact/);
  assert.ok(candidates.includes('name: ${{ inputs.candidate_tag }}-windows-x64'));
  assert.ok(candidates.includes('name: ${{ inputs.candidate_tag }}-${{ matrix.runner }}'));
  assert.ok(candidates.includes('cp -- "$output/$asset" "$output/SHA256SUMS.txt" "release-candidate/$RCA_TEST_TARGET/"'));
  assert.ok(!candidates.includes('name: ${{ inputs.candidate_tag }}-${{ matrix.os }}'));
  const linuxReview=candidates.slice(candidates.indexOf('      - name: Assemble unpublished Linux Node-free artifact'),candidates.indexOf('  macos-native-candidate:'));
  assert.match(linuxReview,/--artifact-profile rust-native-only-v1/);
  const macosReview=candidates.slice(candidates.indexOf('  macos-native-candidate:'));
  assert.match(macosReview,/name: Rust-only native macOS 15/);
  assert.match(macosReview,/--artifact-profile rust-native-only-v1/);
  assert.match(macosReview,/--rust-agent-bin/);
  const core=ci.slice(ci.indexOf('  rust-agent-candidate:'),ci.indexOf('  database-integration:'));
  assert.doesNotMatch(core,/cargo build --locked --release|build-agent-release[.]mjs|macos-native-local-lifecycle[.]integration[.]mjs/);
  assert.match(core,/Verify Darwin owned-group and signed managed WSS/);
  const macJob=macosReview.split('  windows-native-preview:')[0];
  assert.equal((macJob.match(/cargo build --locked --release/g)||[]).length,1);
  assert.equal((macJob.match(/cc -std=c11/g)||[]).length,1);
  for (const marker of ['Interactive menu requires a local terminal','pty.openpty()', 'doctor.findings', 'macos-native-local-lifecycle.integration.mjs','cmp "$temp_dir/first/$asset" "$temp_dir/second/$asset"']) {
    assert.ok(macJob.includes(marker), marker);
  }
  assert.equal(selectionDetails(['apps/remote-control-mcp-worker/agent/native-rust/src/lib.rs']).agentNativeChanged,true);

  assert.doesNotMatch(macosReview,/--node-bin|node_archive_sha256|node-v24[.]21[.]0/);
  assert.doesNotMatch(macosReview,/macos-packaged-runtime-smoke|macos-local[.]test[.]mjs|macos-remote-upgrade[.]test[.]mjs/);
  assert.doesNotMatch(macosReview,/macos-local[.]sh install/);
  const windowsReview=candidates.slice(candidates.indexOf('      - name: Assemble verifiable Windows release candidate'));
  assert.match(windowsReview,/'--artifact-profile','rust-native-only-v1'/);
  assert.doesNotMatch(windowsReview,/\$nativeOnly = \$tag/);
  assert.doesNotMatch(candidates,/candidate-rust-version\.zip|windows-rust-candidate-reopened/);
  assert.match(candidates, /WINDOWS_RUNNING_WITHOUT_SIGNED_WSS_REJECTED/);
  for (const name of ['Save reviewed native candidate for manual Release promotion','Save unpublished macOS candidate for owner-native E2E']) {
    assert.ok(candidates.includes(name + "\n        if: github.event_name == 'workflow_dispatch'"));
  }


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
    'build-agent-release.mjs',
    'build-windows-release.mjs',
    'darwin-session-supervisor',
  ]) {
    assert.ok(candidates.includes(marker), marker);
  }

  const agent = selectionDetails(['apps/remote-control-mcp-worker/agent/scripts/build-session-supervisor.mjs']);
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
    assert.deepEqual(agentPush.changedFiles, ['apps/remote-control-mcp-worker/agent/scripts/build-session-supervisor.mjs']);
    assert.equal(selectionDetails(agentPush.changedFiles).agentNativeChanged, true);
  } finally {
    process.chdir(previous);
    rmSync(history.dir, { recursive: true, force: true });
  }
});


test('Legacy candidate is isolated from the Standard release gate and built on shared source changes', () => {
  const ci = read('.github/workflows/ci.yml');
  const standard = read('.github/workflows/agent-native-candidates.yml');
  const legacy = read('.github/workflows/agent-legacy-candidate.yml');
  const release = read('.github/workflows/agent-release.yml');
  assert.doesNotMatch(standard, /linux-legacy-candidate|linux-x64-legacy-glibc/);
  assert.doesNotMatch(release, /agent-legacy-candidate|linux-x64-legacy-glibc/);
  assert.match(ci, /agent-legacy-candidate:\n    name: Independent Legacy candidate\n    needs: checks\n    if: needs\.checks\.outputs\.agent_legacy_changed == 'true'\n    uses: \.\/\.github\/workflows\/agent-legacy-candidate\.yml/);
  assert.match(legacy, /Manual Legacy candidates are built from main only/);
  assert.match(legacy, /Save independent unpublished Legacy candidate\n        if: github.event_name == 'workflow_dispatch'/);
  assert.match(legacy, /name: \$\{\{ inputs\.candidate_tag \}\}-linux-x64-legacy-glibc/);
  assert.match(legacy, /source-commit\.txt/);
  assert.doesNotMatch(legacy, /gh release (?:create|edit|upload|delete)|contents: write|wrangler deploy/);
  const own = selectionDetails(['.github/workflows/agent-legacy-candidate.yml']);
  assert.equal(own.agentNativeChanged, false);
  assert.equal(own.agentLegacyChanged, true);
  assert.deepEqual(own.apps, ['remote-control-mcp-worker']);
  assert.equal(selectionDetails(['apps/remote-control-mcp-worker/agent/native-rust/src/lib.rs']).agentLegacyChanged, true);
  assert.equal(selectionDetails(['apps/remote-control-mcp-worker/agent/scripts/session-supervisor.c']).agentLegacyChanged, true);
  assert.equal(selectionDetails(['apps/remote-control-mcp-worker/src/worker.ts']).agentLegacyChanged, false);
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
  mkdirSync(path.join(dir, 'apps/remote-control-mcp-worker/agent/scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'apps/remote-control-mcp-worker/agent/scripts/build-session-supervisor.mjs'), 'export {}\n');
  git(['add', 'apps/remote-control-mcp-worker/agent/scripts/build-session-supervisor.mjs']);
  git(['commit', '-q', '-m', 'agent']);
  const agent = git(['rev-parse', 'HEAD']).toString().trim();
  return { dir, base, worker, agent };
}
