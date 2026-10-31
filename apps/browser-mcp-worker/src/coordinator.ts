import { approvalConfig, type ApprovalEnv } from "./approval-auth.ts";
import { isInteraction, validInteraction, interactionExtra } from "./interactions.ts";
import { type Command, IntentLedger, safeFailureCode } from "./intents.ts";
const TEMP_RECONNECT_GRACE_MS = 90000;
type Endpoint = {
  id: string; alias: string; state: "stopped" | "enabled" | "revoked";
  generation: number; revision: number; stop_epoch: number; credential_hash: string; updated_at: number; pairing_mode?:string; lease_expires_at?:number; offline_deadline?:number|null;
};
type SocketAuth = { protocol?:number; endpoint_id?: string; generation?: number; deadline: number; authenticated: boolean; last_seen?: number; };
type PendingMutation = {
  endpoint_id:string;intent_key:string;generation:number;revision:number;socket:WebSocket;
  phase:"preparing"|"dispatched";timer:ReturnType<typeof setTimeout>;
};
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const validId = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
const hash = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
};
const secret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
};
const safeAlias = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 64;
const publicEndpoint = (e: Endpoint, online = false) => ({
  endpoint_id: e.id, alias: e.alias, authorization: e.state,
  online: e.state === "enabled" && (!e.lease_expires_at || e.lease_expires_at>Date.now()) && online,
  // Readiness means connected and locally enabled, never website business success.
  control_ready: e.state === "enabled" && (!e.lease_expires_at || e.lease_expires_at>Date.now()) && online,
  observation_ready: e.state === "enabled" && (!e.lease_expires_at || e.lease_expires_at>Date.now()) && online,
  generation: e.generation, updated_at: e.updated_at,
  pairing_mode:e.pairing_mode??"permanent",lease_expires_at:e.lease_expires_at??null,
});
export class BrowserOwner implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly state: DurableObjectState;
  private readonly intents: IntentLedger;
  // In-flight observations are ephemeral. No offline queue or persisted webpage content.
  private readonly pendingMutations = new Map<string,PendingMutation>();
  // Reserve an Endpoint before the async HMAC/SQLite admission finishes.
  private readonly admittingEndpoints = new Set<string>();
  private terminateMutation(operation_id:string):void {
    const p=this.pendingMutations.get(operation_id);
    if(!p)return;
    clearTimeout(p.timer);
    this.pendingMutations.delete(operation_id);
    if(p.phase==="dispatched")this.intents.markUnknown(p.endpoint_id,p.intent_key);
    else this.intents.abort(p.endpoint_id,p.intent_key);
  }
  private readonly pendingReads = new Map<string,{
    endpoint_id:string;generation:number;socket:WebSocket;tool:string;
    stage?:string;stageEnteredAt?:number;
    resolve:(value:unknown)=>void;timer:ReturnType<typeof setTimeout>;
  }>();
  // Only these fixed diagnostic stages can reach a timeout reply. No DOM data,
  // URL, extension-provided duration, or arbitrary text is stored or relayed.
  private readonly readStages = new Set(["extension_received","tab_lookup",
    "frame_lookup","text_injection","element_refs","final_validation","result_transport"]);
  private readonly env:ApprovalEnv;
  constructor(state: DurableObjectState, env:ApprovalEnv = {}) {
    this.env=env;
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS pairs (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS endpoints (id TEXT PRIMARY KEY, alias TEXT NOT NULL, credential_hash TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, stop_epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
    const columns=this.sql.exec<{name:string}>("PRAGMA table_info(endpoints)").toArray().map(c=>c.name);
    if(!columns.includes("pairing_mode"))this.sql.exec("ALTER TABLE endpoints ADD COLUMN pairing_mode TEXT NOT NULL DEFAULT 'permanent'");
    if(!columns.includes("lease_expires_at"))this.sql.exec("ALTER TABLE endpoints ADD COLUMN lease_expires_at INTEGER");
    if(!columns.includes("offline_deadline"))this.sql.exec("ALTER TABLE endpoints ADD COLUMN offline_deadline INTEGER");
    this.sql.exec("CREATE TABLE IF NOT EXISTS activation_attempts (id TEXT PRIMARY KEY, proof_hash TEXT NOT NULL, alias TEXT NOT NULL, mode TEXT NOT NULL, endpoint_id TEXT, stop_epoch INTEGER, owner_verified INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)");
    this.intents = new IntentLedger(this.sql);
    this.sql.exec("CREATE TABLE IF NOT EXISTS browser_approvals (operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, binding TEXT NOT NULL, expires_at INTEGER NOT NULL, nonce_hash TEXT)");
    // Dispatch effects may have occurred before a DO recreation. Never replay them.
    this.intents.recoverUnknown(Date.now());
    // Existing approval requests had no execute token. Retire them permanently
    // without granting, dispatching, or deleting any historical receipt.
    this.intents.retirePendingApprovals();
  }
  private withOwnerReview<T extends {operation_id?:string;state?:string}>(answer:T) {
    if(answer.state!=="unknown"||!answer.operation_id)return answer;
    const config=approvalConfig(this.env);
    return {...answer,...(config?{
      owner_review_url:config.origin+"/owner/unknown/"+answer.operation_id,
      safe_next_action:"independently_review_unknown; never retry the original effect"
    }:{safe_next_action:"blocked: independent owner review unavailable; never retry"})};
  }
  private async ownerUnknown(arg:Record<string,unknown>,report:boolean):Promise<Response> {
    if(!approvalConfig(this.env)||!validId(arg.operation_id))return json({error_code:"forbidden"},403);
    const row=this.intents.byOperation(arg.operation_id);
    if(!row)return json({error_code:"not_found"},404);
    if(row.state!=="unknown" && row.state!=="owner_reported_resolution")
      return json({error_code:"not_unknown"},409);
    if(!report){
      const nonce=row.state==="unknown"?secret():undefined;
      if(nonce){
        const digest=await hash(nonce);
        // GET grants no execution authority; it merely rotates a bounded nonce.
        if(this.intents.byOperation(row.operation_id)?.state!=="unknown")return json({error_code:"not_unknown"},409);
        this.sql.exec("INSERT INTO browser_owner_resolutions(operation_id,nonce_hash,nonce_expires_at) VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET nonce_hash=excluded.nonce_hash,nonce_expires_at=excluded.nonce_expires_at WHERE outcome IS NULL",
          row.operation_id,digest,Date.now()+300000);
      }
      return json({operation_id:row.operation_id,endpoint_id:row.endpoint_id,action:row.action,
        state:this.intents.status(row.endpoint_id,row.intent_key).state,
        ...(nonce?{nonce}:{})});
    }
    if(typeof arg.nonce!=="string"||!/^[a-f0-9]{64}$/.test(arg.nonce)||
      arg.outcome!=="effect_seen"&&arg.outcome!=="no_effect_seen")
      return json({error_code:"invalid_arguments"},400);
    const nonceHash=await hash(arg.nonce);
    // Atomic one-use nonce consumption closes concurrent/replayed owner POSTs.
    const used=this.sql.exec<{operation_id:string}>("UPDATE browser_owner_resolutions SET nonce_hash=NULL,nonce_expires_at=NULL WHERE operation_id=? AND nonce_hash=? AND nonce_expires_at>? AND outcome IS NULL RETURNING operation_id",
      row.operation_id,nonceHash,Date.now()).toArray();
    if(used.length!==1)return json({error_code:"invalid_nonce"},403);
    const outcome=this.intents.ownerReport(row.endpoint_id,row.intent_key,arg.outcome);
    return json(outcome,outcome.error_code?409:200);
  }
  private endpoint(id: string): Endpoint | undefined {
    return this.sql.exec<Endpoint>("SELECT * FROM endpoints WHERE id = ?", id).toArray()[0];
  }
  private leaseValid(e:Endpoint) {
    const now=Date.now();
    return (!e.lease_expires_at||e.lease_expires_at>now)&&(!e.offline_deadline||e.offline_deadline>now);
  }
  private expireTemporary(now=Date.now()) {
    const expired=this.sql.exec<{id:string}>("SELECT id FROM endpoints WHERE state='enabled' AND pairing_mode='temporary' AND ((lease_expires_at IS NOT NULL AND lease_expires_at<=?) OR (offline_deadline IS NOT NULL AND offline_deadline<=?))",now,now).toArray();
    for(const {id} of expired){
      const changed=this.sql.exec("UPDATE endpoints SET state='revoked',revision=revision+1,updated_at=? WHERE id=? AND state='enabled'",now,id);
      if(changed.rowsWritten===1)this.close(id,"revoked");
    }
  }
  private async scheduleEarlierAlarm(deadline:number) {
    const existing=await this.state.storage.getAlarm();
    if(existing===null||existing>deadline)await this.state.storage.setAlarm(deadline);
  }
  private live(id: string, generation: number) {
    return this.state.getWebSockets().some(s => {
      const a = s.deserializeAttachment() as SocketAuth | null;
      return a?.authenticated === true && a.protocol===3 && a.endpoint_id === id &&
        a.generation === generation && s.readyState === WebSocket.OPEN &&
        typeof a.last_seen === "number" && Date.now()-a.last_seen < 60000;
    });
  }
  private close(id: string, reason: string) {
    for(const [op,p] of this.pendingMutations)if(p.endpoint_id===id)this.terminateMutation(op);
    for (const socket of this.state.getWebSockets()) {
      const a = socket.deserializeAttachment() as SocketAuth | null;
      if (a?.endpoint_id === id) {
        try { socket.send(JSON.stringify({ type: reason })); socket.close(1000, reason); } catch { /* stale socket */ }
      }
    }
  }
  private budget(bucket: string, max: number, now: number): boolean {
    const b = this.sql.exec<{count:number;window_start:number}>("SELECT count, window_start FROM limits WHERE bucket=?", bucket).toArray()[0];
    if (!b || now - b.window_start >= 60000) {
      this.sql.exec("INSERT INTO limits(bucket,count,window_start) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=1,window_start=excluded.window_start", bucket, now);
      return true;
    }
    if (b.count >= max) return false;
    this.sql.exec("UPDATE limits SET count=count+1 WHERE bucket=?", bucket);
    return true;
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/socket") return this.openSocket(request);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let arg: Record<string, unknown>;
    try {
      if (Number(request.headers.get("content-length") || 0) > 4096) return json({error:"too_large"},413);
      const body = await request.text();
      if (body.length > 4096) return json({error:"too_large"},413);
      arg = JSON.parse(body) as Record<string, unknown>;
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) throw Error();
    } catch { return json({error:"bad_request"},400); }
    const now = Date.now();
    this.expireTemporary(now);
    if(url.pathname==="/owner-unknown-view"||url.pathname==="/owner-unknown-report")
      return this.ownerUnknown(arg,url.pathname==="/owner-unknown-report");
    if (url.pathname === "/operation-status") {
      if (Object.keys(arg).length!==2 || !Object.hasOwn(arg,"endpoint_id") || (!Object.hasOwn(arg,"intent_key")&&!Object.hasOwn(arg,"operation_id")))
        return json({error_code:"invalid_arguments"},400);
      this.intents.reconcile(now);
      const original=validId(arg.operation_id)?this.intents.byOperation(arg.operation_id):undefined;
      const result=Object.hasOwn(arg,"operation_id")?
        original&&original.endpoint_id===arg.endpoint_id?this.intents.status(original.endpoint_id,original.intent_key):{error_code:"not_found"}:
        this.intents.status(arg.endpoint_id as string,arg.intent_key as string);
      return json(this.withOwnerReview(result),result.error_code?result.error_code==="not_found"?404:400:200);
    }
    if (url.pathname === "/activity-summary") {
      if(Object.keys(arg).length!==2 || !validId(arg.endpoint_id) || typeof arg.credential!=="string" || arg.credential.length!==64)
        return json({error_code:"invalid_arguments"},400);
      const e=this.endpoint(arg.endpoint_id);
      if(!e || e.state==='revoked' || (await hash(arg.credential))!==e.credential_hash)return json({error_code:"unauthorized"},401);
      this.intents.reconcile(now);
      return json(this.intents.activitySummary(e.id));
    }
    if(url.pathname==="/activate-begin"){
      if(!validId(arg.attempt_id)||typeof arg.proof_hash!=="string"||!/^[a-f0-9]{64}$/.test(arg.proof_hash)||
         !["permanent","temporary"].includes(arg.mode as string)||!safeAlias(arg.alias)||
         !this.budget("activation:begin",60,now))return json({error:"invalid_activation"},400);
      const id=arg.endpoint_id;
      let stopEpoch:number|null=null;
      if(id!==undefined){
        if(!validId(id)||typeof arg.credential!=="string"||arg.credential.length!==64)return json({error:"invalid_endpoint"},400);
        const e=this.endpoint(id);
        if(!e||e.state==="revoked"||!this.leaseValid(e)||e.pairing_mode!==arg.mode||
           await hash(arg.credential)!==e.credential_hash)return json({error:"re_pair_required"},403);
        stopEpoch=e.stop_epoch;
      }
      this.sql.exec("DELETE FROM activation_attempts WHERE expires_at<? OR consumed=1",now);
      if((this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM activation_attempts").toArray()[0]?.n??0)>=40)return json({error:"busy"},429);
      this.sql.exec("INSERT INTO activation_attempts(id,proof_hash,alias,mode,endpoint_id,stop_epoch,expires_at) VALUES(?,?,?,?,?,?,?)",
        arg.attempt_id,arg.proof_hash,arg.alias,arg.mode,id??null,stopEpoch,now+300000);
      return json({state:"pending",expires_at:now+300000});
    }
    if(url.pathname==="/activate-authorize"){
      if(!validId(arg.attempt_id))return json({error:"invalid_activation"},400);
      const count=this.sql.exec("UPDATE activation_attempts SET owner_verified=1 WHERE id=? AND owner_verified=0 AND consumed=0 AND expires_at>?",
        arg.attempt_id,now).rowsWritten;
      return count===1?json({state:"verified"}):json({error:"not_found"},404);
    }
    if(url.pathname==="/activate-cancel"||url.pathname==="/activate-complete"){
      if(!validId(arg.attempt_id)||typeof arg.proof!=="string"||!/^[a-f0-9]{64}$/.test(arg.proof))return json({error:"invalid_activation"},400);
      const row=this.sql.exec<{proof_hash:string;alias:string;mode:string;endpoint_id:string|null;stop_epoch:number|null;owner_verified:number;expires_at:number;consumed:number}>(
        "SELECT * FROM activation_attempts WHERE id=?",arg.attempt_id).toArray()[0];
      if(!row||row.consumed||row.expires_at<=now||await hash(arg.proof)!==row.proof_hash)return json({error:"expired_or_invalid"},403);
      if(url.pathname==="/activate-cancel"){
        this.sql.exec("UPDATE activation_attempts SET consumed=1 WHERE id=? AND consumed=0",arg.attempt_id);
        return json({state:"cancelled"});
      }
      if(row.owner_verified!==1)return json({state:"awaiting_owner"},409);
      let existing:Endpoint|undefined;
      if(row.endpoint_id){
        existing=this.endpoint(row.endpoint_id);
        if(!existing||existing.state==="revoked"||!this.leaseValid(existing)||existing.stop_epoch!==row.stop_epoch||
           existing.pairing_mode!==row.mode||arg.endpoint_id!==row.endpoint_id||
           typeof arg.credential!=="string"||await hash(arg.credential)!==existing.credential_hash)
          return json({error:"activation_superseded"},409);
      }
      // All awaits are above this point. Revalidate at the last synchronous
      // SQLite commit so Stop or Revoke during proof hashing wins.
      if(existing){
        const latest=this.endpoint(existing.id);
        if(!latest||latest.state==="revoked"||!this.leaseValid(latest)||latest.stop_epoch!==row.stop_epoch||
           latest.revision!==existing.revision||latest.credential_hash!==existing.credential_hash)
          return json({error:"activation_superseded"},409);
        if(this.sql.exec("UPDATE activation_attempts SET consumed=1 WHERE id=? AND consumed=0 AND owner_verified=1 AND expires_at>?",
            arg.attempt_id,Date.now()).rowsWritten!==1)return json({error:"activation_superseded"},409);
        const committed=this.sql.exec("UPDATE endpoints SET state='enabled',revision=revision+1,updated_at=? WHERE id=? AND state!='revoked' AND stop_epoch=? AND revision=?",
          Date.now(),latest.id,row.stop_epoch,latest.revision);
        if(committed.rowsWritten!==1)return json({error:"activation_superseded"},409);
        return json({authorization:"enabled",endpoint_id:latest.id,pairing_mode:row.mode});
      }
      const active=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM endpoints WHERE state!='revoked' AND (lease_expires_at IS NULL OR lease_expires_at>?)",now).toArray()[0]?.n??0;
      if(active>=100)return json({error:"capacity_exceeded"},429);
      const endpoint_id=crypto.randomUUID(),credential=secret();
      const credentialHash=await hash(credential);
      if(this.sql.exec("UPDATE activation_attempts SET consumed=1 WHERE id=? AND consumed=0 AND owner_verified=1 AND expires_at>?",
        arg.attempt_id,Date.now()).rowsWritten!==1)return json({error:"activation_superseded"},409);
      const lease=row.mode==="temporary"?Date.now()+86400000:null;
      this.sql.exec("INSERT INTO endpoints(id,alias,credential_hash,state,generation,revision,updated_at,pairing_mode,lease_expires_at) VALUES(?,?,?,'enabled',0,1,?,?,?)",
        endpoint_id,row.alias,credentialHash,Date.now(),row.mode,lease);
      if(lease)try{await this.scheduleEarlierAlarm(lease);}
      catch{
        this.sql.exec("UPDATE endpoints SET state='revoked',revision=revision+1 WHERE id=?",endpoint_id);
        return json({error:"lease_unavailable"},503);
      }
      return json({authorization:"enabled",endpoint_id,credential,pairing_mode:row.mode,lease_expires_at:lease});
    }
    if (url.pathname === "/create-pair" || url.pathname === "/claim" || url.pathname === "/local-resume") return json({error:"protocol_retired"},410);
    if (url.pathname === "/mutate") {
      const command = arg as Command;
      const expected=command.action==="tab_open"?["endpoint_id","intent_key","action","url"]:
        command.action==="tab_navigate"?["endpoint_id","intent_key","action","tab_id","document_id","url"]:
        command.action==="tab_close"?["endpoint_id","intent_key","action","tab_id","document_id"]:
        isInteraction(command.action)?["endpoint_id","intent_key","action","tab_id","document_id","element_id",...interactionExtra[command.action]]:[];
      if(!expected.length || Object.keys(arg).length!==expected.length ||
          Object.keys(arg).some(key=>!expected.includes(key)) ||
          isInteraction(command.action)&&!validInteraction(arg))return json({error_code:"invalid_arguments"},400);
      // Existing keys are checked before current connectivity or Stop state.
      // Replay returns only the original committed receipt; it never dispatches.
      this.intents.reconcile(now);
      const prior=this.intents.status(command.endpoint_id,command.intent_key);
      if(prior.operation_id){
        const recovered=await this.intents.admit(command,now);
        return json(this.withOwnerReview(recovered),recovered.error_code?409:200);
      }
      const e=this.endpoint(command.endpoint_id);
      if(!e||e.state!=="enabled"||!this.leaseValid(e))return json({error_code:e?.state==="stopped"?"stopped":"revoked"},403);
      const pending=this.admittingEndpoints.has(e.id) ||
        [...this.pendingMutations.values()].some(p=>p.endpoint_id===e.id) ||
        [...this.pendingReads.values()].some(p=>p.endpoint_id===e.id);
      if(prior.error_code==="not_found" && (pending||this.intents.hasDispatching(e.id)))
        return json({error_code:"busy"},409);
      const socket=this.state.getWebSockets().find(sock=>{
        const a=sock.deserializeAttachment() as SocketAuth|null;
        return a?.authenticated&&a.protocol===3&&a.endpoint_id===e.id&&a.generation===e.generation&&
          typeof a.last_seen==="number"&&now-a.last_seen<60000&&sock.readyState===WebSocket.OPEN;
      });
      if(!socket)return json({error_code:"offline"},503);
      // A read may arrive while admit() awaits HMAC. Hold a narrow per-Endpoint
      // admission reservation; it is released after durable admission, before
      // synchronous prepare tracking is installed.
      if(this.admittingEndpoints.has(e.id))return json({error_code:"busy"},409);
      this.admittingEndpoints.add(e.id);
      let accepted;
      try{accepted=await this.intents.admit(command,now);}
      finally{this.admittingEndpoints.delete(e.id);}
      if(accepted.error_code)return json(accepted,400);
      if(!accepted.fresh)return json(accepted);
      const current=this.endpoint(e.id);
      if(!current||current.state!=="enabled"||current.generation!==e.generation||
         current.revision!==e.revision){
        this.intents.abort(e.id,command.intent_key);
        return json({operation_id:accepted.operation_id,state:"failed",error_code:"authorization_changed"});
      }
      const operation_id=accepted.operation_id!;
      if(!this.intents.bindPrepare(e.id,command.intent_key,e.generation,e.revision)){
        this.intents.abort(e.id,command.intent_key);
        return json({operation_id,state:"failed",error_code:"preparation_unavailable"},503);
      }
      const timer=setTimeout(()=>this.terminateMutation(operation_id),8000);
      this.pendingMutations.set(operation_id,{
        endpoint_id:e.id,intent_key:command.intent_key,generation:e.generation,revision:e.revision,
        socket,phase:"preparing",timer
      });
      try {socket.send(JSON.stringify({type:"prepare_request",operation_id,
        intent_key:command.intent_key,generation:e.generation,command}));}
      catch {this.terminateMutation(operation_id);}
      return json(this.withOwnerReview(this.intents.status(e.id,command.intent_key)));
    }
    if (url.pathname === "/read") {
      const id=arg.endpoint_id;
      if(!validId(id) || (arg.tool!=="tabs" && arg.tool!=="snapshot" && arg.tool!=="screenshot") ||
          ((arg.tool==="snapshot"||arg.tool==="screenshot") && (!Number.isSafeInteger(arg.tab_id) || (arg.tab_id as number)<0)) ||
          (arg.scope!==undefined&&(arg.tool!=="tabs"||!["ordinary","private"].includes(arg.scope as string))) ||
          Object.keys(arg).some(k=>!["endpoint_id","tool","tab_id","scope"].includes(k)))
        return json({error_code:"invalid_arguments"},400);
      const e=this.endpoint(id);
      if(!e || e.state!=="enabled" || !this.leaseValid(e))return json({error_code:e?.state==="stopped"?"stopped":"revoked"},403);
      const socket=this.state.getWebSockets().find(sock=>{
        const a=sock.deserializeAttachment() as SocketAuth|null;
        return a?.authenticated && a.protocol===3 && a.endpoint_id===id && a.generation===e.generation &&
          typeof a.last_seen==="number" && Date.now()-a.last_seen<60000 && sock.readyState===WebSocket.OPEN;
      });
      if(!socket)return json({error_code:"offline"},503);
      if([...this.pendingReads.values()].some(p=>p.endpoint_id===id) ||
         this.admittingEndpoints.has(id) ||
         [...this.pendingMutations.values()].some(p=>p.endpoint_id===id) ||
         this.intents.hasDispatching(id))return json({error_code:"busy"},409);
      const request_id=crypto.randomUUID();
      const outcome=await new Promise<unknown>(resolve=>{
        const timer=setTimeout(()=>{
          const pending=this.pendingReads.get(request_id);
          this.pendingReads.delete(request_id);
          const stage=pending?.stage??"awaiting_extension";
          const stage_elapsed_ms=Math.min(5000,Math.max(0,
            Date.now()-(pending?.stageEnteredAt??startedAt)));
          resolve(pending?.tool==="snapshot"?{error_code:"timeout",stage,stage_elapsed_ms}:{error_code:"timeout"});
        },5000);
        const startedAt=Date.now();
        this.pendingReads.set(request_id,{endpoint_id:id,generation:e.generation,socket,resolve,timer,
          tool:arg.tool as string,stageEnteredAt:startedAt});
        try {socket.send(JSON.stringify({type:"read_request",request_id,
          generation:e.generation,tool:arg.tool,...(arg.tool!=="tabs"?{tab_id:arg.tab_id}:{scope:arg.scope??"ordinary"})}));}
        catch {clearTimeout(timer);this.pendingReads.delete(request_id);resolve({error_code:"offline"});}
      });
      return json(outcome);
    }
    if (url.pathname === "/list") {
      const endpoints = this.sql.exec<Endpoint>("SELECT * FROM endpoints ORDER BY updated_at DESC LIMIT 100").toArray();
      return json({endpoints:endpoints.map(e=>publicEndpoint(e,this.live(e.id,e.generation)))});
    }
    const id = arg.endpoint_id;
    if (!validId(id)) return json({error:"invalid_endpoint"},400);
    const e = this.endpoint(id);
    if (!e) return json({error:"not_found"},404);
    if (url.pathname === "/state" || url.pathname === "/local-stop" ||
        url.pathname === "/local-revoke") {
      if (typeof arg.credential !== "string" || arg.credential.length !== 64 ||
          (await hash(arg.credential)) !== e.credential_hash) return json({error:"unauthorized"},401);
    }
    // The stop epoch is exposed ONLY to the locally authenticated Profile.
    // It invalidates a cloud Enable that was prepared before a later Stop.
    if (url.pathname === "/state") return json({...publicEndpoint(e,this.live(e.id,e.generation)),stop_epoch:e.stop_epoch});
    if (e.state === "revoked") return (url.pathname === "/revoke" || url.pathname === "/local-revoke")
      ? json({endpoint_id:id,authorization:"revoked"}) : json({error:"revoked"},403);
    if (url.pathname === "/stop" || url.pathname === "/local-stop") {
      // Every Stop invalidates an earlier in-flight Enable, even when already
      // stopped; repeated Stop still preserves grant revision and timestamp.
      if (e.state !== "stopped")
        this.sql.exec("UPDATE endpoints SET state='stopped',revision=revision+1,stop_epoch=stop_epoch+1,updated_at=? WHERE id=?",now,id);
      else this.sql.exec("UPDATE endpoints SET stop_epoch=stop_epoch+1 WHERE id=?",id);
      this.close(id,"stopped");
      return json({endpoint_id:id,authorization:"stopped"});
    }
    if (url.pathname === "/revoke" || url.pathname === "/local-revoke") {
      this.sql.exec("UPDATE endpoints SET state='revoked',revision=revision+1,updated_at=? WHERE id=?",now,id);
      this.close(id,"revoked");
      return json({endpoint_id:id,authorization:"revoked"});
    }
    return json({error:"not_found"},404);
  }
  private async openSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({error:"upgrade_required"},426);
    if (this.state.getWebSockets().length >= 40) return json({error:"capacity_exceeded"},503);
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    const deadline=Date.now()+5000;
    server.serializeAttachment({deadline,authenticated:false} satisfies SocketAuth);
    try {const existing=await this.state.storage.getAlarm();
      if(!existing || existing>deadline)await this.state.storage.setAlarm(deadline);
    }catch {server.close(1011,"alarm_unavailable");return json({error:"unavailable"},503);}
    // A hibernation restore cannot extend the deadline: every frame checks it.
    setTimeout(() => {
      const a = server.deserializeAttachment() as SocketAuth | null;
      if (!a?.authenticated) { try {server.close(1008,"authentication_timeout");} catch {} }
    },5000);
    return new Response(null,{status:101,webSocket:client});
  }
  async alarm():Promise<void> {
    let next=Infinity;const now=Date.now();
    for(const socket of this.state.getWebSockets()){
      const attachment=socket.deserializeAttachment() as SocketAuth|null;
      if(!attachment?.authenticated){
        if(!attachment || attachment.deadline<=now){try{socket.close(1008,"authentication_timeout");}catch{}}
        else next=Math.min(next,attachment.deadline);
      }
    }
    this.expireTemporary(now);
    const pending=this.sql.exec<{next_deadline:number|null}>("SELECT MIN(CASE WHEN offline_deadline IS NULL THEN lease_expires_at WHEN lease_expires_at IS NULL THEN offline_deadline ELSE MIN(offline_deadline,lease_expires_at) END) AS next_deadline FROM endpoints WHERE state='enabled' AND pairing_mode='temporary'").toArray()[0]?.next_deadline;
    if(pending!==null&&pending!==undefined)next=Math.min(next,pending);
    if(Number.isFinite(next))await this.state.storage.setAlarm(next);
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const auth = socket.deserializeAttachment() as SocketAuth | null;
    this.expireTemporary();
    if (!auth || typeof message !== "string" || message.length > (auth.authenticated?2200000:4096) || Date.now() > auth.deadline && !auth.authenticated) {
      socket.close(1008,"invalid_frame");return;
    }
    let v: Record<string,unknown>;
    try { v = JSON.parse(message) as Record<string,unknown>; if (!v || Array.isArray(v)) throw Error(); }
    catch {socket.close(1008,"invalid_frame");return;}
    if (!auth.authenticated) {
      if (v.type !== "authenticate" || v.protocol !== 3 || v.extension_version !== "0.2.2" || !validId(v.endpoint_id) ||
          typeof v.credential !== "string" || v.credential.length !== 64) {
        socket.close(1008,"authentication_required");return;
      }
      const e = this.endpoint(v.endpoint_id);
      if (!e || e.state !== "enabled" || !this.leaseValid(e) || (await hash(v.credential)) !== e.credential_hash) {
        socket.close(1008,"unauthorized");return;
      }
      const current=this.endpoint(e.id);
      if(!current||current.state!=="enabled"||current.revision!==e.revision||current.generation!==e.generation){socket.close(1008,"stale_auth");return;}
      const generation = current.generation + 1;
      const update=this.sql.exec("UPDATE endpoints SET generation=?,offline_deadline=NULL,updated_at=? WHERE id=? AND state='enabled' AND generation=? AND revision=?",generation,Date.now(),e.id,current.generation,current.revision);
      if(update.rowsWritten!==1){socket.close(1008,"stale_auth");return;}
      for (const other of this.state.getWebSockets()) {
        if (other !== socket && (other.deserializeAttachment() as SocketAuth|null)?.endpoint_id === e.id) {
          for(const [op,p] of this.pendingMutations)if(p.socket===other)this.terminateMutation(op);
          try {other.close(1000,"superseded");} catch {}
        }
      }
      socket.serializeAttachment({authenticated:true,protocol:3,endpoint_id:e.id,generation,deadline:0,last_seen:Date.now()} satisfies SocketAuth);
      socket.send(JSON.stringify({type:"authenticated",endpoint_id:e.id,generation,protocol:3}));
      return;
    }
    if(auth.protocol!==3){socket.close(1008,"obsolete_protocol");return;}
    const e = this.endpoint(auth.endpoint_id!);
    if (!e || e.state !== "enabled" || !this.leaseValid(e) || e.generation !== auth.generation) {socket.close(1008,"stale_connection");return;}
    if(v.type==="prepare_result"&&validId(v.operation_id)&&v.generation===e.generation){
      const pending=this.pendingMutations.get(v.operation_id);
      // A hibernated/reconstructed DO has durable prepare metadata but NO
      // in-memory pending grant. An unsolicited late prepare_result must never
      // create a new execute dispatch from that persisted metadata alone.
      if(!pending || pending.socket!==socket || pending.generation!==e.generation ||
         pending.endpoint_id!==e.id || pending.phase!=="preparing" ||
         pending.intent_key!==v.intent_key)return;
      const latest=this.endpoint(e.id);
      if(typeof v.intent_key!=="string" || !latest || latest.state!=="enabled" ||
         latest.generation!==e.generation ||
         !this.intents.matchesPrepare(e.id,v.intent_key,v.operation_id,
           e.generation,latest.revision)){
        if(pending)this.terminateMutation(v.operation_id);
        return;
      }
      // Old approval proposals cannot turn into ordinary execution.
      if(["approval_required","command","context","run_id","expires_at","owner_approved"]
          .some(field=>Object.hasOwn(v,field))){
        this.terminateMutation(v.operation_id);
        this.sql.exec("UPDATE browser_intents SET result_code='forbidden' WHERE operation_id=? AND state='failed'",v.operation_id);
        return;
      }
      if(v.accepted!==true){
        this.intents.abort(e.id,v.intent_key);
        const denial=v.error_code==="approval_required"?"forbidden":safeFailureCode(v.error_code);
        this.sql.exec("UPDATE browser_intents SET result_code=? WHERE operation_id=? AND state='failed'",denial??"preparation_unavailable",v.operation_id);
        if(pending){clearTimeout(pending.timer);this.pendingMutations.delete(v.operation_id);}
        return;
      }
      const dispatch=await this.intents.dispatch(e.id,v.intent_key,e.generation);
      if(!dispatch.execute_token || dispatch.state!=="dispatching"){
        if(pending)this.terminateMutation(v.operation_id);
        return;
      }
      if(pending){pending.phase="dispatched";}
      // Execute is authorized only by the original current grant and generation.
      const after=this.endpoint(e.id);
      if(!after||after.state!=="enabled"||after.generation!==e.generation||
         after.revision!==latest.revision||socket.readyState!==WebSocket.OPEN){
        if(pending)this.terminateMutation(v.operation_id);
        else this.intents.markUnknown(e.id,v.intent_key);
        return;
      }
      try{socket.send(JSON.stringify({type:"execute_request",operation_id:v.operation_id,
        intent_key:v.intent_key,generation:e.generation,execute_token:dispatch.execute_token}));
      }
      catch{
        if(pending)this.terminateMutation(v.operation_id);
        else this.intents.markUnknown(e.id,v.intent_key);
      }
    } else if(v.type==="execute_result"&&validId(v.operation_id) &&
       v.generation===e.generation &&
       typeof v.intent_key==="string" && typeof v.execute_token==="string" &&
       (v.state==="completed"||v.state==="failed"||v.state==="unknown") &&
       (v.tab_id===null||Number.isSafeInteger(v.tab_id) && (v.tab_id as number)>=0) &&
       (v.presentation_warning===undefined||v.presentation_warning==="tab_group_unavailable")){
      const original=this.intents.status(e.id,v.intent_key);
      if(original.operation_id!==v.operation_id)return;
      const result=await this.intents.finalize(e.id,v.intent_key,v.execute_token,
        e.generation,v.state,v.tab_id as number|null,Date.now(),v.presentation_warning as string|undefined,
        v.state==="failed"?safeFailureCode(v.error_code):undefined);
      if(result.error_code)return;
      const pending=this.pendingMutations.get(v.operation_id);
      if(pending && pending.socket===socket){
        clearTimeout(pending.timer);this.pendingMutations.delete(v.operation_id);
      }
    } else if (v.type === "read_progress" && validId(v.request_id) &&
       v.generation===e.generation && typeof v.stage==="string" && this.readStages.has(v.stage)) {
      const pending=this.pendingReads.get(v.request_id);
      if(pending?.tool==="snapshot" && pending.socket===socket &&
         pending.endpoint_id===e.id && pending.generation===e.generation) {
        pending.stage=v.stage;
        pending.stageEnteredAt=Date.now();
      }
    } else if (v.type === "read_result" && validId(v.request_id) && v.generation===e.generation) {
      const pending=this.pendingReads.get(v.request_id);
      if(!pending || pending.socket!==socket || pending.endpoint_id!==e.id ||
         pending.generation!==e.generation)return;
      clearTimeout(pending.timer);this.pendingReads.delete(v.request_id);
      const data=v.data;
      const serialized=JSON.stringify(data);
      pending.resolve(data && typeof data==="object" && !Array.isArray(data) &&
        serialized.length<=(pending.tool==="screenshot"?2100000:250000) ? data : {error_code:"invalid_result"});
    } else if (v.type === "ping" && v.generation === e.generation) {
      socket.serializeAttachment({...auth,last_seen:Date.now()} satisfies SocketAuth);
      socket.send(JSON.stringify({type:"pong",generation:e.generation}));
    } else if (v.type === "stop") {
      this.sql.exec("UPDATE endpoints SET state='stopped',revision=revision+1,updated_at=? WHERE id=?",Date.now(),e.id);
      this.close(e.id,"stopped");
    } else {socket.close(1008,"unsupported_frame");}
  }
  async webSocketClose(socket:WebSocket,_code:number,_reason:string,_wasClean:boolean):Promise<void> {
    // A network flap and browser exit are indistinguishable at WSS close.
    // Keep a bounded reconnect grant, never a live execution socket. Server
    // alarms eventually revoke browser-exit grants without relying on clients.
    // Superseded WSS generations and explicit Stop/Revoke cannot regain access.
    const auth=socket.deserializeAttachment() as SocketAuth|null;
    let deadline:number|null=null, temporaryId:string|null=null;
    if(auth?.authenticated && auth.endpoint_id && typeof auth.generation==="number"){
      const e=this.endpoint(auth.endpoint_id);
      if(e?.state==="enabled"&&e.pairing_mode==="temporary"&&e.generation===auth.generation){
        deadline=Math.min(Date.now()+TEMP_RECONNECT_GRACE_MS,e.lease_expires_at??Infinity);
        const changed=this.sql.exec("UPDATE endpoints SET offline_deadline=? WHERE id=? AND state='enabled' AND generation=? AND offline_deadline IS NULL",
          deadline,e.id,auth.generation);
        if(changed.rowsWritten===1)temporaryId=e.id;
      }
    }
    for(const [op,p] of this.pendingMutations)if(p.socket===socket)this.terminateMutation(op);
    for(const [id,p] of this.pendingReads)if(p.socket===socket) {
      clearTimeout(p.timer);this.pendingReads.delete(id);
      // Preserve only in-memory, fixed-stage diagnostics already authenticated
      // for this socket. The close reason may contain browser/private data.
      p.resolve(p.tool==="snapshot" ? {
        error_code:"offline",stage:p.stage??"awaiting_extension",
        stage_elapsed_ms:Math.min(5000,Math.max(0,Date.now()-(p.stageEnteredAt??Date.now()))),
        close_code:Number.isInteger(_code)&&_code>=1000&&_code<=4999?_code:null
      } : {error_code:"offline"});
    }
    if(temporaryId&&deadline!==null)try{await this.scheduleEarlierAlarm(deadline);}
    catch{
      // A lost alarm must not leave a temporary offline grant indefinitely.
      const e=this.endpoint(temporaryId);
      if(e?.state==="enabled"&&e.generation===auth?.generation&&e.offline_deadline===deadline){
        this.sql.exec("UPDATE endpoints SET state='revoked',revision=revision+1,updated_at=? WHERE id=?",Date.now(),temporaryId);
        this.close(temporaryId,"revoked");
      }
    }
  }
  webSocketError(_socket:WebSocket,_error:unknown):void {}
}
