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


/** Dynamic Task inputs deliberately accept only one exact current-item ref.
 * The compile gate checks syntax; the pinned reviewed provider contract is
 * enforced at Publish and again on the COMPLETE frozen array before dispatch.
 */
export function isForeachTaskInputRef(value:unknown):value is {ref:string}{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const obj=value as Record<string,unknown>;
  return Object.keys(obj).length===1&&typeof obj.ref==='string'&&
    /^(?:item\.index|item\.value(?:\.[A-Za-z][A-Za-z0-9_-]{0,63})*)$/.test(obj.ref)&&
    obj.ref.length<=256;
}
export function containsDynamicForeachTaskInputs(inputs:Record<string,unknown>):boolean{
  return Object.values(inputs).some(isForeachTaskInputRef);
}
/** Validate literal fields and declared keys without predicting runtime item
 * values. Runtime must call validateGitHubActionInputs on the frozen concrete
 * values, including choice membership, required fields and byte budgets.
 */
export function validateForeachTaskInputTemplate(
 action:DiscoveredAction,inputs:Record<string,unknown>,
):void{
  if(!inputs||typeof inputs!=='object'||Array.isArray(inputs))
    throw Error('github_action_invalid_inputs');
  const projected:Record<string,unknown>={};
  for(const [key,value] of Object.entries(inputs)){
    if(value!==null&&typeof value==='object'){
      if(!isForeachTaskInputRef(value))
        throw Error('github_action_invalid_dynamic_input');
      const field=action.inputs[key];
      if(!field)throw Error('github_action_unknown_input');
      projected[key]=field.type==='boolean'?false:field.type==='number'?0:
        field.type==='choice'?field.options?.[0]:'';
    }else projected[key]=value;
  }
  validateGitHubActionInputs(action,projected);
}
