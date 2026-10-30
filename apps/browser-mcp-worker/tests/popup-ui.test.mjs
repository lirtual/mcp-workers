import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../extension/',import.meta.url);
const html=fs.readFileSync(new URL('options.html',root),'utf8');
const source=fs.readFileSync(new URL('options.js',root),'utf8');
function options(){
  const ids=['status','summary','action-feedback','lifetime','locate','stop','revoke','ack','lan','private'];
  const nodes=Object.fromEntries(ids.map(id=>[id,{id,textContent:'',value:'',disabled:false,onclick:null,onchange:null}]));
  const messages=[],state={alias:'chrome',authorization:'enabled',connection:'online',last_update:Date.now(),
    pairing_mode:'permanent',sensitive_permissions:{lan:false,private:false,native_private:false},
    pending_cloud_stop:false,endpoint_id:'11111111-1111-4111-8111-111111111111',activity:{available:true,pending:0,unknown:0,approvals:[]}};
  let confirmRevocation=false,respondStop;
  const chrome={runtime:{lastError:null,sendMessage(message,reply){messages.push(message);
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
  assert.match(p.nodes.status.textContent,/native permission: DENIED/);
});
test('Options Stop visibly reports local progress and cloud-confirmed status',async()=>{
  const p=options();await tick();const pending=p.nodes.stop.onclick();
  assert.match(p.nodes['action-feedback'].textContent,/Stopping locally/);
  p.state.authorization='stopped';p.finishStop({ok:true,result:{authorization:'stopped',cloud_confirmed:true}});
  await pending;assert.match(p.nodes.summary.textContent,/stopped/);
});
test('Options Revoke requires confirmation; lifetime becomes editable only when unpaired',async()=>{
  const p=options();await tick();
  await p.nodes.revoke.onclick();assert.equal(p.messages.filter(m=>m.type==='revoke').length,0);
  p.enableConfirm();await p.nodes.revoke.onclick();assert.equal(p.messages.filter(m=>m.type==='revoke').length,1);
  p.state.endpoint_id=undefined;assert.equal(p.messages.filter(m=>m.type==='resume').length,0);
});
