import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acceptAgentReleaseReadback,
  acceptImmutableBeforeLatest,
  requireReadbackAfterPromotion,
  reviewAgentPublication,
} from '../scripts/agent-release-guard.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const workflows = path.join(root, '.github/workflows');
const TAG = 'v0.2.0';
const SOURCE = '0123456789abcdef0123456789abcdef01234567';
const SCRIPT = 'ab'.repeat(32);
const PLATFORMS = [
  ['linux-x64-glibc', 'ubuntu-24.04', '.tar.gz', '11'],
  ['linux-arm64-glibc', 'ubuntu-24.04-arm', '.tar.gz', '22'],
  ['windows-x64', 'windows-x64', '.zip', '33'],
  ['darwin-arm64', 'darwin-arm64', '.tar.gz', '44'],
  ['darwin-x64', 'darwin-x64', '.tar.gz', '55'],
];

function bundleFor(target) {
  const bundle = {
    name: 'remote-control-agent',
    version: TAG,
    target,
    artifact_schema: 1,
    device_protocol: 2,
    upgrade_protocol: null,
  };
  if (target.startsWith('darwin-')) {
    return {
      ...bundle,
      receipt_schema: 1,
      candidate_profile: 'darwin-permanent-local-v1',
      native_supervisor: 'darwin-owned-group-v1',
      source_commit: SOURCE,
      upgrade_profile: null,
    };
  }
  if (target === 'windows-x64') return { ...bundle, upgrade_profile: 'paired-full-v1' };
  return { ...bundle, receipt_schema: 1, upgrade_profile: 'paired-full-v1' };
}

function candidateFor([target, artifact, extension, digestByte]) {
  const sha256 = digestByte.repeat(32);
  return {
    target,
    artifact: `${TAG}-${artifact}`,
    name: `remote-control-agent-${TAG}-${target}${extension}`,
    sha256,
    observedSha256: sha256,
    bundle: bundleFor(target),
  };
}

function reviewed() {
  return {
    event: 'workflow_dispatch',
    ref: 'refs/heads/main',
    actor: 'lirtual',
    deployWorker: false,
    releaseTag: TAG,
    sourceSha: SOURCE,
    immutableReleases: { enabled: true },
    existingRelease: false,
    existingTag: false,
    candidateRun: {
      event: 'workflow_dispatch',
      path: '.github/workflows/agent-native-candidates.yml',
      head_branch: 'main',
      head_sha: SOURCE,
      status: 'completed',
      conclusion: 'success',
    },
    macosScriptSha256: SCRIPT,
    sourceMacosScriptSha256: SCRIPT,
    candidates: PLATFORMS.map(candidateFor),
  };
}

function published() {
  const input = reviewed();
  return {
    releaseTag: TAG,
    sourceSha: SOURCE,
    expectedAssets: input.candidates.map(({ name, sha256 }) => ({ name, sha256 })),
    downloaded: input.candidates.map(({ name, sha256 }) => ({ name, sha256 })),
    release: {
      tag_name: TAG,
      draft: false,
      prerelease: false,
      immutable: true,
      assets: input.candidates.map(({ name, sha256 }) => ({
        name,
        state: 'uploaded',
        digest: `sha256:${sha256}`,
      })),
    },
    latest: { tag_name: TAG, draft: false, prerelease: false, immutable: true },
    tag: { object: { type: 'commit', sha: SOURCE } },
  };
}

test('a reviewed five-platform candidate can be published manually and read back as immutable Latest', () => {
  assert.deepEqual(reviewAgentPublication(reviewed()), { ok: true });
  assert.deepEqual(acceptAgentReleaseReadback(published()), { ok: true });
});

test('push, an incomplete set, a duplicate, an unreviewed run, drift, damage, and an existing tag are refused', () => {
  assert.throws(() => reviewAgentPublication({ ...reviewed(), event: 'push' }),
    /push-triggered publication is refused/);
  const missing = reviewed();
  missing.candidates = missing.candidates.filter((item) => item.target !== 'darwin-x64');
  assert.throws(() => reviewAgentPublication(missing), /incomplete native candidate/);
  const duplicate = reviewed();
  duplicate.candidates = [...duplicate.candidates, { ...duplicate.candidates[0] }];
  assert.throws(() => reviewAgentPublication(duplicate), /duplicate native candidate/);
  const unreviewed = reviewed();
  unreviewed.candidateRun = { ...unreviewed.candidateRun, conclusion: 'failure' };
  assert.throws(() => reviewAgentPublication(unreviewed), /unreviewed native candidate/);
  const pullRequest = reviewed();
  pullRequest.candidateRun = { ...pullRequest.candidateRun, event: 'pull_request' };
  assert.throws(() => reviewAgentPublication(pullRequest), /unreviewed native candidate/);
  const drifted = reviewed();
  drifted.candidateRun = { ...drifted.candidateRun, head_sha: 'f'.repeat(40) };
  assert.throws(() => reviewAgentPublication(drifted), /candidate source drifted/);
  const scriptDrift = reviewed();
  scriptDrift.macosScriptSha256 = 'cd'.repeat(32);
  assert.throws(() => reviewAgentPublication(scriptDrift), /candidate source drifted/);
  const damaged = reviewed();
  damaged.candidates = damaged.candidates.map((item, index) => (
    index === 0 ? { ...item, observedSha256: 'ee'.repeat(32) } : item
  ));
  assert.throws(() => reviewAgentPublication(damaged), /damaged native candidate/);
  assert.throws(() => reviewAgentPublication({ ...reviewed(), existingTag: true }),
    /existing release may not be overwritten/);
  assert.throws(() => reviewAgentPublication({ ...reviewed(), existingRelease: true }),
    /existing release may not be overwritten/);
  assert.throws(() => reviewAgentPublication({
    ...reviewed(),
    immutableReleases: { enabled: false },
  }), /immutable releases are not enabled/);
  assert.deepEqual(reviewAgentPublication({
    ...reviewed(),
    immutableReleases: { enabled: false, pendingProbe: true },
  }), { ok: true });
  assert.throws(() => acceptImmutableBeforeLatest({
    releaseTag: TAG,
    release: { tag_name: TAG, draft: false, prerelease: false, immutable: false },
    latest: null,
  }), /immutable releases are not enabled/);
  assert.deepEqual(acceptImmutableBeforeLatest({
    releaseTag: TAG,
    release: { tag_name: TAG, draft: false, prerelease: false, immutable: true },
    latest: null,
  }), { ok: true });
  assert.throws(() => reviewAgentPublication({ ...reviewed(), deployWorker: true }),
    /Worker production release is not part of Agent publication/);
  assert.throws(() => reviewAgentPublication({ ...reviewed(), releaseTag: 'v0.0.0-ci' }),
    /unreviewed native candidate/);
  assert.throws(() => reviewAgentPublication({ ...reviewed(), releaseTag: 'v0.1.53-rc.1' }),
    /unreviewed native candidate/);
});

test('readback stops unless the release is a complete immutable stable Latest', () => {
  assert.throws(() => acceptAgentReleaseReadback({ ...published(), releaseTag: 'v0.1.53-rc.1' }),
    /Release is not an immutable stable Latest/);
  const otherLatest = published();
  otherLatest.latest = { ...otherLatest.latest, tag_name: 'v0.1.51' };
  assert.throws(() => acceptAgentReleaseReadback(otherLatest),
    /Release is not an immutable stable Latest/);
  const mutable = published();
  mutable.release = { ...mutable.release, immutable: false };
  assert.throws(() => acceptAgentReleaseReadback(mutable),
    /Release is not an immutable stable Latest/);
  const prerelease = published();
  prerelease.release = { ...prerelease.release, prerelease: true };
  assert.throws(() => acceptAgentReleaseReadback(prerelease),
    /Release is not an immutable stable Latest/);
  const partial = published();
  partial.release = {
    ...partial.release,
    assets: partial.release.assets.filter((asset) => !asset.name.includes('darwin-x64')),
  };
  assert.throws(() => acceptAgentReleaseReadback(partial), /partial native Release/);
  const conflict = published();
  conflict.release = { ...conflict.release, tag_name: 'v0.2.1' };
  assert.throws(() => acceptAgentReleaseReadback(conflict), /GitHub release conflict/);
  const badDownload = published();
  badDownload.downloaded = badDownload.downloaded.map((item, index) => (
    index === 2 ? { ...item, sha256: '99'.repeat(32) } : item
  ));
  assert.throws(() => acceptAgentReleaseReadback(badDownload), /damaged native candidate/);
});

test('the guard command refuses a push fixture and does not require GitHub', () => {
  const guard = fileURLToPath(new URL('../scripts/agent-release-guard.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [guard, 'preflight'], {
    input: JSON.stringify({ ...reviewed(), event: 'push' }),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /push-triggered publication is refused/);
});

test('only the manual Agent workflow can publish, and it does not deploy the Worker', () => {
  const files = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));
  const publishers = files.filter((name) => (
    /\bgh release create\b/.test(readFileSync(path.join(workflows, name), 'utf8'))
  ));
  assert.deepEqual(publishers, ['agent-release.yml']);
  const workflow = readFileSync(path.join(workflows, 'agent-release.yml'), 'utf8');
  const triggers = workflow.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1];
  assert.ok(triggers);
  assert.match(triggers, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(triggers, /^  push:/m);
  assert.doesNotMatch(triggers, /release-pins|pull_request:|workflow_run:/);
  assert.match(workflow, /Agent publication requires the manual main workflow/);
  assert.match(workflow, /node apps\/remote-control-mcp-worker\/agent\/scripts\/agent-release-guard\.mjs preflight/);
  assert.match(workflow, /node apps\/remote-control-mcp-worker\/agent\/scripts\/agent-release-guard\.mjs readback/);
  assert.match(workflow, /repos\/\$GH_REPO\/immutable-releases/);
  const preflight = workflow.slice(0, workflow.indexOf('Publish the draft'));
  const probeAt = preflight.indexOf('agent-release-guard.mjs probe');
  assert.ok(preflight.includes('HTTP 403'));
  assert.ok(preflight.indexOf('pendingProbe') < preflight.indexOf('make_latest=false'));
  assert.ok(preflight.indexOf('make_latest=false') < probeAt);
  assert.ok(probeAt < preflight.indexOf('awaiting-latest'));
  assert.doesNotMatch(preflight, /make_latest=true/);
  const promotion = workflow.slice(workflow.indexOf('Publish the draft'));
  assert.ok(promotion.indexOf('awaiting-latest') < promotion.indexOf('make_latest=true'));
  assert.doesNotMatch(workflow, /-X (?:PUT|DELETE)|--method (?!GET|PATCH)\w+[^\n]*immutable-releases|immutable-releases[^\n]*-X PUT/);
  assert.match(workflow, /make_latest=true/);
  assert.match(workflow, /prerelease=false/);
  assert.deepEqual(requireReadbackAfterPromotion(workflow), { ok: true });
  const hashedBeforePromotion = workflow.replace(
    'release="$(gh api "repos/$GH_REPO/releases/tags/$RELEASE_TAG")"',
    'gh release download "$RELEASE_TAG" --repo "$GH_REPO" --dir "$work/recheck" --clobber\n          sha256sum "$work/recheck/early"\n          release="$(gh api "repos/$GH_REPO/releases/tags/$RELEASE_TAG")"',
  );
  assert.throws(() => requireReadbackAfterPromotion(hashedBeforePromotion),
    /downloaded and rehashed after/);
  assert.doesNotMatch(workflow, /wrangler|uses: \.\/\.github\/workflows\/release\.yml|workflow-mcp-worker/);
  for (const name of [
    'remote-control-agent-$RELEASE_TAG-linux-x64-glibc.tar.gz',
    'remote-control-agent-$RELEASE_TAG-linux-arm64-glibc.tar.gz',
    'remote-control-agent-$RELEASE_TAG-windows-x64.zip',
    'remote-control-agent-$RELEASE_TAG-darwin-arm64.tar.gz',
    'remote-control-agent-$RELEASE_TAG-darwin-x64.tar.gz',
  ]) assert.ok(workflow.includes(name), name);
  assert.equal(existsSync(path.join(root, 'install.ps1')), false);
  assert.equal(existsSync(path.join(root, 'apps/remote-control-mcp-worker/agent/install.ps1')), true);
  assert.equal(existsSync(path.join(root, '.github/release-pins')), false);
});
