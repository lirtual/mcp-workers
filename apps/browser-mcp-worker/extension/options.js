const $=id=>document.getElementById(id);
let aliasRevision=0,aliasDirty=false;
$("alias").oninput=()=>{aliasRevision++;aliasDirty=true;};
async function call(type,extra={}) {
  return new Promise((resolve,reject)=>chrome.runtime.sendMessage({type,...extra},response=>
    chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):
      !response?.ok?reject(Error(response?.error||"unavailable")):resolve(response.result)));
}
async function refresh() {
  const startedAliasRevision=aliasRevision;
  try {
    const s=await call("status");
    const remote=s.cloud_state;
    const name=remote?.alias||(s.alias==="Browser profile"&&s.endpoint_id?s.endpoint_id.slice(0,8):s.alias)||"Not paired";
    const local=s.authorization||"unpaired",connection=s.connection||"offline";
    const ready=local==="enabled"&&connection==="online"&&remote?.authorization==="enabled"&&remote?.online===true;
    $("summary").textContent=ready?"ON · Ready":local==="enabled"?"ON · "+connection:
      local==="stopped"?"OFF · Paired":local==="revoked"?"Revoked":"Not paired";
    $("identity").textContent=[
      name,
      remote?.browser_family&&remote.browser_family!=="unknown"?remote.browser_family:"Browser",
      remote?.browser_platform&&remote.browser_platform!=="other"?remote.browser_platform:null,
      s.endpoint_id&&name!==s.endpoint_id.slice(0,8)?"#"+s.endpoint_id.slice(0,8):null
    ].filter(Boolean).join(" · ");
    if(!aliasDirty&&startedAliasRevision===aliasRevision&&document.activeElement!==$("alias"))
      $("alias").value=(s.alias||s.endpoint_id)?name:"";
    $("save-alias").disabled=local==="revoked";
    $("prepair").hidden=Boolean(s.endpoint_id);
    $("lifetime").value=s.pairing_mode||s.pairing_preference||"permanent";
    $("lifetime").disabled=Boolean(s.endpoint_id);
    $("revoke").disabled=!s.endpoint_id||local==="revoked";
    const expiration=remote?.idle_expires_at??null;
    const isTemporary=(s.pairing_mode||s.pairing_preference)==="temporary";
    $("expiry").textContent=isTemporary?
      (remote?.lease_expires_at?"Temporary grant until "+new Date(remote.lease_expires_at).toLocaleString():"Temporary · browser session"):
      (ready?"Remembered · no idle countdown while online":
       expiration?"Remembered idle expires "+new Date(expiration).toLocaleString():
       s.endpoint_id?"Idle deadline not available (cloud status unconfirmed)":"Remembered · idle default 14 days");
    const warnings=[];
    if(s.pending_cloud_stop)warnings.push("Cloud Stop NOT CONFIRMED");
    if(s.pending_revocation_id)warnings.push("Cloud revocation not confirmed");
    if(s.endpoint_id&&!remote)warnings.push("Remote status unavailable");
    if(remote?.authorization==="revoked" && local!=="revoked")warnings.push("Server grant revoked; local Profile must be re-paired");
    if(s.activity?.available&&s.activity.unknown>0)warnings.push(s.activity.unknown+" unknown operation(s) — review original receipts");
    if(s.activity?.available===false&&s.endpoint_id)warnings.push("Operation counts unconfirmed");
    $("warning").hidden=warnings.length===0;
    $("warning").textContent=warnings.join(" · ");
    const sensitive=s.sensitive_permissions||{};
    for(const surface of ["lan","private"])$(""+surface).textContent=
      (sensitive[surface]?"Disable ":"Enable ")+(surface==="lan"?"direct localhost/LAN":"private/incognito");
    $("locate").disabled=!Number.isSafeInteger(s.last_observed_tab_id);
    $("stop").hidden=!s.endpoint_id||(!s.pending_cloud_stop&&local!=="enabled");
    $("ack").hidden=!s.pending_revocation_id;
    $("visual-feedback").checked=(await chrome.storage.local.get("browser_visual_feedback")).browser_visual_feedback!==false;
    $("status").textContent=[
      "Local control: "+local+" / "+connection,
      "Server authorization: "+(remote?.authorization??"unconfirmed"),
      "Last authenticated online: "+(remote?.last_seen_at?new Date(remote.last_seen_at).toLocaleString():"Unknown"),
      "Server idle deadline: "+(remote?.idle_expires_at?new Date(remote.idle_expires_at).toLocaleString():"None confirmed"),
      "Server extension: "+(remote?.client_version??"Unknown"),
      "Endpoint: "+(s.endpoint_id||"None"),
      "Local update: "+(s.last_update?new Date(s.last_update).toLocaleString():"Never"),
      "Direct LAN: "+(sensitive.lan?"ON":"OFF"),
      "Private: "+(sensitive.private&&sensitive.native_private?"ON":"OFF")+"; native: "+(sensitive.native_private?"allowed":"denied / unavailable"),
      "Last observed target: "+(Number.isSafeInteger(s.last_observed_tab_id)?"Tab "+s.last_observed_tab_id:"None"),
      "Pending operations: "+(s.activity?.available?s.activity.pending:"Unconfirmed"),
      "Unknown operations: "+(s.activity?.available?s.activity.unknown:"Unconfirmed"),
      "Cloud Stop pending: "+(s.pending_cloud_stop?"YES":"No"),
      "Unconfirmed revoke: "+(s.pending_revocation_id||"None"),
      "Use original intent_key to inspect Unknown, never replay.",
      "Tabs are retained until explicit close; Stop/disconnect never closes them."
    ].join("\n");
  } catch(e){
    $("summary").textContent="Local status unavailable";
    $("status").textContent="Unable to read state: "+(e?.message||"unavailable");
  }
}
let actionSequence=0;
async function action(label,fn){
  // Stop must remain available even while Enable or another local action is pending.
  const sequence=++actionSequence;
  const feedback=$("action-feedback");
  feedback.textContent=label+"…";
  try {
    const r=await fn();
    if(sequence===actionSequence){
      feedback.textContent=r===undefined?"Cancelled":
        r?.cloud_confirmed===false?"Local change made; cloud confirmation is pending":
        r?.authorization==="stopped"?"Stopped locally; cloud Stop confirmed":
        r?.authorization==="enabled"?"Enabled locally":
        label+": completed";
    }
  } catch(e){
    if(sequence===actionSequence)feedback.textContent=label+" failed: "+(e?.message||"unavailable");
  }
  await refresh();
}
$("lifetime").onchange=()=>action("Pairing lifetime",()=>call("pairing-preference",{mode:$("lifetime").value}));
$("save-alias").onclick=()=>{
  const requested=$("alias").value.trim();
  return action("Saving Profile name",async()=>{
    const result=await call("rename",{alias:requested});
    const checked=await call("status");
    if(checked.alias!==requested||(checked.endpoint_id&&checked.cloud_state?.alias!==requested))
      throw Error("rename_unconfirmed");
    aliasRevision++;aliasDirty=false;
    return result;
  });
};
$("locate").onclick=()=>action("Locating observed tab",()=>call("locate"));
$("stop").onclick=()=>action("Stopping locally",()=>call("stop"));
$("revoke").onclick=()=>action("Revoking locally",async()=>{
  if(!confirm("Revoke this Profile identity and remove its local credential? If offline, separately revoke the old endpoint through authenticated MCP."))return;
  return call("revoke");
});
$("ack").onclick=()=>action("Acknowledging confirmed revocation",async()=>{
  const s=await call("status");
  if(!s.pending_revocation_id)throw Error("No pending cloud revocation");
  if(!confirm("Only proceed after browser_revoke returned revoked for Endpoint "+s.pending_revocation_id+". This is an owner acknowledgment, NOT an automatic verification. Continue?"))return;
  return call("ack-revocation");
});
void refresh();

for(const surface of ["lan","private"])$(surface).onclick=()=>action("Changing local permission",async()=>{
  const s=await call("status"),enabled=!s.sensitive_permissions?.[surface];
  if(enabled&&!confirm(surface==="lan"?"Allow direct localhost/LAN HTTP(S) control for this browser session? This is not full DNS rebinding or page network isolation. Consequential actions remain blocked, with no remote approval.":"Allow private/incognito observation and control for this browser session? Chrome/Edge native permission is also required. Consequential actions remain blocked, with no remote approval."))return;
  return call("sensitive-permission",{surface,enabled});
});

$("visual-feedback").onchange=async()=>{
  try {await chrome.storage.local.set({browser_visual_feedback:$("visual-feedback").checked});}
  catch {await refresh();}
};
