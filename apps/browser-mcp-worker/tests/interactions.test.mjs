import test from "node:test";
import assert from "node:assert/strict";
import {fixture} from "./helpers/t4-browser.mjs";

test("a valid task may click an explicitly referenced checkbox regardless of business label",async()=>{
  const f=await fixture();
  try {
    const args=await f.command("click",e=>e.type==="checkbox");
    f.nodes[2].labels=[{textContent:"I agree to Pay and confirm purchase"}];
    assert.equal((await f.perform("click",args)).result.state,"completed");
    assert.equal(f.effects.filter(e=>e[0]==="click").length,1);
  } finally {await f.close();}
});


test("ordinary form fields and submit buttons are available through fixed intents",async()=>{
  const f=await fixture();
  try {
    f.nodes[1].form=true;
    f.nodes[3].form=true;
    f.nodes[4].form=true;
    const before=await f.snapshot();
    assert.equal(before.elements.some(e=>e.tag==="button"),true);
    const fill=await f.command("fill",e=>e.type==="text",{text:"public draft"});
    assert.equal((await f.perform("fill",fill)).result.state,"completed");
    const select=await f.command("select",e=>e.tag==="select",{value:"blue"});
    assert.equal((await f.perform("select",select)).result.state,"completed");
    const button=await f.command("click",e=>e.tag==="button");
    assert.equal((await f.perform("click",button)).result.state,"completed");
    assert.equal(f.effects.some(e=>e[0]==="click"&&e[1]==="BUTTON"),true);
  } finally {await f.close();}
});

test("normal fields remain usable beside credentials, and a body reference is not a click target",async()=>{
  const f=await fixture();try{
    f.pageState.sensitive=true;
    const snapshot=await f.snapshot();
    assert.equal(snapshot.elements.some(e=>e.type==="password"),false);
    assert.equal(snapshot.elements.some(e=>e.type==="text"),true);
    const body=await f.command("click",e=>e.tag==="body");
    assert.equal((await f.perform("click",body)).result.state,"failed");
    const input=await f.command("fill",e=>e.type==="text",{text:"approved search"});
    assert.equal((await f.perform("fill",input)).result.state,"completed");
  }finally{await f.close();}
});

test("link click preflight rejects nonweb, Owner and ungranted LAN targets without side effects",async()=>{
  for(const href of ["javascript:alert(1)","chrome://settings/","https://browser.example/activate/verify/attempt",
    "http://127.0.0.1/admin","http://169.254.169.254/latest/meta-data/"]){
    const f=await fixture();try{
      f.nodes[4].tagName="A";f.nodes[4].attrs.href=href;
      const args=await f.command("click",e=>e.tag==="a");
      const result=(await f.perform("click",args)).result;
      assert.equal(result.state,"failed",href);
      assert.equal(f.effects.length,0,href);
    }finally{await f.close();}
  }
  const f=await fixture();try{
    f.nodes[4].tagName="A";f.nodes[4].attrs.href="https://example.org/#/post/save";
    const args=await f.command("click",e=>e.tag==="a");
    assert.equal((await f.perform("click",args)).result.state,"completed");
  }finally{await f.close();}
});
