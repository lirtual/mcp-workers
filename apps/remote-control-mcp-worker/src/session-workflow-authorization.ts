/** Fail-closed, per-admission Workflow decision through a private Service Binding. */
import type { V2Device, SessionCheck } from './v2-session.ts';

/** Only the named WorkerEntrypoint may provide this RPC; there is no public URL. */
export interface WorkflowSessionAuthorization {
  authorizeSessionAttempt(input: { attempt_id: string; oidc_jwt?: string }): Promise<unknown>;
}

/** No cache: each new remote operation and authenticated socket checks Workflow. */
export function sessionAllowedByWorkflow(binding?: WorkflowSessionAuthorization): SessionCheck {
  return async (device: V2Device): Promise<boolean> => {
    if (!binding || device.grant_type !== 'session' || !device.session_attempt_id) return false;
    try {
      const decision = await binding.authorizeSessionAttempt({ attempt_id: device.session_attempt_id });
      if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return false;
      const result = decision as Record<string, unknown>;
      return result.allowed === true &&
        result.attempt_id === device.session_attempt_id &&
        result.github_run_id === device.session_run_id &&
        result.github_run_attempt === device.session_run_attempt &&
        result.workflow_name === device.session_workflow_name &&
        // A stored grant is nonrenewable; reject any divergent source deadline.
        result.expires_at === device.expires_at &&
        typeof result.expires_at === 'number' &&
        Number.isSafeInteger(result.expires_at) && Date.now() < result.expires_at;
    } catch {
      return false; // Unavailable Workflow denies Session only, never personal devices.
    }
  };
}
