const $=id=>document.getElementById(id);
async function call(type,extra={}) {
  return new Promise((resolve,reject)=>chrome.runtime.sendMessage({type,...extra},response=>
    chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):
      !response?.ok?reject(Error(response?.error||"unavailable")):resolve(response.result)));
}
async function refresh() {
  try {
    const s=await call("status");
    $("status").textContent=[
      "Direct localhost/LAN: "+(s.sensitive_permissions?.lan?"ON":"OFF"),
      "Private/incognito: "+(s.sensitive_permissions?.private&&s.sensitive_permissions?.native_private?"ON":"OFF")+"; native permission: "+(s.sensitive_permissions?.native_private?"allowed":"DENIED / unavailable — enable Allow in Incognito/InPrivate in browser extension settings"),
      "Profile: "+(s.alias||"Not paired"),
      "Authorization: "+s.authorization,
      "Connection: "+s.connection,
      "Last update: "+(s.last_update?new Date(s.last_update).toLocaleString():"Never"),
      "Cloud Stop: "+(s.pending_cloud_stop?"NOT CONFIRMED — sync required":"No pending stop"),
      "Endpoint: "+(s.endpoint_id||"—"),
      "Last observed target: "+(Number.isSafeInteger(s.last_observed_tab_id)?`[${s.last_observed_scope||"ordinary"}] Tab ${s.last_observed_tab_id} (${s.last_observed_tab_source==="agent_created"?"Agent-created":"Existing / source unknown"})`:"None / not bound"),
      "Operations Pending: "+(s.activity?.available?s.activity.pending:"UNCONFIRMED — cloud status unavailable"),
      "Owner approvals waiting: "+(s.activity?.available?(s.activity.approvals||[]).length:"UNCONFIRMED"),
      ...(s.activity?.approvals||[]).map(a=>`Operation ${a.operation_id}: ${a.state}; expires ${new Date(a.expires_at).toLocaleString()}`),
      "Waiting approvals do not occupy the execution lock. Open the canonical link from the original receipt in your independent owner Profile; links are not approval credentials.",
      "Operations Unknown: "+(s.activity?.available?s.activity.unknown:"UNCONFIRMED — do not assume zero"),
      "Unknown: query browser_operation_status with the ORIGINAL intent_key; never create a new key to retry.",
      "Tab retention: explicit close only; Stop/disconnect/turn end never auto-close tabs.",
      "Unconfirmed cloud revocation ID: "+(s.pending_revocation_id||"None"),
      "Scope: this Chrome/Edge profile; source supports permitted ordinary/private observations and explicit tab open/navigate/close. High-impact execution requires separately configured isolated owner approval; missing isolation is Blocked. Sensitive and ambiguous surfaces remain denied. No production release is authorized."
    ].join("\n");
    for(const surface of ["lan","private"])$(surface).textContent=(s.sensitive_permissions?.[surface]?"Disable ":"Enable ")+(surface==="lan"?"direct localhost/LAN":"private/incognito");
    $("service").value=typeof BROWSER_MCP_SERVICE_ORIGIN==="string"
      ? BROWSER_MCP_SERVICE_ORIGIN : "Not configured — release required";
    $("locate").disabled=!Number.isSafeInteger(s.last_observed_tab_id);
    if(s.alias)$("alias").value=s.alias;
  } catch(e){$("status").textContent="Unable to read local status: "+e.message;}
}
async function action(label,fn){
  $("status").textContent=label+"…";
  try {const r=await fn();if(r?.cloud_confirmed===false)alert("Local action completed; cloud revocation/stop is NOT confirmed. Use authenticated MCP to revoke if necessary.");}
  catch(e){alert(e.message);}
  await refresh();
}
$("pair").onclick=()=>action("Pairing",async()=>{
  const service=BROWSER_MCP_SERVICE_ORIGIN,code=$("code").value.trim().toLowerCase(),alias=$("alias").value.trim();
  const url=new URL(service);
  if(!confirm(`Pair this exact browser profile with ${url.origin}?\n\nThe code is single-use. Control will remain STOPPED until locally enabled. Verify the service and ownership before confirming.`))return;
  return call("pair",{service,code,alias});
});
$("locate").onclick=()=>action("Locating observed tab",()=>call("locate"));
$("stop").onclick=()=>action("Stopping locally",()=>call("stop"));
$("resume").onclick=()=>action("Enabling locally",()=>call("resume"));
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
  if(enabled&&!confirm(surface==="lan"?"Allow direct localhost/LAN HTTP(S) control for this browser session? This is not full DNS rebinding or page network isolation. Consequential actions still require independent owner approval.":"Allow private/incognito observation and control for this browser session? Chrome/Edge native permission is also required. Consequential actions still require independent owner approval."))return;
  return call("sensitive-permission",{surface,enabled});
});
