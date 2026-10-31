import test from "node:test";
import assert from "node:assert/strict";
import {fixture} from "./helpers/t4-browser.mjs";

test("a hung document text injection reports only a fixed stage and bounded elapsed time",async()=>{
  const f=await fixture();
  let gate;
  try {
    f.pageState.url="https://dashboard.gitguardian.com/dashboard?token=FAKE_SECRET#private";
    f.pageState.text="NEVER_LEAK_VISIBLE_FIXTURE";
    gate=f.pauseNextScript();
    const pending=f.rpc("browser_snapshot",{endpoint_id:f.local.endpoint_id,tab_id:1});
    await gate.entered;
    const result=await pending;
    assert.equal(result.error_code,"timeout");
    assert.equal(result.stage,"text_injection");
    assert.ok(Number.isInteger(result.stage_elapsed_ms));
    assert.ok(result.stage_elapsed_ms>=3000&&result.stage_elapsed_ms<=5000);
    assert.deepEqual(Object.keys(result).sort(),["error_code","stage","stage_elapsed_ms"]);
    assert.doesNotMatch(JSON.stringify(result),/FAKE_SECRET|NEVER_LEAK|dashboard.gitguardian/);
  }finally{
    gate?.release();
    await f.flush();
    await f.close();
  }
});
