import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import {renderV2Service} from "../scripts/install-v2.mjs";

test("#914 Node-free Linux owner upgrade preserves or recovers service/CLI/receipts",()=>{
  if(process.platform!=="linux")return;
  const testFile=path.join(path.dirname(fileURLToPath(import.meta.url)),"native-handoff-contract.py");
  const result=spawnSync("/usr/bin/python3",["-I","-B",testFile],{
    encoding:"utf8",timeout:12000
  });
  assert.equal(result.status,0,result.stderr||String(result.error));
  assert.match(result.stdout,/ISOLATED_NATIVE_HANDOFF_CONTRACT_PASS/);
});

test("#914 Python native and Node service templates match the existing JS installer",()=>{
  if(process.platform!=="linux")return;
  const testFile=path.join(path.dirname(fileURLToPath(import.meta.url)),"native-handoff-contract.py");
  const result=spawnSync("/usr/bin/python3",["-I","-B",testFile,"--units"],{
    encoding:"utf8",timeout:12000
  });
  assert.equal(result.status,0,result.stderr||String(result.error));
  const {home,old,new:next,key,endpoint,old_unit,new_unit}=JSON.parse(result.stdout);
  assert.equal(old_unit,renderV2Service({node:path.join(old,"bin/node"),home,
    repoRoot:old,keyPath:key,endpoint,entryExt:"js",agentRuntime:"node-v2"}));
  assert.equal(new_unit,renderV2Service({node:path.join(next,"bin/node"),home,
    repoRoot:next,keyPath:key,endpoint,entryExt:"js",agentRuntime:"rust-standard-linux-v1"}));
});
