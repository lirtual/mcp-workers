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
