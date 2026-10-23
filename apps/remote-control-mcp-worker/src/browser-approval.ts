import { parseOperationId } from "./local-read.ts";
/** Exact-action, single-use owner-consent state for the existing v2 Owner DO.
 * This does NOT authenticate the approver. Only an independently verified
 * user-session endpoint may call approveBrowserIntent. Never expose it as MCP.
 */
const TTL_MS = 10 * 60_000;
const TOMBSTONE_MS = 5 * 60_000;
const MAX_RECORDS = 32;
const DEVICE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ALLOWED_EFFECTS = new Set(["browser_navigate","browser_click","browser_fill","browser_press_key","browser_select_option"]);

export interface BrowserApprovalIntent {
  device_id: string;
  epoch: string;
  session_id: string;
  tab_id: string;
  operation_id: string;
  tool: string;
  snapshot_version: number;
  origin: string;
  page_path: string;
  page_digest: string;
  parameters_digest: string;
  /** Already sanitized on the trusted Agent side. Never raw form text. */
  display: string;
}

type RecordState = "pending" | "approved" | "consumed";
interface ApprovalRecord {
  id: string;
  digest: string;
  intent: BrowserApprovalIntent;
  state: RecordState;
  created_at: number;
  expires_at: number;
}
type Store = Pick<DurableObjectStorage, "transaction">;
type Tx = DurableObjectTransaction;
type PrepareResult =
  | {status:"pending";approval_id:string;expires_at:number}
  | {status:"invalid"|"conflict"|"capacity"|"expired"|"consumed"};

const recordKey=(operationId:string)=>"browser-approval:op:"+operationId;
const tokenKey=(id:string)=>"browser-approval:id:"+id;

export function validBrowserIntent(input: BrowserApprovalIntent): boolean {
  if (!input || typeof input!=="object" || !DEVICE_ID.test(input.device_id) ||
    !DEVICE_ID.test(input.session_id) || !/^[a-f0-9-]{16,80}$/.test(input.epoch) ||
    !/^tab-[1-9]\d{0,6}$/.test(input.tab_id) ||
    !parseOperationId({operation_id:input.operation_id}) || !ALLOWED_EFFECTS.has(input.tool) ||
    !Number.isSafeInteger(input.snapshot_version) || input.snapshot_version<0 ||
    !DIGEST.test(input.parameters_digest) || !DIGEST.test(input.page_digest) ||
    typeof input.page_path!=="string" || !input.page_path.startsWith("/") ||
    input.page_path.length>512 || /[\x00-\x1f\x7f?#]/.test(input.page_path) ||
    typeof input.display!=="string" || input.display.length<1 || input.display.length>240 ||
    /[\x00-\x1f\x7f]/.test(input.display)) return false;
  // Only navigation may originate in an agent-owned blank tab.
  if(input.origin==="about:blank")
    return input.tool==="browser_navigate" && input.page_path==="/";
  try {
    const parsed=new URL(input.origin);
    return (parsed.protocol==="https:" || parsed.protocol==="http:") &&
      parsed.origin===input.origin;
  }catch{return false;}
}

async function intentDigest(intent:BrowserApprovalIntent):Promise<string> {
  const content=JSON.stringify(["browser-approval-v1",intent.device_id,intent.epoch,
    intent.session_id,intent.tab_id,intent.operation_id,intent.tool,
    intent.snapshot_version,intent.origin,intent.page_path,intent.page_digest,
    intent.parameters_digest,intent.display]);
  const bytes=new TextEncoder().encode(content);
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

/** Only trusted Agent-observed target metadata may be supplied as intent. */
export async function prepareBrowserIntent(store:Store,intent:BrowserApprovalIntent,now=Date.now()):
  Promise<PrepareResult> {
  if(!validBrowserIntent(intent))return{status:"invalid"};
  const digest=await intentDigest(intent);
  return store.transaction(async (tx:Tx)=>{
    const key=recordKey(intent.operation_id);
    const old=await tx.get<ApprovalRecord>(key);
    if(old){
      if(old.digest!==digest)return{status:"conflict" as const};
      if(old.state==="consumed")return{status:"consumed" as const};
      if(old.expires_at<=now)return{status:"expired" as const};
      return{status:"pending" as const,approval_id:old.id,expires_at:old.expires_at};
    }
    // One bounded scan. Never add an alarm/queue/new database.
    const all=await tx.list<ApprovalRecord>({prefix:"browser-approval:op:",limit:MAX_RECORDS+1});
    let active=0;
    for(const [k,row] of all){
      if(row?.expires_at+TOMBSTONE_MS<now){
        await tx.delete(k);
        if(row.id)await tx.delete(tokenKey(row.id));
      }else active++;
    }
    if(active>=MAX_RECORDS||all.size>MAX_RECORDS)return{status:"capacity" as const};
    const id=crypto.randomUUID();
    const record:ApprovalRecord={
      id,digest,intent:{...intent},state:"pending",created_at:now,expires_at:now+TTL_MS,
    };
    await tx.put(key,record);
    await tx.put(tokenKey(id),intent.operation_id);
    return{status:"pending" as const,approval_id:id,expires_at:record.expires_at};
  });
}

/** Read only after verifying the independent owner's Access session.
 * No page text, secrets, or raw payloads are exposed to unauthenticated callers.
 */
export async function inspectBrowserIntent(
  store:Store,approvalId:string,now=Date.now(),
):Promise<{status:"pending"|"approved";intent:BrowserApprovalIntent;expires_at:number}|null>{
  if(!DEVICE_ID.test(approvalId))return null;
  return store.transaction(async (tx:Tx)=>{
    const op=await tx.get<string>(tokenKey(approvalId));
    if(!op)return null;
    const record=await tx.get<ApprovalRecord>(recordKey(op));
    if(!record||record.id!==approvalId||record.expires_at<=now||
      !["pending","approved"].includes(record.state))return null;
    return{status:record.state as "pending"|"approved",
      intent:record.intent,expires_at:record.expires_at};
  });
}

/** Internal only: verifiedSubject must come from a validated Access JWT, NOT MCP. */
export async function approveBrowserIntent(
  store:Store,approvalId:string,verifiedSubject:string,now=Date.now(),
):Promise<"approved"|"denied"> {
  if(!DEVICE_ID.test(approvalId)||typeof verifiedSubject!=="string"||
    !/^[^\s\x00-\x1f]{1,160}$/.test(verifiedSubject))return"denied";
  return store.transaction(async (tx:Tx)=>{
    const op=await tx.get<string>(tokenKey(approvalId));
    if(!op)return"denied";
    const k=recordKey(op);
    const record=await tx.get<ApprovalRecord>(k);
    if(!record||record.id!==approvalId||record.state!=="pending"||
      record.expires_at<=now)return"denied";
    // The Access JWT was checked by the caller; do not persist user identity.
    await tx.put(k,{...record,state:"approved"});
    return"approved";
  });
}

/** The DO must check current live device/epoch and Agent freshness separately. */
export async function consumeBrowserApproval(
  store:Store,intent:BrowserApprovalIntent,now=Date.now(),
):Promise<boolean>{
  if(!validBrowserIntent(intent))return false;
  const digest=await intentDigest(intent);
  return store.transaction(async (tx:Tx)=>{
    const k=recordKey(intent.operation_id);
    const record=await tx.get<ApprovalRecord>(k);
    if(!record||record.state!=="approved"||record.expires_at<=now||
      record.digest!==digest)return false;
    // Mark consumed BEFORE forwarding the effect. Unknown outcome is never replayed.
    await tx.put(k,{...record,state:"consumed"});
    return true;
  });
}

/** Stable checksum of the exact validated effect arguments. No raw text is
 * persisted with the pending approval; unchanged calls remain reproducible.
 */
function canonical(value:unknown):string {
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  if(value!==null&&typeof value==="object"){
    const r=value as Record<string,unknown>;
    return "{"+Object.keys(r).sort().map(k=>JSON.stringify(k)+":"+canonical(r[k])).join(",")+"}";
  }
  return JSON.stringify(value);
}
export async function browserPageDigest(url:string):Promise<string>{
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(url));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
export async function browserParametersDigest(tool:string,args:Record<string,unknown>):Promise<string>{
  const input=new TextEncoder().encode(canonical({tool,arguments:args}));
  const bytes=await crypto.subtle.digest("SHA-256",input);
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
