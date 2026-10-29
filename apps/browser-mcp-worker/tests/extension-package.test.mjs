import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync,cpSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
const repo=new URL("../../../",import.meta.url).pathname;
const builder=join(repo,"scripts/build-browser-extension.py");
test("one reproducible Chrome/Edge extension ZIP is source-bound and refuses tampering",()=>{
  const dir=mkdtempSync(join(tmpdir(),"browser418-zip-"));
  try{
    // Production packaging must fail while source remains deliberately unpinned.
    // Exercise reproducibility in a disposable source fixture, never by changing
    // the worktree service address or publishing an artifact.
    const fixture=join(dir,"source");
    mkdirSync(join(fixture,"scripts"),{recursive:true});
    mkdirSync(join(fixture,"apps/browser-mcp-worker/src"),{recursive:true});
    cpSync(builder,join(fixture,"scripts/build-browser-extension.py"));
    cpSync(join(repo,"scripts/browser-extension-manifest.json"),join(fixture,"scripts/browser-extension-manifest.json"));
    mkdirSync(join(fixture,"docs"),{recursive:true});
    cpSync(join(repo,"docs/browser-extension"),join(fixture,"docs/browser-extension"),{recursive:true});
    cpSync(join(repo,"apps/browser-mcp-worker/extension"),join(fixture,"apps/browser-mcp-worker/extension"),{recursive:true});
    cpSync(join(repo,"apps/browser-mcp-worker/package.json"),join(fixture,"apps/browser-mcp-worker/package.json"));
    cpSync(join(repo,"apps/browser-mcp-worker/src/coordinator.ts"),join(fixture,"apps/browser-mcp-worker/src/coordinator.ts"));
    const config=join(fixture,"apps/browser-mcp-worker/extension/config.js");
    writeFileSync(config,readFileSync(config,"utf8").replace("https://browser-mcp-worker.invalid","https://browser.lirtual.dpdns.org"));
    const invoke=(...argv)=>spawnSync("python3",[join(fixture,"scripts/build-browser-extension.py"),...argv],{
      encoding:"utf8",env:{...process.env,GIT_DIR:join(repo,".git"),GIT_WORK_TREE:repo}});
    const first=invoke("--out-dir",dir);
    assert.equal(first.status,0,first.stderr);
    const zip=join(dir,"browser-mcp-extension-v0.1.0.zip");
    const hash=()=>createHash("sha256").update(readFileSync(zip)).digest("hex");
    const before=hash();
    assert.equal(invoke("--out-dir",dir).status,0);
    assert.equal(hash(),before);
    assert.equal(invoke("--verify",zip).status,0);
    const metadata=JSON.parse(readFileSync(zip+".json","utf8"));
    assert.equal(metadata.sha256,before);
    assert.deepEqual(metadata.browsers,["Chrome","Edge"]);
    assert.equal(typeof metadata.source_dirty,"boolean");
    const original=readFileSync(zip);
    writeFileSync(zip,Buffer.concat([original,Buffer.from("tampered")]));
    assert.notEqual(invoke("--verify",zip).status,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
