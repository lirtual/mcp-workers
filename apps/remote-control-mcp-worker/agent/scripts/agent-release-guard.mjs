import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MANIFEST_NAME, renderAgentReleaseManifest } from './agent-release-manifest.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stable tags only. Installers reject a prerelease suffix, and this workflow publishes prerelease=false.
const TAG = /^v0\.[1-9][0-9]*\.[0-9]+$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CANDIDATE_WORKFLOW = '.github/workflows/agent-native-candidates.yml';
const TARGETS = [
  { target: 'linux-x64-glibc', artifact: 'ubuntu-24.04', extension: '.tar.gz', kind: 'linux' },
  { target: 'linux-arm64-glibc', artifact: 'ubuntu-24.04-arm', extension: '.tar.gz', kind: 'linux' },
  { target: 'windows-x64', artifact: 'windows-x64', extension: '.zip', kind: 'windows' },
  { target: 'darwin-arm64', artifact: 'darwin-arm64', extension: '.tar.gz', kind: 'darwin' },
  { target: 'darwin-x64', artifact: 'darwin-x64', extension: '.tar.gz', kind: 'darwin' },
];

function fail(message) {
  throw new Error(message);
}

function absent(value) {
  return value == null;
}

function bundleMatches(spec, bundle, input) {
  if (!bundle
    || bundle.name !== 'remote-control-agent'
    || bundle.version !== input.releaseTag
    || bundle.target !== spec.target
    || bundle.artifact_schema !== 1
    || bundle.device_protocol !== 2
    || !absent(bundle.upgrade_protocol)) return false;
  if (spec.kind === 'darwin') {
    return bundle.receipt_schema === 1
      && bundle.candidate_profile === 'darwin-permanent-local-v1'
      && bundle.native_supervisor === 'darwin-owned-group-v1'
      && absent(bundle.upgrade_profile)
      && bundle.source_commit === input.sourceSha;
  }
  if (bundle.upgrade_profile !== 'paired-full-v1') return false;
  if (spec.kind === 'linux' && bundle.receipt_schema !== 1) return false;
  return true;
}

export function reviewAgentPublication(input) {
  if (input?.event === 'push') fail('push-triggered publication is refused');
  if (input?.event !== 'workflow_dispatch'
    || input.ref !== 'refs/heads/main'
    || input.actor !== 'lirtual') {
    fail('Agent publication requires a manual main workflow');
  }
  if (input.deployWorker === true) fail('Worker production release is not part of Agent publication');
  if (!TAG.test(input.releaseTag ?? '')) fail('unreviewed native candidate');
  if (!SHA.test(input.sourceSha ?? '')) fail('candidate source drifted');
  // GITHUB_TOKEN cannot read the admin-only immutable-releases setting (HTTP 403).
  // pendingProbe defers that proof to a non-latest published release, before make_latest.
  if (input.immutableReleases?.enabled !== true && input.immutableReleases?.pendingProbe !== true) {
    fail('immutable releases are not enabled');
  }
  if (input.existingRelease || input.existingTag) fail('existing release may not be overwritten');

  const run = input.candidateRun ?? {};
  if (run.event !== 'workflow_dispatch'
    || run.path !== CANDIDATE_WORKFLOW
    || run.head_branch !== 'main'
    || run.status !== 'completed'
    || run.conclusion !== 'success') {
    fail('unreviewed native candidate');
  }
  if (run.head_sha !== input.sourceSha
    || input.macosScriptSha256 !== input.sourceMacosScriptSha256
    || !DIGEST.test(input.macosScriptSha256 ?? '')) {
    fail('candidate source drifted');
  }

  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const targets = candidates.map((item) => item?.target);
  if (new Set(targets).size !== targets.length) fail('duplicate native candidate');
  if (candidates.length !== TARGETS.length) fail('incomplete native candidate');
  for (const spec of TARGETS) {
    const item = candidates.find((candidate) => candidate?.target === spec.target);
    if (!item) fail('incomplete native candidate');
    const name = `remote-control-agent-${input.releaseTag}-${spec.target}${spec.extension}`;
    const artifact = `${input.releaseTag}-${spec.artifact}`;
    if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > 180_000_000) fail('damaged native candidate');
    if (item.name !== name
      || item.artifact !== artifact
      || item.sha256 !== item.observedSha256
      || !DIGEST.test(item.sha256 ?? '')
      || !bundleMatches(spec, item.bundle, input)) {
      fail('damaged native candidate');
    }
  }
  return { ok: true };
}

/** All six assets are re-downloaded and rehashed after immutable Latest promotion. */
export function requireReadbackAfterPromotion(workflow) {
  const marker = 'Publish the draft, then require an immutable stable Latest readback';
  const step = String(workflow).slice(String(workflow).indexOf(marker));
  const mark = step.indexOf('make_latest=true');
  const latest = step.indexOf('releases/latest');
  const immutable = step.indexOf('.immutable');
  const download = step.indexOf('gh release download');
  const hash = step.indexOf('sha256sum');
  const readback = step.indexOf('agent-release-guard.mjs readback');
  if (step.indexOf(marker) !== 0 || mark < 0 || latest < 0 || immutable < 0
    || download < 0 || hash < 0 || readback < 0
    || !(mark < latest && latest < immutable && immutable < download && download < hash && hash < readback)) {
    fail('six official assets must be downloaded and rehashed after the Release is stable, latest, and immutable');
  }
  return { ok: true };
}

/** A published, non-draft release must already be immutable before it is made Latest. */
export function acceptImmutableBeforeLatest(input) {
  const release = input?.release ?? {};
  if (release.tag_name !== input?.releaseTag
    || release.draft !== false
    || release.prerelease !== false
    || release.immutable !== true) {
    fail('immutable releases are not enabled');
  }
  const latest = input.latest ?? null;
  if (latest?.tag_name === input.releaseTag && latest.immutable !== true) {
    fail('immutable releases are not enabled');
  }
  return { ok: true };
}

export function acceptAgentReleaseReadback(input) {
  const release = input?.release ?? {};
  const latest = input?.latest ?? {};
  if (!TAG.test(input?.releaseTag ?? '')) fail('Release is not an immutable stable Latest');
  if (release.tag_name !== input?.releaseTag) fail('GitHub release conflict');
  if (release.draft !== false
    || release.prerelease !== false
    || release.immutable !== true
    || latest.tag_name !== input.releaseTag
    || latest.draft !== false
    || latest.prerelease !== false
    || latest.immutable !== true) {
    fail('Release is not an immutable stable Latest');
  }
  if (input.tag?.object?.type !== 'commit' || input.tag.object.sha !== input.sourceSha) {
    fail('candidate source drifted');
  }
  const expected = Array.isArray(input.expectedAssets) ? input.expectedAssets : [];
  const downloaded = Array.isArray(input.downloaded) ? input.downloaded : [];
  const assets = Array.isArray(release.assets) ? release.assets : [];
  if (expected.length !== TARGETS.length
    || downloaded.length !== TARGETS.length + 1
    || assets.length !== TARGETS.length + 1) {
    fail('partial native Release');
  }
  for (const spec of TARGETS) {
    const name = `remote-control-agent-${input.releaseTag}-${spec.target}${spec.extension}`;
    const want = expected.find((item) => item.name === name);
    const got = assets.find((item) => item.name === name);
    const file = downloaded.find((item) => item.name === name);
    if (!want || !got || !file || got.state !== 'uploaded') fail('partial native Release');
    const digest = typeof got.digest === 'string' && got.digest.startsWith('sha256:')
      ? got.digest.slice('sha256:'.length)
      : '';
    if (want.sha256 !== file.sha256 || want.sha256 !== digest ||
        got.size !== want.size || file.size !== want.size ||
        !DIGEST.test(want.sha256 ?? '')) {
      fail('damaged native candidate');
    }
  }
  // Sixth asset: canonical five-archive manifest, independently rehashed.
  const content = renderAgentReleaseManifest(input.releaseTag, expected);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const manifest = assets.find((a) => a?.name === RELEASE_MANIFEST_NAME);
  const manifestFile = downloaded.find((f) => f?.name === RELEASE_MANIFEST_NAME);
  if (input.manifest !== content || input.manifestSha256 !== sha256 ||
      !manifestFile || manifestFile.sha256 !== sha256 ||
      manifestFile.size !== Buffer.byteLength(content) ||
      !manifest || manifest.state !== 'uploaded' ||
      manifest.browser_download_url !==
        ('https://github.com/lirtual/mcp-workers/releases/download/' + input.releaseTag + '/' + RELEASE_MANIFEST_NAME) ||
      manifest.size !== Buffer.byteLength(content) ||
      manifest.digest !== 'sha256:' + sha256) {
    fail('invalid immutable Release manifest');
  }
  if (new Set(downloaded.map((a) => a?.name)).size !== TARGETS.length + 1 ||
      new Set(assets.map((a) => a?.name)).size !== TARGETS.length + 1) {
    fail('duplicate immutable Release asset');
  }
  return { ok: true };
}

function main() {
  const mode = process.argv[2];
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('Agent publication input is unreadable\n');
    process.exit(1);
  }
  try {
    if (mode === 'preflight') reviewAgentPublication(input);
    else if (mode === 'probe') acceptImmutableBeforeLatest(input);
    else if (mode === 'readback') acceptAgentReleaseReadback(input);
    else {
      process.stderr.write('unknown guard mode\n');
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
