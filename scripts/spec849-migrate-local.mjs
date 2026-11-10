import {
  generateKeyPairSync, randomBytes, timingSafeEqual,
} from 'node:crypto';
import {
  mkdtempSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OLD_ENVIRONMENTS, openSecret } from './spec849-sealed-secret.mjs';

const REPO = 'lirtual/mcp-workers';
const WORKFLOW = 'spec849-sealed-secret.yml';
const ALL_SECRETS = Object.keys(OLD_ENVIRONMENTS);
const ENDPOINT = `repos/${REPO}`;
const SLEEP_MS = 6000;
const MAX_WAIT_MS = 12 * 60 * 1000;

function usage() {
  return 'Usage: node scripts/spec849-migrate-local.mjs --mode=apply|verify --secret=NAME|all --expected-main=40_HEX_SHA';
}

function parseArgs(argv) {
  const args = new Map();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || args.has(match[1])) throw new Error(usage());
    args.set(match[1], match[2]);
  }
  const mode = args.get('mode');
  const secret = args.get('secret');
  const expectedMain = args.get('expected-main');
  if (![ 'apply', 'verify' ].includes(mode)
    || (secret !== 'all' && !ALL_SECRETS.includes(secret))
    || !/^[a-f0-9]{40}$/.test(expectedMain)
    || args.size !== 3) throw new Error(usage());
  return {
    mode,
    secrets: secret === 'all' ? ALL_SECRETS : [secret],
    expectedMain,
  };
}

function runGh(args, { input, maxBuffer = 512 * 1024 } = {}) {
  const child = spawnSync('gh', args, {
    encoding: null,
    input,
    stdio: [ 'pipe', 'pipe', 'pipe' ],
    shell: false,
    maxBuffer,
    timeout: 45000,
  });
  if (child.error || child.status !== 0) {
    throw new Error('GitHub CLI operation failed; stop and inspect read-only receipts');
  }
  return child.stdout;
}

function github(path) {
  return JSON.parse(runGh(['api', path]).toString('utf8'));
}

function currentMain() {
  return github(`${ENDPOINT}/git/ref/heads/main`).object.sha;
}

function requireExactMain(expectedMain) {
  if (currentMain() !== expectedMain) {
    throw new Error('Main SHA changed; no further Settings write permitted');
  }
}

function dispatch({ phase, secretName, publicKey, nonce }) {
  const body = JSON.stringify({
    ref: 'main', return_run_details: true,
    inputs: {
      phase, secret_name: secretName, recipient_public_key: publicKey, nonce,
    },
  });
  const response = JSON.parse(runGh([
    'api', `${ENDPOINT}/actions/workflows/${WORKFLOW}/dispatches`,
    '--method', 'POST', '--input', '-',
  ], { input: Buffer.from(body) }).toString('utf8'));
  if (!Number.isSafeInteger(response.workflow_run_id) || response.workflow_run_id < 1) {
    throw new Error('Workflow dispatch response Unknown; do not retry before read-only inspection');
  }
  return response.workflow_run_id;
}

async function waitRun(runId, expectedMain) {
  const start = Date.now();
  for (;;) {
    const run = github(`${ENDPOINT}/actions/runs/${runId}`);
    if (run.head_sha !== expectedMain || run.head_branch !== 'main'
      || run.event !== 'workflow_dispatch' || run.actor?.login !== 'lirtual'
      || run.path !== `.github/workflows/${WORKFLOW}`) {
      throw new Error(`Run ${runId}: provenance mismatch`);
    }
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Run ${runId}: failed`);
      return;
    }
    if (Date.now() - start > MAX_WAIT_MS) {
      throw new Error(`Run ${runId}: still running or Unknown; inspect without redispatch`);
    }
    await new Promise(resolve => setTimeout(resolve, SLEEP_MS));
  }
}

function readArtifact(runId, directory) {
  runGh(['run', 'download', String(runId), '-R', REPO,
    '-n', 'spec849-sealed', '-D', directory ]);
  const files = readdirSync(directory);
  if (files.length !== 1 || files[0] !== 'spec849-sealed.json') {
    throw new Error('Unexpected artifact contents');
  }
  const file = readFileSync(join(directory, files[0]));
  if (file.length < 1 || file.length > 120000) {
    throw new Error('Unexpected artifact size');
  }
  return JSON.parse(file.toString('utf8'));
}

function targetExists(secretName) {
  const r = github(`${ENDPOINT}/actions/secrets`);
  return r.secrets.some(secret => secret.name === secretName);
}

function sourceStamp(secretName) {
  const env = OLD_ENVIRONMENTS[secretName];
  const secret = github(`${ENDPOINT}/environments/${env}/secrets`)
    .secrets.find(item => item.name === secretName);
  if (!secret) return null;
  const environmentId = github(`${ENDPOINT}/environments/${env}`).id;
  return `${environmentId}:${secret.created_at}:${secret.updated_at}`;
}

async function sealedValue({ phase, secretName, publicKey, privateKey,
  nonce, expectedMain, scratch }) {
  requireExactMain(expectedMain);
  const runId = dispatch({ phase, secretName, publicKey, nonce });
  process.stdout.write(`RUN ${secretName} ${phase}: ${runId}\n`);
  await waitRun(runId, expectedMain);
  const encrypted = readArtifact(runId, scratch);
  return openSecret(encrypted, { phase, secretName, privateKey, nonce });
}

async function migrateOne(secretName, mode, expectedMain) {
  const originalStamp = sourceStamp(secretName);
  if (!originalStamp) throw new Error(`${secretName}: old source absent`);
  if (mode === 'apply' && targetExists(secretName)) {
    throw new Error(`${secretName}: target already exists; run verify mode instead`);
  }
  if (mode === 'verify' && !targetExists(secretName)) {
    throw new Error(`${secretName}: target not present; cannot verify`);
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const encodedPublicKey = Buffer.from(publicKey, 'utf8').toString('base64');
  const nonce = randomBytes(16).toString('hex');
  const temp = mkdtempSync(join(tmpdir(), 'spec849-sealed-'));
  let source;
  let repository;
  try {
    const oldFolder = join(temp, 'old');
    const repoFolder = join(temp, 'repo');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(oldFolder, { mode: 0o700 });
    mkdirSync(repoFolder, { mode: 0o700 });
    source = await sealedValue({
      phase: 'old', secretName, publicKey: encodedPublicKey,
      privateKey, nonce, expectedMain, scratch: oldFolder,
    });
    if (sourceStamp(secretName) !== originalStamp) {
      throw new Error(`${secretName}: old Environment or Secret changed during seal`);
    }
    if (mode === 'apply') {
      if (targetExists(secretName)) throw new Error('Target appeared during source validation');
      requireExactMain(expectedMain);
      // No Secret plaintext on stdout, argv, file, or GitHub artifact.
      // The user must explicitly invoke --mode=apply with approved Settings scope.
      runGh(['secret', 'set', secretName, '--repo', REPO], { input: source });
      if (!targetExists(secretName)) {
        throw new Error(`${secretName}: write status Unknown; inspect target before retry`);
      }
      process.stdout.write(`WRITE ${secretName}: metadata present (not byte proof)\n`);
    }
    repository = await sealedValue({
      phase: 'repository', secretName, publicKey: encodedPublicKey,
      privateKey, nonce, expectedMain, scratch: repoFolder,
    });
    if (sourceStamp(secretName) !== originalStamp) {
      throw new Error(`${secretName}: old source changed during verification`);
    }
    const equal = source.length === repository.length && timingSafeEqual(source, repository);
    if (!equal) throw new Error(`${secretName}: BYTE_EQUALITY_FAIL; retain old Environment`);
    process.stdout.write(`BYTE_EQUALITY_PASS ${secretName}\n`);
  } finally {
    source?.fill(0);
    repository?.fill(0);
    rmSync(temp, { force: true, recursive: true });
  }
}

async function main() {
  const { mode, secrets, expectedMain } = parseArgs(process.argv.slice(2));
  const user = github('user').login;
  if (user !== 'lirtual') throw new Error('Only authenticated repository Owner is permitted');
  requireExactMain(expectedMain);
  process.stdout.write(`SPEC849 mode=${mode} secrets=${secrets.length} main=${expectedMain.slice(0, 12)}\n`);
  for (const secretName of secrets) {
    // A failure or Unknown stops the whole batch; never blind-retry a write.
    await migrateOne(secretName, mode, expectedMain);
  }
  process.stdout.write('SPEC849_ALL_SELECTED_BYTE_EQUALITY_PASS\n');
}
try {
  await main();
} catch (error) {
  process.stderr.write(`SPEC849_STOP: ${error.message}\n`);
  process.exitCode = 1;
}
