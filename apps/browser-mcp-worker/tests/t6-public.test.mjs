import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fixture,intent} from './helpers/t4-browser.mjs';
const grant=(f,surface,enabled)=>f.popup('sensitive-permission',{surface,enabled});
const ids=r=>r.tabs.map(t=>t.tab_id);

test('MCP → DO → extension: independent local LAN/private gates and isolated enumeration',async()=>{
  const f=await fixture();try{
    const tabs=scope=>f.rpc('browser_tabs',{endpoint_id:f.local.endpoint_id,...(scope?{scope}:{})});
    const status=await f.popup('status');
    assert.equal(status.sensitive_permissions.lan,false);assert.equal(status.sensitive_permissions.private,false);
    f.pageState.url='http://192.168.1.42:8080/local?seed=PRIVATE_QUERY';f.pageState.incognito=true;
    assert.equal((await f.snapshot()).error_code,'forbidden');
    await assert.rejects(grant(f,'private',true),/private_permission_denied/);
    await grant(f,'lan',true);assert.deepEqual(ids(await tabs()),[9]);
    assert.equal((await tabs('private')).error_code,'private_permission_denied');
    f.pageState.nativePrivate=true;await grant(f,'private',true);
    assert.deepEqual(ids(await tabs()),[9]);assert.deepEqual(ids(await tabs('private')),[1]);
    for(const [action,find,params] of [['click',e=>e.type==='checkbox',{}],['fill',e=>e.type==='text',{text:'PRIVATE_BODY_SEED'}]]){
      assert.equal((await f.perform(action,await f.command(action,find,params))).result.state,'completed');
    }
    await grant(f,'lan',false);assert.equal((await f.snapshot()).error_code,'forbidden');assert.deepEqual(ids(await tabs('private')),[]);
    f.pageState.url='https://example.com/private?seed=PRIVATE_QUERY';assert.equal((await f.snapshot()).document_id,'doc-1');
    await grant(f,'private',false);assert.equal((await f.snapshot()).error_code,'forbidden');assert.deepEqual(ids(await tabs()),[9]);
    const persisted=JSON.stringify({local:f.local,rows:f.db.prepare('SELECT * FROM browser_intents').all()});
    for(const seed of ['PRIVATE_QUERY','PRIVATE_BODY_SEED','192.168.1.42','example.com/private','Public fixture'])assert.ok(!persisted.includes(seed),seed);
    assert.ok(!Object.hasOwn(f.local,'browser_sensitive_grants'));
  }finally{await f.close();}
});

test('native denial/failure is fail closed and untrusted messages cannot enable either permission',async()=>{
  const f=await fixture();try{
    for(const surface of ['lan','private'])for(const sender of [{id:f.chrome.runtime.id,url:'https://example.com/',tab:{id:1}},{id:'foreign',url:f.chrome.runtime.getURL('popup.html')}])
      assert.equal((await f.spoof({type:'sensitive-permission',surface,enabled:true},sender)).ok,false);
    assert.equal((await f.rpc('browser_tabs',{endpoint_id:f.local.endpoint_id,lan:true})).error_code,'invalid_arguments');
    f.pageState.nativePrivate=true;await grant(f,'private',true);f.pageState.incognito=true;
    assert.equal((await f.snapshot()).document_id,'doc-1');
    for(const failure of [false,true]){
      f.pageState.nativePrivate=false;f.pageState.nativeFailure=failure;
      assert.equal((await f.snapshot()).error_code,'forbidden');
      assert.equal((await f.rpc('browser_tabs',{endpoint_id:f.local.endpoint_id,scope:'private'})).error_code,'private_permission_denied');
    }
    f.pageState.nativePrivate=true;f.pageState.nativeFailure=false;
    assert.equal((await f.snapshot()).error_code,'forbidden','native recovery alone cannot revive local consent');
  }finally{await f.close();}
});

test('LAN consent normalizes misleading URLs and keeps metadata/auth/protected targets prohibited',async()=>{
  const f=await fixture();try{
    await grant(f,'lan',true);
    for(const url of ['http://localhost:8000/app','http://printer.lan/app','http://127.1/app','http://0x7f000001/app','http://2130706433/app','http://[::1]/app','http://[fd12::1]/app']){
      f.pageState.url=url;assert.equal((await f.snapshot()).document_id,'doc-1',url);
    }
    for(const url of ['http://169.254.169.254/latest/meta-data/','http://0xa9fea9fe/','http://2852039166/','http://metadata.google.internal/','http://100.100.100.200/','http://168.63.129.16/','http://[fd00:ec2::254]/','http://[fd20:ce::254]/','http://metadata.tencentyun.com/','http://[::ffff:a9fe:a9fe]/','https://localhost@metadata.google.internal/','file:///x','chrome://settings','chrome-extension://abc/','https://chromewebstore.google.com/','https://localhost/%6cogin','https://localhost/#/login','https://localhost/#/%61pprove','http://printer.lan/approval','https://browser.example/owner/operations/a','https://browser.example.:8443/','http://localhost/auth','https://fixture.cloudflareaccess.com/']){
      f.pageState.url=url;assert.equal((await f.snapshot()).error_code,'forbidden',url);
    }
    f.pageState.url='http://localhost/app';f.pageState.frameUrl='http://169.254.169.254/';
    assert.equal((await f.snapshot()).error_code,'stale_target');delete f.pageState.frameUrl;
    f.pageState.embedded=true;assert.equal((await f.snapshot()).error_code,'sensitive_surface');
  }finally{await f.close();}
});

test('disable/off-on invalidates held execution; revocation during read discards content; Stop clears grants',async()=>{
  for(const surface of ['lan','private']){
    const f=await fixture();try{
      f.pageState.nativePrivate=true;await grant(f,surface,true);
      if(surface==='lan')f.pageState.url='http://localhost/app';else f.pageState.incognito=true;
      const args=await f.command('click',e=>e.type==='checkbox');f.hold();await f.perform('click',args);
      await grant(f,surface,false);await grant(f,surface,true);
      await f.release();await f.flush();assert.equal(f.effects.length,0);f.restart();
      const gate=f.pauseNextScript(),reading=f.snapshot();await gate.entered;
      await grant(f,surface,false);gate.release();const result=await reading;
      assert.ok(result.error_code);assert.equal(result.text,undefined);assert.equal(result.elements,undefined);
      await grant(f,surface,true);await f.popup('stop');await f.popup('resume');await f.restartExtension();
      assert.equal((await f.popup('status')).sensitive_permissions[surface],false);
      assert.equal((await f.snapshot()).error_code,'forbidden');
    }finally{await f.close();}
  }
});

test('SW reconstruction retains session consent; simulated browser/reload session loss clears it',async()=>{
  const f=await fixture();try{
    f.pageState.nativePrivate=true;await grant(f,'lan',true);await grant(f,'private',true);
    f.pageState.incognito=true;f.pageState.url='http://localhost/app';
    await f.restartExtension();assert.equal((await f.snapshot()).document_id,'doc-1');
    await f.restartExtension(true);
    const s=await f.popup('status');assert.equal(s.sensitive_permissions.lan,false);assert.equal(s.sensitive_permissions.private,false);
    assert.equal((await f.snapshot()).error_code,'forbidden');
  }finally{await f.close();}
});

test('delayed local grant cannot beat Stop; failed session revocation stops control across reconstruction',async()=>{
  const f=await fixture();try{
    const original=f.chrome.storage.session.set;
    let release,entered;const ready=new Promise(r=>{release=r;}),seen=new Promise(r=>{entered=r;});
    f.chrome.storage.session.set=async values=>{if(values.browser_sensitive_grants?.lan){entered();await ready;}return original(values);};
    const enabling=grant(f,'lan',true);await seen;
    await f.popup('stop');release();await enabling;
    await f.popup('resume');assert.equal((await f.popup('status')).sensitive_permissions.lan,false);
    await grant(f,'lan',true);
    f.chrome.storage.session.set=async values=>{if(values.browser_sensitive_grants)throw Error('storage unavailable');return original(values);};
    await assert.rejects(grant(f,'lan',false),/storage unavailable/);assert.equal(f.local.authorization,'stopped');
    await f.restartExtension();assert.equal((await f.snapshot()).error_code,'stopped');
    await assert.rejects(f.popup('resume'),/toolbar activation must pair|storage unavailable/);f.chrome.storage.session.set=original;
  }finally{await f.close();}
});


test('private screenshot remains transient and native revocation hides the last observed target',async()=>{
  const f=await fixture();try{
    f.pageState.nativePrivate=true;f.pageState.incognito=true;
    await grant(f,'private',true);
    const image=await f.rpc('browser_screenshot',{endpoint_id:f.local.endpoint_id,tab_id:1});
    assert.equal(image.data_url,'data:image/png;base64,SCREENSHOT_SEED');
    let status=await f.popup('status');assert.equal(status.last_observed_tab_id,1);assert.equal(status.last_observed_scope,'private');
    f.pageState.nativePrivate=false;status=await f.popup('status');assert.equal(status.last_observed_tab_id,null);
    assert.equal((await f.rpc('browser_screenshot',{endpoint_id:f.local.endpoint_id,tab_id:1})).error_code,'forbidden');
    assert.ok(!JSON.stringify({local:f.local,rows:f.db.prepare('SELECT * FROM browser_intents').all()}).includes('SCREENSHOT_SEED'));
  }finally{await f.close();}
});


test('actual Popup buttons require local confirmation and independently change session gates',async()=>{
  const f=await fixture();try{
    const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:false});return elements.get(id);};
    let confirmed=false;
    const popup=vm.createContext({document:{getElementById:element},Date,Number,URL,
      BROWSER_MCP_SERVICE_ORIGIN:'https://browser.example',confirm:()=>confirmed,alert:()=>{},
      chrome:{runtime:{sendMessage:(message,done)=>f.popup(message.type,message).then(result=>done({ok:true,result}),error=>done({ok:false,error:error.message}))}}});
    vm.runInContext(fs.readFileSync(new URL('../extension/options.js',import.meta.url),'utf8'),popup);
    await vm.runInContext("refresh()",popup);
    assert.match(element('status').textContent,/native permission: DENIED/);
    await element('lan').onclick();assert.equal((await f.popup('status')).sensitive_permissions.lan,false);
    confirmed=true;await element('lan').onclick();
    assert.equal((await f.popup('status')).sensitive_permissions.lan,true);assert.equal((await f.popup('status')).sensitive_permissions.private,false);
    f.pageState.nativePrivate=true;await element('private').onclick();
    assert.equal((await f.popup('status')).sensitive_permissions.private,true);
    await element('lan').onclick();assert.equal((await f.popup('status')).sensitive_permissions.lan,false);
    assert.equal((await f.popup('status')).sensitive_permissions.private,true);
  }finally{await f.close();}
});


test('private-focused creation selects an ordinary window/group; existing private tabs never regroup',async()=>{
  const f=await fixture();try{
    f.pageState.nativePrivate=true;f.pageState.incognito=true;await grant(f,'private',true);
    const grouping=[];
    f.chrome.tabGroups={query:async opts=>{grouping.push(['query',opts.windowId]);return [{id:77,title:'Browser MCP',windowId:2},{id:42,title:'Browser MCP',windowId:1}];}};
    f.chrome.tabs.group=async opts=>{grouping.push(['group',opts.groupId]);return opts.groupId;};
    const args={endpoint_id:f.local.endpoint_id,intent_key:intent(),url:'https://example.com/new'};
    assert.equal((await f.perform('tab_open',args)).result.state,'completed');
    assert.deepEqual(f.effects[0],['tab_open','https://example.com/new',1]);
    assert.deepEqual(grouping,[['query',1],['group',42]]);
    for(const action of ['tab_navigate','tab_close']){
      const target={endpoint_id:f.local.endpoint_id,intent_key:intent(),tab_id:1,document_id:'doc-1',...(action==='tab_navigate'?{url:'https://example.com/next'}:{})};
      assert.equal((await f.perform(action,target)).result.state,'completed');
    }
    assert.equal(grouping.length,2);
  }finally{await f.close();}
});
