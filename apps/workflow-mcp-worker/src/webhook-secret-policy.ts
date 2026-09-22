/** Platform-owned Worker bindings must not be re-used as webhook tokens. */
const PLATFORM_PREFIXES = [
  'MCP_', 'EXECUTOR_', 'GITHUB_', 'ADMIN_', 'R2_', 'CF_', 'DYNAMIC_WORKFLOW_'
] as const;

const PLATFORM_BINDINGS = new Set(['DB', 'WORKFLOW', 'ARTIFACTS', 'WEBHOOK_SECRET_ALLOWLIST']);

export function isProtectedWebhookSecret(name: string): boolean {
  return PLATFORM_BINDINGS.has(name) ||
    PLATFORM_PREFIXES.some(prefix => name.startsWith(prefix));
}

/**
 * The owner provisions a bounded non-secret list independently of YAML.
 * No name is authorized merely because it exists in the Worker Env.
 * A missing or malformed allowlist disables all dynamic webhook bindings.
 */
export function hasApprovedWebhookBinding(
  env: Readonly<Record<string, unknown>>, name: string
): boolean {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || isProtectedWebhookSecret(name)) return false;
  const raw = env.WEBHOOK_SECRET_ALLOWLIST;
  if (typeof raw !== 'string' || raw.length > 8192) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64 ||
      !parsed.every(item => typeof item === 'string' &&
        /^[A-Z][A-Z0-9_]{0,127}$/.test(item) && !isProtectedWebhookSecret(item)) ||
      new Set(parsed).size !== parsed.length || !parsed.includes(name)) {
    return false;
  }
  const value = env[name];
  return typeof value === 'string' && value.length > 0;
}
