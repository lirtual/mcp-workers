import test from "node:test";
import assert from "node:assert/strict";
import {fixture,intent} from "./helpers/t4-browser.mjs";

test("a valid task may click an explicitly referenced checkbox regardless of business label",async()=>{
  const f=await fixture();
  try {
    f.nodes[2].labels=[{textContent:"I agree to Pay and confirm purchase"}];
    const args=await f.command("click",e=>e.type==="checkbox");
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


test("native choice discovery includes exact labels, values, disabled and selected state; rejects ambiguous selections",async()=>{
  const f=await fixture();try{
    f.nodes[3].attrs["aria-label"]="Theme";
    f.nodes[3].options=[{value:"",label:"Choose a color",disabled:true,parentElement:f.nodes[3]},
      {value:"blue",label:"Azure",disabled:false,selected:true,parentElement:f.nodes[3]},
      {value:"red",label:"Crimson",disabled:true,parentElement:f.nodes[3]}];
    const before=await f.snapshot(),select=before.elements.find(e=>e.tag==="select");
    assert.equal(select.role,"combobox");
    assert.equal(select.options[0].value,"");
    assert.equal(select.options[1].label,"Azure");
    assert.equal(select.options[1].value,"blue");
    assert.equal(select.options[1].selected,true);
    assert.equal(select.options[2].disabled,true);
    const chosen=await f.command("select",e=>e.tag==="select",{value:"blue"});
    assert.equal((await f.perform("select",chosen)).result.state,"completed");
    const readback=await f.snapshot(),choice=readback.elements.find(e=>e.tag==="select");
    assert.equal(choice.value,"blue");
    assert.equal(choice.options.find(o=>o.value==="blue").selected,true);
    const args=await f.command("select",e=>e.tag==="select",{value:"red"});
    assert.equal((await f.perform("select",args)).result.state,"failed");
    f.nodes[3].options=[{value:"blue",label:"Azure",disabled:true,parentElement:f.nodes[3]},
      {value:"blue",label:"Azure copy",disabled:false,parentElement:f.nodes[3]}];
    const ambiguous=await f.command("select",e=>e.tag==="select",{value:"blue"});
    assert.equal((await f.perform("select",ambiguous)).result.state,"failed");
  } finally {await f.close();}
});

test("a custom listbox option becomes actionable after opening and can be read back independently",async()=>{
  const f=await fixture();try{
    const Element=f.nodes[4].constructor;
    const opener=new Element("DIV",{role:"combobox","aria-label":"Region","aria-expanded":"false"});
    f.nodes.push(opener);
    let s=await f.snapshot();
    assert.equal(s.elements.some(e=>e.role==="combobox"&&e.label==="Region"),true);
    const open=await f.command("click",e=>e.label==="Region");
    assert.equal((await f.perform("click",open)).result.state,"completed");
    opener.attrs["aria-expanded"]="true";
    const choice=new Element("DIV",{role:"option","aria-selected":"false",label:"European Union"});
    f.nodes.push(choice);
    s=await f.snapshot();
    assert.equal(s.elements.find(e=>e.label==="Region").expanded,true);
    assert.equal(s.elements.find(e=>e.role==="option").selected,false);
    const option=await f.command("click",e=>e.role==="option");
    assert.equal((await f.perform("click",option)).result.state,"completed");
    choice.attrs["aria-selected"]="true";
    const after=await f.snapshot();
    assert.equal(after.elements.find(e=>e.role==="option").selected,true);
  }finally{await f.close();}
});


test("bounded combobox keyboard is synthetic and reports real focus separately from selection",async()=>{
  const f=await fixture();try{
    const Element=f.nodes[4].constructor, combo=new Element("DIV",{role:"combobox",tabindex:"0","aria-label":"Fruit"});
    f.nodes.push(combo);
    const args=await f.command("keypress",e=>e.label==="Fruit",{key:"ArrowDown"});
    const result=(await f.perform("keypress",args)).result;
    assert.equal(result.state,"completed");
    // Durable receipt means dispatch only; independently observe actual focus.
    const after=await f.snapshot();
    assert.equal(after.elements.find(e=>e.label==="Fruit").focused,true);
    assert.equal(after.elements.find(e=>e.label==="Fruit").selected,undefined);
    assert.equal(f.effects.some(e=>e[0]==="keydown"&&e[1]==="ArrowDown"),true);
  }finally{await f.close();}
});

test("optional target marker is non-interactive, makes no focus change and clears on local Stop",async()=>{
  const f=await fixture();try{
    const before=await f.command("click",e=>e.tag==="button");
    assert.equal((await f.perform("click",before)).result.state,"completed");
    assert.match(f.pageState.marker?.style.cssText||"",/pointer-events:none!important/);
    assert.equal(f.pageState.marker?.removed,false);
    assert.equal(f.effects.some(e=>e[0]==="focus"),false);
    await f.popup("stop");
    assert.equal(f.pageState.marker?.removed,true);
  }finally{await f.close();}
});


test("custom disabled choices remain observable but cannot be clicked; feedback may be disabled locally",async()=>{
  const f=await fixture();try{
    const Element=f.nodes[4].constructor;
    f.nodes.push(new Element("DIV",{role:"option",label:"Disabled entry","aria-disabled":"true"}));
    const s=await f.snapshot(),option=s.elements.find(e=>e.label==="Disabled entry");
    assert.equal(option.disabled,true);
    const args=await f.command("click",e=>e.label==="Disabled entry");
    assert.equal((await f.perform("click",args)).result.state,"failed");
    await f.chrome.storage.local.set({browser_visual_feedback:false});
    const click=await f.command("click",e=>e.tag==="button");
    assert.equal((await f.perform("click",click)).result.state,"completed");
    assert.equal(f.pageState.marker,undefined);
  }finally{await f.close();}
});

test("select refuses a value that appeared only after the observed snapshot",async()=>{
  const f=await fixture();try{
    const args=await f.command("select",e=>e.tag==="select",{value:"red"});
    f.nodes[3].options.push({value:"red",label:"Red",disabled:false,parentElement:f.nodes[3]});
    assert.equal((await f.perform("select",args)).result.state,"failed");
    assert.equal(f.effects.some(e=>e[0]==="change"),false);
  }finally{await f.close();}
});


test("nonfocusable combobox rejects unsupported keyboard before event dispatch",async()=>{
  const f=await fixture();try{
    const Element=f.nodes[4].constructor,combo=new Element("DIV",{role:"combobox","aria-label":"No keyboard"});
    combo.focus=()=>{};f.nodes.push(combo);
    const cmd=await f.command("keypress",e=>e.label==="No keyboard",{key:"ArrowDown"});
    const {result}=await f.perform("keypress",cmd);
    assert.equal(result.state,"failed");
    assert.equal(result.error_code,"unsupported_input");
    assert.equal(f.effects.some(e=>e[0]==="keydown"),false);
  }finally{await f.close();}
});

test("target feedback expires without moving focus",async()=>{
  const f=await fixture();try{
    const cmd=await f.command("click",e=>e.tag==="button");
    assert.equal((await f.perform("click",cmd)).result.state,"completed");
    assert.equal(f.pageState.marker.removed,false);
    await new Promise(resolve=>setTimeout(resolve,1050));
    assert.equal(f.pageState.marker.removed,true);
    assert.equal(f.effects.some(e=>e[0]==="focus"),false);
  }finally{await f.close();}
});


test("ARIA labelledby gives visible combobox a bounded accessible name",async()=>{
  const f=await fixture();try{
    const Element=f.nodes[4].constructor;
    const label=new Element('DIV',{id:'fruit-label',label:'Favorite Fruit'});
    const combo=new Element('DIV',{role:'combobox','aria-labelledby':'fruit-label','aria-expanded':'false'});
    f.nodes.push(label,combo);
    const snap=await f.snapshot();
    assert.equal(snap.elements.find(e=>e.role==='combobox'&&e.tag==='div').label,'Favorite Fruit');
    label.textContent='New label';f.pageState.mutated=true;f.pageState.mutationTarget=label;
    const args={endpoint_id:f.local.endpoint_id,intent_key:intent(),tab_id:1,document_id:snap.document_id,element_id:snap.elements.find(e=>e.role==='combobox'&&e.tag==='div').element_id};
    assert.equal((await f.perform('click',args)).result.state,'failed');
  }finally{await f.close();}
});
