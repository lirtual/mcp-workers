import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { handleAgentInstallerRequest, renderAgentInstallShell, REVIEWED_V012_RELEASE_PIN, REVIEWED_V014_RELEASE_PIN, REVIEWED_V016_RELEASE_PIN, REVIEWED_V017_RELEASE_PIN, REVIEWED_V018_RELEASE_PIN, REVIEWED_V0110_RELEASE_PIN, REVIEWED_V0111_RELEASE_PIN, REVIEWED_V0112_RELEASE_PIN } from "../src/install-bootstrap.ts";

const origin = "https://remote-control-v2-preview.aiyaya.workers.dev";
function requestInstall(request: Request, release?: Parameters<typeof handleAgentInstallerRequest>[1],
  configuredOrigin: string | undefined = origin) {
  return handleAgentInstallerRequest(request, release, configuredOrigin);
}
const pin = Object.freeze({
  tag:"v0.1.4", commit:"a".repeat(40), pairingProtocol:"single-code-v1" as const,
  x64Sha256:"b".repeat(64), arm64Sha256:"c".repeat(64),
});

test("reviewed immutable single-code Worker installation route is enabled", async()=>{
  const response=requestInstall(new Request(origin+"/install.sh"));
  assert.equal(response.status,200);
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(REVIEWED_V018_RELEASE_PIN.commit,"4d58ffe33e560d6f5f1c375aacf02a774b51a6c0");
  const script=await response.text();
  assert.equal(REVIEWED_V0110_RELEASE_PIN.commit,"8b78294a2fbff18a53d6e3ce0a13e6992ea63478");
  assert.equal(REVIEWED_V0110_RELEASE_PIN.x64Sha256,"ad995f987c6f2cc428baadae92a330fe43ef5f0d52652e1fe582e332b9e26ba9");
  assert.equal(REVIEWED_V0110_RELEASE_PIN.arm64Sha256,"bdb52cb83d0186127fc0ea65248d97701fe6cbc2d0d1ac9984b9e8eedf9a7397");
  assert.equal(REVIEWED_V0111_RELEASE_PIN.tag, "v0.1.11");
  assert.equal(REVIEWED_V0111_RELEASE_PIN.commit, "c558ac6a9f2ecc0129234790bf4f3b3a3a4aa191");
  assert.equal(REVIEWED_V0111_RELEASE_PIN.x64Sha256, "641efcefe08d8bd4a70a1b3511d498d48a21687f05f167122219262bda9db6ec");
  assert.equal(REVIEWED_V0111_RELEASE_PIN.arm64Sha256, "45d17c77c8fe37f7838f8015ad14518412161552e2d01f48e021788fb9a088dd");
  assert.equal(REVIEWED_V0112_RELEASE_PIN.tag, "v0.1.12");
  assert.equal(REVIEWED_V0112_RELEASE_PIN.commit, "799c5b7e487df9f4d7c260147b61cc99d15084d6");
  assert.equal(REVIEWED_V0112_RELEASE_PIN.x64Sha256, "7090a5b2c1f0f448a09d5ae466f2f96d507c873ef7c1f5904e56b710312deef5");
  assert.equal(REVIEWED_V0112_RELEASE_PIN.arm64Sha256, "d129fd94d8aff681623a407fe7c28d0ca22945cec7686b7ee63fb9ebf54bc124");
  assert.ok(script.includes("remote-control-agent-v0.1.12"));
  assert.match(script,/7090a5b2c1f0f448/);
  assert.match(script,/d129fd94d8aff681/);
  assert.doesNotMatch(script,/remote-control-agent-v0.1.11/);
  assert.match(script,/1\) \[ "\$1" = "--upgrade"/);
});

test("one-line installer reports genuine download progress and each checked stage", () => {
  const shell=renderAgentInstallShell(origin,REVIEWED_V018_RELEASE_PIN);
  const stage=(n: number): number => {
    const position=shell.indexOf(`[${n}/5]`);
    assert.ok(position>=0);
    return position;
  };
  assert.ok(stage(1)<stage(2) && stage(2)<stage(3) &&
    stage(3)<stage(4) && stage(4)<stage(5));
  assert.match(shell,/effective=\$\(curl -fL --progress-bar /);
  assert.doesNotMatch(shell,/effective=\$\(curl -fsSL /);
  assert.match(shell,/--max-redirs 3 --max-time 180 --max-filesize 180000000/);
  assert.match(shell,/SHA-256 verification passed/);
  const download=shell.indexOf("effective=$(curl");
  const verify=shell.indexOf("sha256sum -c");
  const unpack=shell.indexOf("tar -xOzf");
  const launch=shell.indexOf('"$stage/node" "$stage/bootstrap-node.mjs"');
  assert.ok(stage(2)<download && download<stage(3));
  assert.ok(stage(3)<verify && verify<stage(4));
  assert.ok(stage(4)<unpack && unpack<stage(5));
  assert.ok(stage(5)<launch);
  const syntax=spawnSync("sh",["-n"],{input:shell,encoding:"utf8",timeout:3000});
  assert.equal(syntax.status,0,syntax.stderr);
});

test("production custom hostname serves pinned installer with same-domain Agent endpoint",async()=>{
  const custom="https://rca.lirtual.dpdns.org";
  const response=requestInstall(new Request(custom+"/install.sh"), undefined, custom);
  assert.equal(response.status,200);
  const shell=await response.text();
  assert.ok(shell.startsWith("#!/bin/sh"));
  assert.ok(shell.includes('--endpoint "https://rca.lirtual.dpdns.org/"'));
  assert.equal(shell.includes("--endpoint \"https://remote-control-v2-preview"),false);
  assert.equal(requestInstall(new Request("http://rca.lirtual.dpdns.org/install.sh"), undefined, custom).status,403);
  assert.equal(requestInstall(new Request(custom+"/install.sh",{headers:{host:"evil.test"}}), undefined, custom).status,403);
  assert.equal(requestInstall(new Request("https://evil.lirtual.dpdns.org/install.sh"), undefined, custom).status,403);
});

test("unconfigured installer origin fails closed without trusting arbitrary Host",()=>{
  assert.equal(handleAgentInstallerRequest(new Request(origin+"/install.sh"), undefined, undefined).status,503);
  assert.equal(requestInstall(new Request(origin+"/install.sh"), undefined, "").status,503);
  assert.equal(requestInstall(new Request(origin+"/install.sh"), undefined, "http://bad.example").status,503);
  assert.equal(requestInstall(new Request(origin+"/install.sh"), undefined, "https://bad.example/path").status,503);
  assert.equal(requestInstall(new Request(origin+"/install.sh"), undefined,
    "https://unrelated.example").status,403);
});

test("historical two-code v0.1.2 cannot be served by single-code Worker even when explicitly passed",async()=>{
  const reviewed=REVIEWED_V012_RELEASE_PIN;
  assert.equal(reviewed.tag,"v0.1.2");
  assert.equal(reviewed.commit,"00aaf200107e42a1b7cede3db51f9a16edea5b09");
  assert.equal(reviewed.x64Sha256,"b895f8133a03a53f4eacbf4fa6d0619f59ad722064c5e2e8ca469f9fc637221a");
  assert.equal(reviewed.arm64Sha256,"ec16343f50b20b762b04a06039164c0f3a7f42bdeb597ab8e04ecc4b3e40724c");
  const nowEnabled=requestInstall(new Request(origin+"/install.sh"));
  assert.equal(nowEnabled.status,200);
  assert.equal(reviewed.pairingProtocol,"two-code-v1");
  const incompatible=requestInstall(new Request(origin+"/install.sh"),reviewed);
  assert.equal(incompatible.status,503);
  assert.doesNotMatch(await incompatible.text(),/#!/);
  assert.throws(()=>renderAgentInstallShell(origin,reviewed),/Unapproved/);
});

test("future reviewed route binds its own validated origin and pins both ABIs", async()=>{
  const response=requestInstall(new Request(origin+"/install.sh"),pin);
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
    const response=requestInstall(request,pin);
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
  assert.throws(()=>renderAgentInstallShell("https://unknown.example/path",pin),/Unapproved/);
});
