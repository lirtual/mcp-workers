import { CANONICAL_SCHEDULER_CRON, GITHUB_EXECUTOR_CONFIG } from './platform-config.js';

export interface WranglerDeployConfig {
  name?: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  keep_vars?: boolean;
  d1_databases?: unknown[];
  workflows?: unknown[];
  triggers?: { crons?: unknown };
  r2_buckets?: unknown[];
  vars?: Record<string, unknown>;
  secrets?: { required?: string[] };
  [key: string]: unknown;
}

export interface WorkflowDeployContext {
  WORKFLOW_MCP_WORKER_NAME: string;
  WORKFLOW_MCP_D1_DATABASE_NAME: string;
  WORKFLOW_MCP_D1_DATABASE_ID: string;
  WORKFLOW_MCP_R2_BUCKET: string;
  WORKFLOW_MCP_URL: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  GITHUB_REPOSITORY: string;
  GITHUB_REPOSITORY_ID: string;
  R2_ACCESS_KEY_ID: string;
}

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function readWorkflowDeployContext(
  env: Record<string, string | undefined>
): WorkflowDeployContext {
  return {
    WORKFLOW_MCP_WORKER_NAME: required(env, 'WORKFLOW_MCP_WORKER_NAME'),
    WORKFLOW_MCP_D1_DATABASE_NAME: required(env, 'WORKFLOW_MCP_D1_DATABASE_NAME'),
    WORKFLOW_MCP_D1_DATABASE_ID: required(env, 'WORKFLOW_MCP_D1_DATABASE_ID'),
    WORKFLOW_MCP_R2_BUCKET: required(env, 'WORKFLOW_MCP_R2_BUCKET'),
    WORKFLOW_MCP_URL: required(env, 'WORKFLOW_MCP_URL'),
    CLOUDFLARE_ACCOUNT_ID: required(env, 'CLOUDFLARE_ACCOUNT_ID'),
    GITHUB_REPOSITORY: required(env, 'GITHUB_REPOSITORY'),
    GITHUB_REPOSITORY_ID: required(env, 'GITHUB_REPOSITORY_ID'),
    R2_ACCESS_KEY_ID: required(env, 'R2_ACCESS_KEY_ID')
  };
}

export function buildWorkflowDeployConfig(
  source: WranglerDeployConfig,
  context: WorkflowDeployContext
): WranglerDeployConfig {
  if (context.GITHUB_REPOSITORY !== GITHUB_EXECUTOR_CONFIG.repository) {
    throw new Error('GITHUB_REPOSITORY does not match the trusted executor repository.');
  }
  if (context.GITHUB_REPOSITORY_ID !== GITHUB_EXECUTOR_CONFIG.repositoryId) {
    throw new Error('GITHUB_REPOSITORY_ID does not match the trusted executor repository ID.');
  }
  if (!ACCOUNT_ID.test(context.CLOUDFLARE_ACCOUNT_ID)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character Cloudflare account ID.');
  }
  if (!R2_BUCKET.test(context.WORKFLOW_MCP_R2_BUCKET)) {
    throw new Error('WORKFLOW_MCP_R2_BUCKET must be a valid R2 bucket name.');
  }

  const baseUrl = context.WORKFLOW_MCP_URL.replace(/\/+$/, '');
  const parsedUrl = new URL(baseUrl);
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error('WORKFLOW_MCP_URL must be an HTTPS URL without credentials or query.');
  }

  const crons = source.triggers?.crons;
  if (
    !Array.isArray(crons) ||
    crons.length !== 1 ||
    crons[0] !== CANONICAL_SCHEDULER_CRON
  ) {
    throw new Error('Canonical one-minute Workflow MCP Cron is missing or inconsistent.');
  }

  const workerName = context.WORKFLOW_MCP_WORKER_NAME;
  const preservedVars = omitVars(source.vars ?? {}, [
    'GITHUB_OIDC_ISSUER',
    'GITHUB_OIDC_AUDIENCE',
    'GITHUB_OIDC_JWKS_URL',
    'GITHUB_EXECUTOR_REF',
    'GITHUB_EXECUTOR_WORKFLOW',
    'SMOKE_MODERN_MCP_ENDPOINT',
    'SMOKE_READONLY_MCP_ENDPOINT'
  ]);

  return {
    ...source,
    name: workerName,
    workers_dev: true,
    preview_urls: false,
    keep_vars: false,
    d1_databases: [
      {
        binding: 'DB',
        database_name: context.WORKFLOW_MCP_D1_DATABASE_NAME,
        database_id: context.WORKFLOW_MCP_D1_DATABASE_ID,
        migrations_dir: 'migrations'
      }
    ],
    workflows: [
      {
        name: `${workerName}-runtime`,
        binding: 'WORKFLOW',
        class_name: 'WorkflowRuntime'
      }
    ],
    triggers: { crons: [CANONICAL_SCHEDULER_CRON] },
    r2_buckets: [{ binding: 'ARTIFACTS', bucket_name: context.WORKFLOW_MCP_R2_BUCKET }],
    vars: {
      ...preservedVars,
      GITHUB_REPOSITORY: context.GITHUB_REPOSITORY,
      GITHUB_REPOSITORY_ID: context.GITHUB_REPOSITORY_ID,
      R2_ACCOUNT_ID: context.CLOUDFLARE_ACCOUNT_ID,
      R2_BUCKET_NAME: context.WORKFLOW_MCP_R2_BUCKET,
      R2_ACCESS_KEY_ID: context.R2_ACCESS_KEY_ID
    }
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function omitVars(vars: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const next = { ...vars };
  for (const key of keys) delete next[key];
  return next;
}
