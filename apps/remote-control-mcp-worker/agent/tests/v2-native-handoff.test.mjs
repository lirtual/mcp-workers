import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";

test("#914 Node-free Linux owner upgrade preserves or recovers service/CLI/receipts",()=>{
  if(process.platform!=="linux")return;
  const testFile=path.join(path.dirname(fileURLToPath(import.meta.url)),"native-handoff-contract.py");
  const result=spawnSync("/usr/bin/python3",["-I","-B",testFile],{
    encoding:"utf8",timeout:12000
  });
  assert.equal(result.status,0,result.stderr||String(result.error));
  assert.match(result.stdout,/ISOLATED_NATIVE_HANDOFF_CONTRACT_PASS/);
});
