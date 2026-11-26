import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const home=await mkdtemp(path.join(os.tmpdir(),"rc-cli-lab-"));
  const programs=path.join(home,".local/share/mcp-workers/remote-control/programs");
  const program=path.join(programs,"v0.1.1-linux-x64-glibc");
  const script=path.join(program,"apps/remote-control-agent/scripts");
  await mkdir(script,{recursive:true,mode:0o700});
  await writeFile(path.join(script,"manage-v2.py"),"#!/usr/bin/env python3\n",{mode:0o700});
  await chmod(path.join(script,"manage-v2.py"),0o700);
  await writeFile(path.join(script,"rca.sh"),"#!/bin/sh\nexit 0\n",{mode:0o700});
  await chmod(path.join(script,"rca.sh"),0o700);
  await writeFile(path.join(home,".bashrc"),"# existing commands\n",{mode:0o600});
  return {home,program,script};
}

test("#914 Linux Rust local status uses the bounded Python manager, not bundled Node",async t=>{
  if(process.platform!=="linux") { t.skip("Linux-only local manager"); return; }
  const f=await fixture();
  try{
    const src=path.join(packageRoot,"scripts");
    const rustDir=path.join(f.program,"apps/remote-control-agent/.build");
    await mkdir(rustDir,{recursive:true,mode:0o700});
    await writeFile(path.join(rustDir,"rca-standard-linux-candidate"),"fixture", {mode:0o700});
    await chmod(path.join(rustDir,"rca-standard-linux-candidate"),0o700);
    await writeFile(path.join(rustDir,"session-supervisor"),"fixture",{mode:0o700});
    await writeFile(path.join(f.program,"bundle.json"),JSON.stringify({
      name:"remote-control-agent",version:"v0.1.1",target:"linux-x64-glibc",
      artifact_schema:1,device_protocol:2,receipt_schema:1,
      upgrade_profile:"paired-full-v1",agent_runtime:"rust-standard-linux-v1",
      candidate_profile:"standard-linux-rust-runtime-v1",artifact_profile:"rust-native-only-v1",modules:[]
    })+"\n",{mode:0o600});
    for(const name of ["manage-v2.py","bootstrap-v2.py","rca.sh"])
      await writeFile(path.join(f.script,name),await readFile(path.join(src,name)),
        {mode:name==="rca.sh" ? 0o700 : 0o600});
    const env={...process.env,HOME:f.home};
    const command=path.join(f.script,"rca.sh");
    const run=args=>spawnSync("/bin/sh",[command,...args],
      {encoding:"utf8",env,timeout:10000});
    const result=run(["status"]);
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/"cli_version": "v0.1.1"/);
    assert.match(result.stdout,/"local_permanent_service": "not_installed"/);
    const structured=run(["status","--json"]);
    assert.equal(structured.status,0,structured.stderr);
    const state=JSON.parse(structured.stdout);
    assert.equal(state.cli_version,"v0.1.1");
    assert.equal(state.local_permanent_service,"not_installed");
    assert.equal(state.cloud_authorization,"unconfirmed");
    assert.equal(state.platform,"linux");
    assert.equal(state.arch,"x64");
    assert.equal(state.installed_version,null);
    assert.equal(state.local_service,"not_installed");
    assert.equal(state.identity_present,false);
    assert.equal(state.device_id,null);
    const diagnosis=run(["doctor","--json"]);
    assert.equal(diagnosis.status,0,diagnosis.stderr);
    const checked=JSON.parse(diagnosis.stdout);
    assert.deepEqual(checked.status,state);
    assert.ok(checked.findings.includes("permanent_service_not_installed"));
    assert.ok(checked.findings.includes("cloud_authorization_unconfirmed"));
    assert.notEqual(run(["status","--json","extra"]).status,0);
    assert.notEqual(run(["doctor","--repair"]).status,0);
    await assert.rejects(lstat(path.join(f.home,".config")),{code:"ENOENT"});
    const help=run(["--help"]);
    assert.equal(help.status,0,help.stderr);
    assert.match(help.stdout,/status\|doctor/);
    assert.match(help.stdout,/--version\|--help/);
    assert.match(help.stdout,/browser authorization link/);
    assert.match(help.stdout,/provide the approved HTTPS origin explicitly/);
    // Verify the shipped shell/Python entry, not just the native binary.
    // The native fixture records only the public request ID and its own argv;
    // Rust's real noninteractive and PTY tests own input/identity validation.
    const requestId="123e4567-e89b-42d3-a456-426614174001";
    const native=path.join(rustDir,"rca-standard-linux-candidate");
    await writeFile(native,"#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 23\n",{mode:0o700});
    const secure=run(["secure-input",requestId]);
    assert.equal(secure.status,23,secure.stderr);
    assert.equal(secure.stdout,"--cli\nsecure-input\n"+requestId+"\n");
    for(const args of [["secure-input"],["secure-input",requestId,"extra"]]){
      const rejected=run(args);
      assert.notEqual(rejected.status,0);
      assert.notEqual(rejected.status,23,"invalid arity must not launch Rust");
    }
    assert.match(help.stdout,/secure-input REQUEST_ID/);
    for(const args of [["--version","extra"],["--help","extra"]])
      assert.notEqual(run(args).status,0);
    const version=run(["--version"]);
    assert.equal(version.status,0,version.stderr);
    assert.equal(version.stdout.trim(),"v0.1.1");
    await assert.rejects(lstat(path.join(f.program,"bin/node")),{code:"ENOENT"});
    await assert.rejects(lstat(path.join(f.script,"__pycache__")),{code:"ENOENT"});
    // Direct Python invocations must never gain an alternate lifecycle entry.
    const python=args=>spawnSync("/usr/bin/python3",
      ["-I","-B",path.join(f.script,"manage-v2.py"),...args],
      {encoding:"utf8",env,timeout:10000});
    for(const args of [[],["pair"],["upgrade"],["update"],["update","--check"],["uninstall"]])
      assert.notEqual(python(args).status,0,"Rust Python manager must reject "+args.join(" "));
    await assert.rejects(
      lstat(path.join(f.home,".local/share/mcp-workers/remote-control/v2-identity.pem")),
      {code:"ENOENT"});

    // A stray Rust executable must not persuade the Python manager to accept
    // a Node manifest as a Rust-owned full-tools installation.
    await writeFile(path.join(f.program,"bundle.json"),JSON.stringify({
      version:"v0.1.1",target:"linux-x64-glibc",artifact_schema:1,
      device_protocol:2,receipt_schema:1,agent_runtime:"node-v2",
      upgrade_profile:"paired-full-v1"
    })+"\n",{mode:0o600});
    assert.notEqual(run(["status"]).status,0);
  } finally { await rm(f.home,{recursive:true,force:true}); }
});
