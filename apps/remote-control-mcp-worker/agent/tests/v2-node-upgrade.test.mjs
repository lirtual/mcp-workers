import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  validateManualUpgrade,prepareManualUpgrade,activateManualUpgrade,resolveWorkerUpgradePin
} from "../scripts/upgrade-v2.mjs";
import { downloadSelectedReleaseAsset } from "../scripts/verify-v2-release.mjs";
import { renderLinuxLatestInstallShell } from "../../src/install-bootstrap.ts";
import { selectLatestAgentRelease } from "../../src/github-latest-agent-release.ts";
import { runInteractiveLocalManager } from "../scripts/manage-v2.mjs";

const APP="apps/remote-control-agent";
const ID="ea3b5d4f-e35c-4425-84d1-fa16d25e2efe";
const ENDPOINT="https://remote-control-v2-preview.aiyaya.workers.dev/";
const tag="v0.1.3",commit="a".repeat(40);
const TARGET=process.arch==="arm64"?"linux-arm64-glibc":"linux-x64-glibc";
const MAIN="const caps = {readOnly: true, writeFile: false, shell: false,};\n";
const FULL_MAIN='export const V2_RUNTIME_PROFILE = "paired-full-v1";\n';
function incompressibleSource(seed){
  const noise=Buffer.alloc(12000);
  for(let i=0;i<noise.length;i++)noise[i]=(i*31+seed)&255;
  return FULL_MAIN+"\nconst pad="+JSON.stringify(noise.toString("base64"))+";\n";
}
const manifest=()=>({name:"remote-control-agent",artifact_schema:1,
  version:tag,target:TARGET,node:"v24.21.0",glibc_min:"2.34",
  device_protocol:2,receipt_schema:1,upgrade_profile:"paired-full-v1"});
function elf(){
  const b=Buffer.alloc(72);b.writeUInt32LE(0x464c457f,0);
  b[4]=2;b[5]=1;b.writeUInt16LE(process.arch==="arm64"?183:62,18);return b;
}
function fixture({newSource=FULL_MAIN,releaseTag=tag,installedVersion="v0.1.2"}={}){
  const home=mkdtempSync(path.join(os.tmpdir(),"rca-upgrade-local-"));chmodSync(home,0o700);
  const programs=path.join(home,".local/share/mcp-workers/remote-control/programs");
  mkdirSync(programs,{recursive:true,mode:0o700});chmodSync(programs,0o700);
  const oldRoot=path.join(programs,installedVersion+"-"+TARGET);
  const oldSrc=path.join(oldRoot,APP,"src");
  mkdirSync(oldSrc,{recursive:true,mode:0o700});
  writeFileSync(path.join(oldSrc,"v2-main.js"),MAIN,{mode:0o600});
  const ids=path.join(home,".local/share/mcp-workers/remote-control/v2-identity.pem.device-id");
  writeFileSync(ids,ID,{mode:0o600});
  const receipt=path.join(home,".local/share/mcp-workers/remote-control/receipts.keep");
  writeFileSync(receipt,"PRESERVE_RECEIPT",{mode:0o600});
  const unit=[
    "# Managed by Remote Control Agent installer.",
    "[Service]",
    "Environment=REMOTE_CONTROL_AGENT_ENDPOINT="+ENDPOINT,
    "WorkingDirectory="+path.join(oldRoot,APP),
    "ExecStart="+path.join(oldRoot,"bin/node")+" "+path.join(oldRoot,APP,"src/v2-main.js"),
    "",
  ].join("\n");
  const state={root:oldRoot,versions:[path.basename(oldRoot)],unit,
    ids:{permanent:ID},info:{version:installedVersion,target:TARGET}};
  const packageDir=path.join(home,"archive-fixture");
  const filePaths=[
    ["bin/node",elf(),0o700],
    ["bundle.json",JSON.stringify({...manifest(),version:releaseTag}),0o600],
    [APP+"/package.json",'{"type":"module"}\n',0o600],
    [APP+"/.build/session-supervisor",elf(),0o700],
    [APP+"/scripts/bootstrap-node.mjs","export const safe=true;\n",0o600],
    [APP+"/scripts/manage-v2.mjs","export const safe=true;\n",0o600],
    [APP+"/scripts/lifecycle-v2.mjs","export const safe=true;\n",0o600],
    [APP+"/scripts/upgrade-v2.mjs","export const safe=true;\n",0o600],
    [APP+"/scripts/verify-v2-release.mjs","export const safe=true;\n",0o600],
    [APP+"/scripts/rca.sh","#!/bin/sh\n",0o700],
    [APP+"/scripts/install-v2.mjs","export const safe=true;\n",0o600],
    [APP+"/src/v2-main.js",newSource,0o600],
  ];
  mkdirSync(packageDir,{mode:0o700});
  for(const [name,content,mode] of filePaths){
    const full=path.join(packageDir,name);
    mkdirSync(path.dirname(full),{recursive:true,mode:0o700});
    writeFileSync(full,content,{mode});chmodSync(full,mode);
  }
  const tar=spawnSync("tar",[
    "--format=ustar","--owner=0","--group=0","--numeric-owner",
    "--mode=u+rwX,go-rwx","-czf","-","bin","apps","bundle.json"
  ],{cwd:packageDir,timeout:10000,maxBuffer:1024*1024});
  assert.equal(tar.status,0,tar.stderr.toString());
  const archive=tar.stdout;
  const digest=createHash("sha256").update(archive).digest("hex");
  const release=Object.freeze({tag:releaseTag,commit,target:TARGET,digest});
  return {home,programs,oldRoot,state,ids,receipt,archive,digest,release};
}
const cleanup=f=>rmSync(f.home,{recursive:true,force:true});

test("retrying rca upgrade recovers an interrupted unit before inventory and release validation",async()=>{
  const calls=[];
  const home="/tmp/rca-recovery-order-test";
  const stdout={isTTY:true,write:()=>{}};
  const stdin={isTTY:true};
  const state={unit:"owned-unit",root:"old-root",info:{version:"v0.1.2"},ids:{permanent:ID}};
  const prepared={version:tag,program:"new-root"};
  const result=await runInteractiveLocalManager(["upgrade",tag,commit],{
    home,stdin,stdout,
    recoverInterruptedUpgrade:async options=>{calls.push("recover");assert.equal(options.home,home);},
    inventory:()=>{calls.push("inventory");return state;},
    prepareUpgrade:async()=>{calls.push("prepare");return prepared;},
    activateUpgrade:()=>{calls.push("activate");return prepared;},
  });
  assert.equal(result,0);
  assert.deepEqual(calls,["recover","inventory","prepare","activate"]);
});

test("preflight accepts explicit newer release and unchanged Worker endpoint",()=>{
  const f=fixture();
  try{
    const p=validateManualUpgrade(f.state,{home:f.home,tag,commit});
    assert.equal(p.targetDir,path.join(f.programs,tag+"-"+TARGET));
    assert.equal(p.endpoint,ENDPOINT);
    assert.equal(readFileSync(f.ids,"utf8"),ID);
  }finally{cleanup(f);}
});
test("preflight rejects downgrades, unreviewed release and Shell-enabled old agent",()=>{
  const f=fixture();
  try{
    for(const [t,c] of [["v0.1.2",commit],["v0.1.0",commit],["v0.1.3","z".repeat(40)],["latest",commit]]){
      assert.throws(()=>validateManualUpgrade(f.state,{home:f.home,tag:t,commit:c}));
    }
    writeFileSync(path.join(f.oldRoot,APP,"src/v2-main.js"),
      "const c={readOnly: true, writeFile: false, shell: true,};\n");
    assert.throws(()=>validateManualUpgrade(f.state,{home:f.home,tag,commit}),/mutable or Shell/);
  }finally{cleanup(f);}
});
test("verified immutable release stage is private, preserves old identity and receipts",async()=>{
  const f=fixture();
  try{
    const result=await prepareManualUpgrade(f.state,{tag,commit},{
      home:f.home,resolve:async()=>f.release,download:async()=>f.archive
    });
    assert.equal(result.program,path.join(f.programs,tag+"-"+TARGET));
    assert.equal(readFileSync(f.ids,"utf8"),ID);
    assert.equal(readFileSync(f.receipt,"utf8"),"PRESERVE_RECEIPT");
    assert.equal(readFileSync(path.join(f.oldRoot,APP,"src/v2-main.js"),"utf8"),MAIN);
    const calls=[];
    const activation=activateManualUpgrade(result,{invoke:(bin,args,options)=>{
      calls.push({bin,args,options});return {status:0};
    }});
    assert.equal(activation.version,tag);
    assert.equal(calls[0].bin,path.join(result.program,"bin/node"));
    assert.deepEqual(calls[0].args,[
      path.join(result.program,APP,"scripts/install-v2.mjs"),
      "--upgrade","--endpoint",ENDPOINT
    ]);
    assert.equal(calls[0].options.env.RC_AGENT_NO_POST_START,"1");
    assert.equal(readFileSync(f.receipt,"utf8"),"PRESERVE_RECEIPT");
  }finally{cleanup(f);}
});
test("wrong Release mapping or digest cannot create a new staged version",async()=>{
  const f=fixture();
  try{
    const versions=()=>readFileSync(f.receipt,"utf8");
    await assert.rejects(prepareManualUpgrade(f.state,{tag,commit},{
      home:f.home,resolve:async()=>({...f.release,commit:"b".repeat(40)}),
      download:async()=>f.archive
    }),/Release pin mismatch/);
    await assert.rejects(prepareManualUpgrade(f.state,{tag,commit},{
      home:f.home,resolve:async()=>({...f.release,digest:"0".repeat(64)}),
      download:async()=>f.archive
    }),/SHA mismatch/);
    assert.equal(versions(),"PRESERVE_RECEIPT");
    assert.equal(readFileSync(f.ids,"utf8"),ID);
  }finally{cleanup(f);}
});
test("new mutable agent is refused before any activation",async()=>{
  const f=fixture({newSource:"const c={readOnly: true, writeFile: false, shell: true,};\n"});
  try{
    await assert.rejects(prepareManualUpgrade(f.state,{tag,commit},{
      home:f.home,resolve:async()=>f.release,download:async()=>f.archive
    }),/Unproven paired full-tools/);
    assert.equal(readFileSync(f.ids,"utf8"),ID);
  }finally{cleanup(f);}
});
test("service activation rejection propagates without touching keys or receipt",async()=>{
  const f=fixture();
  try{
    const result=await prepareManualUpgrade(f.state,{tag,commit},{
      home:f.home,resolve:async()=>f.release,download:async()=>f.archive
    });
    assert.throws(()=>activateManualUpgrade(result,{invoke:()=>({status:1})}),
      /upgrade failed/);
    assert.equal(readFileSync(f.ids,"utf8"),ID);
    assert.equal(readFileSync(f.receipt,"utf8"),"PRESERVE_RECEIPT");
  }finally{cleanup(f);}
});


function workerInstallFixture(endpoint=ENDPOINT){
  const asset=(target,ext,sha,size,id)=>({
    target,id,name:"remote-control-agent-"+tag+"-"+target+ext,size,sha256:sha,
    downloadUrl:"https://github.com/lirtual/mcp-workers/releases/download/"+tag+
      "/remote-control-agent-"+tag+"-"+target+ext,
  });
  return renderLinuxLatestInstallShell(endpoint.slice(0,-1),{
    repository:"lirtual/mcp-workers",id:5,tag,immutable:true,
    assets:{
      "linux-x64-glibc":asset("linux-x64-glibc",".tar.gz","a".repeat(64),1111,1),
      "linux-arm64-glibc":asset("linux-arm64-glibc",".tar.gz","b".repeat(64),2222,2),
      "windows-x64":asset("windows-x64",".zip","c".repeat(64),3333,3),
      "darwin-arm64":asset("darwin-arm64",".tar.gz","d".repeat(64),4444,4),
      "darwin-x64":asset("darwin-x64",".tar.gz","e".repeat(64),5555,5),
    },
  });
}
const mockWorkerResponse=(url,body,status=200)=>({
  ok:status===200,status,url,headers:new Headers(),
  text:async()=>body,
});
test("rca upgrade discovers only bound Worker immutable pin without executing fetched script",async()=>{
  let fetched;
  const pin=await resolveWorkerUpgradePin(ENDPOINT,{request:async(url,opts)=>{
    fetched={url,opts};
    return mockWorkerResponse(url,workerInstallFixture());
  }});
  assert.equal(pin.tag,tag);
  assert.equal(pin.commit,undefined);
  assert.equal(pin.x64.sha256,"a".repeat(64));
  assert.equal(pin.x64.size,1111);
  assert.equal(pin.arm64.sha256,"b".repeat(64));
  assert.equal(pin.x64.url,"https://github.com/lirtual/mcp-workers/releases/download/"+tag+"/remote-control-agent-"+tag+"-linux-x64-glibc.tar.gz");
  assert.equal(fetched.url,ENDPOINT+"install.sh");
  assert.equal(fetched.opts.redirect,"error");
});
test("reviewed pin discovery fails closed on wrong endpoint, redirects and ambiguous content",async()=>{
  const source=workerInstallFixture();
  const request=async(url)=>mockWorkerResponse(url,source);
  await assert.rejects(resolveWorkerUpgradePin("http://evil.example/",{request}),/Untrusted/);
  await assert.rejects(resolveWorkerUpgradePin(ENDPOINT,{request:async(url)=>
    mockWorkerResponse("https://other.example/install.sh",source)}),/unavailable/);
  await assert.rejects(resolveWorkerUpgradePin(ENDPOINT,{request:async(url)=>
    mockWorkerResponse(url,source+source)}),/unambiguous/);
  await assert.rejects(resolveWorkerUpgradePin(ENDPOINT,{request:async(url)=>
    mockWorkerResponse(url,source.replace("sha256sum -c -","skip-check"))}),/Unrecognized/);
  await assert.rejects(resolveWorkerUpgradePin(ENDPOINT,{request:async(url)=>
    mockWorkerResponse(url,source.replace(ENDPOINT,"https://other.example/"))}),/unambiguous/);
});
test("rca upgrade with no tag or commit uses reviewed Worker release, preserving recovery order",async()=>{
  const calls=[];
  const state={unit:"# Managed by Remote Control Agent installer.\nEnvironment=REMOTE_CONTROL_AGENT_ENDPOINT="+ENDPOINT+"\n",
    root:"old-root",info:{version:"v0.1.2"},ids:{permanent:ID}};
  const prepared={version:tag,program:"new-root"};
  const rc=await runInteractiveLocalManager(["upgrade"],{
    home:"/tmp/rca-zero-arg-test",stdin:{isTTY:true},stdout:{isTTY:true,write:()=>{}},
    recoverInterruptedUpgrade:async()=>{calls.push("recover");},
    inventory:()=>{calls.push("inventory");return state;},
    resolveWorkerPin:async(endpoint)=>{calls.push("pin");assert.equal(endpoint,ENDPOINT);return {tag,commit};},
    prepareUpgrade:async(_,pin)=>{calls.push("prepare");assert.deepEqual(pin,{tag,commit});return prepared;},
    activateUpgrade:()=>{calls.push("activate");return prepared;},
  });
  assert.equal(rc,0);
  assert.deepEqual(calls,["recover","inventory","pin","prepare","activate"]);
});

test("rca upgrade is idempotent if bound Worker already pins installed release",async()=>{
  const calls=[];
  let output="";
  const unit="# Managed by Remote Control Agent installer.\n"+
    "Environment=REMOTE_CONTROL_AGENT_ENDPOINT="+ENDPOINT+"\n";
  const result=await runInteractiveLocalManager(["upgrade"],{
    home:"/tmp/rca-up-to-date-test",stdin:{isTTY:true},
    stdout:{isTTY:true,write:x=>{output+=x;}},
    recoverInterruptedUpgrade:async()=>{calls.push("recover");},
    inventory:()=>({unit,root:"old-root",info:{version:tag},ids:{permanent:ID}}),
    resolveWorkerPin:async()=>({tag,commit}),
    prepareUpgrade:async()=>{calls.push("download");throw Error("must not download");},
    activateUpgrade:()=>{calls.push("activate");throw Error("must not activate");},
  });
  assert.equal(result,0);
  assert.deepEqual(calls,["recover"]);
  assert.match(output,/Already up to date/);
});

function latestBody(releaseTag,target,digest,size){
  const specs=[
    ["linux-x64-glibc",".tar.gz"],
    ["linux-arm64-glibc",".tar.gz"],
    ["windows-x64",".zip"],
    ["darwin-arm64",".tar.gz"],
    ["darwin-x64",".tar.gz"],
  ];
  return {
    id:80,tag_name:releaseTag,draft:false,prerelease:false,immutable:true,
    assets:specs.map(([name,ext],index)=>{
      const file="remote-control-agent-"+releaseTag+"-"+name+ext;
      const selected=name===target;
      return {
        id:81+index,name:file,state:"uploaded",
        size:selected?size:2048,
        digest:"sha256:"+(selected?digest:String(index+1).repeat(64)),
        browser_download_url:"https://github.com/lirtual/mcp-workers/releases/download/"+releaseTag+"/"+file,
      };
    }),
  };
}
function assetUrl(releaseTag){
  return "https://github.com/lirtual/mcp-workers/releases/download/"+releaseTag+
    "/remote-control-agent-"+releaseTag+"-"+TARGET+".tar.gz";
}
function preserved(home){
  const root=path.join(home,".local/share/mcp-workers/remote-control");
  return {
    id:readFileSync(path.join(root,"v2-identity.pem.device-id")),
    receipt:readFileSync(path.join(root,"operation-receipts.sqlite")),
    stop:readFileSync(path.join(root,"owner-stopped"),"utf8"),
  };
}

test("an installed v0.1.51 layout upgrades from one latest asset without a commit pin",async()=>{
  const releaseTag="v0.1.52";
  const f=fixture({releaseTag,installedVersion:"v0.1.51",newSource:incompressibleSource(7)});
  assert.ok(f.archive.length>=1024);
  const unknown=Buffer.from("SQLite format 3\0status=unknown\n");
  const stateDir=path.join(f.home,".local/share/mcp-workers/remote-control");
  writeFileSync(path.join(f.oldRoot,APP,"src/v2-main.js"),FULL_MAIN,{mode:0o600});
  chmodSync(path.join(f.oldRoot,APP,"src/v2-main.js"),0o600);
  writeFileSync(path.join(stateDir,"operation-receipts.sqlite"),unknown,{mode:0o600});
  writeFileSync(path.join(stateDir,"owner-stopped"),"stopped\n",{mode:0o600});
  const before=preserved(f.home);
  try{
    let lookups=0;
    const selected=await selectLatestAgentRelease({fetch:async(url,init)=>{
      lookups+=1;
      assert.equal(String(url),"https://api.github.com/repos/lirtual/mcp-workers/releases/latest");
      assert.equal(init?.redirect,"manual");
      return new Response(JSON.stringify(latestBody(releaseTag,TARGET,f.digest,f.archive.length)),{status:200});
    }});
    assert.equal(lookups,1);
    const shell=renderLinuxLatestInstallShell(ENDPOINT.slice(0,-1),selected);
    const pin=await resolveWorkerUpgradePin(ENDPOINT,{request:async()=>mockWorkerResponse(ENDPOINT+"install.sh",shell)});
    assert.equal(pin.tag,releaseTag);
    assert.equal(pin.commit,undefined);
    assert.equal(pin[TARGET==="linux-arm64-glibc"?"arm64":"x64"].url,assetUrl(releaseTag));
    assert.throws(()=>validateManualUpgrade(f.state,{home:f.home,tag:"v0.1.51",
      url:assetUrl("v0.1.51"),sha256:f.digest,size:f.archive.length}),/same-version|downgrade|stable/);
    assert.throws(()=>validateManualUpgrade(f.state,{home:f.home,tag:"v0.1.50",
      url:assetUrl("v0.1.50"),sha256:f.digest,size:f.archive.length}),/downgrade|stable/);
    let downloads=0;
    const result=await prepareManualUpgrade(f.state,pin,{
      home:f.home,
      downloadAsset:async(asset)=>{
        downloads+=1;
        assert.equal(asset.url,assetUrl(releaseTag));
        assert.equal(asset.url.includes("/lirtual/remote-control-agent/"),false);
        assert.equal(asset.digest,f.digest);
        assert.equal(asset.bytes,f.archive.length);
        return f.archive;
      },
      resolve:async()=>{throw Error("old repository pin must not be resolved");},
    });
    assert.equal(downloads,1);
    assert.equal(lookups,1);
    assert.equal(result.program,path.join(f.programs,releaseTag+"-"+TARGET));
    assert.equal(readFileSync(path.join(f.oldRoot,APP,"src/v2-main.js"),"utf8"),FULL_MAIN);
    assert.deepEqual(preserved(f.home),before);
    assert.ok(readFileSync(path.join(f.programs,releaseTag+"-"+TARGET,"bundle.json"),"utf8").includes(releaseTag));
  }finally{cleanup(f);}
});

test("a refused latest asset does not change an installed v0.1.51 identity, receipt, or program",async()=>{
  const releaseTag="v0.1.52";
  const f=fixture({releaseTag,installedVersion:"v0.1.51",newSource:incompressibleSource(9)});
  assert.ok(f.archive.length>=1024);
  const stateDir=path.join(f.home,".local/share/mcp-workers/remote-control");
  writeFileSync(path.join(stateDir,"operation-receipts.sqlite"),Buffer.from("SQLite format 3\0status=unknown\n"),{mode:0o600});
  writeFileSync(path.join(stateDir,"owner-stopped"),"stopped\n",{mode:0o600});
  const before=preserved(f.home);
  const programsBefore=readFileSync(path.join(f.oldRoot,APP,"src/v2-main.js"));
  try{
    let calls=0;
    await assert.rejects(prepareManualUpgrade(f.state,{
      tag:releaseTag,url:assetUrl(releaseTag),sha256:f.digest,size:f.archive.length,
    },{
      home:f.home,
      downloadAsset:(asset)=>downloadSelectedReleaseAsset(asset,async()=>{
        calls+=1;
        return new Response("no",{status:429,headers:{"retry-after":"8"}});
      }),
      resolve:async()=>{throw Error("old repository fallback");},
    }),/rate limit/);
    assert.equal(calls,1);
    const payload=Buffer.alloc(2048);
    for(let i=0;i<payload.length;i++)payload[i]=(i*17+3)&255;
    const header=Buffer.alloc(512);
    header.write("../etc/passwd",0,"ascii");
    header.write(payload.length.toString(8).padStart(11,"0")+"\0",124);
    header.write("        ",148);
    header[156]=48;
    header.write("ustar\0",257);
    header.write("00",263);
    let sum=0; for(const byte of header)sum+=byte;
    header.write(sum.toString(8).padStart(6,"0")+"\0 ",148);
    const body=Buffer.alloc(Math.ceil(payload.length/512)*512);
    payload.copy(body);
    const hostile=gzipSync(Buffer.concat([header,body,Buffer.alloc(1024)]),{level:0});
    assert.ok(hostile.length>=1024);
    calls=0;
    await assert.rejects(prepareManualUpgrade(f.state,{
      tag:releaseTag,url:assetUrl(releaseTag),
      sha256:createHash("sha256").update(hostile).digest("hex"),size:hostile.length,
    },{
      home:f.home,
      downloadAsset:async()=>{calls+=1;return hostile;},
      resolve:async()=>{throw Error("old repository fallback");},
    }),/Unsafe tar path/);
    assert.equal(calls,1);
    assert.deepEqual(readdirSync(f.programs),[ "v0.1.51-"+TARGET ]);
    assert.deepEqual(readFileSync(path.join(f.oldRoot,APP,"src/v2-main.js")),programsBefore);
    assert.deepEqual(preserved(f.home),before);
  }finally{cleanup(f);}
});

test("selected Release download stops on refusal, rate limit, and a hostile redirect",async()=>{
  const asset={
    url:assetUrl("v0.1.52"),
    bytes:2048,
    digest:"ab".repeat(32),
  };
  for(const [status,message] of [[403,/refused/],[429,/rate limit/]]){
    let calls=0;
    await assert.rejects(downloadSelectedReleaseAsset(asset,async()=>{
      calls+=1;
      return new Response("no",{status,headers:{"retry-after":"9"}});
    }),message);
    assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(downloadSelectedReleaseAsset(asset,async()=>{
    calls+=1;
    return new Response(null,{status:302,headers:{
      location:"https://github.com/lirtual/remote-control-agent/releases/download/v0.1.51/remote-control-agent-v0.1.51-linux-x64-glibc.tar.gz",
    }});
  }),/redirected outside/);
  assert.equal(calls,1);
  await assert.rejects(downloadSelectedReleaseAsset({
    ...asset,
    url:"https://github.com/lirtual/remote-control-agent/releases/download/v0.1.51/remote-control-agent-v0.1.51-linux-x64-glibc.tar.gz",
  },async()=>{throw Error("old repository was fetched");}),/Untrusted/);
  const payload=Buffer.alloc(2048,3);
  const digest=createHash("sha256").update(payload).digest("hex");
  calls=0;
  await assert.rejects(downloadSelectedReleaseAsset({...asset,digest,bytes:2048},async()=>{
    calls+=1;
    return new Response(payload.subarray(0,100));
  }),/Incomplete/);
  assert.equal(calls,1);
  calls=0;
  const bytes=await downloadSelectedReleaseAsset({...asset,digest,bytes:2048},async(url)=>{
    calls+=1;
    if(calls===1){
      assert.equal(new URL(String(url)).hostname,"github.com");
      return new Response(null,{status:302,headers:{location:"https://objects.githubusercontent.com/github-production-release-asset"}});
    }
    return new Response(payload);
  });
  assert.equal(calls,2);
  assert.equal(bytes.length,2048);
});
