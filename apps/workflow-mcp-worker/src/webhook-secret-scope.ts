import { hasApprovedWebhookBinding } from './webhook-secret-policy.js';
import type { Env } from './types.js';

/** Platform bindings cannot be granted by an author-controlled YAML secret name. */
const SECRET_REF = /^[A-Z][A-Z0-9_]{0,127}$/;

/**
 * Resolve only a trusted, currently approved workflow + trigger + immutable
 * definition digest binding. This is authorization, not a fallback lookup.
 *
 * Callers must separately CAS the same selected definition digest/revision
 * during admission: success here alone never authorizes an external Run.
 */
export async function resolveApprovedWebhookSecret(
  env: Env,
  workflowId: string,
  triggerId: string,
  definitionDigest: string,
  declaredSecret: string
): Promise<string | null> {
  if (!env.DB || !SECRET_REF.test(declaredSecret) ||
      !hasApprovedWebhookBinding(env as unknown as Record<string, unknown>, declaredSecret)) {
    return null;
  }

  const row = await env.DB.prepare(
    `SELECT scope.secret_name, scope.enabled, scope.policy_revision,
            policy.revision AS current_policy_revision
     FROM workflow_webhook_secret_scopes scope
     JOIN connection_policy_revision policy ON policy.singleton = 1
     WHERE scope.workflow_id = ? AND scope.trigger_id = ?
       AND scope.definition_digest = ?`
  ).bind(workflowId, triggerId, definitionDigest).first<{
    secret_name: string;
    enabled: number;
    policy_revision: number;
    current_policy_revision: number;
  }>();

  if (!row || row.enabled !== 1 || row.secret_name !== declaredSecret ||
      !Number.isSafeInteger(row.policy_revision) || row.policy_revision < 1 ||
      row.policy_revision !== row.current_policy_revision ||
      !hasApprovedWebhookBinding(env as unknown as Record<string, unknown>, row.secret_name)) {
    return null;
  }

  // A scoped reference is not evidence of a configured Worker binding.
  const value = (env as unknown as Record<string, unknown>)[row.secret_name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
