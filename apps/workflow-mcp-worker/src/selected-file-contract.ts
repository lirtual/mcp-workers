import type {ActionInput} from './github-action-contract.ts';

/** Source-owned, reviewed file capability; no caller-selected transport or input mapping. */
export type GitHubSelectedFileContract={
 delivery:'github_encrypted_locator_v1';
 extensions:string[];
 max_bytes:number;
 input_slots:['drop_part_0','drop_part_1','drop_part_2'];
 consent:'cloudflare_terms_v1'|'owner_public_upload_v1';
 receipt:'owner_claim_v1'|'reviewed_output_v1';
};
const SLOTS=['drop_part_0','drop_part_1','drop_part_2'] as const;
const FIELDS=['delivery','extensions','max_bytes','input_slots','consent','receipt'];
const own=(v:unknown):v is Record<string,unknown>=>
 !!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(actual:string[],expected:readonly string[]) =>
 actual.length===expected.length&&actual.every(k=>expected.includes(k));

/** The encrypted locator and its three GitHub inputs are fixed protocol fields.
 * File policy and user consent are frozen by the reviewed Action source.
 * Unsupported delivery/consent/receipt protocols fail closed.
 */
export function isReviewedGitHubSelectedFilePolicy(raw:unknown):raw is GitHubSelectedFileContract{
 if(!own(raw)||!exact(Object.keys(raw),FIELDS)||
    raw.delivery!=='github_encrypted_locator_v1'||
    !['cloudflare_terms_v1','owner_public_upload_v1'].includes(String(raw.consent))||
    !['owner_claim_v1','reviewed_output_v1'].includes(String(raw.receipt))||
    !Number.isSafeInteger(raw.max_bytes)||Number(raw.max_bytes)<1||
    Number(raw.max_bytes)>10*1024*1024||
    !Array.isArray(raw.extensions)||raw.extensions.length<1||raw.extensions.length>8||
    raw.extensions.some(e=>typeof e!=='string'||
      (e!=='*'&&!/^\.[a-z0-9]{1,8}$/.test(e)))||
    new Set(raw.extensions).size!==raw.extensions.length||
    (raw.extensions.includes('*')&&raw.extensions.length!==1)||
    !Array.isArray(raw.input_slots)||!exact(raw.input_slots,SLOTS)||
    SLOTS.some((s,i)=>(raw.input_slots as string[])[i]!==s))return false;
 return true;
}

/** Parse only the existing, audited encrypted GitHub locator transport.
 * A future transport is a separate review, never a user-provided extension.
 */
export function parseGitHubSelectedFile(
 raw:unknown,inputs:Record<string,ActionInput>,type:'task'|'session',
 outputKind:'tailnet'|'web'|'none'|undefined,
):GitHubSelectedFileContract|undefined{
 if(raw===undefined)return undefined;
 if(typeof raw!=='string'||raw.length>1024||raw.includes('${{')||
    type!=='task'||outputKind!=='none')throw Error('github_action_invalid_selected_file');
 let value:unknown;
 try{value=JSON.parse(raw);}catch{throw Error('github_action_invalid_selected_file');}
 if(!isReviewedGitHubSelectedFilePolicy(value)||
    SLOTS.some((slot,i)=>!inputs[slot]||inputs[slot].type!=='string'||
      inputs[slot].required!==(i===0)||
      (i===0?inputs[slot].default!==undefined:inputs[slot].default!=='')))
   throw Error('github_action_invalid_selected_file');
 return value as GitHubSelectedFileContract;
}
