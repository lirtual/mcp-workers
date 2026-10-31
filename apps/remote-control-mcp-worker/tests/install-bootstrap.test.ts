import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { handleAgentInstallerRequest, renderAgentInstallShell, REVIEWED_V012_RELEASE_PIN, REVIEWED_V014_RELEASE_PIN, REVIEWED_V016_RELEASE_PIN, REVIEWED_V017_RELEASE_PIN, REVIEWED_V018_RELEASE_PIN, REVIEWED_V0110_RELEASE_PIN, REVIEWED_V0111_RELEASE_PIN, REVIEWED_AGENT_RELEASE_PIN } from "../src/install-bootstrap.ts";

const origin = "https://remote-control-v2-preview.aiyaya.workers.dev";
function requestInstall(request: Request, release?: Parameters<typeof handleAgentInstallerRequest>[1],
  configuredOrigin: string | undefined = origin) {
  return handleAgentInstallerRequest(request, release, configuredOrigin);
}
const pin = Object.freeze({
  tag:"v0.1.4", commit:"a".repeat(40), pairingProtocol:"single-code-v1" as const,
  x64Sha256:"b".repeat(64), arm64Sha256:"c".repeat(64),
});

test("public Linux installer remains disabled until new interactive-mode Release is reviewed", async()=>{
  const response=requestInstall(new Request(origin+"/install.sh"));
  assert.equal(response.status,503);
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
  assert.equal(REVIEWED_AGENT_RELEASE_PIN.tag, "v0.1.13");
  assert.equal(REVIEWED_AGENT_RELEASE_PIN.commit, "1171542d2951042cc1e0992c8cb9b97d3284fe03");
  assert.equal(REVIEWED_AGENT_RELEASE_PIN.x64Sha256, "bcb932d9f3539233204decf70ed0a748e2e31ac2a069e5b8b29484ab8733a0e3");
  assert.equal(REVIEWED_AGENT_RELEASE_PIN.arm64Sha256, "bdbe443d6010e372a03bff773d0e0bce946ac7bbbd45d9d1b75c99477eb23aa9");
  assert.match(script,/No reviewed.*release is published yet/);
  assert.doesNotMatch(script,/#!/);
  assert.doesNotMatch(script,/v0\.1\.13|curl|sha256sum/);
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

test("production custom hostname does not advertise old Linux binary while reviewed candidate is absent",async()=>{
  const custom="https://rca.lirtual.dpdns.org";
  const noPin=requestInstall(new Request(custom+"/install.sh"), undefined, custom);
  assert.equal(noPin.status,503);
  assert.doesNotMatch(await noPin.text(),/#!/);
  const response=requestInstall(new Request(custom+"/install.sh"), pin, custom);
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
  const noNewRelease=requestInstall(new Request(origin+"/install.sh"));
  assert.equal(noNewRelease.status,503);
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

test('public installation home is isolated from authentication and shows the two exact commands',async()=>{
  const custom='https://rca.lirtual.dpdns.org';
  const page=requestInstall(new Request(custom+'/'),undefined,custom);
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-type')??'',/text\/html/);
  assert.match(page.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);
  const html=await page.text();
  assert.match(html,/role="tablist"/);
  assert.match(html,/>Linux<\/button>/);
  assert.doesNotMatch(html,/>Linux \/ WSL2<\/button>/);
  assert.match(html,/aria-selected/);
  assert.match(html,/const ready=\{windows:false,linux:false\}/);
  assert.match(html,/copy\.disabled=!ready\[value\]/);
  assert.match(html,/Not available/);
  assert.match(html,/navigator\.userAgentData/);
  assert.match(html,/clipboard\.writeText/);
  assert.match(html,/irm https:\/\/rca\.lirtual\.dpdns\.org\/install\.ps1 \| iex/);
  assert.match(html,/curl -fsSL https:\/\/rca\.lirtual\.dpdns\.org\/install\.sh \| sh/);
  assert.doesNotMatch(html,/api\/devices|Bearer |secret|Remote Desktop/);
  assert.equal(requestInstall(new Request(custom+'/',{method:'POST'}),undefined,custom).status,405);
  assert.equal(requestInstall(new Request(custom+'/',{headers:{host:'evil.test'}}),undefined,custom).status,403);
  assert.equal(requestInstall(new Request(custom+'/install.ps1'),undefined,custom).status,503);
});

test('Windows installer fetches only independently source-pinned script and release',async()=>{
  const { renderAgentInstallPowerShell } = await import('../src/install-bootstrap.ts');
  const synthetic={tag:'v0.1.99-windows.1',commit:'a'.repeat(40),scriptSha256:'b'.repeat(64),assetSha256:'c'.repeat(64)};
  const script=renderAgentInstallPowerShell(origin,synthetic);
  assert.match(script,/Invoke-WebRequest .* -MaximumRedirection 0/);
  assert.match(script,/SHA-256 mismatch/);
  assert.match(script,/ScriptBlock\]::Create/);
  assert.match(script,/-PinnedReleaseSha256/);
  const resp=handleAgentInstallerRequest(new Request(origin+'/install.ps1'),undefined,origin,synthetic);
  assert.equal(resp.status,200);
  assert.match(await resp.text(),/v0\.1\.99-windows\.1/);
  assert.throws(()=>renderAgentInstallPowerShell(origin,{...synthetic,commit:'not-pinned'}),/Unapproved/);
});

test('homepage copy state follows the separately verified platform pins',async()=>{
  const {renderInstallHome}=await import('../src/install-home.ts');
  const closed=renderInstallHome();
  const linux=renderInstallHome({linux:true,windows:false});
  const windows=renderInstallHome({linux:false,windows:true});
  assert.match(closed,/const ready=\{windows:false,linux:false\}/);
  assert.match(linux,/const ready=\{windows:false,linux:true\}/);
  assert.match(windows,/const ready=\{windows:true,linux:false\}/);
  assert.match(closed,/field\.textContent=ready\[value\]\?cmds\[value\]:'Not available'/);
  assert.match(closed,/copy\.disabled=!ready\[value\]/);
  assert.match(closed,/if\(!ready\[platform\]\)return;/);
  const custom='https://rca.lirtual.dpdns.org';
  const resp=requestInstall(new Request(custom+'/'),pin,custom);
  assert.match(await resp.text(),/const ready=\{windows:false,linux:true\}/);
});


test('reviewed Linux and Windows v0.1.40 public installers pin immutable local upgrade sources', async () => {
  const { REVIEWED_PUBLIC_INSTALL_RELEASE_PIN, REVIEWED_WINDOWS_INSTALL_PIN } =
    await import('../src/install-bootstrap.ts');
  const base = 'https://rca.lirtual.dpdns.org';
  assert.equal(REVIEWED_PUBLIC_INSTALL_RELEASE_PIN.tag, 'v0.1.40');
  assert.equal(REVIEWED_PUBLIC_INSTALL_RELEASE_PIN.commit, '6b3dd437c828c89b33cfb5f49e610f16ff6ecfbc');
  assert.equal(REVIEWED_PUBLIC_INSTALL_RELEASE_PIN.upgradeMode, 'explicit-v1');
  assert.equal(REVIEWED_PUBLIC_INSTALL_RELEASE_PIN.x64Sha256, 'a5094f2c75406eb5a1c5581e1db36e6cc3482c94b4bbce14965e1f78486187fa');
  assert.equal(REVIEWED_PUBLIC_INSTALL_RELEASE_PIN.arm64Sha256, '3f8c221f6ec73f98c203fd0848243e8fa058a9a5c549891142842ae9af2124c2');
  assert.equal(REVIEWED_WINDOWS_INSTALL_PIN.tag, 'v0.1.40');
  assert.equal(REVIEWED_WINDOWS_INSTALL_PIN.commit, '6b3dd437c828c89b33cfb5f49e610f16ff6ecfbc');
  assert.equal(REVIEWED_WINDOWS_INSTALL_PIN.assetSha256, '6553dd901bd5883f670a1ba8e517ab45caecfa03030b3c74eef8894182ef499f');
  assert.equal(REVIEWED_WINDOWS_INSTALL_PIN.scriptSha256, '94267de0bdb9c8e8776929190e92143128ec15dcb714ca9dd37d15ba97778cb2');
  const home = handleAgentInstallerRequest(new Request(base + '/'), REVIEWED_PUBLIC_INSTALL_RELEASE_PIN, base, REVIEWED_WINDOWS_INSTALL_PIN);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /const ready=\{windows:true,linux:true\}/);
  const linux = handleAgentInstallerRequest(new Request(base + '/install.sh'), REVIEWED_PUBLIC_INSTALL_RELEASE_PIN, base, REVIEWED_WINDOWS_INSTALL_PIN);
  assert.equal(linux.status, 200);
  const shell = await linux.text();
  assert.match(shell, /remote-control-agent-v0\.1\.40/);
  assert.match(shell, /1\) \[ "\$1" = "--upgrade"/);
  assert.match(shell, /"\$@" < \/dev\/tty/);
  const windows = handleAgentInstallerRequest(new Request(base + '/install.ps1'), REVIEWED_PUBLIC_INSTALL_RELEASE_PIN, base, REVIEWED_WINDOWS_INSTALL_PIN);
  assert.equal(windows.status, 200);
  const ps1 = await windows.text();
  assert.match(ps1, /v0\.1\.40/);
  assert.match(ps1, /6b3dd437c828c89b33cfb5f49e610f16ff6ecfbc/);
  assert.match(ps1, /94267de0bdb9c8e8776929190e92143128ec15dcb714ca9dd37d15ba97778cb2/);
  assert.match(ps1, /6553dd901bd5883f670a1ba8e517ab45caecfa03030b3c74eef8894182ef499f/);
  assert.equal(handleAgentInstallerRequest(new Request(base + '/'), null, base, null).status, 200);
  assert.equal(handleAgentInstallerRequest(new Request(base + '/install.sh'), null, base, null).status, 503);
  assert.equal(handleAgentInstallerRequest(new Request(base + '/install.ps1'), null, base, null).status, 503);
});


test("mobile links may open static install home with query or Origin but not scripts", async () => {
  const { REVIEWED_PUBLIC_INSTALL_RELEASE_PIN, REVIEWED_WINDOWS_INSTALL_PIN } =
    await import("../src/install-bootstrap.ts");
  const host = "https://rca.lirtual.dpdns.org";
  const serve = (request: Request) => handleAgentInstallerRequest(
    request, REVIEWED_PUBLIC_INSTALL_RELEASE_PIN, host, REVIEWED_WINDOWS_INSTALL_PIN);
  const clean = await serve(new Request(host + "/")).text();
  const linked = serve(new Request(host + "/?utm_source=chatgpt.com&utm_medium=share", {
    headers: { origin: "https://chatgpt.com" },
  }));
  assert.equal(linked.status, 200);
  assert.equal(await linked.text(), clean, "URL parameters must not affect or appear in static HTML");
  assert.equal(serve(new Request(host + "/?utm_source=chatgpt.com", {method:"POST"})).status, 405);
  assert.equal(serve(new Request(host + "/?utm_source=chatgpt.com", {
    headers: {host:"untrusted.example"},
  })).status, 403);
  assert.equal(serve(new Request(host + "/?utm_source=chatgpt.com", {
    headers: {"x-forwarded-host":"untrusted.example"},
  })).status, 403);
  for (const path of ["/install.sh", "/install.ps1"]) {
    assert.equal(serve(new Request(host + path + "?utm_source=chatgpt.com")).status, 405);
    assert.equal(serve(new Request(host + path, {
      headers: {origin:"https://chatgpt.com"},
    })).status, 405);
  }
});


test('mobile home stays compact, uses semantic numbered steps and follows OS theme', async () => {
  const {renderInstallHome}=await import('../src/install-home.ts');
  const html=renderInstallHome({windows:true,linux:true});
  assert.match(html, /@media\(prefers-color-scheme:dark\)/);
  assert.match(html, /color-scheme:light/);
  assert.match(html, /color-scheme:dark/);
  for(const token of ['--bg','--fg','--muted','--surface','--border','--icon-hover']){
    assert.ok(html.includes(token), 'missing theme variable '+token);
  }
  assert.match(html, /@media\(max-width:520px\)/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Install on your device/);
  assert.match(html, /Run the command, then approve in MCP\./);
  assert.match(html, /Copy install command/);
  assert.doesNotMatch(html, /[\u3400-\u9fff]/, "install page must use English throughout");
  assert.match(html, /-webkit-text-size-adjust:100%/);
  assert.match(html, /list-style:none/);
  assert.match(html, /<ol role="list">/);
  assert.equal((html.match(/<li><strong>[123] · /g)??[]).length,3);
  assert.doesNotMatch(html, /padding-top:12vh|list-style-position:inside/);
  assert.match(html, /class="command-head"/);
  assert.match(html, /id="shell-label"/);
  assert.ok(html.indexOf('id="copy"')<html.indexOf('id="command"'), 'copy button stays above wrapped command');
  assert.match(html, /class="command-scroll"/);
  assert.match(html, /overflow-x:auto/);
  assert.match(html, /white-space:pre/);
  assert.match(html, /border-radius:24px/);
  assert.match(html, /aria-hidden="true" focusable="false"/);
  assert.match(html, /class="icon-copy"/);
  assert.match(html, /class="icon-check"/);
  assert.doesNotMatch(html, /id="copy"[^>]*>复制<\/button>/);
  assert.match(html, /select\(detected\.includes\('linux'\)\?'linux':'windows'\)/);
  assert.doesNotMatch(html, /先选择 Windows 或 Linux|const mobile=/);
  assert.match(html, /copy\.disabled=!ready\[value\]/);
  assert.match(html, /aria-selected/);
  assert.match(html, /clipboard\.writeText\(cmds\[requestedPlatform\]\)/);
  assert.match(html, /irm https:\/\/rca\.lirtual\.dpdns\.org\/install\.ps1 \| iex/);
  assert.match(html, /curl -fsSL https:\/\/rca\.lirtual\.dpdns\.org\/install\.sh \| sh/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|document\.cookie|api\/devices/);
});

test('mobile install card uses compact proportional sizes and wraps complete commands', async () => {
  const {renderInstallHome}=await import('../src/install-home.ts');
  const html=renderInstallHome({windows:true,linux:true});
  const mobile=html.match(/@media\(max-width:520px\)\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(mobile, 'mobile rules required');
  assert.match(mobile,/h1\{font-size:27px/);
  assert.match(mobile,/min-height:100svh;display:flex;flex-direction:column/);
  assert.match(mobile,/main\{margin:auto\}/);
  assert.match(mobile,/\.command\{border-radius:20px;padding:16px 17px 18px\}/);
  assert.match(mobile,/\.command-label\{font-size:15px\}/);
  assert.match(mobile,/button\.copy\{width:36px;height:36px/);
  assert.match(mobile,/button\.copy svg\{width:22px;height:22px\}/);
  assert.match(mobile,/\.command-scroll\{overflow-x:visible\}/);
  assert.match(mobile,/code\{width:auto;max-width:100%;font-size:13px;line-height:1\.6;white-space:normal;overflow-wrap:normal;word-break:normal\}/);
  assert.match(mobile,/ol\{grid-template-columns:1fr;gap:13px/);
  assert.match(html,/@media\(prefers-color-scheme:dark\)/);
  assert.match(html,/--surface:#23242a/);
  assert.match(html,/--surface:#f4f4f5/);
  assert.match(html,/Command copied/);
  assert.match(html,/Copy failed\. Select the command manually\./);
  assert.match(html,/clipboard\.writeText\(cmds\[requestedPlatform\]\)/);
  assert.match(html,/irm https:\/\/rca\.lirtual\.dpdns\.org\/install\.ps1 \| iex/);
  assert.match(html,/curl -fsSL https:\/\/rca\.lirtual\.dpdns\.org\/install\.sh \| sh/);
});

test('narrow install commands break only at URL path while copied text stays exact', async () => {
  const {renderInstallHome}=await import('../src/install-home.ts');
  const html=renderInstallHome({windows:true,linux:true});
  const source=html.split('<script>')[1]?.split('</script>')[0];
  assert.ok(source);
  const codeNodes:{data?:string;tagName?:string;splitText?:(at:number)=>unknown}[]=[];
  const code = {
    set textContent(value:string){
      codeNodes.length=0;
      codeNodes.push(makeText(value));
    },
    get firstChild(){return codeNodes[0];},
    insertBefore(node:unknown,reference:unknown){
      const i=codeNodes.indexOf(reference as typeof codeNodes[number]);
      assert.ok(i>=0);
      codeNodes.splice(i,0,node as typeof codeNodes[number]);
    },
  };
  function makeText(value:string){
    return {
      data:value,
      splitText(at:number){
        const suffix=makeText(this.data.slice(at));
        this.data=this.data.slice(0,at);
        const i=codeNodes.indexOf(this);
        codeNodes.splice(i+1,0,suffix);
        return suffix;
      },
    };
  }
  function element(){
    return {
      textContent:'',disabled:false,tabIndex:0,
      attributes:{} as Record<string,string>,
      handlers:{} as Record<string,()=>void>,
      setAttribute(name:string,value:string){this.attributes[name]=value;},
      removeAttribute(name:string){delete this.attributes[name];},
      addEventListener(name:string,handler:()=>void){this.handlers[name]=handler;},
      focus(){},
    };
  }
  const windows=element(),linux=element(),copy=element(),shellLabel=element(),message=element();
  const elems:Record<string,unknown>={windows,linux,copy,'shell-label':shellLabel,message,command:code};
  const copied:string[]=[];
  runInNewContext(source,{
    document:{
      getElementById:(id:string)=>elems[id],
      createElement:(tag:string)=>{assert.equal(tag,'wbr');return {tagName:'WBR'};},
    },
    navigator:{platform:'iPhone',clipboard:{writeText:async(text:string)=>{copied.push(text);}}},
    setTimeout:()=>1,clearTimeout:()=>{},
  });
  assert.deepEqual(codeNodes.map(n=>n.tagName??n.data),[
    'irm https://rca.lirtual.dpdns.org/','WBR','install.ps1 | iex',
  ]);
  await (copy.handlers.click as ()=>Promise<void>)();
  assert.equal(copied[0],'irm https://rca.lirtual.dpdns.org/install.ps1 | iex');
  linux.handlers.click!();
  assert.deepEqual(codeNodes.map(n=>n.tagName??n.data),[
    'curl -fsSL https://rca.lirtual.dpdns.org/','WBR','install.sh | sh',
  ]);
  await (copy.handlers.click as ()=>Promise<void>)();
  assert.equal(copied[1],'curl -fsSL https://rca.lirtual.dpdns.org/install.sh | sh');
  assert.doesNotMatch(source,/innerHTML/);
});

test('installer home drops source/docs and defaults unknown device to first Windows tab', async () => {
  const {renderInstallHome}=await import('../src/install-home.ts');
  const html=renderInstallHome({windows:true,linux:true});
  assert.doesNotMatch(html, /<footer\b|>源码<\/a>|>文档<\/a>|#readme/);
  assert.match(html, /let platform='windows'/);
  assert.match(html, /select\(detected\.includes\('linux'\)\?'linux':'windows'\)/);
  assert.match(html, /id="windows" role="tab"/);
  assert.match(html, /id="linux" role="tab"/);
  assert.match(html, /tab\.setAttribute\('aria-selected',String\(name===value\)\)/);
  assert.match(html, /copy\.disabled=!ready\[value\]/);
  assert.match(html, /clipboard\.writeText\(cmds\[requestedPlatform\]\)/);
  assert.doesNotMatch(html, /先选择 Windows 或 Linux/);
});


test('icon-copy feedback resets correctly and retains SVG children', async () => {
  const { renderInstallHome } = await import('../src/install-home.ts');
  const html = renderInstallHome({ windows: true, linux: true });
  const source = html.split('<script>')[1]?.split('</script>')[0];
  assert.ok(source, 'inline page script must exist');
  type FakeElement = {
    textContent: string; disabled: boolean; tabIndex: number;
    attributes: Record<string,string>;
    handlers: Record<string,(event?: {key?:string,preventDefault?:()=>void})=>unknown>;
    setAttribute: (name:string,value:string)=>void;
    removeAttribute: (name:string)=>void;
    addEventListener: (name:string,handler:(event?:{key?:string,preventDefault?:()=>void})=>unknown)=>void;
    focus:()=>void;
  };
  function element(): FakeElement {
    return {
      textContent:'', disabled:false, tabIndex:0, attributes:{}, handlers:{},
      setAttribute(name,value){this.attributes[name]=value;},
      removeAttribute(name){delete this.attributes[name];},
      addEventListener(name,handler){this.handlers[name]=handler;},
      focus(){},
    };
  }
  const els = Object.fromEntries(['windows','linux','command','shell-label','message','copy'].map(id=>[id,element()])) as Record<'windows'|'linux'|'command'|'shell-label'|'message'|'copy',FakeElement>;
  const clipboard:string[] = [];
  let rejectCopy=false;
  const pending=new Map<number,()=>void>();
  let id=0;
  runInNewContext(source,{
    document:{getElementById:(name:string)=>els[name as keyof typeof els]},
    navigator:{
      platform:'iPhone',
      clipboard:{writeText:async (text:string)=>{
        if(rejectCopy)throw Error('Clipboard unavailable');
        clipboard.push(text);
      }},
    },
    setTimeout:(fn:()=>void,delay:number)=>{
      assert.equal(delay,1600);
      const next=++id;pending.set(next,fn);return next;
    },
    clearTimeout:(timer:number)=>{pending.delete(timer);},
  });
  assert.equal(els.windows.attributes['aria-selected'],'true','unknown/mobile defaults to first Windows tab');
  assert.equal(els.copy.attributes['aria-label'],'Copy install command');
  await els.copy.handlers.click!();
  assert.equal(clipboard[0],'irm https://rca.lirtual.dpdns.org/install.ps1 | iex');
  assert.equal(els.copy.attributes['data-copied'],'true');
  assert.equal(els.copy.textContent,'','state must preserve the inline SVGs');
  assert.equal(els.copy.attributes['aria-label'],'Command copied');
  assert.equal(els.message.textContent,'','no duplicate success label below the button');
  assert.equal(pending.size,1);
  [...pending.values()][0]!();
  assert.equal(els.copy.attributes['aria-label'],'Copy install command','accessible name resets after timeout');
  assert.equal(els.copy.attributes['data-copied'],undefined,'check icon resets after timeout');
  els.linux.handlers.click!();
  assert.equal(els.copy.attributes['aria-label'],'Copy install command');
  await els.copy.handlers.click!();
  assert.equal(clipboard[1],'curl -fsSL https://rca.lirtual.dpdns.org/install.sh | sh');
  assert.equal(els.copy.attributes['data-copied'],'true');
  els.windows.handlers.click!();
  assert.equal(els.copy.attributes['aria-label'],'Copy install command','switching platform resets accessible name');
  assert.equal(els.copy.attributes['data-copied'],undefined,'switching platforms restores copy icon');
  assert.equal(pending.size,0,'switching platforms cancels previous timer');
  rejectCopy=true;
  await els.copy.handlers.click!();
  assert.equal(els.copy.attributes['aria-label'],'Copy install command','failed copy must not show success');
  assert.equal(els.copy.attributes['data-copied'],undefined,'failed copy cannot show check icon');
  assert.equal(els.message.textContent,'Copy failed. Select the command manually.');
});

test('icon copy card adapts to system light/dark color scheme and remains accessible', async () => {
  const {renderInstallHome}=await import('../src/install-home.ts');
  const html=renderInstallHome({windows:true,linux:true});
  assert.ok(html.includes('--surface:#f4f4f5'));
  assert.ok(html.includes('--surface:#23242a'));
  assert.ok(html.includes('--icon-hover:rgba(20,20,24,.07)'));
  assert.ok(html.includes('--icon-hover:rgba(255,255,255,.1)'));
  assert.ok(html.includes('button.copy{display:inline-flex'));
  assert.ok(html.includes('background:transparent;color:var(--fg)'));
  assert.ok(html.includes('stroke:currentColor'));
  assert.ok(html.includes('button.copy[data-copied="true"] .icon-copy{display:none}'));
  assert.ok(html.includes('button.copy[data-copied="true"] .icon-check{display:block}'));
  assert.ok(html.includes('button.copy:disabled{opacity:.45;cursor:not-allowed}'));
  assert.ok(html.includes("copy.setAttribute('data-copied','true')"));
  assert.ok(html.includes("copy.removeAttribute('data-copied')"));
  assert.doesNotMatch(html,/--copied-bg|--copied-fg/);
});
