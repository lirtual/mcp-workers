import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { handleAgentInstallerRequest, renderAgentInstallShell, REVIEWED_V012_RELEASE_PIN, REVIEWED_V014_RELEASE_PIN, REVIEWED_V016_RELEASE_PIN } from "../src/install-bootstrap.ts";

const origin = "https://remote-control-v2-preview.aiyaya.workers.dev";
const pin = Object.freeze({
  tag:"v0.1.4", commit:"a".repeat(40), pairingProtocol:"single-code-v1" as const,
  x64Sha256:"b".repeat(64), arm64Sha256:"c".repeat(64),
});

test("reviewed immutable single-code Worker installation route is enabled", async()=>{
  const response=handleAgentInstallerRequest(new Request(origin+"/install.sh"));
  assert.equal(response.status,200);
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(REVIEWED_V016_RELEASE_PIN.commit,"db1194ee151d93b68d0b21b6f0c19ac8b64ac065");
  const script=await response.text();
  assert.match(script,/remote-control-agent-v0\.1\.6/);
  assert.match(script,/328b0407c71713f3/);
  assert.match(script,/66d53cf06b35ea94/);
  assert.match(script,/1\) \[ "\$1" = "--upgrade"/);
});

test("historical two-code v0.1.2 cannot be served by single-code Worker even when explicitly passed",async()=>{
  const reviewed=REVIEWED_V012_RELEASE_PIN;
  assert.equal(reviewed.tag,"v0.1.2");
  assert.equal(reviewed.commit,"00aaf200107e42a1b7cede3db51f9a16edea5b09");
  assert.equal(reviewed.x64Sha256,"b895f8133a03a53f4eacbf4fa6d0619f59ad722064c5e2e8ca469f9fc637221a");
  assert.equal(reviewed.arm64Sha256,"ec16343f50b20b762b04a06039164c0f3a7f42bdeb597ab8e04ecc4b3e40724c");
  const nowEnabled=handleAgentInstallerRequest(new Request(origin+"/install.sh"));
  assert.equal(nowEnabled.status,200);
  assert.equal(reviewed.pairingProtocol,"two-code-v1");
  const incompatible=handleAgentInstallerRequest(new Request(origin+"/install.sh"),reviewed);
  assert.equal(incompatible.status,503);
  assert.doesNotMatch(await incompatible.text(),/#!/);
  assert.throws(()=>renderAgentInstallShell(origin,reviewed),/Unapproved/);
});

test("future reviewed route binds its own validated origin and pins both ABIs", async()=>{
  const response=handleAgentInstallerRequest(new Request(origin+"/install.sh"),pin);
  assert.equal(response.status,200);
  assert.match(response.headers.get("content-type")??"",/text\/x-shellscript/);
  const shell=await response.text();
  assert.match(shell,/--endpoint "https:\/\/remote-control-v2-preview.aiyaya.workers.dev\/"/);
  assert.match(shell,/^#!\/bin\/sh/);
  assert.match(shell,/--sha256/);
  assert.match(shell,/sha256sum -c/);
  assert.match(shell,/bootstrap-node.mjs/);
  assert.match(shell,/for tool in curl sha256sum tar mktemp uname id chmod flock rm readlink dirname/);
  assert.match(shell,/unset NODE_OPTIONS NODE_PATH/);
  assert.doesNotMatch(shell,/python3|pip install|REMOTE_CONTROL_AGENT_ENDPOINT/);
  assert.ok(shell.indexOf("sha256sum -c")<shell.indexOf("tar -xOzf"));
  assert.match(shell,/effective=\$\(curl[\s\S]*-w '%\{url_effective\}'/);
  assert.match(shell,/case "\$effective" in/);
  assert.match(shell,/https:\/\/release-assets\.githubusercontent\.com\/\*/);
  assert.match(shell,/https:\/\/objects\.githubusercontent\.com\/\*/);
  assert.match(shell,/Unexpected GitHub Release asset redirect/);
  assert.ok(shell.indexOf('case "$effective" in')<shell.indexOf("sha256sum -c"));
  const syntax=spawnSync("sh",["-n"],{input:shell,encoding:"utf8",timeout:3000});
  assert.equal(syntax.status,0,syntax.stderr);
});

test("migration flag is fail-closed on the published v0.1.4 pin and opt-in for a future reviewed release",()=>{
  const current=renderAgentInstallShell(origin,REVIEWED_V014_RELEASE_PIN);
  assert.doesNotMatch(current,/1\) \[ "\$1" = "--upgrade"/);
  assert.match(current,/Unsupported installer action/);
  assert.match(current,/"\$@" < \/dev\/tty/);
  const future=renderAgentInstallShell(origin,REVIEWED_V016_RELEASE_PIN);
  assert.match(future,/1\) \[ "\$1" = "--upgrade"/);
  assert.match(future,/"\$@" < \/dev\/tty/);
  const syntax=spawnSync("sh",["-n"],{input:future,encoding:"utf8"});
  assert.equal(syntax.status,0,syntax.stderr);
  assert.throws(()=>renderAgentInstallShell(origin,{...pin,upgradeMode:"bogus" as never}),/Unapproved/);
});

test("fake Host, Forwarded, scheme, path, query and method are refused",async()=>{
  const bad=[
    new Request("http://remote-control-v2-preview.aiyaya.workers.dev/install.sh"),
    new Request("https://evil.example/install.sh"),
    new Request(origin+"/install.sh?endpoint=https://evil.example"),
    new Request(origin+"/INSTALL.SH"),
    new Request(origin+"/install.sh",{method:"POST"}),
    new Request(origin+"/install.sh",{headers:{"host":"evil.example"}}),
    new Request(origin+"/install.sh",{headers:{"x-forwarded-host":"evil.example"}}),
    new Request(origin+"/install.sh",{headers:{"forwarded":"host=evil.example"}}),
    new Request(origin+"/install.sh",{headers:{"origin":"https://evil.example"}}),
  ];
  for(const request of bad){
    const response=handleAgentInstallerRequest(request,pin);
    assert.notEqual(response.status,200,request.url);
    assert.doesNotMatch(await response.text(),/#!/);
  }
});

test("untrusted pinned release metadata cannot interpolate shell commands",async()=>{
  const bad=[
    {...pin,tag:"v0.1.2; touch /tmp/unsafe"},
    {...pin,commit:"$(id)"},
    {...pin,x64Sha256:"x".repeat(64)},
    {...pin,arm64Sha256:"a".repeat(63)},
  ];
  for(const candidate of bad){
    assert.throws(()=>renderAgentInstallShell(origin,candidate),/Unapproved/);
  }
  assert.throws(()=>renderAgentInstallShell("https://unknown.example",pin),/Unapproved/);
});
