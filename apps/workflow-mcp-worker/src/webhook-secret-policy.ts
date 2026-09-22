/** Platform-owned Worker bindings must not be re-used as webhook tokens. */
const PLATFORM_PREFIXES = [
  'MCP_', 'EXECUTOR_', 'GITHUB_', 'ADMIN_', 'R2_', 'CF_', 'DYNAMIC_WORKFLOW_'
] as const;

const PLATFORM_BINDINGS = new Set(['DB', 'WORKFLOW', 'ARTIFACTS']);

export function isProtectedWebhookSecret(name: string): boolean {
  return PLATFORM_BINDINGS.has(name) ||
    PLATFORM_PREFIXES.some(prefix => name.startsWith(prefix));
}
