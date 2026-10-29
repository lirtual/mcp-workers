import test from "node:test";
import assert from "node:assert/strict";
import {fixture,intent} from "./helpers/t4-browser.mjs";

test("MCP → durable owner → extension executes all five interactions with stable receipts",async()=>{
  const f=await fixture();try {
    for(const [action,find,params,effect] of [
      ["click",e=>e.type==="checkbox",{},"click"],["fill",e=>e.type==="text",{text:"public draft"},"input"],
      ["keypress",e=>e.type==="text",{key:"ArrowRight"},"keydown"],["scroll",e=>e.tag==="body",{delta_y:250},"scroll"],
      ["select",e=>e.tag==="select",{value:"blue"},"change"]]){
      const args=await f.command(action,find,params),before=f.effects.length;
      const {admitted,result}=await f.perform(action,args);assert.equal(result.state,"completed",action);assert.equal(result.operation_id,admitted.operation_id);
      assert.ok(f.effects.slice(before).some(e=>e[0]===effect),action);const effects=f.effects.length;
      assert.equal((await f.rpc("browser_"+action,args)).operation_id,result.operation_id);await f.flush();assert.equal(f.effects.length,effects);
      assert.equal((await f.rpc("browser_"+action,{...args,element_id:"e-"+crypto.randomUUID()})).error_code,"intent_conflict");
      if(action==="fill")assert.equal((await f.rpc("browser_fill",{...args,text:"changed"})).error_code,"intent_conflict");
    }
    const rows=f.db.prepare("SELECT * FROM browser_intents").all();assert.equal(rows.length,5);
    assert.ok(!JSON.stringify(rows).includes("public draft"));assert.ok(!JSON.stringify(rows).includes("example.com"));
  }finally{await f.close();}
});

test("public MCP and DO ingress reject unknown fields, selectors, keys and missing identities",async()=>{
  const f=await fixture();try {
    const args=await f.command("fill",e=>e.type==="text",{text:"draft"});
    for(const patch of [{element_id:undefined},{document_id:""},{endpoint_id:undefined},{tab_id:undefined},{selector:"input"},{script:"alert(1)"},{approval:true},{text:"x".repeat(2001)}])
      assert.equal((await f.rpc("browser_fill",{...args,...patch})).error_code,"invalid_arguments");
    for(const key of ["Enter","Tab","Control+Enter","F5"]){const {text,...target}=args;
      assert.equal((await f.rpc("browser_keypress",{...target,key})).error_code,"invalid_arguments");}
    for(const patch of [{element_id:undefined},{delta_y:9},{action:"evaluate"},{text:42}])
      assert.equal((await f.doRequest({...args,action:"fill",...patch})).error_code,"invalid_arguments");
    const listed=await f.rpc(null,{},"tools/list");for(const action of ["click","fill","keypress","scroll","select"]){
      const schema=listed.result.tools.find(t=>t.name==="browser_"+action).inputSchema;assert.equal(schema.additionalProperties,false);
      for(const k of ["endpoint_id","tab_id","document_id","element_id","intent_key"])assert.ok(schema.required.includes(k));}
    assert.equal(f.effects.length,0);
  }finally{await f.close();}
});

test("public path denies sensitive/prohibited pages, expired/mutated refs, stale documents and consequential controls",async()=>{
  const f=await fixture();try {
    let args=await f.command("fill",e=>e.type==="text",{text:"draft"});
    const denied=async patch=>assert.equal((await f.perform("fill",{...args,intent_key:intent(),...patch})).result.state,"failed");
    await denied({element_id:"e-"+crypto.randomUUID()});await denied({document_id:"old"});
    for(const text of ["Enter password","One time code","Approve access","Authentication required"]){f.pageState.text=text;await denied({});}
    f.pageState.text="Public";f.pageState.sensitive=true;await denied({});f.pageState.sensitive=false;
    f.nodes[1].attrs.autocomplete="one-time-code";await denied({});delete f.nodes[1].attrs.autocomplete;
    f.pageState.mutated=true;await denied({});await denied({});
    const expired=await f.command("fill",e=>e.type==="text",{text:"draft"});f.pageState.now=Date.now()+31000;
    assert.equal((await f.perform("fill",expired)).result.state,"failed");delete f.pageState.now;
    args=await f.command("fill",e=>e.type==="text",{text:"draft"});
    for(const url of ["https://example.com/login","https://example.com/approval","https://example.com/cdn-cgi/access/authorize","https://accounts.google.com/","https://example.com/operations?confirm=1","https://example.com/?token=secret","http://127.0.0.1/private","chrome://settings/","https://browser.example/"]){f.pageState.url=url;await denied({});}
    f.pageState.url="https://example.com/clean";f.pageState.incognito=true;await denied({});f.pageState.incognito=false;
    assert.equal((await f.perform("click",await f.command("click",e=>e.tag==="button"))).result.state,"failed");
    args=await f.command("click",e=>e.type==="checkbox");f.nodes[2].form=true;assert.equal((await f.perform("click",{...args,intent_key:intent()})).result.state,"failed");f.nodes[2].form=false;
    args=await f.command("fill",e=>e.type==="text",{text:"draft"});f.nodes[1].isConnected=false;await denied({});
    assert.equal(f.effects.length,0);
  }finally{await f.close();}
});

test("lost receipt survives DO recreation as Unknown without replay",async()=>{
  const f=await fixture();try{
    const args=await f.command("click",e=>e.type==="checkbox");f.drop();await f.perform("click",args);assert.equal(f.effects.length,1);f.restart();
    const receipt=await f.rpc("browser_operation_status",{endpoint_id:args.endpoint_id,intent_key:args.intent_key});assert.equal(receipt.state,"unknown");
    const retry=await f.rpc("browser_click",args);await f.flush();assert.equal(retry.state,"unknown");assert.equal(retry.operation_id,receipt.operation_id);assert.equal(f.effects.length,1);
  }finally{await f.close();}
});

test("execute rechecks sensitive DOM after prepare and respects owner Stop",async()=>{
  for(const stop of [false,true]){const f=await fixture();try{
    const args=await f.command("fill",e=>e.type==="text",{text:"draft"});f.hold();await f.perform("fill",args);
    if(stop)await f.popup("stop");else f.pageState.text="Approve authentication";await f.release();await f.flush();assert.equal(f.effects.length,0);
    assert.equal((await f.rpc("browser_operation_status",{endpoint_id:args.endpoint_id,intent_key:args.intent_key})).state,stop?"unknown":"failed");
  }finally{await f.close();}}
});

test("exception after a DOM effect is Unknown and cannot repeat the effect",async()=>{
  const f=await fixture();try{
    const args=await f.command("click",e=>e.type==="checkbox");f.nodes[2].throwAfterEffect=true;
    assert.equal((await f.perform("click",args)).result.state,"unknown");assert.equal((await f.rpc("browser_click",args)).state,"unknown");await f.flush();assert.equal(f.effects.length,1);
  }finally{await f.close();}
});

// Public MCP → extension behavior seam: expandable UI controls should not require
// the independent owner approval reserved for consequential actions.
test("ordinary disclosure button works once without approval, but payment control stays blocked",async()=>{
  const f=await fixture();try {
    const button=f.nodes[4];
    button.attrs["aria-expanded"]="false";button.attrs["aria-controls"]="details-panel";
    button.textContent="Show details";button.attrs.label="Show details";
    const args=await f.command("click",e=>e.tag==="button");
    assert.equal((await f.perform("click",args)).result.state,"completed");
    assert.equal(f.effects.filter(e=>e[0]==="click").length,1);
    assert.equal((await f.rpc("browser_click",args)).state,"completed");
    assert.equal(f.effects.filter(e=>e[0]==="click").length,1);
    button.textContent="Pay now";button.attrs.label="Pay now";
    const dangerous=await f.command("click",e=>e.tag==="button");
    assert.equal((await f.perform("click",dangerous)).result.state,"failed");
    assert.equal(f.effects.filter(e=>e[0]==="click").length,1);
  }finally{await f.close();}
});

test("failed operation receipts preserve safe denial codes across prepare and execute",async()=>{
  for(const afterPrepare of [false,true]){
    const f=await fixture();
    try {
      const args=await f.command("scroll",e=>e.tag==="body",{delta_y:120});
      if(afterPrepare){
        f.hold();
        await f.perform("scroll",args);
      }
      f.pageState.text="Enter password";
      if(afterPrepare){await f.release();await f.flush();}
      else await f.perform("scroll",args);
      const receipt=await f.rpc("browser_operation_status",{endpoint_id:args.endpoint_id,intent_key:args.intent_key});
      assert.equal(receipt.state,"failed");
      assert.equal(receipt.error_code,"sensitive_surface");
      assert.equal(receipt.safe_next_action,"blocked_sensitive_surface");
      const stored=JSON.stringify(f.db.prepare("SELECT * FROM browser_intents").all());
      assert.ok(!stored.includes("Enter password"));
      assert.equal(f.effects.length,0);
    }finally{await f.close();}
  }
});
