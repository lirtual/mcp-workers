import { spawnSync } from 'node:child_process';
import { runReleaseCompatibilityGate } from '../src/provenance.js';

const appRoot = new URL('..', import.meta.url);
const mode = process.argv.includes('--local') ? '--local' : '--remote';

const query = `
SELECT wr.run_id, wr.definition_digest, wdv.dsl_version, sa.execution_manifest_json
FROM workflow_runs wr
JOIN workflow_definition_versions wdv
  ON wdv.definition_digest = wr.definition_digest
LEFT JOIN step_runs sr ON sr.run_id = wr.run_id
LEFT JOIN step_attempts sa
  ON sa.step_run_id = sr.step_run_id
 AND sa.execution_manifest_json IS NOT NULL
WHERE wr.state IN ('queued', 'running', 'waiting', 'cancel_requested')
ORDER BY wr.run_id ASC;
`.trim();

const result = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'execute', 'workflow-mcp', mode, '--json', '--command', query],
  {
    cwd: appRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Wrangler D1 compatibility query failed: ${(result.stderr || result.stdout).trim()}`
  );
}

const rows = extractRows(JSON.parse(result.stdout || '[]'));
const grouped = new Map<
  string,
  {
    runId: string;
    definitionDigest: string;
    dslVersion: number;
    manifestVersions: number[];
    hasInvalidManifest: boolean;
  }
>();

for (const row of rows) {
  const runId = String(row.run_id);
  let record = grouped.get(runId);
  if (!record) {
    record = {
      runId,
      definitionDigest: String(row.definition_digest),
      dslVersion: Number(row.dsl_version),
      manifestVersions: [],
      hasInvalidManifest: false
    };
    grouped.set(runId, record);
  }

  if (row.execution_manifest_json !== null && row.execution_manifest_json !== undefined) {
    try {
      const parsed: unknown = JSON.parse(String(row.execution_manifest_json));
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).version === 'number'
      ) {
        record.manifestVersions.push(
          Number((parsed as Record<string, unknown>).version)
        );
      } else {
        record.hasInvalidManifest = true;
      }
    } catch {
      record.hasInvalidManifest = true;
    }
  }
}

await runReleaseCompatibilityGate({
  async listNonterminalCompatibilityRecords() {
    return [...grouped.values()];
  }
});

console.log(
  `Release compatibility gate passed for ${grouped.size} nonterminal workflow run(s).`
);

function extractRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(item => extractRows(item));
  }
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
