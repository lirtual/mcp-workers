import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../extension/',import.meta.url);
const html=fs.readFileSync(new URL('options.html',root),'utf8');
const source=fs.readFileSync(new URL('options.js',root),'utf8');
function options(){
  const ids=['status','summary','action-feedback','identity','expiry','warning','alias','save-alias','prepair','lifetime','locate','stop','revoke','ack','lan','private','visual-feedback'];
  const nodes=Object.fromEntries(ids.map(id=>[id,{id,textContent:'',value:'',disabled:false,onclick:null,onchange:null}]));
  const messages=[],state={alias:'chrome',authorization:'enabled',connection:'online',last_update:Date.now(),
    pairing_mode:'permanent',sensitive_permissions:{lan:false,private:false,native_private:false},
    pending_cloud_stop:false,endpoint_id:'11111111-1111-4111-8111-111111111111',activity:{available:true,pending:0,unknown:0,approvals:[]}};
  let confirmRevocation=false,respondStop;
  const chrome={storage:{local:{get:async()=>({browser_visual_feedback:true}),set:async()=>{}}},runtime:{lastError:null,sendMessage(message,reply){messages.push(message);
    if(message.type==='status')queueMicrotask(()=>reply({ok:true,result:{...state}}));
    else if(message.type==='stop')respondStop=reply;
    else if(message.type==='revoke')queueMicrotask(()=>reply({ok:true,result:{cloud_confirmed:true}}));
    else if(message.type==='pairing-preference')queueMicrotask(()=>reply({ok:true,result:{mode:message.mode}}));
    else queueMicrotask(()=>reply({ok:false,error:'unavailable'}));
  }}};
  const ctx=vm.createContext({document:{getElementById:id=>nodes[id]},chrome,URL,Date,console,confirm:()=>confirmRevocation});
  vm.runInContext(source,ctx);
  return {nodes,messages,state,finishStop:reply=>respondStop(reply),enableConfirm:()=>{confirmRevocation=true;}};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('single toolbar action has no popup; Options shows status, duration, and permissions',async()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',root)));
  assert.equal(manifest.action.default_popup,undefined);
  assert.equal(manifest.options_page,'options.html');
  assert.ok(manifest.permissions.includes('alarms'));
  assert.ok(html.includes('id="lifetime"'));
  assert.ok(!html.includes('pairing code')&&!html.includes('id="resume"'));
  const p=options();await tick();
  assert.equal(p.nodes.lifetime.value,'permanent');assert.equal(p.nodes.lifetime.disabled,true);
  assert.match(p.nodes.status.textContent,/native: denied/);
  assert.equal(p.nodes.prepair.hidden,true,'pairing lifetime should be hidden for an existing Profile');
});
test('Options Stop visibly reports local progress and cloud-confirmed status',async()=>{
  const p=options();await tick();const pending=p.nodes.stop.onclick();
  assert.match(p.nodes['action-feedback'].textContent,/Stopping locally/);
  p.state.authorization='stopped';p.finishStop({ok:true,result:{authorization:'stopped',cloud_confirmed:true}});
  await pending;assert.match(p.nodes.summary.textContent,/OFF/);
});
test('Options Revoke requires confirmation; lifetime becomes editable only when unpaired',async()=>{
  const p=options();await tick();
  await p.nodes.revoke.onclick();assert.equal(p.messages.filter(m=>m.type==='revoke').length,0);
  p.enableConfirm();await p.nodes.revoke.onclick();assert.equal(p.messages.filter(m=>m.type==='revoke').length,1);
  p.state.endpoint_id=undefined;assert.equal(p.messages.filter(m=>m.type==='resume').length,0);
});

function renameOptions({confirmCloud=true}={}){
  const ids=['status','summary','action-feedback','identity','expiry','warning','alias','save-alias','prepair','lifetime','locate','stop','revoke','ack','lan','private','visual-feedback'];
  const nodes=Object.fromEntries(ids.map(id=>[id,{id,textContent:'',value:'',disabled:false,onclick:null,onchange:null,oninput:null}]));
  const endpoint_id='11111111-1111-4111-8111-111111111111';
  const state={alias:'11111111',authorization:'enabled',connection:'online',endpoint_id,
    pairing_mode:'permanent',sensitive_permissions:{},activity:{available:true,pending:0,unknown:0}};
  const cloud={alias:'11111111',authorization:'enabled',online:true};
  const received=[];
  let holdStatus=false,pendingStatus=null;
  const response=()=>({...state,cloud_state:{...cloud}});
  const chrome={storage:{local:{get:async()=>({browser_visual_feedback:true}),set:async()=>{}}},
    runtime:{lastError:null,sendMessage(message,reply){
      if(message.type==='status'){
        if(holdStatus)pendingStatus=reply;
        else queueMicrotask(()=>reply({ok:true,result:response()}));
      }else if(message.type==='rename'){
        received.push(message.alias);
        state.alias=message.alias;
        if(confirmCloud)cloud.alias=message.alias;
        queueMicrotask(()=>reply({ok:true,result:{alias:message.alias}}));
      }else queueMicrotask(()=>reply({ok:false,error:'unavailable'}));
    }} };
  const document={activeElement:null,getElementById:id=>nodes[id]};
  const ctx=vm.createContext({document,chrome,URL,Date,console,confirm:()=>false});
  vm.runInContext(source,ctx);
  return {ctx,nodes,received,cloud,document,
    hold:()=>{holdStatus=true;},
    release:()=>{assert.ok(pendingStatus,'expected in-flight status');holdStatus=false;
      const done=pendingStatus;pendingStatus=null;done({ok:true,result:response()});},
  };
}

test('Options preserves typed Profile name across an in-flight stale refresh and Save blur',async()=>{
  const f=renameOptions();await tick();
  const desired='111111112';
  f.nodes.alias.value=desired;f.nodes.alias.oninput?.();f.document.activeElement=f.nodes.alias;
  f.hold();vm.runInContext('void refresh()',f.ctx);await tick();
  f.document.activeElement=f.nodes['save-alias'];
  f.release();await tick();
  const saving=f.nodes['save-alias'].onclick();await tick();
  assert.deepEqual(f.received,[desired],'Save must submit exactly the owner-edited name, not a stale default');
  await saving;
  assert.equal(f.nodes.alias.value,desired);
  assert.match(f.nodes['action-feedback'].textContent,/completed/);
});

test('Options reports rename_unconfirmed rather than completed when authoritative cloud alias is stale',async()=>{
  const f=renameOptions({confirmCloud:false});await tick();
  const desired='111111112';
  f.nodes.alias.value=desired;f.nodes.alias.oninput?.();
  await f.nodes['save-alias'].onclick();
  assert.deepEqual(f.received,[desired]);
  assert.match(f.nodes['action-feedback'].textContent,/failed: rename_unconfirmed/);
  assert.equal(f.nodes.alias.value,desired,'failed save should preserve user input for correction');
});
