import type {ActionInput} from './github-action-contract.ts';

/** Source-owned, reviewed file capability; no caller-selected transport or input mapping. */
export type GitHubSelectedFileContract={
 delivery:'github_encrypted_locator_v1';
 extensions:string[];
 max_bytes:number;
 input_slots:['drop_part_0','drop_part_1','drop_part_2'];
 consent:'cloudflare_terms_v1';
 receipt:'owner_claim_v1';
};
const SLOTS=['drop_part_0','drop_part_1','drop_part_2'] as const;
const FIELDS=['delivery','extensions','max_bytes','input_slots','consent','receipt'];
const own=(v:unknown):v is Record<string,unknown>=>
 !!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(actual:string[],expected:readonly string[]) =>
 actual.length===expected.length&&actual.every(k=>expected.includes(k));

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
 if(!own(value)||!exact(Object.keys(value),FIELDS)||
    value.delivery!=='github_encrypted_locator_v1'||
    value.consent!=='cloudflare_terms_v1'||
    value.receipt!=='owner_claim_v1'||
    !Number.isSafeInteger(value.max_bytes)||Number(value.max_bytes)<1||
    Number(value.max_bytes)!==10485760||
    !Array.isArray(value.extensions)||
    !exact(value.extensions,['.html','.zip'])||
    value.extensions[0]!=='.html'||value.extensions[1]!=='.zip'||
    !Array.isArray(value.input_slots)||
    !exact(value.input_slots,SLOTS)||SLOTS.some((s,i)=>(value.input_slots as string[])[i]!==s)||
    SLOTS.some((slot,i)=>!inputs[slot]||inputs[slot].type!=='string'||
      inputs[slot].required!==(i===0)||
      (i===0?inputs[slot].default!==undefined:inputs[slot].default!=='')))
   throw Error('github_action_invalid_selected_file');
 return value as GitHubSelectedFileContract;
}
