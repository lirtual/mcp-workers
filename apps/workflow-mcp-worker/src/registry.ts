import { workflowRegistry } from './generated/workflow-registry.js';
import type { WorkflowRegistryEntry } from './types.js';

const entries = workflowRegistry as unknown as readonly WorkflowRegistryEntry[];
const byId = new Map(entries.map(entry => [entry.metadata.id, entry] as const));

export function getWorkflowRegistry(): readonly WorkflowRegistryEntry[] {
  return entries;
}

export function findWorkflow(workflowId: string): WorkflowRegistryEntry | undefined {
  return byId.get(workflowId);
}
