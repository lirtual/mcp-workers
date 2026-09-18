import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const outputPath = process.argv[2];
if (!outputPath) throw new Error('Usage: build-production-config.ts <output-path>');

interface WranglerConfig {
  name?: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  d1_databases?: unknown[];
  workflows?: unknown[];
  triggers?: Record<string, unknown>;
  r2_buckets?: unknown[];
  vars?: Record<string, unknown>;
}

const config = JSON.parse(await readFile(sourcePath, 'utf8')) as WranglerConfig;
const workerName = required('WORKFLOW_MCP_PRODUCTION_WORKER_NAME');
const d1Name = required('WORKFLOW_MCP_PRODUCTION_D1_DATABASE_NAME');
const d1Id = required('WORKFLOW_MCP_PRODUCTION_D1_DATABASE_ID');
const r2Bucket = required('WORKFLOW_MCP_PRODUCTION_R2_BUCKET');
const baseUrl = required('WORKFLOW_MCP_PRODUCTION_URL').replace(/\/+$/, '');

config.name = workerName;
config.workers_dev = true;
config.preview_urls = false;
config.d1_databases = [
  {
    binding: 'DB',
    database_name: d1Name,
    database_id: d1Id,
    migrations_dir: 'migrations'
  }
];
config.workflows = [
  {
    name: `${workerName}-runtime`,
    binding: 'WORKFLOW',
    class_name: 'WorkflowRuntime'
  }
];
config.triggers = { crons: [] };
config.r2_buckets = [{ binding: 'ARTIFACTS', bucket_name: r2Bucket }];
config.vars = {
  ...(config.vars ?? {}),
  GITHUB_EXECUTOR_REF: 'main',
  GITHUB_EXECUTOR_WORKFLOW: 'workflow-executor-production.yml',
  R2_BUCKET_NAME: r2Bucket,
  SMOKE_MODERN_MCP_ENDPOINT: `${baseUrl}/mcp`
};

await writeFile(outputPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log(`Wrote production Wrangler config for ${workerName} from ${appRoot}.`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
