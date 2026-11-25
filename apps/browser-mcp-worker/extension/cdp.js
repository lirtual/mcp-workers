// Spec #917: transient CDP control in this owner Profile. No local Agent or debug port.
// Debuggee sessions are internal; the public surface uses only Endpoint and tab_id.
const browserCdpTabs=new Map();
let browserCdpEpoch=0;
let browserCdpCleanup=Promise.resolve(),browserCdpWrites=Promise.resolve(),browserCdpWriteEpoch=0;
const CDP_MAX_EVENTS=64,CDP_EVENT_BYTES=32768,CDP_RESULT_BYTES=131072,CDP_TTL=120000,CDP_EXEC_MS=6000;
function browserCdpAvailable(){
  return Boolean(chrome.debugger?.attach&&chrome.debugger?.sendCommand&&chrome.debugger?.detach);
}
async function browserCdpEnabled(){
  await trustedStorage;
  return (await chrome.storage.local.get("browser_advanced_cdp_enabled")).browser_advanced_cdp_enabled===true;
}
function browserCdpSetEnabled(enabled){
  // Fence in-flight permission grants synchronously, then serialize disk writes.
  const epoch=++browserCdpWriteEpoch;
  if(!enabled)browserCdpEpoch++;
  const task=browserCdpWrites.catch(()=>{}).then(async()=>{
    if(!enabled){await browserCdpClear();await chrome.storage.local.set({browser_advanced_cdp_enabled:false});return;}
    if(!browserCdpAvailable())throw Error("unsupported_cdp");
    if(epoch!==browserCdpWriteEpoch||(await state()).authorization!=="enabled")throw Error("local_authorization_changed");
    await chrome.storage.local.set({browser_advanced_cdp_enabled:true});
    if(epoch!==browserCdpWriteEpoch||(await state()).authorization!=="enabled"){
      await chrome.storage.local.set({browser_advanced_cdp_enabled:false});
      throw Error("local_authorization_changed");
    }
  });
  browserCdpWrites=task;
  return task.then(()=>({enabled}));
}
async function browserCdpTarget(tab_id){
  try {
    const tab=await chrome.tabs.get(tab_id);
    return await browserAccessTab(tab);
  } catch {return false;}
}
async function browserCdpClear(){
  browserCdpEpoch++;
  const entries=[...browserCdpTabs.entries()];
  browserCdpTabs.clear();
  for(const [,entry] of entries)clearTimeout(entry.expiry_timer);
  browserCdpCleanup=browserCdpCleanup.catch(()=>{}).then(()=>Promise.allSettled(entries.map(async([tab_id])=>{
    try{await chrome.debugger.detach({tabId:tab_id});}catch{/* closed or DevTools-owned */}
  })));
  await browserCdpCleanup;
}
async function browserCdpForgetTab(tab_id){
  const entry=browserCdpTabs.get(tab_id);
  if(!entry)return;
  browserCdpTabs.delete(tab_id);
  clearTimeout(entry.expiry_timer);
  try{await chrome.debugger.detach({tabId:tab_id});}catch{/* already gone */}
}
function browserCdpRefreshExpiry(tab_id,entry){
  clearTimeout(entry.expiry_timer);
  entry.expires_at=Date.now()+CDP_TTL;
  entry.expiry_timer=setTimeout(()=>{
    if(browserCdpTabs.get(tab_id)===entry)void browserCdpForgetTab(tab_id).catch(()=>{});
  },CDP_TTL);
  entry.expiry_timer.unref?.(); // Node test runner only; Chrome uses numeric timers.
}
async function browserCdpAttach(tab_id,authorized){
  if(!browserCdpAvailable())return {error_code:"unsupported_cdp"};
  if(!await browserCdpEnabled())return {error_code:"cdp_disabled"};
  if(!await browserCdpTarget(tab_id)||!await authorized())return {error_code:"forbidden"};
  await browserCdpCleanup;
  if(!await authorized()||!await browserCdpTarget(tab_id)||!await browserCdpEnabled())return {error_code:"stopped"};
  const prior=browserCdpTabs.get(tab_id);
  if(prior&&prior.epoch===browserCdpEpoch&&prior.expires_at>=Date.now())return {entry:prior};
  if(prior)await browserCdpForgetTab(tab_id);
  if(browserCdpTabs.size>=8)return {error_code:"capacity_exceeded"};
  const epoch=browserCdpEpoch;
  try{await chrome.debugger.attach({tabId:tab_id},"1.3");}
  catch{return {error_code:"debugger_unavailable"};}
  if(epoch!==browserCdpEpoch||!await authorized()||!await browserCdpTarget(tab_id)||
     !await browserCdpEnabled()){
    try{await chrome.debugger.detach({tabId:tab_id});}catch{}
    return {error_code:"stopped"};
  }
  const entry={epoch,events:null,sequence:0,dropped:0,expires_at:0,expiry_timer:null,processing:false};
  browserCdpTabs.set(tab_id,entry);
  browserCdpRefreshExpiry(tab_id,entry);
  return {entry};
}
chrome.debugger?.onDetach?.addListener(source=>{
  if(!Number.isSafeInteger(source.tabId))return;
  const entry=browserCdpTabs.get(source.tabId);
  if(entry)clearTimeout(entry.expiry_timer);
  browserCdpTabs.delete(source.tabId);
});
chrome.debugger?.onEvent?.addListener(async(source,method,params)=>{
  const entry=browserCdpTabs.get(source.tabId);
  if(!entry||!entry.events||entry.epoch!==browserCdpEpoch||!entry.filter.has(method))return;
  // A burst must not create unbounded asynchronous tab-policy lookups. Drop
  // concurrent events and retain Chrome delivery order among accepted ones.
  if(entry.processing){entry.dropped++;return;}
  entry.processing=true;
  try {
    if(!await browserCdpTarget(source.tabId)){
      await browserCdpForgetTab(source.tabId);
      return;
    }
    if(browserCdpTabs.get(source.tabId)!==entry||entry.epoch!==browserCdpEpoch)return;
    if(entry.expires_at<Date.now()){await browserCdpForgetTab(source.tabId);return;}
    const next={cursor:++entry.sequence,method,...(source.sessionId?{session_id:source.sessionId}:{}),params};
    let size;
    try{size=new TextEncoder().encode(JSON.stringify(next)).byteLength;}
    catch{entry.dropped++;return;}
    if(size>CDP_EVENT_BYTES){entry.dropped++;return;}
    if(entry.events.length>=CDP_MAX_EVENTS){entry.events.shift();entry.dropped++;}
    entry.events.push(next);
  } finally{entry.processing=false;}
});
async function browserCdpPrepare(command){
  if(!browserCdpAvailable())return {error_code:"unsupported_cdp"};
  if(!await browserCdpEnabled())return {error_code:"cdp_disabled"};
  if(!await browserCdpTarget(command.tab_id))return {error_code:"forbidden"};
  return {ready:true};
}
async function browserCdpExecute(command,authorized,onProgress=()=>{}){
  const deadline=Date.now()+CDP_EXEC_MS;
  const ready=await browserCdpPrepare(command);
  if(!ready.ready)return {state:"failed",error_code:ready.error_code};
  const attached=await browserCdpAttach(command.tab_id,authorized);
  if(!attached.entry)return {state:"failed",error_code:attached.error_code};
  const epoch=attached.entry.epoch;
  const results=[];
  for(let index=0;index<command.commands.length;index++){
    // Commands may have effects before Chrome reports an error; never return a
    // retryable failed receipt after dispatch has started.
    if(Date.now()>=deadline)
      return {state:"unknown",data:{error_code:"cdp_timeout",executed_count:index,results}};
    if(epoch!==browserCdpEpoch||!await authorized()||!await browserCdpTarget(command.tab_id))
      return {state:"unknown",data:{error_code:"authorization_changed",executed_count:index,results}};
    const step=command.commands[index];
    if(["Page.navigate","Target.createTarget"].includes(step.method)&&
       (typeof step.params?.url!=="string"||!await browserAccessUrl(step.params.url)))
      return index===0?{state:"failed",error_code:"forbidden"}:
        {state:"unknown",data:{error_code:"forbidden",executed_count:index,results}};
    try {
      const target={tabId:command.tab_id,...(command.session_id?{sessionId:command.session_id}:{})};
      let timeout;
      const result=await Promise.race([
        chrome.debugger.sendCommand(target,step.method,step.params||{}),
        new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error("cdp_timeout")),
          Math.max(1,deadline-Date.now()));})
      ]).finally(()=>clearTimeout(timeout));
      results.push({index,method:step.method,result});
      try{onProgress(index+1);}catch{/* never turn a confirmed command into replayable failure */}
      if(Date.now()>=deadline)
        return {state:"unknown",data:{error_code:"cdp_timeout",executed_count:index+1,results}};
      if(new TextEncoder().encode(JSON.stringify(results)).byteLength>CDP_RESULT_BYTES)
        return {state:"unknown",data:{error_code:"result_too_large",executed_count:index+1}};
    } catch (error) {
      return {state:"unknown",data:{error_code:error?.message==="cdp_timeout"?"cdp_timeout":"cdp_command_error",
        failed_at:index,executed_count:index,attempted_count:index+1,results}};
    }
    if(step.delay_ms&&index+1<command.commands.length)
      await new Promise(resolve=>setTimeout(resolve,step.delay_ms));
  }
  return {state:"completed",tab_id:command.tab_id,data:{commands:results,executed_count:results.length}};
}
async function browserCdpEvents(command,authorized){
  const {tab_id,action}=command;
  if(!browserCdpAvailable())return {error_code:"unsupported_cdp"};
  if(!await browserCdpEnabled())return {error_code:"cdp_disabled"};
  if(!await browserCdpTarget(tab_id)||!await authorized())return {error_code:"forbidden"};
  if(action==="unsubscribe"){
    await browserCdpForgetTab(tab_id);
    return {unsubscribed:true};
  }
  if(action==="read"&&!browserCdpTabs.has(tab_id))return {error_code:"not_subscribed"};
  const attached=action==="read"?{entry:browserCdpTabs.get(tab_id)}:
    await browserCdpAttach(tab_id,authorized);
  if(!attached.entry)return {error_code:attached.error_code};
  const entry=attached.entry;
  if(action==="subscribe"){
    entry.events=[];entry.filter=new Set(command.events);
    entry.sequence=0;entry.dropped=0;browserCdpRefreshExpiry(tab_id,entry);
    return {subscribed:true,cursor:0,expires_in_ms:CDP_TTL,capacity:CDP_MAX_EVENTS};
  }
  if(!entry.events)return {error_code:"not_subscribed"};
  if(entry.expires_at<Date.now()){await browserCdpForgetTab(tab_id);return {error_code:"subscription_expired"};}
  const cursor=command.cursor??0,limit=command.limit??32;
  // Bound the complete WSS response, not just each individual event. The
  // cursor advances only through returned events so the caller can page.
  const events=[];
  let bytes=0;
  for(const event of entry.events){
    if(event.cursor<=cursor)continue;
    const size=new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if(events.length>=limit||bytes+size>CDP_RESULT_BYTES)break;
    events.push(event);bytes+=size;
  }
  const oldest=entry.events[0]?.cursor??entry.sequence+1;
  return {events,cursor:events.at(-1)?.cursor??cursor,latest_cursor:entry.sequence,
    oldest_cursor:oldest,dropped:entry.dropped,overflow:cursor<oldest-1,expires_in_ms:Math.max(0,entry.expires_at-Date.now())};
}
