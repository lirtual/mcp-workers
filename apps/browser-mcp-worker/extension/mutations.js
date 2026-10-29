// Fixed browser-side mutation executor. No arbitrary JavaScript or CDP surface.
// A prepare validates the target; only a separate consumed execute permits effects.
function browserMutationTarget(command,allowConsequential=false,allowLan=false) {
  if(browserInteractionCommand(command))return true;
  if(!command || !["tab_open","tab_navigate","tab_close"].includes(command.action)) return false;
  if(command.action!=="tab_close"){
    if(typeof command.url!=="string" || command.url.length>2048 || !browserEligibleUrl(command.url,allowLan))return false;
    const url=new URL(command.url);
    // Consequential destinations require independent approval; inspect path and query
    // keys. A GET can itself have effects; a safe-looking path is insufficient.
    let target;
    try {target=decodeURIComponent(url.hostname+url.pathname+url.search).toLowerCase();}
    catch {return false;} // Ambiguous percent-encoding fails closed.
    if(url.hash||/(^|[^a-z0-9])(logout|signout|signin|login|oauth|authorize|approve|consent|credential|password|otp|token|secret)(?=$|[^a-z0-9])/i.test(target))return false;
    if(!allowConsequential&&/(^|[^a-z0-9])(delete|remove|pay|payment|purchase|checkout|transfer|withdraw|submit|confirm|unsubscribe|revoke|send|publish|post)(?=$|[^a-z0-9])/i.test(target))return false;
  }
  if(command.action!=="tab_open" &&
    (!Number.isSafeInteger(command.tab_id)||command.tab_id<0 ||
     typeof command.document_id!=="string"||command.document_id.length<1||command.document_id.length>200))return false;
  return true;
}
async function browserValidateMutation(command,approval=false) {
  if(browserInteractionCommand(command)){
    try {return await browserRunInteraction(command,approval?"prepare":"validate");}
    catch {return {error_code:"stale_target"};}
  }
  const permissions=await browserSensitivePermissions();
  const consequential=!browserMutationTarget(command,false,permissions.lan)&&browserMutationTarget(command,true,permissions.lan);
  if(!browserMutationTarget(command,true,permissions.lan))return {error_code:"forbidden"};
  if(consequential&&!approval)return {error_code:"approval_required"};
  const result=consequential?{ready:true,approval_required:true,description:command.action==="tab_open"?"Open background tab at this exact destination":"Navigate the observed tab to this exact destination",target_url:command.url}:{ready:true};
  if(command.action==="tab_open")return result;
  try {
    const tab=await chrome.tabs.get(command.tab_id);
    if(!await browserAccessTab(tab))return {error_code:"forbidden"};
    const frame=await chrome.webNavigation.getFrame({tabId:command.tab_id,frameId:0});
    if(!frame||frame.documentLifecycle!=="active"||frame.documentId!==command.document_id||
      !await browserAccessUrl(frame.url)||new URL(frame.url).href!==new URL(tab.url).href)
      return {error_code:"stale_target"};
    return {...result,...(consequential?{source_url:tab.url}:{})};
  } catch {return {error_code:"stale_target"};}
}
async function browserExecuteMutation(command,authorized=async()=>true,ownerApproved=false) {
  const checked=await browserValidateMutation(command,ownerApproved);
  if(!checked.ready)return {state:"failed",error_code:checked.error_code};
  // Revalidate the owner Stop/generation gate after async document checks, immediately
  // before attempting a browser effect. Already-dispatched events remain in-flight.
  if(!await authorized())return {state:"failed",error_code:"stopped"};
  // At this point, Chromium APIs may produce an effect even if a later call rejects.
  // Such exceptions are Unknown; never repeat automatically with another key.
  try {
    if(browserInteractionCommand(command)){
      const result=await browserRunInteraction(command,ownerApproved?"approved_execute":"execute",authorized);
      return result.error_code?{state:"failed",error_code:result.error_code}:
        {...result,...(result.state==="completed"?{tab_id:command.tab_id}:{})};
    }
    if(command.action==="tab_open"){
      const ordinary=await chrome.tabs.query({});
      const windowId=ordinary.find(t=>t.incognito===false&&Number.isSafeInteger(t.windowId))?.windowId;
      if(!Number.isSafeInteger(windowId))return {state:"failed",error_code:"ordinary_window_required"};
      if(!await browserAccessUrl(command.url)||!await authorized())return {state:"failed",error_code:"forbidden"};
      const created=await chrome.tabs.create({url:command.url,active:false,windowId});
      if(!Number.isSafeInteger(created?.id))return {state:"unknown"};
      let presentation_warning;
      try {
        const windowId=Number.isSafeInteger(created.windowId)?created.windowId:null;
        // Reuse only an ordinary exact-title group in the same window. Group IDs
        // are ephemeral, and user-renamed groups must not be renamed back.
        const candidates=windowId===null?[]:await chrome.tabGroups.query({windowId,title:"Browser MCP"});
        const existing=candidates.find(g=>g.title==="Browser MCP" && g.windowId===windowId &&
          g.shared!==true && Number.isSafeInteger(g.id) && g.id>=0);
        if(!await authorized())throw Error("stopped");
        if(existing){
          await chrome.tabs.group({tabIds:[created.id],groupId:existing.id});
        } else {
          const group=await chrome.tabs.group({tabIds:[created.id],
            ...(windowId===null?{}:{createProperties:{windowId}})});
          if(!await authorized())throw Error("stopped");
          await chrome.tabGroups.update(group,{title:"Browser MCP"});
        }
      } catch {presentation_warning="tab_group_unavailable";}
      return {state:"completed",tab_id:created.id,...(presentation_warning?{presentation_warning}:{})};
    }
    const latest=await browserValidateMutation(command,ownerApproved);
    if(!latest.ready||!await authorized())return {state:"failed",error_code:"forbidden"};
    if(command.action==="tab_navigate"){
      await chrome.tabs.update(command.tab_id,{url:command.url});
      return {state:"completed",tab_id:command.tab_id};
    }
    await chrome.tabs.remove(command.tab_id);
    return {state:"completed",tab_id:command.tab_id};
  } catch {return {state:"unknown"};}
}

function browserInteractionCommand(c) {
  const extras={click:[],fill:["text"],keypress:["key"],scroll:["delta_y"],select:["value"]};
  if(!c||!Object.hasOwn(extras,c.action))return false;
  const keys=["endpoint_id","intent_key","action","tab_id","document_id","element_id",...extras[c.action]];
  if(Object.keys(c).length!==keys.length||keys.some(k=>!Object.hasOwn(c,k)))return false;
  if(typeof c.endpoint_id!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.endpoint_id)||!/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(c.intent_key)||
     !Number.isSafeInteger(c.tab_id)||c.tab_id<0||typeof c.document_id!=="string"||!c.document_id.length||c.document_id.length>200||
     typeof c.element_id!=="string"||!/^e-[a-f0-9-]{36}$/.test(c.element_id))return false;
  if(c.action==="fill")return typeof c.text==="string"&&c.text.length<=2000;
  if(c.action==="select")return typeof c.value==="string"&&c.value.length<=200;
  if(c.action==="keypress")return ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","Escape"].includes(c.key);
  if(c.action==="scroll")return Number.isSafeInteger(c.delta_y)&&c.delta_y!==0&&Math.abs(c.delta_y)<=1000;
  return true;
}
// Serialized by scripting.executeScript into the top document's ISOLATED world.
// No caller script, selector, coordinates, expression, frame or modifier keys.
function browserPageInteraction(mode,command,expectedUrl) {
  const denied=error_code=>({error_code});
  if(location.href!==expectedUrl||!document.body)return denied("stale_target");
  const sensitive=/secret|credential|token|credit.card|card.number|cc-number|cc-csc|\bcvv\b|\bpin\b|recovery|password|passcode|one[ -]?time|verification[ -]?code|security[ -]?code|\botp\b|\b2fa\b|captcha|authenticat|sign[ -]?in|log[ -]?in|approv|授权|批准|验证码|密码|登录/i;
  const consequential=/submit|send|publish|post|delete|remove|pay|purchase|checkout|transfer|confirm|accept|agree|subscribe|revoke|connect|upload|download|save|提交|发送|发布|删除|支付|确认|同意|保存/i;
  if(document.querySelector('input[type="password"],input[autocomplete="one-time-code"],iframe,frame,object,embed')||
     sensitive.test((document.body.innerText||"").slice(0,100000)))return denied("sensitive_surface");
  const fields=document.querySelectorAll("input,textarea,select");
  if(fields.length>500 || Array.from(fields).some(el=>sensitive.test([
    el.getAttribute("type"),el.id,el.getAttribute("name"),el.getAttribute("autocomplete"),el.getAttribute("aria-label"),
    ...Array.from(el.labels||[],l=>l.textContent)].join(" "))))return denied("sensitive_surface");
  const visible=el=>el.isConnected && !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
    getComputedStyle(el).display!=="none"&&getComputedStyle(el).visibility==="visible"&&el.getClientRects().length>0;
  const safe=el=>visible(el)&&!el.disabled&&!el.readOnly&&!el.form&&el.getAttribute("aria-disabled")!=="true"&&!el.closest('form,[contenteditable],[role="dialog"],[aria-modal="true"]')&&
    !sensitive.test([el.id,el.getAttribute("name"),el.getAttribute("autocomplete"),el.getAttribute("aria-label"),
      ...Array.from(el.labels||[],l=>l.textContent)].join(" "));
  const slot="__browserMcpElementsT4";
  if(mode==="snapshot"){
    globalThis[slot]?.observer.disconnect();
    const registry={nodes:new Map(),url:location.href,expires:Date.now()+30000,dirty:false};
    registry.observer=new MutationObserver(()=>{registry.dirty=true;});
    registry.observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    globalThis[slot]=registry;
    const elements=[];
    for(const el of [document.body,...Array.from(document.querySelectorAll('input,textarea,select,button,a,summary,[role="button"],[tabindex]')).slice(0,500)]){
      if(elements.length>=100)break;
      if(!safe(el))continue;
      const type=(el.getAttribute("type")||"").toLowerCase();
      if(el.tagName==="INPUT"&&!["text","search","checkbox","radio", ""].includes(type))continue;
      const element_id="e-"+crypto.randomUUID();
      registry.nodes.set(element_id,el);
      const label=el===document.body?"":(el.getAttribute("aria-label")||
        Array.from(el.labels||[],l=>l.textContent).join(" ")||
        (["BUTTON","SUMMARY","A"].includes(el.tagName)?el.textContent:"")).slice(0,160);
      elements.push({element_id,tag:el.tagName.toLowerCase(),...(type?{type}:{}),...(label?{label}:{})});
    }
    return {elements};
  }
  const r=globalThis[slot],el=r?.nodes.get(command.element_id);
  if(r?.observer.takeRecords().length)r.dirty=true;
  if(!r||r.dirty||r.expires<Date.now()||r.url!==location.href||!el||!safe(el))return denied("stale_element");
  const tag=el.tagName,type=(el.getAttribute("type")||"text").toLowerCase();
  const approvalMode=mode==="prepare"||mode==="approved_execute";
  const description=(el.getAttribute("aria-label")||Array.from(el.labels||[],l=>l.textContent).join(" ")||el.textContent||"").trim();
  let needsApproval=false;
  // Only meaningful, non-form button controls can enter the first approval
  // slice. Authentication, frames, forms and unidentified controls stay blocked.
  if(command.action!=="scroll"&&consequential.test([el.textContent,el.getAttribute("aria-label"),el.id,el.getAttribute("name"),...Array.from(el.labels||[],l=>l.textContent)].join(" ")))
    needsApproval=true;
  const controlLabel=(el.getAttribute("aria-label")||Array.from(el.labels||[],l=>l.textContent).join(" ")||el.textContent||"").trim();
  if(command.action==="click" && !(tag==="SUMMARY"&&el.parentElement?.tagName==="DETAILS"&&controlLabel ||
      tag==="INPUT"&&["checkbox","radio"].includes(type)&&
      /^(?:(?:show|hide|display|filter|expand|collapse)\b|显示|隐藏|筛选)/i.test(controlLabel)))needsApproval=true;
  if(["fill","keypress"].includes(command.action) && !(tag==="TEXTAREA"||tag==="INPUT"&&["text","search"].includes(type)))
    return denied("forbidden");
  if(command.action==="select" && (tag!=="SELECT"||el.multiple||
      !Array.from(el.options).some(o=>o.value===command.value&&!o.disabled&&!o.parentElement?.disabled)))return denied("forbidden");
  if(command.action==="select"&&Array.from(el.options).some(o=>o.value===command.value&&
      (sensitive.test(o.value+" "+o.textContent)||consequential.test(o.value+" "+o.textContent))))needsApproval=true;
  if(command.action==="scroll"&&el!==document.body&&el.scrollHeight<=el.clientHeight)return denied("forbidden");
  if(needsApproval){
    if(!approvalMode)return denied("approval_required");
    if(command.action!=="click"||tag!=="BUTTON"||!description||description.length>160)return denied("forbidden");
  }
  if(mode==="prepare"){if(needsApproval)r.expires=Math.max(r.expires,Date.now()+300000);return {ready:true,approval_required:needsApproval,description};}
  if(mode==="validate")return {ready:true};
  if(mode!=="execute"&&mode!=="approved_execute")return denied("forbidden");
  // Any exception after this boundary may follow a webpage effect.
  try {
    if(command.action==="click")el.click();
    else if(command.action==="fill"||command.action==="select"){
      const proto=tag==="TEXTAREA"?HTMLTextAreaElement.prototype:tag==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,"value").set.call(el,command.action==="fill"?command.text:command.value);
      el.dispatchEvent(new Event("input",{bubbles:true}));
      el.dispatchEvent(new Event("change",{bubbles:true}));
    } else if(command.action==="keypress"){
      el.focus({preventScroll:true});
      el.dispatchEvent(new KeyboardEvent("keydown",{key:command.key,bubbles:true,cancelable:true}));
      el.dispatchEvent(new KeyboardEvent("keyup",{key:command.key,bubbles:true,cancelable:true}));
    } else if(command.action==="scroll"){
      (el===document.body?document.scrollingElement:el).scrollBy({top:command.delta_y,behavior:"instant"});
    }
    r.dirty=true; // a new observation is required after every attempted effect
    return {state:"completed"};
  } catch {r.dirty=true;return {state:"unknown"};}
}
async function browserRunInteraction(command,mode,authorized=async()=>true) {
  const tab=await chrome.tabs.get(command.tab_id);
  if(!await browserAccessTab(tab)||!browserMutationTarget({action:"tab_open",url:tab.url},false,(await browserSensitivePermissions()).lan))return {error_code:"forbidden"};
  const route=decodeURIComponent(new URL(tab.url).pathname);
  if(/auth|password|passcode|otp|mfa|approval|approve|consent|payment|checkout|billing|credential|secret/i.test(route))
    return {error_code:"forbidden"};
  const frame=await chrome.webNavigation.getFrame({tabId:command.tab_id,frameId:0});
  if(!frame||frame.documentLifecycle!=="active"||frame.documentId!==command.document_id||
     !await browserAccessUrl(frame.url)||new URL(frame.url).href!==new URL(tab.url).href)return {error_code:"stale_target"};
  if(!await browserAccessTab(await chrome.tabs.get(command.tab_id))||!await authorized())return {error_code:"forbidden"};
  const results=await chrome.scripting.executeScript({target:{tabId:command.tab_id,documentIds:[command.document_id]},
    world:"ISOLATED",func:browserPageInteraction,args:[mode,command,frame.url]});
  if(results.length!==1||results[0].frameId!==0||results[0].documentId!==command.document_id||!results[0].result)
    return mode==="execute"?{state:"unknown"}:{error_code:"stale_target"};
  return {...results[0].result,...(mode==="prepare"&&results[0].result.approval_required?{target_url:frame.url}:{})};
}
