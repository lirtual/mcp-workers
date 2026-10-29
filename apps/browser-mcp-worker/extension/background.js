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
async function approvalRun() {
  await trustedSession;
  const stored=await chrome.storage.session.get("browser_approval_run");
  if(stored.browser_approval_run)return stored.browser_approval_run;
  const run=crypto.randomUUID();await chrome.storage.session.set({browser_approval_run:run});return run;
}
const DEFAULT = {authorization:"unpaired",connection:"offline",last_update:0,pending_cloud_stop:false};
let socket = null, timer = null, reconnect = null;
let currentGeneration = 0;
// In-memory only: never persist tab title, URL, document identity or page content.
let lastObserved = null;
const executingOperations=new Set();
// A local Stop/Revoke invalidates every earlier in-flight Enable response.
let localDenialEpoch=0;
let pendingCloudEnables=0;
const state = async () => {
  await trustedStorage;
  const stored = {...DEFAULT,...await chrome.storage.local.get(null)};
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
  const label = s.authorization==="revoked"?"REV":s.authorization==="stopped"?"STOP":s.connection==="online"?"ON":"OFF";
  await chrome.action.setBadgeText({text:label});
  await chrome.action.setTitle({title:`Browser MCP — ${s.authorization} / ${s.connection}`});
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
async function pair({service,code,alias}) {
  const url=validService(service);
  await trustedStorage;
  if(!url||!(/^[a-f0-9]{24}$/).test(code)||!alias||alias.length>64)throw Error("invalid_pairing_details");
  const prior=await state();
  if(prior.endpoint_id)throw Error("revoke_existing_endpoint_first");
  if(prior.pending_revocation_id)throw Error("cloud_revocation_unconfirmed");
  const response=await fetch(url+"/extension/claim",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({code,alias}),redirect:"error"});
  const result=await response.json();
  if(!response.ok)throw Error(result.error||"pairing_failed");
  await persist({service:url,endpoint_id:result.endpoint_id,credential:result.credential,alias,
    authorization:"stopped",connection:"offline",pending_cloud_stop:false,pending_revocation_id:null});
  return {authorization:"stopped",endpoint_id:result.endpoint_id};
}
async function stopLocal() {
  localBlocked=true;
  localDenialEpoch++;
  const sensitiveClear=clearSensitivePermissions();
  void sensitiveClear.catch(()=>{});
  // Persist the local denial *before* any cloud/network action.
  await persist({authorization:"stopped",connection:"offline",pending_cloud_stop:true});
  clearNetwork();
  const s=await state();
  if(s.endpoint_id) {
    try {
      await endpointPost("stop",s);
      // An earlier cloud Enable still in transit can arrive after this Stop.
      if(pendingCloudEnables===0)await persist({pending_cloud_stop:false});
    } catch { /* cloud not confirmed; show pending stop */ }
  }
  return {authorization:"stopped",cloud_confirmed:!(await state()).pending_cloud_stop};
}
async function resumeLocal() {
  const requestEpoch=localDenialEpoch;
  await clearSensitivePermissions();
  const s=await state();
  if(!s.endpoint_id||s.authorization==="revoked")throw Error("not_paired");
  if(s.pending_cloud_stop) {
    try{await endpointPost("stop",s);await persist({pending_cloud_stop:false});}
    catch{throw Error("cloud_stop_not_confirmed");}
  }
  // Local user gesture is the only way to enable a stopped Endpoint.
  pendingCloudEnables++;
  let result;
  try {result=await endpointPost("resume",s);}
  finally {pendingCloudEnables--;}
  if(result.authorization!=="enabled")throw Error("resume_not_confirmed");
  // A delayed cloud Enable must never undo a later local Stop. A second
  // cloud Stop also closes the network reordering window (Stop then Resume).
  const denyStaleResume=async()=>{
    const latest=await state();
    // The older Enable write itself might have landed *after* Stop's stored
    // denial. The changed epoch is authoritative, even if disk reads enabled.
    if(latest.endpoint_id===s.endpoint_id &&
       (localDenialEpoch!==requestEpoch || latest.authorization==="stopped")){
      await persist({authorization:"stopped",connection:"offline",pending_cloud_stop:true});
      clearNetwork();
      await syncPendingStop();
    }
    throw Error("local_authorization_changed");
  };
  if(localDenialEpoch!==requestEpoch || (await state()).authorization!=="stopped")
    return denyStaleResume();
  await persist({authorization:"enabled",connection:"connecting",pending_cloud_stop:false});
  // A Stop can run while chrome.storage.local.set is pending. Recheck before
  // opening WSS, repairing local denial/cloud Stop if the older write landed last.
  if(localDenialEpoch!==requestEpoch)return denyStaleResume();
  localBlocked=false;
  connect();
  return result;
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
  // Local Popup action only. Remote reads never change focus.
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
  localBlocked=true;
  localDenialEpoch++;
  const sensitiveClear=clearSensitivePermissions();
  void sensitiveClear.catch(()=>{});
  const s=await state();
  await trustedStorage;
  await chrome.storage.local.remove(["credential","endpoint_id"]);
  await persist({authorization:"revoked",connection:"offline",pending_cloud_stop:false,pending_revocation_id:s.endpoint_id||s.pending_revocation_id||null});
  clearNetwork();
  if(!s.endpoint_id)return {cloud_confirmed:false};
  try {await endpointPost("revoke",s);await persist({pending_revocation_id:null});return {cloud_confirmed:true};}
  catch{return {cloud_confirmed:false,action:"Use authenticated browser_revoke with the old endpoint_id to finish cloud revocation."};}
}
async function syncPendingStop() {
  const s=await state();
  if(!s.pending_cloud_stop||!s.endpoint_id)return;
  try {
    await endpointPost("stop",s);
    if(pendingCloudEnables===0)await persist({pending_cloud_stop:false});
  } catch {/* no privilege expansion on failed sync */}
}
function connect() {
  clearNetwork();
  void (async()=>{
    const s=await state();
    if(s.authorization!=="enabled"||!s.endpoint_id||!validService(s.service))return;
    if((await state()).authorization!=="enabled")return;
    const wsUrl=s.service.replace(/^https:/,"wss:")+"/extension/socket";
    const ws=new WebSocket(wsUrl);
    socket=ws;
    await persist({connection:"connecting"});
    ws.onopen=()=>{
      if(socket!==ws)return;
      ws.send(JSON.stringify({type:"authenticate",protocol:1,extension_version:"0.1.0",endpoint_id:s.endpoint_id,credential:s.credential,service_origin:s.service}));
    };
    ws.onmessage=async event=>{
      if(socket!==ws)return;
      let message;try{message=JSON.parse(event.data);}catch{return;}
      if(message.type==="authenticated"&&message.endpoint_id===s.endpoint_id&&Number.isInteger(message.generation)){
        currentGeneration=message.generation;
        await persist({connection:"online"});
        timer=setInterval(()=>{if(socket===ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:"ping",generation:currentGeneration}));},20000);
      } else if(message.type==="prepare_request") {
        if(message.generation!==currentGeneration||typeof message.operation_id!=="string"||
            !/^[a-f0-9-]{36}$/.test(message.operation_id))return;
        let accepted=false,proposal={};
        try {
          const permissionToken=await sensitiveToken();
          const check=await browserValidateMutation(message.command,message.approval_available===true);
          if(check.error_code==="approval_required")proposal={error_code:"approval_required"};
          const local=await state();
          if(check.ready&&permissionToken===await sensitiveToken()&&message.command?.endpoint_id===local.endpoint_id&&socket===ws&&local.authorization==="enabled"&&
              message.generation===currentGeneration){
            await trustedSession;
            const all=await chrome.storage.session.get(null);
            const prepared=Object.entries(all).filter(([k])=>k.startsWith("browser_prepare_"));
            for(const [k,v] of prepared)if(v.expires_at<Date.now()||v.generation!==currentGeneration)await chrome.storage.session.remove(k);
            const needsApproval=check.approval_required===true;
            if(needsApproval&&prepared.filter(([,v])=>v.approval_required&&v.expires_at>=Date.now()&&v.generation===currentGeneration).length>=10)throw Error("capacity_exceeded");
            if(new TextEncoder().encode(JSON.stringify(message.command)).byteLength>65536)throw Error("capacity_exceeded");
            const run_id=needsApproval?await approvalRun():null;
            if(needsApproval&&(!Number.isSafeInteger(message.expires_at)||message.expires_at>Date.now()+300000||message.expires_at<=Date.now()))throw Error("invalid_expiry");
            proposal=needsApproval?{approval_required:true,command:message.command,run_id,expires_at:message.expires_at,context:{description:check.description,target_url:check.target_url,source_url:check.source_url??null}}:{};
            await chrome.storage.session.set({["browser_prepare_"+message.operation_id]:{
              command:message.command,permissionToken,generation:message.generation,
              endpoint_id:local.endpoint_id,approval_required:needsApproval,run_id,context:proposal.context,
              expires_at:needsApproval?message.expires_at:Date.now()+15000
            }});
            accepted=true;
          }
        } catch(error){if(error?.message==="capacity_exceeded")proposal={error_code:"capacity_exceeded"};/* never execute on invalid prepare */}
        if(socket===ws&&ws.readyState===WebSocket.OPEN&&message.generation===currentGeneration)
          ws.send(JSON.stringify({type:"prepare_result",operation_id:message.operation_id,
            intent_key:message.intent_key,generation:currentGeneration,accepted,...proposal}));
      } else if(message.type==="approval_request") {
        if(message.generation!==currentGeneration||!/^[a-f0-9-]{36}$/.test(message.request_id||"")||!/^[a-f0-9-]{36}$/.test(message.operation_id||""))return;
        let proposal={ready:false};
        try {
          await trustedSession;
          const key="browser_prepare_"+message.operation_id;
          const stored=(await chrome.storage.session.get(key))[key],local=await state();
          if(stored?.permissionToken===await sensitiveToken()&&stored?.approval_required&&stored.generation===currentGeneration&&stored.endpoint_id===local.endpoint_id&&
             stored.expires_at>Date.now()&&stored.run_id===await approvalRun()&&local.authorization==="enabled"){
            const check=await browserValidateMutation(stored.command,true);
            if(check.ready&&check.approval_required&&check.description&&check.description===stored.context.description&&check.target_url===stored.context.target_url&&(check.source_url??null)===stored.context.source_url)
              proposal={ready:true,command:stored.command,run_id:stored.run_id,expires_at:stored.expires_at,context:stored.context};
          }
        }catch{/* no command recovery from local storage, DO or page */}
        if(socket===ws&&currentGeneration===message.generation&&ws.readyState===WebSocket.OPEN)
          ws.send(JSON.stringify({type:"approval_result",request_id:message.request_id,generation:currentGeneration,...proposal}));
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
          if(stored.approval_required&&(message.owner_approved!==true||stored.run_id!==message.run_id||
             stored.run_id!==await approvalRun()||stored.expires_at!==message.expires_at))return;
          // Persist consumption before touching any webpage. Failure means no action.
          await chrome.storage.session.set({[consumed]:true});
          await chrome.storage.session.remove(key);
          const result=await browserExecuteMutation(stored.command,async()=>{
            const latest=await state();
            return stored.permissionToken===await sensitiveToken() && latest.authorization==="enabled" && socket===ws &&
              currentGeneration===message.generation && latest.endpoint_id===stored.endpoint_id;
          },stored.approval_required&&message.owner_approved===true);
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
              ...(result.presentation_warning?{presentation_warning:result.presentation_warning}:{})}));
        } catch {/* failure after consumption is Unknown, never retry */}
        finally {executingOperations.delete(op);}
      } else if(message.type==="read_request") {
        if(!/^[a-f0-9-]{36}$/.test(message.request_id||"") || !["tabs","snapshot","screenshot"].includes(message.tool) ||
           message.generation!==currentGeneration)return;
        const permissionToken=await sensitiveToken();
        let response;
        try { response=await executeBrowserRead(message.tool,message.tab_id,message.scope,async()=>
          socket===ws&&currentGeneration===message.generation&&(await state()).authorization==="enabled"&&permissionToken===await sensitiveToken()); }
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
        ws.send(serialized);
      } else if(message.type==="stopped"||message.type==="revoked"){
        localBlocked=true;localDenialEpoch++;
        void clearSensitivePermissions().catch(()=>{});
        await chrome.storage.local.set({authorization:message.type,connection:"offline",last_update:Date.now()});
        if(message.type==="revoked")await chrome.storage.local.remove(["credential","endpoint_id"]);
        clearNetwork();await render();
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
            if(remote.authorization==="revoked")await chrome.storage.local.remove(["credential","endpoint_id"]);
            return;
          }
        } catch { /* offline; reconnect only while local authorization permits */ }
        if((await state()).authorization==="enabled")reconnect=setTimeout(connect,3000+Math.floor(Math.random()*3000));
      }
    };
    ws.onerror=()=>{/* close handler owns recovery */};
  })();
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  // Do not allow content scripts or arbitrary extension pages to invoke local Resume.
  if(sender?.tab || sender?.id!==chrome.runtime.id || sender?.url!==chrome.runtime.getURL("popup.html")){
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
    if(message.type==="pair")return pair(message);
    if(message.type==="stop")return stopLocal();
    if(message.type==="resume")return resumeLocal();
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
chrome.runtime.onStartup.addListener(()=>{void syncPendingStop();connect();});
chrome.runtime.onInstalled.addListener(({reason})=>{
  // Clear transient sensitive grants before reconnecting after an update.
  // Persistent owner Stop remains authoritative; session clearance failure is fail-closed.
  void (async()=>{
    try {
      if(reason==="update")await chrome.storage.session.clear();
      await syncPendingStop();
      connect();
    } catch { clearNetwork(); }
  })();
});
void syncPendingStop().then(()=>connect());
