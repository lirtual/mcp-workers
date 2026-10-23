import type { DiscoveredAction } from './github-action-contract.ts';

const RESERVED = new Set(['attempt_id', 'dispatch_id', 'capability_id']);
const forbidden = (key: string): boolean =>
  RESERVED.has(key.toLowerCase()) || key.toLowerCase().startsWith('workflow_');

/**
 * Strictly validate MCP-provided inputs before dispatch.
 * Never accept internal execution identity, arbitrary command or secret inputs.
 */
export function validateGitHubActionInputs(
  action: DiscoveredAction,
  supplied: Record<string, unknown>,
): Record<string, string> {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
    throw Error('github_action_invalid_inputs');
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const declared = action.inputs;
  for (const key of Object.keys(supplied)) {
    if (forbidden(key) || !Object.hasOwn(declared, key))
      throw Error('github_action_unknown_input');
  }
  for (const [name, field] of Object.entries(declared)) {
    if (forbidden(name)) throw Error('github_action_reserved_input');
    const value = Object.hasOwn(supplied, name) ? supplied[name] : field.default;
    if (value === undefined) {
      if (field.required) throw Error('github_action_required_input');
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw Error('github_action_wrong_type');
      result[name] = String(value);
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw Error('github_action_wrong_type');
      result[name] = String(value);
    } else {
      if (typeof value !== 'string') throw Error('github_action_wrong_type');
      if (field.type === 'choice' && !field.options?.includes(value))
        throw Error('github_action_invalid_choice');
      result[name] = value;
    }
    if (new TextEncoder().encode(result[name]).byteLength > 4096)
      throw Error('github_action_input_too_large');
  }
  // The Session lifetime is measured from the physical GitHub Job start.
  // GitHub Runner's 360 minute ceiling remains a separate native backstop.
  if (action.type === 'session' && Object.hasOwn(declared, 'duration_minutes')) {
    const duration = Number(result.duration_minutes);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 330)
      throw Error('github_action_invalid_duration');
  }
  if (Object.keys(result).length > 10) throw Error('github_action_too_many_inputs');
  return result;
}
