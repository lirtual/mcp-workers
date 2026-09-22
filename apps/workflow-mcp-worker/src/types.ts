export interface WorkflowRunParams {
  runId: string;
}

export interface Env {
  CF_VERSION_METADATA?: {
    id: string;
    tag?: string;
    timestamp?: string;
  };
  MCP_ACCESS_TOKEN?: string;
  /** Owner-provisioned JSON array of at most 64 approved dynamic webhook Secret names. */
  WEBHOOK_SECRET_ALLOWLIST?: string;
  /** Explicit OFF-by-default gate for isolated D1-backed list/get only. */
  DYNAMIC_WORKFLOW_REGISTRY_ENABLED?: string;
  /** T06: explicitly opt in to version-pinned D1 manual admission; OFF by default. */
  DYNAMIC_WORKFLOW_ADMISSION_ENABLED?: string;
  EXECUTOR_LEASE_SECRET?: string;
  GITHUB_ACTIONS_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_REPOSITORY_ID?: string;
  GITHUB_EXECUTOR_WORKFLOW_SHA?: string;
  ADMIN_PUBLISHER_REPOSITORY_ID?: string;
  ADMIN_PUBLISHER_WORKFLOW_REF?: string;
  ADMIN_PUBLISHER_REF?: string;
  ADMIN_PUBLISHER_WORKFLOW_SHA?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  DB: D1Database;
  ARTIFACTS?: R2Bucket;
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
