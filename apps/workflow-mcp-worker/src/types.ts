export interface WorkflowRunParams {
  runId: string;
}

export interface Env {
  MCP_ACCESS_TOKEN?: string;
  EXECUTOR_LEASE_SECRET?: string;
  GITHUB_OIDC_ISSUER?: string;
  GITHUB_OIDC_AUDIENCE?: string;
  GITHUB_OIDC_JWKS_URL?: string;
  DB: D1Database;
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
