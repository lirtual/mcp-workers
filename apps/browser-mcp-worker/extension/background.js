importScripts("config.js");
importScripts("observation.js");
importScripts("mutations.js");
// Browser MCP Profile identity lives only in trusted extension storage.
// A release must pin this exact trusted origin; arbitrary origins are not permitted.
// storage.local defaults to content-script readable: deny access before handling commands.
const trustedStorage = chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"});
const trustedSession = chrome.storage.session.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"});
// Handle an early rejection even before a command arrives; command awaits still
// reject and cannot proceed when trusted session access cannot be established.
void trustedSession.catch(()=>{});
let sensitiveEpoch=0, sensitiveChanging=0, sensitiveFault=false;
let localBlocked=false;
let sensitiveWrites=Promise.resolve();
async function sensitiveToken() {
  return sensitiveEpoch+":"+(await browserSensitivePermissions()).revision;
}
function changeSensitivePermission(surface,enabled) {
  if(!["lan","private"].includes(surface)||typeof enabled!=="boolean")throw Error("invalid_permission");
  // Invalidate pending work synchronously, including delayed writes and off/on.
  sensitiveEpoch++;sensitiveChanging++;lastObserved=null;
  const epoch=sensitiveEpoch;
  const task=sensitiveWrites.catch(()=>{}).then(async()=>{
    await trustedSession;
    const prior=(await chrome.storage.session.get("browser_sensitive_grants")).browser_sensitive_grants??{lan:false,private:false};
    if(enabled&&(epoch!==sensitiveEpoch||(await state()).authorization!=="enabled"))throw Error("local_authorization_changed");
    if(enabled&&surface==="private"&&!await browserNativePrivateAllowed())throw Error("private_permission_denied: Enable Allow in Incognito/InPrivate in Chrome/Edge first; native access unavailable or denied");
    await chrome.storage.session.set({browser_sensitive_grants:{...prior,[surface]:enabled,revision:crypto.randomUUID()}});
    // A delayed enable write cannot undo a later Stop or disable.
    if(enabled&&epoch!==sensitiveEpoch)await chrome.storage.session.set({browser_sensitive_grants:{lan:false,private:false,revision:crypto.randomUUID()}});
    sensitiveFault=false;
  }).catch(async error=>{
    if(!error.message?.startsWith("private_permission_denied")&&error.message!=="local_authorization_changed"){
      sensitiveFault=true;localBlocked=true;
      await persist({authorization:"stopped",pending_cloud_stop:true});clearNetwork();
    }
    throw error;
  }).finally(()=>{sensitiveChanging--;});
  sensitiveWrites=task;
  return task;
}
function clearSensitivePermissions() {
  sensitiveEpoch++;sensitiveChanging++;lastObserved=null;
  const task=sensitiveWrites.catch(()=>{}).then(()=>chrome.storage.session.set({browser_sensitive_grants:{lan:false,private:false,revision:crypto.randomUUID()}})).then(()=>{sensitiveFault=false;},error=>{sensitiveFault=true;throw error;}).finally(()=>{sensitiveChanging--;});
  sensitiveWrites=task;return task;
}
const DEFAULT = {authorization:"unpaired",connection:"offline",last_update:0,pending_cloud_stop:false};
let socket = null, timer = null, reconnect = null;
let currentGeneration = 0;
// In-memory only: never persist tab title, URL, document identity or page content.
let lastObserved = null;
const executingOperations=new Set();
// A local Stop/Revoke invalidates every earlier in-flight Enable response.
let localDenialEpoch=0;
let pendingCloudActivations=0;
const state = async () => {
  await trustedStorage;
  await trustedSession;
  const saved=await chrome.storage.session.get("browser_temporary_grant");
  const stored = {...DEFAULT,...await chrome.storage.local.get(null),...(saved.browser_temporary_grant?Object.fromEntries(Object.entries(saved.browser_temporary_grant).filter(([k])=>k!=="authorization")): {})};
  if(stored.pairing_mode==="temporary"&&(!saved.browser_temporary_grant||
      saved.browser_temporary_grant.lease_expires_at<=Date.now())){
    stored.authorization="stopped";
    delete stored.credential;delete stored.endpoint_id;
  }
  if(localBlocked&&stored.authorization==="enabled")stored.authorization="stopped";
  // Connectivity is runtime evidence, never an assertion inherited from disk.
  const live = stored.authorization==="enabled" && socket?.readyState===1 && currentGeneration>0;
  const connecting = stored.authorization==="enabled" && socket?.readyState<=1 && !live;
  return {...stored,connection:live?"online":connecting?"connecting":"offline"};
};
const persist = async (fields) => {
  await trustedStorage;
  await chrome.storage.local.set({...fields,last_update:Date.now()});
  await render();
};
async function render() {
  const s = await state();
  const activation=(await chrome.storage.session.get("browser_activation_attempt")).browser_activation_attempt;
  const label=s.authorization==="revoked"?"REV":activation?"AUTH":s.pending_cloud_stop?"STOP":
    s.authorization!=="enabled"?"OFF":s.connection==="online"?"ON":"WAIT";
  await chrome.action.setBadgeText({text:label});
  await chrome.action.setTitle({title:`Browser MCP — ${activation?"authenticating":s.authorization} / ${s.connection}${s.pending_cloud_stop?" · cloud Stop pending":""}`});
}
function clearNetwork() {
  currentGeneration=0;
  lastObserved=null;
  if(timer)clearInterval(timer);timer=null;
  if(reconnect)clearTimeout(reconnect);reconnect=null;
  if(socket){const ws=socket;socket=null;try{ws.close();}catch{}}
}
function validService(value) {
  try {const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&u.pathname==="/"&&!u.search&&!u.hash&&
    !["localhost","127.0.0.1","0.0.0.0"].includes(u.hostname)&&u.origin===BROWSER_MCP_SERVICE_ORIGIN ? u.origin : null;}
  catch{return null;}
}
async function endpointPost(route,cred,data={}) {
  const url=validService(cred.service);
  if(!url)throw Error("invalid_service");
  const response=await fetch(url+"/extension/"+route,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({...data,endpoint_id:cred.endpoint_id,credential:cred.credential}),redirect:"error",
    ...(route==="summary"&&typeof AbortSignal!=="undefined"?{signal:AbortSignal.timeout(3500)}:{})});
  const result=await response.json();
  if(!response.ok)throw Error(result.error||"service_unavailable");
  return result;
}
// Only toolbar clicks start activation. The proof never enters page URLs, content
// scripts, logs or MCP results. A verified Access page alone cannot activate.
async function activationRequest(route,data) {
  const url=validService(BROWSER_MCP_SERVICE_ORIGIN);
  if(!url)throw Error("invalid_service");
  const response=await fetch(url+"/extension/activate-"+route,{method:"POST",
    headers:{"content-type":"application/json"},body:JSON.stringify(data),redirect:"error"});
  const result=await response.json();
  if(!response.ok){if(response.status===409&&result.state==="awaiting_owner")return result;
    throw Error(result.error||"activation_unavailable");}
  return result;
}
function newProof(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");}
async function proofHash(value){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,"0")).join("");}
async function activationAttempt(){await trustedSession;return (await chrome.storage.session.get("browser_activation_attempt")).browser_activation_attempt;}
async function beginActivation(){
  const epoch=localDenialEpoch;
  const s=await state();
  if(s.authorization==="enabled"||await activationAttempt())throw Error("already_active");
  if(s.pending_revocation_id)throw Error("cloud_revocation_unconfirmed");
  if(s.pending_cloud_stop){await syncPendingStop();if((await state()).pending_cloud_stop)throw Error("cloud_stop_not_confirmed");}
  const mode=s.endpoint_id?s.pairing_mode??"permanent":s.pairing_preference??"permanent";
  const proof=newProof(),attempt_id=crypto.randomUUID();
  const attempt={attempt_id,proof,epoch,mode,created_at:Date.now()};
  await chrome.storage.session.set({browser_activation_attempt:attempt});
  try{
    const result=await activationRequest("begin",{attempt_id,proof_hash:await proofHash(proof),
      alias:s.alias||"Browser profile",mode,...(s.endpoint_id?{endpoint_id:s.endpoint_id,credential:s.credential}:{})});
    if(result.state!=="pending"||localDenialEpoch!==epoch||
       (await activationAttempt())?.attempt_id!==attempt_id)throw Error("activation_superseded");
    const tab=await chrome.tabs.create({url:BROWSER_MCP_SERVICE_ORIGIN+"/activate/verify/"+attempt_id+"?extension="+chrome.runtime.id,active:true});
    // The auth page is the only tab this extension may close automatically.
    if(Number.isSafeInteger(tab.id))await chrome.storage.session.set({
      browser_activation_tab:{attempt_id,tab_id:tab.id,epoch}});
    await chrome.alarms.create("browser-activation",{periodInMinutes:0.5});
    void pollActivation();
    await render();
    return {state:"authenticating"};
  }catch(error){await chrome.storage.session.remove("browser_activation_attempt");await render();throw error;}
}
// Access success wakes the local proof-bound completion immediately; the
// 30-second alarm remains only as a recovery fallback.
let pollingActivation=false,activationWakePending=false;
function wakeActivation(){
  if(pollingActivation){activationWakePending=true;return;}
  void pollActivation();
}
async function closeVerifiedActivationTab(){
  await trustedSession;
  const marker=(await chrome.storage.session.get("browser_activation_tab")).browser_activation_tab;
  if(!marker?.confirmed_endpoint_id||!Number.isSafeInteger(marker.tab_id)||
     marker.epoch!==localDenialEpoch||currentGeneration<=0)return;
  const s=await state();
  if(s.authorization!=="enabled"||s.endpoint_id!==marker.confirmed_endpoint_id||
     s.connection!=="online")return;
  const expected=BROWSER_MCP_SERVICE_ORIGIN+"/activate/verify/"+marker.attempt_id+
    "?extension="+chrome.runtime.id;
  try {
    const tab=await chrome.tabs.get(marker.tab_id);
    // Do not close reused, navigated, or pre-existing browser tabs.
    if(tab.id===marker.tab_id&&tab.url===expected&&
       localDenialEpoch===marker.epoch&&(await state()).authorization==="enabled")
      await chrome.tabs.remove(marker.tab_id);
  } catch {/* Tab was closed by the user or the browser; not an auth failure. */}
  await chrome.storage.session.remove("browser_activation_tab");
}
async function pollActivation(){
  if(pollingActivation)return;pollingActivation=true;try{
  const a=await activationAttempt();if(!a)return;
  if(Date.now()-a.created_at>=300000){await chrome.storage.session.remove(["browser_activation_attempt","browser_activation_tab"]);await render();return;}
  const s=await state();
  if(s.authorization==="enabled"||s.pending_cloud_stop)return;
  let result;
  pendingCloudActivations++;
  try {result=await activationRequest("complete",{attempt_id:a.attempt_id,proof:a.proof,
    ...(s.endpoint_id?{endpoint_id:s.endpoint_id,credential:s.credential}:{})});}
  catch{return;}
  finally{pendingCloudActivations--;if(pendingCloudActivations===0)void syncPendingStop();} // transient network loss cannot grant control
  if(result.state==="awaiting_owner")return;
  const current=await activationAttempt();
  if(!current||current.attempt_id!==a.attempt_id||localDenialEpoch!==a.epoch){
    if(result.endpoint_id){
      const cred=result.credential||s.credential;
      const existing=s.endpoint_id===result.endpoint_id;
      if(cred){
        try{
          // An abandoned *new* Endpoint has no retained local identity: revoke
          // it; an earlier paired Endpoint must be stopped, not revoked.
          await endpointPost(existing?"stop":"revoke",{service:BROWSER_MCP_SERVICE_ORIGIN,
            endpoint_id:result.endpoint_id,credential:cred});
          if(existing)await persist({pending_cloud_stop:false});
        }catch{
          // The cloud result is unknown, never present an unconfirmed denial
          // as fully reconciled. A new grant needs owner MCP revocation.
          if(existing)await persist({pending_cloud_stop:true});
          else await persist({pending_revocation_id:result.endpoint_id});
        }
      }else await persist({pending_revocation_id:result.endpoint_id});
    }
    return;
  }
  if(result.authorization!=="enabled"||!result.endpoint_id)return;
  if(a.mode==="temporary"){
    await chrome.storage.session.set({browser_temporary_grant:{service:BROWSER_MCP_SERVICE_ORIGIN,
      endpoint_id:result.endpoint_id,credential:result.credential||s.credential,
      pairing_mode:"temporary",lease_expires_at:result.lease_expires_at||s.lease_expires_at,
      alias:s.alias||"Browser profile"}});
    await persist({authorization:"enabled",pairing_mode:"temporary",connection:"connecting",pending_cloud_stop:false});
  }else{
    await persist({service:BROWSER_MCP_SERVICE_ORIGIN,endpoint_id:result.endpoint_id,
      credential:result.credential||s.credential,pairing_mode:"permanent",alias:s.alias||"Browser profile",
      authorization:"enabled",connection:"connecting",pending_cloud_stop:false});
  }
  const marker=(await chrome.storage.session.get("browser_activation_tab")).browser_activation_tab;
  if(marker?.attempt_id===a.attempt_id&&marker.epoch===a.epoch&&localDenialEpoch===a.epoch)
    await chrome.storage.session.set({browser_activation_tab:{...marker,confirmed_endpoint_id:result.endpoint_id}});
  await chrome.storage.session.remove("browser_activation_attempt");
  if(localDenialEpoch!==a.epoch){await stopLocal();return;}
  localBlocked=false;connect();await render();
  }finally{
    pollingActivation=false;
    if(activationWakePending){activationWakePending=false;void pollActivation();}
  }
}
async function clearObservedTargetFeedback(target=lastObserved) {
  if(!target)return;
  try {await chrome.scripting.executeScript({
    target:{tabId:target.tab_id,documentIds:[target.document_id]},
    world:"ISOLATED",func:browserClearTargetFeedback
  });}catch { /* expired tab/document; navigation also destroys the overlay */ }
}
async function stopLocal() {
  const feedbackTarget=lastObserved;
  localBlocked=true;
  localDenialEpoch++;
  const active=await activationAttempt();
  await chrome.storage.session.remove(["browser_activation_attempt","browser_activation_tab"]);
  if(active)void activationRequest("cancel",{attempt_id:active.attempt_id,proof:active.proof}).catch(()=>{});
  const sensitiveClear=clearSensitivePermissions();
  void sensitiveClear.catch(()=>{});
  // A never-paired Profile has no cloud grant to reconcile.
  const hadEndpoint=Boolean((await state()).endpoint_id);
  // Persist the local denial *before* any cloud/network action.
  await persist({authorization:"stopped",connection:"offline",pending_cloud_stop:hadEndpoint});
  clearNetwork();
  await clearObservedTargetFeedback(feedbackTarget);
  const s=await state();
  if(s.endpoint_id) {
    try {
      await endpointPost("stop",s);
      // An earlier cloud Enable still in transit can arrive after this Stop.
      if(pendingCloudActivations===0)await persist({pending_cloud_stop:false});
    } catch { /* cloud not confirmed; show pending stop */ }
  }
  return {authorization:"stopped",cloud_confirmed:!(await state()).pending_cloud_stop};
}
async function locateObservedTab() {
  const target=lastObserved;
  const local=await state();
  if(!target||local.authorization!=="enabled")throw Error("no_observed_tab");
  const tab=await chrome.tabs.get(target.tab_id);
  if(!await browserAccessTab(tab))throw Error("stale_target");
  const frame=await chrome.webNavigation.getFrame({tabId:target.tab_id,frameId:0});
  if(!frame||frame.documentId!==target.document_id||!await browserAccessUrl(frame.url)||
     new URL(frame.url).href!==new URL(tab.url).href)throw Error("stale_target");
  // Trusted Options action only. Remote reads never change focus.
  if(lastObserved!==target||(await state()).authorization!=="enabled")throw Error("stale_target");
  await chrome.windows.update(tab.windowId,{focused:true});
  await chrome.tabs.update(tab.id,{active:true});
  return {located:true,tab_id:target.tab_id};
}
async function acknowledgeCloudRevocation() {
  const s=await state();
  if(s.endpoint_id||s.authorization!=="revoked"||!s.pending_revocation_id)throw Error("no_pending_revocation");
  await persist({pending_revocation_id:null});
  return {acknowledged_locally:true};
}
async function revokeLocal() {
  const feedbackTarget=lastObserved;
  localBlocked=true;
  localDenialEpoch++;
  const active=await activationAttempt();
  await chrome.storage.session.remove(["browser_activation_attempt","browser_activation_tab"]);
  if(active)void activationRequest("cancel",{attempt_id:active.attempt_id,proof:active.proof}).catch(()=>{});
  const sensitiveClear=clearSensitivePermissions();
  void sensitiveClear.catch(()=>{});
  const s=await state();
  await trustedStorage;
  await chrome.storage.local.remove(["credential","endpoint_id"]);
  await chrome.storage.session.remove("browser_temporary_grant");
  await persist({authorization:"revoked",connection:"offline",pending_cloud_stop:false,pending_revocation_id:s.endpoint_id||s.pending_revocation_id||null});
  clearNetwork();
  await clearObservedTargetFeedback(feedbackTarget);
  if(!s.endpoint_id)return {cloud_confirmed:false};
  try {await endpointPost("revoke",s);await persist({pending_revocation_id:null});return {cloud_confirmed:true};}
  catch{return {cloud_confirmed:false,action:"Use authenticated browser_revoke with the old endpoint_id to finish cloud revocation."};}
}
async function syncPendingStop() {
  const s=await state();
  if(!s.pending_cloud_stop||!s.endpoint_id)return;
  try {
    await endpointPost("stop",s);
    if(pendingCloudActivations===0)await persist({pending_cloud_stop:false});
  } catch {/* no privilege expansion on failed sync */}
}
function connect() {
  if(socket&&(socket.readyState===0||socket.readyState===1))return;
  clearNetwork();
  void (async()=>{
    const s=await state();
    if(s.authorization!=="enabled"||!s.endpoint_id||!validService(s.service))return;
    if((await state()).authorization!=="enabled")return;
    const wsUrl=s.service.replace(/^https:/,"wss:")+"/extension/socket";
    const ws=new WebSocket(wsUrl);
    socket=ws;
    // state() derives connecting from this socket; no asynchronous storage write
    // may delay registering handlers and lose a fast WSS open/authentication.
    ws.onopen=()=>{
      if(socket!==ws)return;
      ws.send(JSON.stringify({type:"authenticate",protocol:3,extension_version:"0.2.5",endpoint_id:s.endpoint_id,credential:s.credential,service_origin:s.service}));
    };
    ws.onmessage=async event=>{
      if(socket!==ws)return;
      let message;try{message=JSON.parse(event.data);}catch{return;}
      if(message.type==="authenticated"&&message.endpoint_id===s.endpoint_id&&Number.isInteger(message.generation)){
        currentGeneration=message.generation;
        await persist({connection:"online"});
        void closeVerifiedActivationTab().catch(()=>{});
        timer=setInterval(()=>{if(socket===ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:"ping",generation:currentGeneration}));},20000);
      } else if(message.type==="prepare_request") {
        if(message.generation!==currentGeneration||typeof message.operation_id!=="string"||
            !/^[a-f0-9-]{36}$/.test(message.operation_id))return;
        let accepted=false,proposal={};
        // Fixed preparation-stage reason codes only; never send page content or raw exceptions.
        let prepareStage="validation";
        try {
          const permissionToken=await sensitiveToken();
          const check=await browserValidateMutation(message.command);
          if(check.error_code)proposal={error_code:check.error_code};
          prepareStage="context";
          const local=await state();
          const validContext=permissionToken===await sensitiveToken()&&message.command?.endpoint_id===local.endpoint_id&&socket===ws&&local.authorization==="enabled"&&
              message.generation===currentGeneration;
          if(check.ready&&validContext){
            prepareStage="storage";
            await trustedSession;
            const all=await chrome.storage.session.get(null);
            const prepared=Object.entries(all).filter(([k])=>k.startsWith("browser_prepare_"));
            for(const [k,v] of prepared)if(v.expires_at<Date.now()||v.generation!==currentGeneration)await chrome.storage.session.remove(k);
            if(new TextEncoder().encode(JSON.stringify(message.command)).byteLength>65536)throw Error("capacity_exceeded");
            await chrome.storage.session.set({["browser_prepare_"+message.operation_id]:{
              command:message.command,permissionToken,generation:message.generation,
              endpoint_id:local.endpoint_id,expires_at:Date.now()+15000
            }});
            accepted=true;
          } else if(check.ready)proposal={error_code:"prepare_context_changed"};
          else if(!check.error_code)proposal={error_code:"prepare_validation_unavailable"};
        } catch(error){
          // Preserve fail-closed behavior and avoid exposing exception messages.
          proposal={error_code:error?.message==="capacity_exceeded"?"capacity_exceeded":
            prepareStage==="expiry"?"prepare_expired":
            prepareStage==="storage"?"prepare_storage_unavailable":
            prepareStage==="context"?"prepare_context_changed":"prepare_validation_unavailable"};
        }
        if(socket===ws&&ws.readyState===WebSocket.OPEN&&message.generation===currentGeneration)
          ws.send(JSON.stringify({type:"prepare_result",operation_id:message.operation_id,
            intent_key:message.intent_key,generation:currentGeneration,accepted,...proposal}));
      } else if(message.type==="execute_request") {
        const op=message.operation_id;
        if(message.generation!==currentGeneration||typeof op!=="string"||
            !/^[a-f0-9-]{36}$/.test(op)||typeof message.execute_token!=="string"||
            !/^[a-f0-9]{64}$/.test(message.execute_token)||executingOperations.has(op))return;
        executingOperations.add(op);
        try {
          const key="browser_prepare_"+op,consumed="browser_consumed_"+op;
          await trustedSession;
          const values=await chrome.storage.session.get([key,consumed]);
          const stored=values[key],local=await state();
          if(!stored||stored.permissionToken!==await sensitiveToken()||values[consumed]||stored.generation!==currentGeneration||
             stored.endpoint_id!==local.endpoint_id||stored.command?.intent_key!==message.intent_key||
             stored.expires_at<Date.now()||local.authorization!=="enabled"||socket!==ws)return;
          // Never dispatch a legacy owner-approved command after protocol retirement.
          if(stored.approval_required!==undefined||message.owner_approved!==undefined||
             message.run_id!==undefined||message.expires_at!==undefined)return;
          // Persist consumption before touching any webpage. Failure means no action.
          await chrome.storage.session.set({[consumed]:true});
          await chrome.storage.session.remove(key);
          const result=await browserExecuteMutation(stored.command,async()=>{
            const latest=await state();
            return stored.permissionToken===await sensitiveToken() && latest.authorization==="enabled" && socket===ws &&
              currentGeneration===message.generation && latest.endpoint_id===stored.endpoint_id;
          });
          // Session-only tab provenance; never derive permission to auto-close from it.
          // If recording fails after a browser effect, leave the receipt Unknown.
          if(result.state==="completed" && Number.isSafeInteger(result.tab_id)){
            const sourceKey="browser_source_"+result.tab_id;
            if(stored.command.action==="tab_open")await chrome.storage.session.set({[sourceKey]:"agent_created"});
            if(stored.command.action==="tab_close")await chrome.storage.session.remove(sourceKey);
          }
          if(socket===ws&&ws.readyState===WebSocket.OPEN&&currentGeneration===message.generation)
            ws.send(JSON.stringify({type:"execute_result",operation_id:op,
              intent_key:message.intent_key,execute_token:message.execute_token,
              generation:currentGeneration,state:result.state,tab_id:result.tab_id??null,
              ...(result.presentation_warning?{presentation_warning:result.presentation_warning}:{}),
              ...(result.state==="failed"&&result.error_code?{error_code:result.error_code}:{})}));
        } catch {/* failure after consumption is Unknown, never retry */}
        finally {executingOperations.delete(op);}
      } else if(message.type==="read_request") {
        if(!/^[a-f0-9-]{36}$/.test(message.request_id||"") || !["tabs","snapshot","screenshot"].includes(message.tool) ||
           message.generation!==currentGeneration)return;
        // Fixed, non-content-bearing progress markers; transient and only for
        // the authenticated in-flight read on this WebSocket generation.
        const progress=stage=>{
          if(message.tool==="snapshot"&&socket===ws&&ws.readyState===WebSocket.OPEN&&
             currentGeneration===message.generation)
            ws.send(JSON.stringify({type:"read_progress",request_id:message.request_id,
              generation:currentGeneration,stage}));
        };
        progress("extension_received");
        const permissionToken=await sensitiveToken();
        let response;
        try { response=await executeBrowserRead(message.tool,message.tab_id,message.scope,async()=>
          socket===ws&&currentGeneration===message.generation&&(await state()).authorization==="enabled"&&permissionToken===await sensitiveToken(),progress); }
        catch { response={error_code:"unavailable"}; }
        const latest=await state();
        if(socket!==ws||ws.readyState!==WebSocket.OPEN||latest.authorization!=="enabled"||
           currentGeneration!==message.generation)return;
        if(!response?.error_code&&(permissionToken!==await sensitiveToken()||message.tool!=="tabs"&&!await browserAccessTab(await chrome.tabs.get(message.tab_id))))response={error_code:"permission_changed"};
        if(message.tool==="tabs"&&message.scope==="private"&&!await browserPrivateAllowed())response={error_code:"private_permission_denied"};
        if(["snapshot","screenshot"].includes(message.tool) && response &&
           response.tab_id===message.tab_id && typeof response.document_id==="string")
          lastObserved={tab_id:message.tab_id,document_id:response.document_id};
        let serialized=JSON.stringify({type:"read_result",request_id:message.request_id,
          generation:currentGeneration,data:response});
        if(new TextEncoder().encode(serialized).byteLength>
            (message.tool==="screenshot"?2200000:262144))
          serialized=JSON.stringify({type:"read_result",request_id:message.request_id,
            generation:currentGeneration,data:{error_code:"capacity_exceeded"}});
        progress("result_transport");
        ws.send(serialized);
      } else if(message.type==="stopped"||message.type==="revoked"){
        const feedbackTarget=lastObserved;
        localBlocked=true;localDenialEpoch++;
        void clearSensitivePermissions().catch(()=>{});
        await chrome.storage.local.set({authorization:message.type,connection:"offline",last_update:Date.now()});
        if(message.type==="revoked"){await chrome.storage.local.remove(["credential","endpoint_id"]);await chrome.storage.session.remove("browser_temporary_grant");}
        clearNetwork();await clearObservedTargetFeedback(feedbackTarget);await render();
      }
    };
    ws.onclose=async()=>{
      if(socket!==ws)return;
      clearNetwork();
      const latest=await state();
      await persist({connection:"offline"});
      if(latest.authorization==="enabled") {
        try {
          const remote=await endpointPost("state",latest);
          if(remote.authorization!=="enabled") {
            await persist({authorization:remote.authorization,connection:"offline"});
            if(remote.authorization==="revoked"){await chrome.storage.local.remove(["credential","endpoint_id"]);await chrome.storage.session.remove("browser_temporary_grant");}
            return;
          }
        } catch { /* offline; reconnect only while local authorization permits */ }
        if((await state()).authorization==="enabled")reconnect=setTimeout(connect,3000+Math.floor(Math.random()*3000));
      }
    };
    ws.onerror=()=>{/* close handler owns recovery */};
  })();
}
// Only the verified Access page opened in this SAME browser Profile may
// acknowledge the current one-time attempt. A copied URL in another Profile
// cannot satisfy the local-presence handshake.
chrome.runtime.onMessageExternal.addListener((message,sender,sendResponse)=>{
  let ok=false;
  try{
    const url=new URL(sender.url);
    const id=/^\/activate\/verify\/([a-f0-9-]{36})$/.exec(url.pathname)?.[1];
    ok=sender.origin===BROWSER_MCP_SERVICE_ORIGIN && url.origin===BROWSER_MCP_SERVICE_ORIGIN &&
      url.searchParams.size===1 && url.searchParams.get("extension")===chrome.runtime.id &&
      ["activation-presence","activation-verified"].includes(message?.type) &&
      message.attempt_id===id && Boolean(id);
  }catch{}
  if(!ok){sendResponse({ok:false});return false;}
  void (async()=>{
    const a=await activationAttempt();
    if(!a||a.attempt_id!==message.attempt_id||a.epoch!==localDenialEpoch||
       Date.now()-a.created_at>=300000)return {ok:false};
    if(message.type==="activation-presence")return {ok:true};
    if(message.type!=="activation-verified"||!Number.isSafeInteger(sender.tab?.id))
      return {ok:false};
    const marker=(await chrome.storage.session.get("browser_activation_tab")).browser_activation_tab;
    if(marker?.attempt_id!==a.attempt_id||marker.epoch!==a.epoch||
       marker.tab_id!==sender.tab.id)return {ok:false};
    wakeActivation();
    return {ok:true};
  })().then(sendResponse,()=>sendResponse({ok:false}));
  return true;
});
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  // A native Options page opened as a browser tab legitimately has sender.tab.
  // Authorize the exact top-level extension-owned Options document, not an
  // arbitrary tab, a content script, a sibling page, or an embedded frame.
  if(sender?.id!==chrome.runtime.id || sender?.url!==chrome.runtime.getURL("options.html") ||
     (sender.frameId!==undefined && sender.frameId!==0)){
    sendResponse({ok:false,error:"untrusted_sender"});
    return false;
  }
  (async()=>{
    if(!message||typeof message!=="object")throw Error("invalid_message");
    if(message.type==="status") {
      const local=await state();
      const {credential,...publicState}=local;
      let activity={available:false};
      if(local.endpoint_id && local.credential && validService(local.service)){
        try {
          const data=await endpointPost("summary",local);
          if(Number.isSafeInteger(data.pending)&&data.pending>=0&&Number.isSafeInteger(data.unknown)&&data.unknown>=0)
            activity={available:true,pending:data.pending,unknown:data.unknown,approvals:data.approvals||[]};
        } catch {/* absence of a confirmed count is NOT a zero count */}
      }
      if(lastObserved){
        try {if(!await browserAccessTab(await chrome.tabs.get(lastObserved.tab_id)))lastObserved=null;}
        catch {lastObserved=null;}
      }
      const tab_id=publicState.authorization==="enabled"?lastObserved?.tab_id??null:null;
      let tab_source="none";
      if(tab_id!==null){
        try {
          const marker=(await chrome.storage.session.get("browser_source_"+tab_id))["browser_source_"+tab_id];
          tab_source=marker==="agent_created"?"agent_created":"existing_or_unknown";
        }catch{tab_source="existing_or_unknown";}
      }
      await browserPrivateAllowed();
      const permissions=await browserSensitivePermissions();
      return {...publicState,sensitive_permissions:{...permissions,native_private:await browserNativePrivateAllowed()},last_observed_tab_id:tab_id,last_observed_scope:tab_id===null?null:(await chrome.tabs.get(tab_id)).incognito===true?"private":"ordinary",last_observed_tab_source:tab_source,activity};
    }
    if(message.type==="sensitive-permission"){await changeSensitivePermission(message.surface,message.enabled);return {changed:true};}
    if(message.type==="locate")return locateObservedTab();
    if(message.type==="pairing-preference"){
      if(!["permanent","temporary"].includes(message.mode)||(await state()).endpoint_id)throw Error("revoke_before_mode_change");
      await persist({pairing_preference:message.mode});return {mode:message.mode};
    }
    if(message.type==="stop")return stopLocal();
    if(message.type==="revoke")return revokeLocal();
    if(message.type==="ack-revocation")return acknowledgeCloudRevocation();
    throw Error("unsupported_message");
  })().then(result=>sendResponse({ok:true,result}),error=>sendResponse({ok:false,error:error?.message||"unavailable"}));
  return true;
});
chrome.tabs.onRemoved.addListener(tab_id=>{
  if(lastObserved?.tab_id===tab_id)lastObserved=null;
  void chrome.storage.session.remove("browser_source_"+tab_id).catch(()=>{});
});
let toolbarBusy=false;
chrome.action.onClicked.addListener(()=>{
  if(toolbarBusy){void stopLocal();return;}
  toolbarBusy=true;
  void (async()=>{
    try{
      if((await state()).authorization==="enabled"||await activationAttempt())await stopLocal();
      else await beginActivation();
    }catch{await render();}
    finally{toolbarBusy=false;}
  })();
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==="browser-activation")void pollActivation();});
let migrationTask;
function migrateActivation(){
  return migrationTask??=(async()=>{
    const s=await state();
    if(s.activation_protocol===2)return;
    // Once only: existing permanently paired Profiles keep identities and
    // receipts, but their previously enabled local state is forced OFF.
    if(s.authorization==="enabled")await stopLocal();
    await persist({activation_protocol:2,authorization:"stopped"});
  })();
}
async function boot(){
  await migrateActivation();
  await syncPendingStop();
  const a=await activationAttempt();
  if(a){await chrome.alarms.create("browser-activation",{periodInMinutes:0.5});void pollActivation();}
  connect();
}
chrome.runtime.onStartup.addListener(()=>{void boot().catch(()=>clearNetwork());});
chrome.runtime.onInstalled.addListener(({reason})=>{
  void (async()=>{
    if(reason==="update"){clearNetwork();await chrome.storage.session.clear();}
    await boot();
  })().catch(()=>clearNetwork());
});
void boot().catch(()=>clearNetwork());
