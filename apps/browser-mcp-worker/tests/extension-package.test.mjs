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
    // Production build uses the reviewed pinned origin from source unchanged.
    // Reproduce the exact bytes in a disposable fixture without publishing.
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
    assert.match(readFileSync(config,"utf8"),/const BROWSER_MCP_SERVICE_ORIGIN = "https:\/\/browser\.lirtual\.dpdns\.org";/);
    const invoke=(...argv)=>spawnSync("python3",[join(fixture,"scripts/build-browser-extension.py"),...argv],{
      encoding:"utf8",env:{...process.env,GIT_DIR:join(repo,".git"),GIT_WORK_TREE:repo}});
    const first=invoke("--out-dir",dir);
    assert.equal(first.status,0,first.stderr);
    const zip=join(dir,"browser-mcp-extension-v0.2.2.zip");
    const hash=()=>createHash("sha256").update(readFileSync(zip)).digest("hex");
    const before=hash();
    assert.equal(invoke("--out-dir",dir).status,0);
    assert.equal(hash(),before);
    assert.equal(invoke("--verify",zip).status,0);
    const reviewedConfig=readFileSync(config,"utf8");
    writeFileSync(config,reviewedConfig.replace("https://browser.lirtual.dpdns.org","https://browser-mcp-worker.invalid"));
    assert.notEqual(invoke("--verify",zip).status,0,"wrong service origin must fail release verification");
    writeFileSync(config,reviewedConfig);
    const metadata=JSON.parse(readFileSync(zip+".json","utf8"));
    assert.equal(metadata.sha256,before);
    assert.deepEqual(metadata.browsers,["Chrome","Edge"]);
    assert.equal(typeof metadata.source_dirty,"boolean");
    // Changing the packaged guide must change the immutable URL even if the
    // Chrome manifest version stays exactly the same.
    const guide=join(fixture,"docs/browser-extension/INSTALL.md");
    const guideBefore=readFileSync(guide);
    writeFileSync(guide,Buffer.concat([guideBefore,Buffer.from("\nVersion-neutral update note.\n")]));
    assert.equal(invoke("--out-dir",dir).status,0);
    assert.notEqual(hash(),before,"packaged guide bytes must change content hash");
    assert.equal(JSON.parse(readFileSync(zip+".json","utf8")).version,"0.2.2");
    writeFileSync(guide,guideBefore);
    assert.equal(invoke("--out-dir",dir).status,0);
    assert.equal(hash(),before,"restoring exact guide bytes must restore ZIP hash");
    const original=readFileSync(zip);
    writeFileSync(zip,Buffer.concat([original,Buffer.from("tampered")]));
    assert.notEqual(invoke("--verify",zip).status,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
