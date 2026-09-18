export interface WorkflowRunParams {
  runId: string;
}

export interface Env {
  MCP_ACCESS_TOKEN?: string;
  EXECUTOR_LEASE_SECRET?: string;
  GITHUB_OIDC_ISSUER?: string;
  GITHUB_OIDC_AUDIENCE?: string;
  GITHUB_OIDC_JWKS_URL?: string;
  GITHUB_ACTIONS_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_REPOSITORY_ID?: string;
  GITHUB_EXECUTOR_REF?: string;
  GITHUB_EXECUTOR_WORKFLOW?: string;
  GITHUB_EXECUTOR_WORKFLOW_SHA?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  WORKFLOW: Workflow<WorkflowRunParams>;
}

export interface WorkflowInputMetadata {
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  enum?: readonly string[];
}

export interface WorkflowMetadata {
  id: string;
  name: string;
  description?: string;
  definitionDigest: string;
  triggerTypes: readonly string[];
  inputs: Readonly<Record<string, WorkflowInputMetadata>>;
  stepCapabilities: readonly string[];
}

export interface WorkflowRegistryEntry {
  sourcePath: string;
  definitionDigest: string;
  metadata: WorkflowMetadata;
  plan: unknown;
}
