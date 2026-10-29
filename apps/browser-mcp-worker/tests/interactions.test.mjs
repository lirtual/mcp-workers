import test from "node:test";
import assert from "node:assert/strict";
import {fixture} from "./helpers/t4-browser.mjs";

test("consequential checkbox labels require approval even when the input has no own text",async()=>{
  const f=await fixture();
  try {
    const args=await f.command("click",e=>e.type==="checkbox");
    f.nodes[2].labels=[{textContent:"I agree to Pay and confirm purchase"}];
    assert.equal((await f.perform("click",args)).result.state,"failed");
    assert.equal(f.effects.length,0);
  } finally {await f.close();}
});


test("ordinary form fields are editable while form submission controls remain excluded",async()=>{
  const f=await fixture();
  try {
    f.nodes[1].form=true;
    f.nodes[3].form=true;
    f.nodes[4].form=true;
    const before=await f.snapshot();
    assert.equal(before.elements.some(e=>e.tag==="button"),false);
    const fill=await f.command("fill",e=>e.type==="text",{text:"public draft"});
    assert.equal((await f.perform("fill",fill)).result.state,"completed");
    const select=await f.command("select",e=>e.tag==="select",{value:"blue"});
    assert.equal((await f.perform("select",select)).result.state,"completed");
    assert.equal(f.effects.some(e=>e[0]==="click"&&e[1]==="BUTTON"),false);
  } finally {await f.close();}
});
