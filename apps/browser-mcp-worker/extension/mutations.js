// Fixed browser-side mutation executor. No arbitrary JavaScript or CDP surface.
// A prepare validates the target; only a separate consumed execute permits effects.
function browserMutationTarget(command,allowLan=false) {
  if(browserInteractionCommand(command))return true;
  if(!command || !["tab_open","tab_navigate","tab_close"].includes(command.action)) return false;
  if(command.action!=="tab_close"){
    if(typeof command.url!=="string" || command.url.length>2048 || !browserEligibleUrl(command.url,allowLan))return false;
    // Browser URL eligibility is a technical boundary. Business path/query/hash
    // strings cannot establish website safety and are not denied here.
  }
  if(command.action!=="tab_open" &&
    (!Number.isSafeInteger(command.tab_id)||command.tab_id<0 ||
     typeof command.document_id!=="string"||command.document_id.length<1||command.document_id.length>200))return false;
  return true;
}
async function browserValidateMutation(command) {
  if(browserInteractionCommand(command)){
    try {return await browserRunInteraction(command,"validate");}
    catch {return {error_code:"stale_target"};}
  }
  const permissions=await browserSensitivePermissions();
  if(!browserMutationTarget(command,permissions.lan))return {error_code:"forbidden"};
  const result={ready:true};
  if(command.action==="tab_open")return result;
  try {
    const tab=await chrome.tabs.get(command.tab_id);
    if(!await browserAccessTab(tab))return {error_code:"forbidden"};
    const frame=await chrome.webNavigation.getFrame({tabId:command.tab_id,frameId:0});
    if(!frame||frame.documentLifecycle!=="active"||frame.documentId!==command.document_id||
      !await browserAccessUrl(frame.url)||new URL(frame.url).href!==new URL(tab.url).href)
      return {error_code:"stale_target"};
    return result;
  } catch {return {error_code:"stale_target"};}
}
async function browserExecuteMutation(command,authorized=async()=>true) {
  const checked=await browserValidateMutation(command);
  if(!checked.ready)return {state:"failed",error_code:checked.error_code};
  // Revalidate the owner Stop/generation gate after async document checks, immediately
  // before attempting a browser effect. Already-dispatched events remain in-flight.
  if(!await authorized())return {state:"failed",error_code:"stopped"};
  // At this point, Chromium APIs may produce an effect even if a later call rejects.
  // Such exceptions are Unknown; never repeat automatically with another key.
  try {
    if(browserInteractionCommand(command)){
      const result=await browserRunInteraction(command,"execute",authorized);
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
    const latest=await browserValidateMutation(command);
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
function browserPageInteraction(mode,command,expectedUrl,feedbackEnabled=false) {
  const denied=error_code=>({error_code});
  if(location.href!==expectedUrl||!document.body)return denied("stale_target");
  // Credentials are excluded at their field, not by surrounding page text,
  // other ordinary fields or business words in button names.
  // The scripted function must remain self-contained for Chrome's isolated world.
  const secret=/password|passcode|one[ -]?time[ -]?code|otp|2fa|captcha|verification[ -]?code|security[ -]?code|authenticator|recovery[ -]?code|api[ _-]?key|secret|credential|token|cvv|cc-number|cc-csc/i;
  const sensitiveField=el=>{
    const role=el.getAttribute('role')||'';
    if(!['INPUT','TEXTAREA','SELECT','OPTION'].includes(el.tagName)&&
       !['combobox','listbox','option','menu','menuitem','menuitemradio','menuitemcheckbox'].includes(role))return false;
    const type=(el.getAttribute('type')||'').toLowerCase();
    if(['password','file','hidden'].includes(type))return true;
    const fields=[type,el.id,el.getAttribute('name'),el.getAttribute('autocomplete'),
      el.getAttribute('aria-label'),...Array.from(el.labels||[],l=>l.textContent)].join(' ');
    return secret.test(fields);
  };
  const visible=el=>el.isConnected && !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
    getComputedStyle(el).display!=="none"&&getComputedStyle(el).visibility==="visible"&&el.getClientRects().length>0;
  const observable=el=>visible(el)&&!el.closest('[contenteditable]')&&!sensitiveField(el);
  const disabled=el=>el.disabled===true||el.readOnly===true||el.getAttribute('aria-disabled')==='true'||
    el.closest('[disabled],[aria-disabled="true"]')!==null;
  const safe=el=>observable(el)&&!disabled(el);
  const plain=value=>typeof value==='string'&&value.length<=200&&
    !secret.test(value)&&!/(?:[A-Za-z0-9_\-]{32,}|[A-Za-z0-9+/]{32,}={0,2})/.test(value);
  const compact=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,160);
  const labelledNodes=el=>{
    const raw=el.getAttribute('aria-labelledby')||'';
    if(raw.length>256||!raw.trim())return [];
    const ids=raw.trim().split(/\s+/);
    if(ids.length>3)return [];
    const nodes=ids.map(id=>/^[a-zA-Z0-9_-]{1,100}$/.test(id)?document.getElementById(id):null);
    if(nodes.some(node=>!node||!visible(node)||sensitiveField(node)||secret.test(node.id||'')||!plain(compact(node.textContent))))return [];
    return nodes;
  };
  const name=el=>compact(el.getAttribute('aria-label')||
    labelledNodes(el).map(node=>node.textContent).join(' ')||
    Array.from(el.labels||[],l=>l.textContent).join(' ')||
    (['BUTTON','SUMMARY','A','OPTION'].includes(el.tagName)||
      ['combobox','option','menuitem','menuitemradio','menuitemcheckbox','radio','button'].includes(el.getAttribute('role'))
      ?el.innerText??(el.children?.length===0?el.textContent:''):''));
  const nativeOptions=el=>{
    if(el.tagName!=='SELECT'||el.multiple)return null;
    const list=Array.from(el.options||[]);
    if(list.length>32)return null; // no partial list can be used as an allowlist
    const result=[];
    for(const option of list){
      const value=option.value,label=compact(option.label??option.textContent);
      if(typeof value!=='string'||value.length>200||!plain(value)||!label||!plain(label))return null;
      result.push({label,value,selected:option.selected===true,
        disabled:option.disabled===true||option.parentElement?.disabled===true});
    }
    return result;
  };
  const slot="__browserMcpElementsT4";
  if(mode==="snapshot"){
    globalThis[slot]?.observer.disconnect();
    const registry={nodes:new Map(),labels:new Map(),options:new Map(),url:location.href,
      expires:Date.now()+30000,dirty:false,changed:new Set()};
    // Invalidate targets and associated labels on re-render or ancestor changes.
    const apply=records=>{
      for(const record of records)for(const [id,el] of registry.nodes){
        const target=record.target;
        const subjects=[el,...(registry.labels.get(id)||[])];
        const affected=subjects.some(node=>target===node ||
          (record.type==='attributes'&&target?.contains?.(node)) ||
          node.contains?.(target) ||
          (record.type==='childList'&&Array.from(record.removedNodes||[]).some(n=>n===node||n.contains?.(node))));
        if(affected)registry.changed.add(id);
      }
    };
    registry.apply=apply;
    registry.observer=new MutationObserver(apply);
    registry.observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    globalThis[slot]=registry;
    const elements=[];
    const selector='input,textarea,select,button,a,summary,[role="button"],[role="combobox"],'+
      '[role="listbox"],[role="option"],[role="menu"],[role="menuitem"],'+
      '[role="menuitemradio"],[role="menuitemcheckbox"],[role="radio"],[tabindex]';
    for(const el of [document.body,...Array.from(document.querySelectorAll(selector)).slice(0,500)]){
      if(elements.length>=100)break;
      if(!observable(el))continue;
      const type=(el.getAttribute("type")||"").toLowerCase();
      if(el.tagName==="INPUT"&&!["text","search","email","url","tel","number","submit","button","reset","checkbox","radio",""].includes(type))continue;
      const role=el.getAttribute('role')||(el.tagName==='SELECT'&&!el.multiple?'combobox':
        el.tagName==='OPTION'?'option':el.tagName==='BUTTON'?'button':'');
      const label=el===document.body?'':name(el);
      const options=nativeOptions(el);
      const element_id="e-"+crypto.randomUUID();
      registry.nodes.set(element_id,el);
      registry.labels.set(element_id,[...Array.from(el.labels||[]),...labelledNodes(el)]);
      if(options)registry.options.set(element_id,options);
      const property=(attr)=>el.getAttribute(attr);
      const expanded=property('aria-expanded'),selected=property('aria-selected'),checked=property('aria-checked');
      elements.push({element_id,tag:el.tagName.toLowerCase(),...(role?{role}:{}),
        ...(type?{type}:{}),...(label?{label}:{}),disabled:disabled(el),
        ...(expanded==='true'||expanded==='false'?{expanded:expanded==='true'}:{}),
        ...(selected==='true'||selected==='false'?{selected:selected==='true'}:{}),
        ...(checked==='true'||checked==='false'?{checked:checked==='true'}:{}),
        ...(options?{options,options_truncated:false}:el.tagName==='SELECT'?{options_truncated:true}:{}),
        ...(el.tagName==='SELECT'&&options?{value:options.find(o=>o.selected)?.value??''}:{}),
        ...(document.activeElement===el?{focused:true}:{})});
    }
    return {elements};
  }
  const r=globalThis[slot],el=r?.nodes.get(command.element_id);
  if(r)r.apply(r.observer.takeRecords());
  if(!r||r.dirty||r.expires<Date.now()||r.url!==location.href||!el||!el.isConnected)
    return denied("stale_element");
  if(sensitiveField(el))return denied("sensitive_surface");
  if(r.changed.has(command.element_id)||!safe(el))return denied("stale_element");
  const labels=Array.from(el.labels||[]),originalLabels=r.labels.get(command.element_id)||[];
  if(labels.length!==originalLabels.length||labels.some((node,i)=>node!==originalLabels[i]))
    return denied("stale_element");
  const tag=el.tagName,type=(el.getAttribute("type")||"text").toLowerCase();

  // A body ref is for scrolling, never a wildcard click on arbitrary page handlers.
  if(command.action==="click"&&el===document.body)return denied("forbidden");
  if(["fill","keypress"].includes(command.action) &&
    !(tag==="TEXTAREA"||tag==="INPUT"&&["text","search","email","url","tel","number"].includes(type)||
      command.action==="keypress"&&el.getAttribute('role')==='combobox'))
    return denied("forbidden");
  if(command.action==="select" && (tag!=="SELECT"||el.multiple||
    !r.options.has(command.element_id)))return denied("forbidden");
  if(command.action==='select'){
    const seen=r.options.get(command.element_id);
    const current=nativeOptions(el);
    const matches=seen.filter(o=>o.value===command.value);
    if(!current||matches.length!==1||matches[0].disabled||seen.filter(o=>o.label===matches[0].label).length!==1||
       current.length!==seen.length||current.some((o,i)=>o.label!==seen[i].label||o.value!==seen[i].value||o.disabled!==seen[i].disabled))
      return denied('stale_element');
  }
  if(command.action==="scroll"&&el!==document.body&&el.scrollHeight<=el.clientHeight)return denied("forbidden");
  if(mode==="prepare"||mode==="validate"){
    // Resolve a link destination here, where its actual referenced element is
    // available. The background executor checks it against the single shared
    // technical URL policy; page-authored handlers can still have other effects.
    if(command.action==="click"&&tag==="A"&&el.getAttribute("href")!==null){
      try{return {ready:true,destination_url:new URL(el.getAttribute("href"),location.href).href};}
      catch{return denied("forbidden");}
    }
    return {ready:true};
  }
  if(mode!=="execute")return denied("forbidden");
  // Target indication is presentation only; it cannot make input trusted.
  // Never append to BODY, so the page reference observer cannot mistake it
  // for a change to a selected business target.
  if(feedbackEnabled&&el!==document.body){
    try {
      const previous=globalThis.__browserMcpTargetMarker;
      if(previous){clearTimeout(previous.timer);previous.node.remove();}
      const rect=el.getBoundingClientRect(),marker=document.createElement('div');
      marker.setAttribute('aria-hidden','true');marker.tabIndex=-1;
      marker.style.cssText='all:initial!important;position:fixed!important;z-index:2147483647!important;'+
        'width:18px!important;height:18px!important;border:3px solid #16a085!important;'+
        'border-radius:50%!important;background:rgba(22,160,133,.12)!important;'+
        'box-shadow:0 0 0 4px rgba(22,160,133,.25)!important;pointer-events:none!important;';
      marker.style.left=Math.round(rect.left+rect.width/2-12)+'px';
      marker.style.top=Math.round(rect.top+rect.height/2-12)+'px';
      document.documentElement.appendChild(marker);
      const record={node:marker,timer:null};globalThis.__browserMcpTargetMarker=record;
      record.timer=setTimeout(()=>{
        marker.remove();if(globalThis.__browserMcpTargetMarker===record)delete globalThis.__browserMcpTargetMarker;
      },900);
    }catch{ /* visual feedback must not gate an authorized action */ }
  }
  // Any exception after this boundary may follow a webpage effect.
  try {
    if(command.action==="click")el.click();
    else if(command.action==="fill"||command.action==="select"){
      const proto=tag==="TEXTAREA"?HTMLTextAreaElement.prototype:tag==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,"value").set.call(el,command.action==="fill"?command.text:command.value);
      el.dispatchEvent(new Event("input",{bubbles:true}));
      el.dispatchEvent(new Event("change",{bubbles:true}));
    } else if(command.action==="keypress"){
      try {el.focus({preventScroll:true});}
      catch {r.dirty=true;return denied('unsupported_input');}
      if(document.activeElement!==el){r.dirty=true;return denied('unsupported_input');}
      el.dispatchEvent(new KeyboardEvent("keydown",{key:command.key,bubbles:true,cancelable:true}));
      el.dispatchEvent(new KeyboardEvent("keyup",{key:command.key,bubbles:true,cancelable:true}));
    } else if(command.action==="scroll"){
      (el===document.body?document.scrollingElement:el).scrollBy({top:command.delta_y,behavior:"instant"});
    }
    r.dirty=true; // readback is required; event dispatch is not website acceptance
    return {state:"completed"};
  } catch {r.dirty=true;return {state:"unknown"};}
}
async function browserRunInteraction(command,mode,authorized=async()=>true) {
  const tab=await chrome.tabs.get(command.tab_id);
  if(!await browserAccessTab(tab)||!browserMutationTarget({action:"tab_open",url:tab.url},(await browserSensitivePermissions()).lan))return {error_code:"forbidden"};
  const frame=await chrome.webNavigation.getFrame({tabId:command.tab_id,frameId:0});
  if(!frame||frame.documentLifecycle!=="active"||frame.documentId!==command.document_id||
     !await browserAccessUrl(frame.url)||new URL(frame.url).href!==new URL(tab.url).href)return {error_code:"stale_target"};
  if(!await browserAccessTab(await chrome.tabs.get(command.tab_id))||!await authorized())return {error_code:"forbidden"};
  let feedback=false;
  if(mode==='execute'){
    try {feedback=(await chrome.storage.local.get('browser_visual_feedback')).browser_visual_feedback!==false;}
    catch {feedback=false;}
  }
  const results=await chrome.scripting.executeScript({target:{tabId:command.tab_id,documentIds:[command.document_id]},
    world:"ISOLATED",func:browserPageInteraction,args:[mode,command,frame.url,feedback]});
  if(results.length!==1||results[0].frameId!==0||results[0].documentId!==command.document_id||!results[0].result)
    return mode==="execute"?{state:"unknown"}:{error_code:"stale_target"};
  const result=results[0].result;
  if((mode==="prepare"||mode==="validate")&&result.ready&&typeof result.destination_url==="string"){
    // Do not send raw destinations back in durable operation receipts.
    return await browserAccessUrl(result.destination_url)?{ready:true}:{error_code:"forbidden"};
  }
  return result;
}

// Isolated-world presentation cleanup. No page selector or user-provided code.
function browserClearTargetFeedback() {
  const record=globalThis.__browserMcpTargetMarker;
  if(!record)return;
  clearTimeout(record.timer);record.node.remove();delete globalThis.__browserMcpTargetMarker;
}
