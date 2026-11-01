import { isInteraction, validInteraction, type Interaction } from "./interactions.ts";
// Browser MCP T3 foundation: durable, minimum-fact operation intent ledger.
// This module never executes a browser action, queues offline work, or stores a URL,
// tab title, input body or raw execution payload. Only a privileged coordinator
// may call admit/dispatch/finalize after checking local authorization and target.
type Sql = Pick<SqlStorage,"exec">;
type Action = "tab_open" | "tab_navigate" | "tab_close" | Interaction["action"];
type State = "admitted" | "pending_approval" | "denied" | "dispatching" | "unknown" | "owner_reported_resolution" | "completed" | "failed" | "expired";
export type Command = {endpoint_id:string;intent_key:string;action:Action;url?:string;tab_id?:number;document_id?:string;element_id?:string;text?:string;key?:string;delta_y?:number;value?:string};
type Row = {
  endpoint_id:string;intent_key:string;operation_id:string;action:Action;
  commitment:string;state:State;generation:number|null;prepared_revision:number|null;execute_token_hash:string|null;
  created_at:number;updated_at:number;tab_id:number|null;result_code:string|null;
};
type Answer = {operation_id?:string;state?:State;tab_id?:number|null;error_code?:string;execute_token?:string;fresh?:boolean;presentation_warning?:string;owner_reported_resolution?:"effect_seen"|"no_effect_seen";safe_next_action?:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const endpoint=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sevenDays=7*86400000, fiveMinutes=5*60000;
type ApprovalExpiryReason = "approval_deadline_expired" | "approval_endpoint_changed" | "approval_extension_context_invalid" | "approval_retired";
const approvalExpiryReasons:ReadonlySet<string>=new Set<ApprovalExpiryReason>([
  "approval_deadline_expired","approval_endpoint_changed","approval_extension_context_invalid","approval_retired"
]);

// Only these static, non-content-bearing denial codes may enter durable receipts.
const failureActions:Record<string,string>={
  forbidden:"blocked_forbidden_target",
  stale_target:"reobserve_target_before_new_intent",
  stale_element:"reobserve_target_before_new_intent",
  sensitive_surface:"blocked_sensitive_surface",
  unsupported_input:"manual_owner_input_or_separately_review_trusted_input; do_not_claim_success",
  stopped:"owner_must_resume_locally",
  preparation_unavailable:"extension_prepare_failed; confirm installed extension version before a new intent",
  prepare_validation_unavailable:"extension_target_validation_failed; check local extension readiness",
  prepare_context_changed:"extension_authorization_or_session_changed; verify enabled Profile and reconnect",
  prepare_storage_unavailable:"extension_session_prepare_storage_failed; check extension session storage",
  prepare_expired:"extension_prepare_deadline_invalid; do not reuse this operation",
  capacity_exceeded:"review_operation_capacity",
  ordinary_window_required:"owner_must_open_ordinary_window"
};
export const safeFailureCode=(value:unknown):string|undefined=>
  typeof value==="string"&&Object.hasOwn(failureActions,value)?value:undefined;
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,"0")).join("");
function validCommand(value: Command) {
  if(isInteraction(value.action))return validInteraction(value);
  if(!endpoint.test(value.endpoint_id) || !uuid.test(value.intent_key))return false;
  if(value.action!=="tab_open" && value.action!=="tab_navigate" && value.action!=="tab_close")return false;
  if(value.action==="tab_open" && (value.tab_id!==undefined || value.document_id!==undefined))return false;
  if(value.action!=="tab_open" && (!Number.isSafeInteger(value.tab_id) || (value.tab_id as number)<0 ||
    typeof value.document_id!=="string" || value.document_id.length<1 || value.document_id.length>200))return false;
  if(value.action==="tab_close")return value.url===undefined;
  if(typeof value.url!=="string" || value.url.length>2048)return false;
  try{
    const u=new URL(value.url);
    return ["http:","https:"].includes(u.protocol) && !u.username && !u.password;
  }catch{return false;}
}
const bytes=(text:string)=>new TextEncoder().encode(text);
const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join("");
async function sha(value:string) {return hex(await crypto.subtle.digest("SHA-256",bytes(value)));}
export class IntentLedger {
  private readonly sql:Sql;
  private readonly secret:string;
  constructor(sql:Sql){
    this.sql=sql;
    sql.exec("CREATE TABLE IF NOT EXISTS browser_intent_keys (id INTEGER PRIMARY KEY CHECK (id=1), secret TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS browser_intents (endpoint_id TEXT NOT NULL, intent_key TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, action TEXT NOT NULL, commitment TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER, prepared_revision INTEGER, execute_token_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tab_id INTEGER, result_code TEXT, PRIMARY KEY(endpoint_id,intent_key))");
    // The owner can report a past Unknown effect without asserting an observed
    // service receipt. Keep this tiny fact separate from browser contents.
    sql.exec("CREATE TABLE IF NOT EXISTS browser_owner_resolutions (operation_id TEXT PRIMARY KEY, outcome TEXT, reported_at INTEGER, nonce_hash TEXT, nonce_expires_at INTEGER)");
    sql.exec("CREATE INDEX IF NOT EXISTS browser_intents_state_idx ON browser_intents(state,updated_at)");
    // A database constraint, not an in-memory check, serializes concurrent intents.
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS browser_intents_one_dispatch ON browser_intents(endpoint_id) WHERE state='dispatching'");
    let secret=sql.exec<{secret:string}>("SELECT secret FROM browser_intent_keys WHERE id=1").toArray()[0]?.secret;
    if(!secret){
      sql.exec("INSERT OR IGNORE INTO browser_intent_keys(id,secret) VALUES(1,?)",random());
      secret=sql.exec<{secret:string}>("SELECT secret FROM browser_intent_keys WHERE id=1").toArray()[0]!.secret;
    }
    this.secret=secret;
  }
  private row(endpoint_id:string,intent_key:string):Row|undefined{
    return this.sql.exec<Row>("SELECT * FROM browser_intents WHERE endpoint_id=? AND intent_key=?",endpoint_id,intent_key).toArray()[0];
  }
  private exposed(row:Row):Answer {
    const review=this.sql.exec<{outcome:string}>("SELECT outcome FROM browser_owner_resolutions WHERE operation_id=?",row.operation_id).toArray()[0];
    return {operation_id:row.operation_id,state:row.state,...(row.tab_id===null?{}:{tab_id:row.tab_id}),
      ...(review?.outcome==="effect_seen"||review?.outcome==="no_effect_seen"?{owner_reported_resolution:review.outcome as "effect_seen"|"no_effect_seen"}:{}),
      ...(row.state==="unknown"?{safe_next_action:"review_unknown_in_independent_owner_page; never retry with a new key"}:{}),
      ...(row.state==="owner_reported_resolution"?{safe_next_action:"owner_report_recorded; no automatic execution or confirmed website result"}:{}),
      ...(row.result_code==="capacity_exceeded"?{error_code:"capacity_exceeded"}:{}),
      ...(row.result_code==="approval_blocked"?{error_code:"approval_blocked",safe_next_action:"Blocked: independent owner approval is unavailable"}:{}),
      ...(row.state==="failed"&&safeFailureCode(row.result_code)?{error_code:row.result_code!,safe_next_action:failureActions[row.result_code!]}:{}),
      ...(row.state==="expired"&&row.result_code&&approvalExpiryReasons.has(row.result_code)?{error_code:row.result_code}:{}),
      ...(row.result_code==="tab_group_unavailable"?{presentation_warning:row.result_code}:{})};
  }
  private async commitment(command:Command) {
    // Fixed order and fixed parameters: do not hash caller-supplied serialization.
    const canonical=JSON.stringify([command.endpoint_id,command.action,command.tab_id??null,command.document_id??null,command.url??null,...(isInteraction(command.action)?[command.element_id,command.text??null,command.key??null,command.delta_y??null,command.value??null]:[])]);
    const key=await crypto.subtle.importKey("raw",bytes(this.secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    return hex(await crypto.subtle.sign("HMAC",key,bytes(canonical)));
  }
  retirePendingApprovals(now=Date.now()) {
    // On upgrade, a prior manual-approval request must never become dispatchable.
    this.sql.exec("UPDATE browser_intents SET state='expired',updated_at=?,result_code='approval_retired' WHERE state='pending_approval'",now);
  }
  byOperation(operation_id:string):Row|undefined {
    return this.sql.exec<Row>("SELECT * FROM browser_intents WHERE operation_id=?",operation_id).toArray()[0];
  }
  async admit(command:Command,now=Date.now(),limits:{maxUnknown?:number}={}):Promise<Answer>{
    if(!endpoint.test(command.endpoint_id) || !uuid.test(command.intent_key))return {error_code:"invalid_intent_key"};
    if(!validCommand(command))return {error_code:"invalid_arguments"};
    // Lookup precedes clock checks: a retry can always find an existing intent.
    const commitment=await this.commitment(command);
    const existing=this.row(command.endpoint_id,command.intent_key);
    if(existing)return existing.commitment===commitment?this.exposed(existing):{error_code:"intent_conflict"};
    const timestamp=Number.parseInt(command.intent_key.slice(0,8)+command.intent_key.slice(9,13),16);
    if(timestamp>now+30000)return {error_code:"clock_skew"};
    if(timestamp<now-fiveMinutes)return {error_code:"expired_intent_key"};
    this.sweep(now);
    const unknownCount=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM browser_intents WHERE state='unknown'").toArray()[0]?.n??0;
    if(unknownCount>=(limits.maxUnknown??100))return {error_code:"unknown_capacity_exceeded"};
    const operation_id=crypto.randomUUID();
    // All fields are minimal, and the private command payload remains transient.
    try{
      this.sql.exec("INSERT INTO browser_intents(endpoint_id,intent_key,operation_id,action,commitment,state,created_at,updated_at) VALUES(?,?,?,?,?,'admitted',?,?)",
        command.endpoint_id,command.intent_key,operation_id,command.action,commitment,now,now);
    }catch{
      const concurrent=this.row(command.endpoint_id,command.intent_key);
      if(concurrent)return concurrent.commitment===commitment?this.exposed(concurrent):{error_code:"intent_conflict"};
      return {error_code:"storage_unavailable"};
    }
    return {operation_id,state:"admitted",fresh:true};
  }
  status(endpoint_id:string,intent_key:string):Answer {
    if(!endpoint.test(endpoint_id)||!uuid.test(intent_key))return {error_code:"invalid_arguments"};
    const row=this.row(endpoint_id,intent_key);
    return row?this.exposed(row):{error_code:"not_found"};
  }
  bindPrepare(endpoint_id:string,intent_key:string,generation:number,revision:number,now=Date.now()):boolean {
    if(!Number.isSafeInteger(generation)||generation<1||!Number.isSafeInteger(revision)||revision<0)return false;
    this.sql.exec("UPDATE browser_intents SET generation=?,prepared_revision=?,updated_at=? WHERE endpoint_id=? AND intent_key=? AND state='admitted' AND generation IS NULL",
      generation,revision,now,endpoint_id,intent_key);
    const bound=this.row(endpoint_id,intent_key);
    return bound?.state==="admitted"&&bound.generation===generation&&
      bound.prepared_revision===revision&&bound.updated_at===now;
  }
  matchesPrepare(endpoint_id:string,intent_key:string,operation_id:string,generation:number,revision:number,now=Date.now()):boolean {
    const row=this.row(endpoint_id,intent_key);
    return !!row&&row.state==="admitted"&&row.operation_id===operation_id&&
      row.generation===generation&&row.prepared_revision===revision&&
      row.updated_at<=now&&now-row.updated_at<=8000;
  }
  reconcile(now=Date.now()) {
    // A missing execute receipt never triggers another dispatch.
    this.sql.exec("UPDATE browser_intents SET state='unknown',updated_at=? WHERE state='dispatching' AND updated_at<?",now,now-8000);
    // A prepare without an execute token provably had no website effect.
    this.sql.exec("UPDATE browser_intents SET state='failed',updated_at=? WHERE state='admitted' AND generation IS NOT NULL AND updated_at<?",now,now-8000);
  }
  async dispatch(endpoint_id:string,intent_key:string,generation:number,now=Date.now()):Promise<Answer>{
    const row=this.row(endpoint_id,intent_key);
    if(!row)return {error_code:"not_found"};
    if(row.state!=="admitted")return {error_code:"already_dispatched"};
    if(!Number.isSafeInteger(generation)||generation<1)return {error_code:"invalid_generation"};
    const busy=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM browser_intents WHERE endpoint_id=? AND state='dispatching'",endpoint_id).toArray()[0]?.n??0;
    if(busy>0)return {error_code:"busy"};
    const execute_token=random(), tokenHash=await sha(execute_token);
    try{
      this.sql.exec("UPDATE browser_intents SET state='dispatching',generation=?,execute_token_hash=?,updated_at=? WHERE endpoint_id=? AND intent_key=? AND state='admitted'",
        generation,tokenHash,now,endpoint_id,intent_key);
    }catch{
      const current=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM browser_intents WHERE endpoint_id=? AND state='dispatching'",endpoint_id).toArray()[0]?.n??0;
      return {error_code:current?"busy":"storage_unavailable"};
    }
    // Workerd SqlStorage cursors do not report mutation counts like Node's fixture.
    // Re-read the committed token hash; never hand out a losing concurrent token.
    const written=this.row(endpoint_id,intent_key);
    if(!written || written.state!=="dispatching" || written.generation!==generation ||
       written.execute_token_hash!==tokenHash)return {error_code:"already_dispatched"};
    // DO must persist dispatching *before* any caller sends execute.
    return {operation_id:row.operation_id,state:"dispatching",execute_token};
  }
  abort(endpoint_id:string,intent_key:string,now=Date.now()):Answer {
    const row=this.row(endpoint_id,intent_key);
    if(!row)return {error_code:"not_found"};
    this.sql.exec("UPDATE browser_intents SET state='failed',updated_at=? WHERE endpoint_id=? AND intent_key=? AND state='admitted'",now,endpoint_id,intent_key);
    return this.status(endpoint_id,intent_key);
  }
  markUnknown(endpoint_id:string,intent_key:string,now=Date.now()):Answer {
    const row=this.row(endpoint_id,intent_key);
    if(!row)return {error_code:"not_found"};
    this.sql.exec("UPDATE browser_intents SET state='unknown',updated_at=? WHERE endpoint_id=? AND intent_key=? AND state='dispatching'",now,endpoint_id,intent_key);
    return this.status(endpoint_id,intent_key);
  }
  ownerReport(endpoint_id:string,intent_key:string,outcome:"effect_seen"|"no_effect_seen",now=Date.now()):Answer {
    if(outcome!=="effect_seen"&&outcome!=="no_effect_seen")return {error_code:"invalid_arguments"};
    const row=this.row(endpoint_id,intent_key);
    if(!row)return {error_code:"not_found"};
    if(row.state!=="unknown")return {error_code:"not_unknown"};
    // No browser effect, new execute token or optimistic completion is ever created here.
    this.sql.exec("INSERT INTO browser_owner_resolutions(operation_id,outcome,reported_at) VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET outcome=excluded.outcome,reported_at=excluded.reported_at WHERE outcome IS NULL",
      row.operation_id,outcome,now);
    this.sql.exec("UPDATE browser_intents SET state='owner_reported_resolution',updated_at=? WHERE operation_id=? AND state='unknown'",
      now,row.operation_id);
    return this.status(endpoint_id,intent_key);
  }
  hasDispatching(endpoint_id:string):boolean {
    return (this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM browser_intents WHERE endpoint_id=? AND state='dispatching'",endpoint_id).toArray()[0]?.n??0)>0;
  }
  activitySummary(endpoint_id:string):{pending:number;unknown:number} {
    if(!endpoint.test(endpoint_id))return {pending:0,unknown:0};
    const rows=this.sql.exec<{state:State;n:number}>(
      "SELECT state,COUNT(*) AS n FROM browser_intents WHERE endpoint_id=? AND state IN ('admitted','dispatching','unknown') GROUP BY state",endpoint_id).toArray();
    return {pending:rows.filter(r=>r.state==='admitted'||r.state==='dispatching').reduce((n,r)=>n+r.n,0),
      unknown:rows.find(r=>r.state==='unknown')?.n??0};
  }
  recoverUnknown(now=Date.now()):number{
    // Conservative recovery after DO recreation: never retransmit execute.
    const r=this.sql.exec("UPDATE browser_intents SET state='unknown',updated_at=? WHERE state='dispatching'",now);
    return r.rowsWritten;
  }
  async finalize(endpoint_id:string,intent_key:string,execute_token:string,generation:number,
    result:"completed"|"failed"|"unknown",tab_id:number|null,now=Date.now(),presentation_warning?:string,failureCode?:string):Promise<Answer>{
    const row=this.row(endpoint_id,intent_key);
    if(!row)return {error_code:"not_found"};
    if(row.state!=="dispatching" && row.state!=="unknown" &&
       !(row.state==="owner_reported_resolution"&&result!=="unknown"))return {error_code:"not_dispatching"};
    if(!/^[0-9a-f]{64}$/.test(execute_token)||row.generation!==generation||
      (await sha(execute_token))!==row.execute_token_hash)return {error_code:"receipt_mismatch"};
    if(!["completed","failed","unknown"].includes(result) ||
      (result==="completed" && tab_id===null) ||
      (tab_id!==null && (!Number.isSafeInteger(tab_id)||tab_id<0)) ||
      (presentation_warning!==undefined &&
       (result!=="completed"||row.action!=="tab_open"||presentation_warning!=="tab_group_unavailable")) ||
      (failureCode!==undefined && (result!=="failed"||!safeFailureCode(failureCode))))
      return {error_code:"invalid_arguments"};
    this.sql.exec("UPDATE browser_intents SET state=?,updated_at=?,tab_id=?,result_code=? WHERE endpoint_id=? AND intent_key=? AND state IN ('dispatching','unknown','owner_reported_resolution')",
      result,now,tab_id,presentation_warning??failureCode??null,endpoint_id,intent_key);
    const stored=this.row(endpoint_id,intent_key);
    if(!stored||stored.state!==result||stored.updated_at!==now||stored.tab_id!==tab_id)
      return {error_code:"not_dispatching"};
    return this.status(endpoint_id,intent_key);
  }
  sweep(now=Date.now()) {
    // Unknown is never garbage collected automatically, including capacity pressure.
    this.sql.exec("DELETE FROM browser_intents WHERE state IN ('completed','failed','expired','denied') AND updated_at<?",now-sevenDays);
    // An admitted intent cannot have reached a website; expiration is safe.
    this.sql.exec("UPDATE browser_intents SET state='expired',updated_at=? WHERE state='admitted' AND created_at<?",now,now-fiveMinutes);
  }
}
