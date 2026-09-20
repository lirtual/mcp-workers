import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const outputPath = process.argv[2];
if (!outputPath) throw new Error('Usage: build-deploy-config.ts <output-path>');

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
const workerName = required('WORKFLOW_MCP_WORKER_NAME');
const d1Name = required('WORKFLOW_MCP_D1_DATABASE_NAME');
const d1Id = required('WORKFLOW_MCP_D1_DATABASE_ID');
const r2Bucket = required('WORKFLOW_MCP_R2_BUCKET');
const baseUrl = required('WORKFLOW_MCP_URL').replace(/\/+$/, '');
const repository = required('GITHUB_REPOSITORY');
const repositoryId = required('GITHUB_REPOSITORY_ID');
const accountId = required('CLOUDFLARE_ACCOUNT_ID');
if (repository !== 'lirtual/mcp-workers') {
  throw new Error('GITHUB_REPOSITORY does not match the trusted executor repository.');
}
if (repositoryId !== '1371085786') {
  throw new Error('GITHUB_REPOSITORY_ID does not match the trusted executor repository ID.');
}
if (!/^[a-f0-9]{32}$/i.test(accountId)) {
  throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character Cloudflare account ID.');
}
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(r2Bucket)) {
  throw new Error('WORKFLOW_MCP_R2_BUCKET must be a valid R2 bucket name.');
}
const parsedUrl = new URL(baseUrl);
if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password ||
    parsedUrl.search || parsedUrl.hash) {
  throw new Error('WORKFLOW_MCP_URL must be an HTTPS URL without credentials or query.');
}

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
// A deployment must not silently remove the checked-in scheduler trigger.
const crons = config.triggers?.crons;
if (!Array.isArray(crons) || crons.length !== 1 || crons[0] !== '* * * * *') {
  throw new Error('Canonical one-minute Workflow MCP Cron is missing or inconsistent.');
}
config.r2_buckets = [{ binding: 'ARTIFACTS', bucket_name: r2Bucket }];
config.vars = {
  ...(config.vars ?? {}),
  GITHUB_REPOSITORY: repository,
  GITHUB_REPOSITORY_ID: repositoryId,
  R2_ACCOUNT_ID: accountId,
  R2_BUCKET_NAME: r2Bucket,
  SMOKE_MODERN_MCP_ENDPOINT: `${baseUrl}/mcp`
};

await writeFile(outputPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log(`Wrote Workflow MCP Wrangler config for ${workerName} from ${appRoot}.`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
