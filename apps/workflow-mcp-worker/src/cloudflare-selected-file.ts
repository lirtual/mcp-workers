import type {Plan} from './plan.ts';

/** The existing Cloudflare Service Binding accepts bounded bytes in memory.
 * This manifest field is source-reviewed, published and digested with the
 * ordinary Provider contract; caller Plan inputs do not grant file access.
 */
export type CloudflareFilePolicy={
 delivery:'cloudflare_memory_bytes_v1';
 extensions:string[];
 max_bytes:number;
 input_slots:['file_name','size_bytes','sha256','time'];
 consent:'owner_public_upload_v1';
 receipt:'reviewed_output_v1';
};
export type CloudflareFilePlan={
 delivery:'cloudflare_memory_bytes_v1';
 step_id:string;
 policy:CloudflareFilePolicy;
 manifest:Record<string,unknown>;
};
const record=(x:unknown):x is Record<string,unknown>=>
 x!==null&&typeof x==='object'&&!Array.isArray(x);
const same=(a:readonly string[],b:readonly string[])=>
 a.length===b.length&&a.every((s,i)=>s===b[i]);
const SLOTS=['file_name','size_bytes','sha256','time'] as const;
const KEYS=['delivery','extensions','max_bytes','input_slots','consent','receipt'] as const;
export function reviewedCloudflareFilePolicy(raw:unknown):CloudflareFilePolicy|null{
 if(!record(raw)||!same(Object.keys(raw).sort(),[...KEYS].sort())||
    raw.delivery!=='cloudflare_memory_bytes_v1'||
    raw.consent!=='owner_public_upload_v1'||raw.receipt!=='reviewed_output_v1'||
    !Array.isArray(raw.input_slots)||!same(raw.input_slots,SLOTS)||
    !Array.isArray(raw.extensions)||raw.extensions.length<1||raw.extensions.length>8||
    raw.extensions.some(e=>typeof e!=='string'||
      (e!=='*'&&!/^\.[a-z0-9]{1,8}$/.test(e)))||
    new Set(raw.extensions).size!==raw.extensions.length||
    (raw.extensions.includes('*')&&raw.extensions.length!==1)||
    !Number.isSafeInteger(raw.max_bytes)||Number(raw.max_bytes)<1||
    Number(raw.max_bytes)>10*1024*1024)return null;
 return raw as CloudflareFilePolicy;
}
/** Exactly one manual, approved consumer with a frozen four-field binding.
 * Existing Litterbox remains a historical adapter until explicit cutover.
 */
export function cloudflareSelectedFilePlan(plan:Plan):CloudflareFilePlan|null{
 if(!plan||!Array.isArray(plan.steps)||plan.steps.length!==1||
    plan.triggers?.length||plan.saga||plan.cloudflare_execution_approved!==true||
    (plan.inputs&&Object.keys(plan.inputs).length!==0))return null;
 const step=plan.steps[0]!;
 if(step.uses!=='action.run'||step.needs.length!==0||
    step.if!==undefined||step.approval!==undefined||
    step.needs_policy!==undefined||step.with.executor!=='cloudflare')return null;
 const manifest=plan.cloudflare_action_contracts?.[step.id];
 const policy=reviewedCloudflareFilePolicy(manifest?.selected_file);
 if(!policy||!manifest||manifest.source_repository!=='lirtual/cloudflare-actions'||
    manifest.service!=='cloudflare-actions'||manifest.entrypoint!=='ActionsEntrypoint'||
    manifest.executor!=='cloudflare'||
    manifest.provider!==step.with.provider||
    manifest.action!==step.with.action||
    manifest.contract_digest!==step.with.contract_digest||
    !plan.cloudflare_action_approvals?.some(a=>
      a.executor==='cloudflare'&&a.action===step.with.action&&
      a.provider===step.with.provider&&a.contract_digest===step.with.contract_digest))
    return null;
 const schema=manifest.input_schema;
 if(!record(schema)||!record(schema.properties)||!Array.isArray(schema.required)||
    !same([...schema.required].sort(),[...SLOTS].sort())||
    !same(Object.keys(schema.properties).sort(),[...SLOTS].sort()))return null;
 const outputSchema=manifest.output_schema;
 if(!record(outputSchema)||!record(outputSchema.properties)||
    !Object.hasOwn(outputSchema.properties,'status')||
    Object.keys(outputSchema.properties).some(k=>/secret|claim|token|password|private|key/i.test(k)))
   return null;
 const given=step.with.input;
 if(!record(given)||!same(Object.keys(given).sort(),[...SLOTS].sort())||
    SLOTS.some(name=>!record(given[name])||
      !same(Object.keys(given[name]),['ref'])||
      (given[name] as Record<string,unknown>).ref!=='inputs.'+name))return null;
 return {delivery:'cloudflare_memory_bytes_v1',step_id:step.id,policy,manifest};
}
