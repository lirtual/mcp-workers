import { approvalConfig, type ApprovalEnv } from "./approval-auth.ts";
import { isInteraction, validInteraction, interactionExtra } from "./interactions.ts";
import { type Command, IntentLedger, safeFailureCode } from "./intents.ts";
type Endpoint = {
  id: string; alias: string; state: "stopped" | "enabled" | "revoked";
  generation: number; revision: number; stop_epoch: number; credential_hash: string; updated_at: number;
};
type SocketAuth = { endpoint_id?: string; generation?: number; deadline: number; authenticated: boolean; last_seen?: number; approval_origin?:string };
type PendingMutation = {
  endpoint_id:string;intent_key:string;generation:number;revision:number;socket:WebSocket;
  phase:"preparing"|"dispatched";prepared?:()=>void;timer:ReturnType<typeof setTimeout>;
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
  online: e.state === "enabled" && online,
  // Readiness means connected and locally enabled, never website business success.
  control_ready: e.state === "enabled" && online,
  observation_ready: e.state === "enabled" && online,
  generation: e.generation, updated_at: e.updated_at,
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
    p.prepared?.();
    this.pendingMutations.delete(operation_id);
    if(p.phase==="dispatched")this.intents.markUnknown(p.endpoint_id,p.intent_key);
    else this.intents.abort(p.endpoint_id,p.intent_key);
  }
  private readonly pendingReads = new Map<string,{
    endpoint_id:string;generation:number;socket:WebSocket;tool:string;
    resolve:(value:unknown)=>void;timer:ReturnType<typeof setTimeout>;
  }>();
  private readonly env:ApprovalEnv;
  constructor(state: DurableObjectState, env:ApprovalEnv = {}) {
    this.env=env;
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS pairs (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS endpoints (id TEXT PRIMARY KEY, alias TEXT NOT NULL, credential_hash TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, stop_epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)");
    this.intents = new IntentLedger(this.sql);
    this.sql.exec("CREATE TABLE IF NOT EXISTS browser_approvals (operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, binding TEXT NOT NULL, expires_at INTEGER NOT NULL, nonce_hash TEXT)");
    // Dispatch effects may have occurred before a DO recreation. Never replay them.
    this.intents.recoverUnknown(Date.now());
  }
  private readonly approvalReads=new Map<string,{socket:WebSocket;resolve:(value:Record<string,unknown>|null)=>void;timer:ReturnType<typeof setTimeout>}>();
  private expireApprovals(now=Date.now()) {
    const rows=this.sql.exec<{operation_id:string;expires_at:number}>("SELECT a.operation_id,a.expires_at FROM browser_approvals a JOIN browser_intents i ON i.operation_id=a.operation_id WHERE i.state='pending_approval'").toArray();
    for(const a of rows){
      const row=this.intents.byOperation(a.operation_id);if(!row)continue;
      const e=this.endpoint(row.endpoint_id);
      if(row.state==="pending_approval"&&(a.expires_at<=now||!e||e.state!=="enabled"||e.generation!==row.generation||e.revision!==row.prepared_revision||!approvalConfig(this.env)))
        this.intents.approvalState(row.endpoint_id,row.intent_key,"expired");
    }
    this.sql.exec("DELETE FROM browser_approvals WHERE expires_at<?",now-7*86400000);
  }
  private withApproval<T extends {operation_id?:string;state?:string}>(answer:T) {
    if(answer.state==="unknown"&&answer.operation_id){
      const config=approvalConfig(this.env);
      return {...answer,...(config?{
        owner_review_url:config.origin+"/owner/unknown/"+answer.operation_id,
        safe_next_action:"independently_review_unknown; never retry the original effect"
      }:{safe_next_action:"blocked: independent owner review unavailable; never retry"})};
    }
    if(answer.state!=="pending_approval"||!answer.operation_id)return answer;
    const a=this.sql.exec<{expires_at:number}>("SELECT expires_at FROM browser_approvals WHERE operation_id=?",answer.operation_id).toArray()[0];
    return {...answer,expires_at:a?.expires_at,approval_url:approvalConfig(this.env)?.origin+"/owner/operations/"+answer.operation_id,safe_next_action:"wait_for_owner_approval"};
  }
  private approvalBinding(command:Command,run_id:string,generation:number,revision:number,expires_at:number,context:unknown) {
    // Includes every actual parameter, exact document/element, top frame, browser
    // run, grant, connection and deadline. No low-entropy public hash.
    return this.intents.seal([command.endpoint_id,command.intent_key,command.action,command.tab_id??null,0,
      command.document_id??null,command.element_id??null,command.url??null,command.text??null,
      command.key??null,command.delta_y??null,command.value??null,run_id,generation,revision,expires_at,context]);
  }
  private async ownerApproval(arg:Record<string,unknown>,decide:boolean):Promise<Response> {
    if(!approvalConfig(this.env)||!validId(arg.operation_id))return json({error_code:"forbidden"},403);
    this.expireApprovals();
    const row=this.intents.byOperation(arg.operation_id);
    if(!row)return json({error_code:"not_found"},404);
    if(row.state!=="pending_approval")return json(this.intents.status(row.endpoint_id,row.intent_key));
    const a=this.sql.exec<{run_id:string;binding:string;expires_at:number;nonce_hash:string|null}>("SELECT * FROM browser_approvals WHERE operation_id=?",row.operation_id).toArray()[0];
    if(!a)return json({error_code:"expired"},409);
    if(decide){
      if(!["approve","deny"].includes(arg.decision as string)||typeof arg.nonce!=="string"||arg.nonce.length!==64||!a.nonce_hash||await hash(arg.nonce)!==a.nonce_hash)return json({error_code:"invalid_nonce"},403);
      // Consume before any async extension round trip. Concurrent/replayed POSTs
      // cannot both redeem a nonce, even when the extension or SQLite fails.
      const consumed=this.sql.exec<{operation_id:string}>("UPDATE browser_approvals SET nonce_hash=NULL WHERE operation_id=? AND nonce_hash=? RETURNING operation_id",row.operation_id,a.nonce_hash).toArray();
      if(consumed.length!==1)return json({error_code:"invalid_nonce"},403);
      if(arg.decision==="deny"){
        this.intents.approvalState(row.endpoint_id,row.intent_key,"denied");
        return json(this.intents.status(row.endpoint_id,row.intent_key));
      }
    }
    if(this.approvalReads.size>=40)return json({error_code:"busy"},409);
    const e=this.endpoint(row.endpoint_id)!;
    const socket=this.state.getWebSockets().find(sock=>{
      const auth=sock.deserializeAttachment() as SocketAuth|null;
      return auth?.authenticated&&auth.endpoint_id===e.id&&auth.generation===e.generation&&
        typeof auth.last_seen==="number"&&Date.now()-auth.last_seen<60000&&sock.readyState===WebSocket.OPEN;
    });
    const expire=()=>{this.intents.approvalState(row.endpoint_id,row.intent_key,"expired");return json(this.intents.status(row.endpoint_id,row.intent_key));};
    if(!socket)return expire();
    if(decide){
      if(this.admittingEndpoints.has(e.id)||this.intents.hasDispatching(e.id)||[...this.pendingReads.values()].some(p=>p.endpoint_id===e.id)||[...this.pendingMutations.values()].some(p=>p.endpoint_id===e.id))return expire();
      this.admittingEndpoints.add(e.id);
    }
    try {
      const request_id=crypto.randomUUID();
      const proposal=await new Promise<Record<string,unknown>|null>(resolve=>{
        const timer=setTimeout(()=>{this.approvalReads.delete(request_id);resolve(null);},5000);
        this.approvalReads.set(request_id,{socket,resolve,timer});
        try{socket.send(JSON.stringify({type:"approval_request",request_id,operation_id:row.operation_id,generation:e.generation}));}
        catch{clearTimeout(timer);this.approvalReads.delete(request_id);resolve(null);}
      });
      const command=proposal?.command as Command|undefined;
      if(!command||proposal?.run_id!==a.run_id||proposal.expires_at!==a.expires_at||
         proposal.ready!==true||JSON.stringify(command).length>65536||!await this.intents.matchesCommand(command,row.operation_id)||
         await this.approvalBinding(command,a.run_id,e.generation,e.revision,a.expires_at,proposal.context)!==a.binding)return expire();
      this.expireApprovals();
      const current=this.endpoint(e.id);
      if(this.intents.byOperation(row.operation_id)?.state!=="pending_approval"||!current||current.state!=="enabled"||current.generation!==e.generation||current.revision!==e.revision)return expire();
      if(!decide){
        const nonce=secret();
        const nonceHash=await hash(nonce);
        if(this.intents.byOperation(row.operation_id)?.state!=="pending_approval"||a.expires_at<=Date.now())return expire();
        this.sql.exec("UPDATE browser_approvals SET nonce_hash=? WHERE operation_id=?",nonceHash,row.operation_id);
        return json({operation_id:row.operation_id,state:"pending_approval",expires_at:a.expires_at,
          endpoint_id:e.id,run_id:a.run_id,frame_id:0,command,context:proposal.context,nonce});
      }
      this.intents.approvalState(e.id,row.intent_key,"admitted");
      const dispatch=await this.intents.dispatch(e.id,row.intent_key,e.generation);
      if(!dispatch.execute_token)return expire();
      const latest=this.endpoint(e.id);
      if(!latest||latest.state!=="enabled"||latest.generation!==e.generation||latest.revision!==e.revision||Date.now()>=a.expires_at){this.intents.markUnknown(e.id,row.intent_key);return json(this.intents.status(e.id,row.intent_key));}
      const timer=setTimeout(()=>this.terminateMutation(row.operation_id),8000);
      this.pendingMutations.set(row.operation_id,{endpoint_id:e.id,intent_key:row.intent_key,generation:e.generation,revision:e.revision,socket,phase:"dispatched",timer});
      try{socket.send(JSON.stringify({type:"execute_request",operation_id:row.operation_id,intent_key:row.intent_key,generation:e.generation,execute_token:dispatch.execute_token,owner_approved:true,run_id:a.run_id,expires_at:a.expires_at}));}
      catch{this.terminateMutation(row.operation_id);}
      return json(this.intents.status(e.id,row.intent_key));
    } finally {if(decide)this.admittingEndpoints.delete(e.id);}
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
  private live(id: string, generation: number) {
    return this.state.getWebSockets().some(s => {
      const a = s.deserializeAttachment() as SocketAuth | null;
      return a?.authenticated === true && a.endpoint_id === id &&
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
    this.expireApprovals(now);
    if(url.pathname==="/owner-view"||url.pathname==="/owner-decide")return this.ownerApproval(arg,url.pathname==="/owner-decide");
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
      return json(this.withApproval(result),result.error_code?result.error_code==="not_found"?404:400:200);
    }
    if (url.pathname === "/activity-summary") {
      if(Object.keys(arg).length!==2 || !validId(arg.endpoint_id) || typeof arg.credential!=="string" || arg.credential.length!==64)
        return json({error_code:"invalid_arguments"},400);
      const e=this.endpoint(arg.endpoint_id);
      if(!e || e.state==='revoked' || (await hash(arg.credential))!==e.credential_hash)return json({error_code:"unauthorized"},401);
      this.intents.reconcile(now);
      const approvals=this.sql.exec<{operation_id:string;expires_at:number}>("SELECT a.operation_id,a.expires_at FROM browser_approvals a JOIN browser_intents i ON i.operation_id=a.operation_id WHERE i.endpoint_id=? AND i.state='pending_approval'",e.id).toArray();
      return json({...this.intents.activitySummary(e.id),...(approvals.length?{approvals:approvals.map(a=>({...a,state:"pending_approval"}))}: {})});
    }
    if (url.pathname === "/create-pair") {
      if (!this.budget("create", 12, now)) return json({error:"rate_limited"},429);
      const code = secret().slice(0, 24);
      this.sql.exec("DELETE FROM pairs WHERE expires_at < ? OR used=1",now);
      this.sql.exec("INSERT INTO pairs(code_hash,expires_at) VALUES(?,?)",await hash(code),now+600000);
      return json({ pairing_code: code, expires_at: now+600000 });
    }
    if (url.pathname === "/claim") {
      const ip = typeof arg.client_ip === "string" && arg.client_ip.length <= 64 ? arg.client_ip : "unknown";
      this.sql.exec("DELETE FROM limits WHERE window_start < ?",now - 60000);
      if (!this.budget("claim:global", 80, now) || !this.budget("claim:"+ip, 8, now)) return json({error:"rate_limited"},429);
      if (typeof arg.code !== "string" || !/^[0-9a-f]{24}$/.test(arg.code) || !safeAlias(arg.alias)) return json({error:"invalid_pairing"},400);
      this.sql.exec("DELETE FROM endpoints WHERE state='revoked' AND updated_at < ?",now-7*86400000);
      const active=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM endpoints WHERE state!='revoked'").toArray()[0]?.n??0;
      if(active>=100)return json({error:"capacity_exceeded"},429);
      const codeHash = await hash(arg.code);
      const id = crypto.randomUUID();
      const credential = secret();
      const credentialHash = await hash(credential);
      const found = this.sql.exec<{used:number;expires_at:number}>("SELECT used,expires_at FROM pairs WHERE code_hash=?",codeHash).toArray()[0];
      if (!found || found.used || found.expires_at < now) return json({error:"invalid_pairing"},403);
      // No await between the one-use update and insertion.
      const updated=this.sql.exec("UPDATE pairs SET used=1 WHERE code_hash=? AND used=0 AND expires_at>=?",codeHash,now);
      if(updated.rowsWritten!==1)return json({error:"invalid_pairing"},403);
      this.sql.exec("INSERT INTO endpoints(id,alias,credential_hash,state,generation,revision,updated_at) VALUES(?,?,?,'stopped',0,0,?)",id,arg.alias,credentialHash,now);
      return json({endpoint_id:id,credential,authorization:"stopped"});
    }
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
        return json(this.withApproval(recovered),recovered.error_code?409:200);
      }
      const e=this.endpoint(command.endpoint_id);
      if(!e||e.state!=="enabled")return json({error_code:e?.state==="stopped"?"stopped":"revoked"},403);
      const pending=this.admittingEndpoints.has(e.id) ||
        [...this.pendingMutations.values()].some(p=>p.endpoint_id===e.id) ||
        [...this.pendingReads.values()].some(p=>p.endpoint_id===e.id);
      if(prior.error_code==="not_found" && (pending||this.intents.hasDispatching(e.id)))
        return json({error_code:"busy"},409);
      const socket=this.state.getWebSockets().find(sock=>{
        const a=sock.deserializeAttachment() as SocketAuth|null;
        return a?.authenticated&&a.endpoint_id===e.id&&a.generation===e.generation&&
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
      let prepared:(()=>void)|undefined;
      const ready=approvalConfig(this.env)?new Promise<void>(resolve=>{prepared=resolve;}):null;
      const timer=setTimeout(()=>this.terminateMutation(operation_id),8000);
      this.pendingMutations.set(operation_id,{
        endpoint_id:e.id,intent_key:command.intent_key,generation:e.generation,revision:e.revision,
        socket,phase:"preparing",timer,prepared
      });
      try {socket.send(JSON.stringify({type:"prepare_request",operation_id,
        intent_key:command.intent_key,generation:e.generation,command,
        approval_available:!!approvalConfig(this.env)&& (socket.deserializeAttachment() as SocketAuth)?.approval_origin===approvalConfig(this.env)?.origin,expires_at:now+300000}));}
      catch {this.terminateMutation(operation_id);}
      if(ready)await ready;
      return json(this.withApproval(this.intents.status(e.id,command.intent_key)));
    }
    if (url.pathname === "/read") {
      const id=arg.endpoint_id;
      if(!validId(id) || (arg.tool!=="tabs" && arg.tool!=="snapshot" && arg.tool!=="screenshot") ||
          ((arg.tool==="snapshot"||arg.tool==="screenshot") && (!Number.isSafeInteger(arg.tab_id) || (arg.tab_id as number)<0)) ||
          (arg.scope!==undefined&&(arg.tool!=="tabs"||!["ordinary","private"].includes(arg.scope as string))) ||
          Object.keys(arg).some(k=>!["endpoint_id","tool","tab_id","scope"].includes(k)))
        return json({error_code:"invalid_arguments"},400);
      const e=this.endpoint(id);
      if(!e || e.state!=="enabled")return json({error_code:e?.state==="stopped"?"stopped":"revoked"},403);
      const socket=this.state.getWebSockets().find(sock=>{
        const a=sock.deserializeAttachment() as SocketAuth|null;
        return a?.authenticated && a.endpoint_id===id && a.generation===e.generation &&
          typeof a.last_seen==="number" && Date.now()-a.last_seen<60000 && sock.readyState===WebSocket.OPEN;
      });
      if(!socket)return json({error_code:"offline"},503);
      if([...this.pendingReads.values()].some(p=>p.endpoint_id===id) ||
         this.admittingEndpoints.has(id) ||
         [...this.pendingMutations.values()].some(p=>p.endpoint_id===id) ||
         this.intents.hasDispatching(id))return json({error_code:"busy"},409);
      const request_id=crypto.randomUUID();
      const outcome=await new Promise<unknown>(resolve=>{
        const timer=setTimeout(()=>{this.pendingReads.delete(request_id);resolve({error_code:"timeout"});},5000);
        this.pendingReads.set(request_id,{endpoint_id:id,generation:e.generation,socket,resolve,timer,tool:arg.tool as string});
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
        url.pathname === "/local-resume" || url.pathname === "/local-revoke") {
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
    if (url.pathname === "/local-resume") {
      this.sql.exec("UPDATE endpoints SET state='enabled',revision=revision+1,updated_at=? WHERE id=?",now,id);
      return json({endpoint_id:id,authorization:"enabled"});
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
    if(Number.isFinite(next))await this.state.storage.setAlarm(next);
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const auth = socket.deserializeAttachment() as SocketAuth | null;
    if (!auth || typeof message !== "string" || message.length > (auth.authenticated?2200000:4096) || Date.now() > auth.deadline && !auth.authenticated) {
      socket.close(1008,"invalid_frame");return;
    }
    let v: Record<string,unknown>;
    try { v = JSON.parse(message) as Record<string,unknown>; if (!v || Array.isArray(v)) throw Error(); }
    catch {socket.close(1008,"invalid_frame");return;}
    if (!auth.authenticated) {
      if (v.type !== "authenticate" || v.protocol !== 1 || v.extension_version !== "0.1.0" || !validId(v.endpoint_id) ||
          typeof v.credential !== "string" || v.credential.length !== 64) {
        socket.close(1008,"authentication_required");return;
      }
      const e = this.endpoint(v.endpoint_id);
      if (!e || e.state !== "enabled" || (await hash(v.credential)) !== e.credential_hash) {
        socket.close(1008,"unauthorized");return;
      }
      const current=this.endpoint(e.id);
      if(!current||current.state!=="enabled"||current.revision!==e.revision||current.generation!==e.generation){socket.close(1008,"stale_auth");return;}
      const generation = current.generation + 1;
      const update=this.sql.exec("UPDATE endpoints SET generation=?,updated_at=? WHERE id=? AND state='enabled' AND generation=? AND revision=?",generation,Date.now(),e.id,current.generation,current.revision);
      if(update.rowsWritten!==1){socket.close(1008,"stale_auth");return;}
      for (const other of this.state.getWebSockets()) {
        if (other !== socket && (other.deserializeAttachment() as SocketAuth|null)?.endpoint_id === e.id) {
          for(const [op,p] of this.pendingMutations)if(p.socket===other)this.terminateMutation(op);
          try {other.close(1000,"superseded");} catch {}
        }
      }
      socket.serializeAttachment({authenticated:true,endpoint_id:e.id,generation,deadline:0,last_seen:Date.now(),approval_origin:v.service_origin===approvalConfig(this.env)?.origin?v.service_origin as string:undefined} satisfies SocketAuth);
      socket.send(JSON.stringify({type:"authenticated",endpoint_id:e.id,generation,protocol:1}));
      return;
    }
    const e = this.endpoint(auth.endpoint_id!);
    if (!e || e.state !== "enabled" || e.generation !== auth.generation) {socket.close(1008,"stale_connection");return;}
    if(v.type==="approval_result"&&validId(v.request_id)&&v.generation===e.generation){
      const p=this.approvalReads.get(v.request_id);
      if(!p||p.socket!==socket)return;
      clearTimeout(p.timer);this.approvalReads.delete(v.request_id);p.resolve(v);return;
    }
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
      if(v.accepted===true && v.approval_required===true) {
        if(!approvalConfig(this.env)||auth.approval_origin!==approvalConfig(this.env)?.origin||!validId(v.run_id)||!Number.isSafeInteger(v.expires_at)||
           (v.expires_at as number)>Date.now()+300000||(v.expires_at as number)<=Date.now()||
           !v.command||!v.context||JSON.stringify(v.context).length>8192||JSON.stringify(v.command).length>65536||
           !await this.intents.matchesCommand(v.command as Command,v.operation_id)){
          this.terminateMutation(v.operation_id);return;
        }
        const current=this.endpoint(e.id);
        const count=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM browser_intents WHERE endpoint_id=? AND state='pending_approval'",e.id).toArray()[0]?.n??0;
        if(!current||current.state!=="enabled"||current.generation!==e.generation||current.revision!==latest.revision||count>=10){
          this.terminateMutation(v.operation_id);
          if(count>=10)this.sql.exec("UPDATE browser_intents SET result_code='capacity_exceeded' WHERE operation_id=? AND state='failed'",v.operation_id);
          return;
        }
        const binding=await this.approvalBinding(v.command as Command,v.run_id as string,e.generation,latest.revision,v.expires_at as number,v.context);
        const after=this.endpoint(e.id);
        if(!after||after.state!=="enabled"||after.generation!==e.generation||after.revision!==latest.revision||!this.pendingMutations.has(v.operation_id)){this.terminateMutation(v.operation_id);return;}
        this.sql.exec("INSERT OR IGNORE INTO browser_approvals(operation_id,run_id,binding,expires_at) VALUES(?,?,?,?)",v.operation_id,v.run_id,binding,v.expires_at);
        this.intents.approvalState(e.id,v.intent_key,"pending_approval");
        clearTimeout(pending.timer);pending.prepared?.();this.pendingMutations.delete(v.operation_id);
        return; // prepare never grants execute, and waiting holds no lock
      }
      if(v.accepted!==true){
        this.intents.abort(e.id,v.intent_key);
        const denial=v.error_code==="approval_required"?"approval_blocked":safeFailureCode(v.error_code);
        if(denial)this.sql.exec("UPDATE browser_intents SET result_code=? WHERE operation_id=? AND state='failed'",denial,v.operation_id);
        if(pending){clearTimeout(pending.timer);pending.prepared?.();this.pendingMutations.delete(v.operation_id);}
        return;
      }
      const dispatch=await this.intents.dispatch(e.id,v.intent_key,e.generation);
      if(!dispatch.execute_token || dispatch.state!=="dispatching"){
        if(pending)this.terminateMutation(v.operation_id);
        return;
      }
      if(pending){pending.phase="dispatched";pending.prepared?.();}
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
        clearTimeout(pending.timer);pending.prepared?.();this.pendingMutations.delete(v.operation_id);
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
  webSocketClose(socket:WebSocket,_code:number,_reason:string,_wasClean:boolean):void {
    for(const [id,p] of this.approvalReads)if(p.socket===socket){clearTimeout(p.timer);this.approvalReads.delete(id);p.resolve(null);}
    for(const [op,p] of this.pendingMutations)if(p.socket===socket)this.terminateMutation(op);
    for(const [id,p] of this.pendingReads){if(p.socket===socket){clearTimeout(p.timer);this.pendingReads.delete(id);p.resolve({error_code:"offline"});}}
  }
  webSocketError(_socket:WebSocket,_error:unknown):void {}
}
