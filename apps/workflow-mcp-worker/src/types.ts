export interface Env {
  MCP_ACCESS_TOKEN?: string;
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
