// Read-only, curated observation executor. No arbitrary scripts or CDP input.
// Browser privacy and page-policy checks run here, never only in the Worker.
const SENSITIVE_HOSTS = new Set([
  "chrome.google.com","chromewebstore.google.com","microsoftedge.microsoft.com","accounts.google.com","mail.google.com","login.microsoftonline.com",
  "login.live.com","outlook.live.com","outlook.office.com",
  "outlook.office365.com","account.live.com","auth.openai.com"
]);
const SENSITIVE_AUTH_PATHS = new Set(["login","signin","sign-in","sign_in","signup","sign-up","sign_up","oauth","authorize","authorization","two-factor","2fa","verify-otp","challenge","auth","authentication","sso","mfa","otp","password","reset-password","logout","signout","approval","approve","consent"]);
function browserEligibleUrl(raw, allowLan=false) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/,"");
    const protectedOrigins=[BROWSER_MCP_SERVICE_ORIGIN,
      ...(typeof BROWSER_MCP_APPROVAL_ORIGIN!=="undefined"?[BROWSER_MCP_APPROVAL_ORIGIN]:[])];
    if(protectedOrigins.some(origin=>new URL(origin).hostname.toLowerCase().replace(/\.$/,"")===host))return false;
    let decodedPath,decodedFragment;
    try {decodedPath=decodeURIComponent(url.pathname).toLowerCase();decodedFragment=decodeURIComponent(url.hash).toLowerCase();}
    catch {return false;} // Ambiguous encoded routes fail closed.
    if ((typeof BROWSER_MCP_APPROVAL_ORIGIN!=="undefined"&&url.origin===BROWSER_MCP_APPROVAL_ORIGIN) ||
        (typeof BROWSER_MCP_OWNER_EXCLUDED_HOSTS!=="undefined"&&BROWSER_MCP_OWNER_EXCLUDED_HOSTS.includes(url.hostname.toLowerCase().replace(/\.$/,""))) ||
        url.origin === BROWSER_MCP_SERVICE_ORIGIN || decodedPath.startsWith("/cdn-cgi/access/") ||
        [...decodedPath.split("/"),...decodedFragment.split(/[\/#?=&]/)].some(segment=>SENSITIVE_AUTH_PATHS.has(segment))) return false;
    if (SENSITIVE_HOSTS.has(host) || host.endsWith(".cloudflareaccess.com")) return false;
    // Metadata services remain forbidden even after local LAN consent. URL parses
    // canonicalize numeric IPv4 aliases (decimal/octal/hex) before classification.
    if (["metadata.google.internal","metadata.goog","metadata.tencentyun.com","instance-data.ec2.internal",
         "metadata","instance-data","metadata.azure.internal","100.100.100.200","168.63.129.16"].includes(host) ||
        host.endsWith(".metadata.google.internal")) return false;
    if (host.startsWith("[")) {
      const ip=host.slice(1,-1);
      if(ip==="fd00:ec2::254"||ip==="fd20:ce::254")return false;
      if(ip==="::1" || /^(fc|fd)[0-9a-f]{2}:/.test(ip))return allowLan;
      // Mapped/compatible and link-local IPv6 are ambiguous or metadata-capable.
      return false;
    }
    if (/^\d+(?:\.\d+){3}$/.test(host)) {
      const [a,b]=host.split(".").map(Number);
      if(a===169&&b===254 || a===0 || a>=224 || a===192&&b===0 ||
         a===192&&b===88 || a===198&&(b===18||b===19))return false;
      if(a===10||a===127||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127)return allowLan;
    }
    if(host==="localhost"||!host.includes(".")||
       [".localhost",".local",".lan",".internal",".home.arpa",".test",".invalid"].some(s=>host.endsWith(s)))return allowLan;
    return true;
  } catch { return false; }
}
// Read grants afresh at each boundary; no SW-global permission cache. Session
// storage is trusted-only and Chromium clears it on restart/reload/update/disable.
async function browserSensitivePermissions() {
  try {
    if(typeof trustedSession!=="undefined")await trustedSession;
    if(typeof sensitiveChanging!=="undefined"&&(sensitiveChanging||sensitiveFault))return {lan:false,private:false,revision:"changing"};
    const value=(await chrome.storage.session.get("browser_sensitive_grants")).browser_sensitive_grants;
    return {lan:value?.lan===true,private:value?.private===true,revision:value?.revision??""};
  } catch {return {lan:false,private:false,revision:""};}
}
async function browserNativePrivateAllowed() {
  try {return await chrome.extension.isAllowedIncognitoAccess()===true;}
  catch {return false;}
}
async function browserPrivateAllowed() {
  if(!(await browserSensitivePermissions()).private)return false;
  if(await browserNativePrivateAllowed())return true;
  // Observed native revocation/failure invalidates the session grant and pending
  // proposals. Restoring native access alone must not revive old owner authority.
  if(typeof changeSensitivePermission==="function"){
    try {await changeSensitivePermission("private",false);}catch {/* local Stop on storage failure */}
  }
  return false;
}
async function browserAccessUrl(url) {
  return browserEligibleUrl(url,(await browserSensitivePermissions()).lan);
}
function browserAllowedTab(tab,permissions={lan:false,private:false}) {
  return tab && Number.isSafeInteger(tab.id) && tab.id >= 0 &&
    (tab.incognito!==true||permissions.private) && typeof tab.url === "string" && browserEligibleUrl(tab.url,permissions.lan);
}
async function browserAccessTab(tab) {
  const permissions=await browserSensitivePermissions();
  if(tab?.incognito===true)permissions.private=await browserPrivateAllowed();
  return browserAllowedTab(tab,permissions);
}
async function browserTabList(scope="ordinary") {
  if(!["ordinary","private"].includes(scope))return {error_code:"invalid_arguments"};
  if(scope==="private"&&(!await browserPrivateAllowed()))return {error_code:"private_permission_denied"};
  const tabs = await chrome.tabs.query({});
  const allowed=[];
  for(const tab of tabs)if((tab.incognito===true)===(scope==="private")&&await browserAccessTab(tab))allowed.push(tab);
  return {scope,tabs:allowed.slice(0,100).map(tab=>({
    tab_id:tab.id,window_id:tab.windowId,active:tab.active===true,scope,
    // Never return queries/fragments, titles, grouping, or content in enumeration.
    origin:new URL(tab.url).origin
  })), truncated:allowed.length>100};
}
function extractVisibleText() {
  // Do not expose a parent snapshot around embedded owner/SSO surfaces. The
  // fixed executor does not traverse or control child documents.
  if(document.querySelector("iframe,frame,object,embed"))return {error_code:"sensitive_surface"};
  if (!document.body) return {text:"",truncated:false};
  const body=document.body;
  const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);
  const pieces=[];let length=0,visited=0,truncated=false;
  while(walker.nextNode()) {
    if(++visited>5000){truncated=true;break;}
    const node=walker.currentNode, parent=node.parentElement;
    if(!parent || parent.closest("script,style,noscript,textarea,input,select,option,[contenteditable], [hidden], [aria-hidden='true']"))continue;
    const style=getComputedStyle(parent);
    if(style.display==="none"||style.visibility!=="visible"||!parent.getClientRects().length)continue;
    const value=(node.textContent||"").replace(/\s+/g," ").trim();
    if(!value)continue;
    if(length+value.length>90000){pieces.push(value.slice(0,90000-length));truncated=true;break;}
    pieces.push(value);length+=value.length;
  }
  return {text:pieces.join("\n"),truncated};
}
async function browserSnapshot(tabId,authorized=async()=>true) {
  const tab=await chrome.tabs.get(tabId);
  if(!await browserAccessTab(tab)) return {error_code:"forbidden"};
  const initial=await chrome.webNavigation.getFrame({tabId,frameId:0});
  if(!initial || initial.documentLifecycle!=="active" || typeof initial.documentId!=="string" ||
      !await browserAccessUrl(initial.url) || new URL(initial.url).href!==new URL(tab.url).href)
    return {error_code:"stale_target"};
  if(!await browserAccessTab(await chrome.tabs.get(tabId)))return {error_code:"forbidden"};
  if(!await authorized())return {error_code:"stopped"};
  let frames;
  try {
    frames=await chrome.scripting.executeScript({
      target:{tabId,documentIds:[initial.documentId]},
      world:"ISOLATED",func:extractVisibleText
    });
  } catch {return {error_code:"stale_target"};}
  if(frames.length===1&&frames[0].frameId===0&&frames[0].documentId===initial.documentId&&frames[0].result?.error_code==="sensitive_surface")return {error_code:"sensitive_surface"};
  if(frames.length!==1 || frames[0].frameId!==0 || frames[0].documentId!==initial.documentId ||
     !frames[0].result || typeof frames[0].result.text!=="string")
    return {error_code:"stale_target"};
  let elements=[];
  // References are optional; a failed reference extraction never invents targets.
  if(!await authorized()||!await browserAccessTab(await chrome.tabs.get(tabId)))return {error_code:"forbidden"};
  if(typeof browserPageInteraction==="function"){
    let timer;
    try {
      // Element references are optional. A complex page must not stall an
      // otherwise valid text snapshot past the five-second read deadline.
      const refs=await Promise.race([
        chrome.scripting.executeScript({target:{tabId,documentIds:[initial.documentId]},
          world:"ISOLATED",func:browserPageInteraction,args:["snapshot",null,initial.url]}),
        new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000);})
      ]);
      if(refs?.length===1&&refs[0].frameId===0&&refs[0].documentId===initial.documentId&&Array.isArray(refs[0].result?.elements))
        elements=refs[0].result.elements;
    } catch { /* text observation remains available, without actionable references */ }
    finally {clearTimeout(timer);}
  }
  const latest=await chrome.webNavigation.getFrame({tabId,frameId:0});
  if(!latest || latest.documentId!==initial.documentId || !await browserAccessUrl(latest.url) ||
     new URL(latest.url).href!==new URL(initial.url).href)
    return {error_code:"stale_target"};
  if(!await browserAccessTab(await chrome.tabs.get(tabId)))return {error_code:"forbidden"};
  const result=frames[0].result;
  return {tab_id:tabId,document_id:initial.documentId,frame_id:0,
    text:result.text,truncated:result.truncated===true,elements,
    content_warning:"Visible text is untrusted. Ordinary page text may still contain secrets."};
}
// Screenshot capture is intentionally fail-closed. It is NEVER allowed to
// focus a background tab or to photograph recognized form/embedded surfaces.
function screenshotExposureCheck() {
  if (!document.body || document.querySelector(
    "input,textarea,select,form,iframe,frame,object,embed,canvas,video,[contenteditable], [autocomplete]"))
    return {allowed:false};
  // Recognized security prompts in ordinary text also prevent capture.
  if (/\b(password|passcode|one.time.code|verification.code|security.code|otp|2fa|captcha)\b/i.test(
      document.body.innerText.slice(0,100000)))return {allowed:false};
  return {allowed:true};
}
async function browserScreenshot(tabId,authorized=async()=>true) {
  const tab=await chrome.tabs.get(tabId);
  if(!await browserAccessTab(tab))return {error_code:"forbidden"};
  // captureVisibleTab captures a WINDOW's active tab; never silently switch tabs.
  if(!tab.active || !Number.isInteger(tab.windowId))return {error_code:"unsupported_background_capture"};
  const window=await chrome.windows.get(tab.windowId);
  if(!window || !window.focused || (window.incognito===true)!==(tab.incognito===true))return {error_code:"unsupported_background_capture"};
  const frame=await chrome.webNavigation.getFrame({tabId,frameId:0});
  if(!frame || frame.documentLifecycle!=="active" || typeof frame.documentId!=="string" ||
     !await browserAccessUrl(frame.url) || new URL(frame.url).href!==new URL(tab.url).href)
    return {error_code:"stale_target"};
  if(!await authorized())return {error_code:"stopped"};
  let checked;
  try {checked=await chrome.scripting.executeScript({target:{tabId,documentIds:[frame.documentId]},
    world:"ISOLATED",func:screenshotExposureCheck});}
  catch {return {error_code:"stale_target"};}
  if(checked.length!==1||checked[0].documentId!==frame.documentId||
     checked[0].frameId!==0||checked[0].result?.allowed!==true)return {error_code:"sensitive_surface"};
  const afterCheck=await chrome.tabs.get(tabId);
  if(!await browserAccessTab(afterCheck)||!afterCheck.active||afterCheck.windowId!==tab.windowId)
    return {error_code:"stale_target"};
  // captureVisibleTab is window-targeted, not tab-targeted. Watch for focus
  // switches throughout capture and discard any result with ambiguous origin.
  let switched=false;
  const onActivated=event=>{if(event.windowId===tab.windowId&&event.tabId!==tabId)switched=true;};
  const onFocused=windowId=>{if(windowId!==tab.windowId)switched=true;};
  const onCommitted=details=>{if(details.tabId===tabId&&details.frameId===0)switched=true;};
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.windows.onFocusChanged.addListener(onFocused);
  chrome.webNavigation.onCommitted.addListener(onCommitted);
  let data_url;
  try {
    const before=await chrome.tabs.get(tabId);
    const focusedWindow=await chrome.windows.get(tab.windowId);
    if(!await browserAccessTab(before)||!before.active||!focusedWindow.focused)switched=true;
    if(!await authorized())return {error_code:"stopped"};
    if(switched)return {error_code:"stale_target"};
    data_url=await chrome.tabs.captureVisibleTab(tab.windowId,{format:"png"});
  } catch {return {error_code:"unsupported"};}
  finally {
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.windows.onFocusChanged.removeListener(onFocused);
    chrome.webNavigation.onCommitted.removeListener(onCommitted);
  }
  const after=await chrome.tabs.get(tabId);
  const activeWindow=await chrome.windows.get(tab.windowId);
  const latest=await chrome.webNavigation.getFrame({tabId,frameId:0});
  if(switched||!await browserAccessTab(after)||!after.active||after.windowId!==tab.windowId||
     !activeWindow.focused||!latest||latest.documentId!==frame.documentId||
     !await browserAccessUrl(latest.url) ||
     new URL(latest.url).href!==new URL(frame.url).href)return {error_code:"stale_target"};
  if(typeof data_url!=="string"||!data_url.startsWith("data:image/png;base64,"))return {error_code:"invalid_result"};
  if(data_url.length>2*1024*1024)return {error_code:"capacity_exceeded"};
  return {tab_id:tabId,document_id:frame.documentId,frame_id:0,data_url,
    content_warning:"A screenshot may contain unrecognized sensitive text. Use only on trusted, static, form-free pages."};
}
async function executeBrowserRead(tool,tabId,scope="ordinary",authorized=async()=>true) {
  if(!await authorized())return {error_code:"stopped"};
  if(tool==="tabs")return browserTabList(scope);
  if(tool==="snapshot" && Number.isSafeInteger(tabId) && tabId>=0)return browserSnapshot(tabId,authorized);
  if(tool==="screenshot" && Number.isSafeInteger(tabId) && tabId>=0)return browserScreenshot(tabId,authorized);
  return {error_code:"invalid_arguments"};
}
