import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const evidencePath = required('STAGING_EVIDENCE_PATH');
const config = required('WORKFLOW_MCP_WRANGLER_CONFIG');
const repository = required('GITHUB_REPOSITORY');
const token = required('GITHUB_TOKEN');
const evidence = asObject(JSON.parse(await readFile(evidencePath, 'utf8')));
const heavy = asObject(evidence.heavy);
const heavyRunId = heavy.runId;
if (typeof heavyRunId !== 'string') throw new Error('Evidence is missing heavy.runId.');
if (!/^run_[A-Za-z0-9_-]+$/.test(heavyRunId)) throw new Error('Heavy run ID has an unexpected format.');

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const query = `
SELECT sa.github_run_id, sa.github_run_attempt, sa.state, sa.executor_version, sa.executor_revision
FROM step_attempts sa
JOIN step_runs sr ON sr.step_run_id = sa.step_run_id
WHERE sr.run_id = '${heavyRunId.replace(/'/g, "''")}'
  AND sr.step_id = 'archive'
ORDER BY sa.attempt_number DESC
LIMIT 1;
`.trim();

const command = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'execute', 'DB', '--remote', '--json', '--command', query, '--config', config],
  { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
);
if (command.error) throw command.error;
if (command.status !== 0) {
  throw new Error(`D1 executor evidence query failed: ${(command.stderr || command.stdout).trim()}`);
}
const rows = extractRows(JSON.parse(command.stdout || '[]'));
if (rows.length !== 1) throw new Error(`Expected one archive Attempt row; found ${rows.length}.`);
const row = rows[0]!;
const githubRunId = String(row.github_run_id || '');
if (!/^\d+$/.test(githubRunId)) throw new Error('Archive Attempt has no valid GitHub run ID.');
if (String(row.state) !== 'succeeded') {
  throw new Error(`Archive Attempt state is ${String(row.state)}, expected succeeded.`);
}

const response = await fetch(
  `https://api.github.com/repos/${repository}/actions/runs/${githubRunId}`,
  {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'workflow-mcp-staging-gate'
    }
  }
);
if (!response.ok) throw new Error(`GitHub run lookup failed with status ${response.status}.`);
const run = asObject(await response.json());
if (run.status !== 'completed' || run.conclusion !== 'success') {
  throw new Error(
    `GitHub executor run ${githubRunId} is ${String(run.status)}/${String(run.conclusion)}, expected completed/success.`
  );
}

evidence.githubExecutor = {
  runId: githubRunId,
  runAttempt: Number(row.github_run_attempt),
  state: row.state,
  executorVersion: row.executor_version,
  executorRevision: row.executor_revision,
  status: run.status,
  conclusion: run.conclusion,
  htmlUrl: run.html_url
};
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(evidence.githubExecutor, null, 2));

function extractRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(extractRows);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.results)) {
    return object.results.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    );
  }
  if (object.result) return extractRows(object.result);
  return [];
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object.');
  }
  return value as Record<string, unknown>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
