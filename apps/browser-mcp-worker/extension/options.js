const $=id=>document.getElementById(id);
async function call(type,extra={}) {
  return new Promise((resolve,reject)=>chrome.runtime.sendMessage({type,...extra},response=>
    chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):
      !response?.ok?reject(Error(response?.error||"unavailable")):resolve(response.result)));
}
async function refresh() {
  try {
    const s=await call("status");
    $("summary").textContent="Profile: "+(s.alias||"Not paired")+"\nAuthorization: "+s.authorization+
      " · Connection: "+s.connection+
      (s.pending_cloud_stop?"\nCloud Stop: NOT CONFIRMED":"");
    $("lifetime").value=s.pairing_mode||s.pairing_preference||"permanent";
    $("lifetime").disabled=Boolean(s.endpoint_id);
    $("status").textContent=[
      "Direct localhost/LAN: "+(s.sensitive_permissions?.lan?"ON":"OFF"),
      "Private/incognito: "+(s.sensitive_permissions?.private&&s.sensitive_permissions?.native_private?"ON":"OFF")+"; native permission: "+(s.sensitive_permissions?.native_private?"allowed":"DENIED / unavailable — enable Allow in Incognito/InPrivate in browser extension settings"),
      "Profile: "+(s.alias||"Not paired"),
      "Authorization: "+s.authorization,
      "Connection: "+s.connection,
      "Last update: "+(s.last_update?new Date(s.last_update).toLocaleString():"Never"),
      "Cloud Stop: "+(s.pending_cloud_stop?"NOT CONFIRMED — sync required":"No pending stop"),
      "Endpoint: "+(s.endpoint_id||"—"),
      "Pairing: "+(s.pairing_mode||"not paired")+(s.lease_expires_at?"; expires "+new Date(s.lease_expires_at).toLocaleString():""),
      "Last observed target: "+(Number.isSafeInteger(s.last_observed_tab_id)?`[${s.last_observed_scope||"ordinary"}] Tab ${s.last_observed_tab_id} (${s.last_observed_tab_source==="agent_created"?"Agent-created":"Existing / source unknown"})`:"None / not bound"),
      "Operations Pending: "+(s.activity?.available?s.activity.pending:"UNCONFIRMED — cloud status unavailable"),
      "Operations Unknown: "+(s.activity?.available?s.activity.unknown:"UNCONFIRMED — do not assume zero"),
      "Unknown: query browser_operation_status with the ORIGINAL intent_key; never create a new key to retry.",
      "Tab retention: explicit close only; Stop/disconnect/turn end never auto-close tabs.",
      "Unconfirmed cloud revocation ID: "+(s.pending_revocation_id||"None"),
      "High-impact and unidentified controls are blocked, not remotely approved. Authentication and sensitive surfaces stay denied; Unknown receipts may be reviewed independently."
    ].join("\n");
    for(const surface of ["lan","private"])$(surface).textContent=(s.sensitive_permissions?.[surface]?"Disable ":"Enable ")+(surface==="lan"?"direct localhost/LAN":"private/incognito");
    $("locate").disabled=!Number.isSafeInteger(s.last_observed_tab_id);
  } catch(e){
    $("summary").textContent="Local status unavailable";
    $("status").textContent="Unable to read local status: "+e.message;
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
