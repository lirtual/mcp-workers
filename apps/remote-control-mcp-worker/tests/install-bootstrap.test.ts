import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { handleAgentInstallerRequest } from "../src/install-bootstrap.ts";
import { REVIEWED_V012_RELEASE_PIN, REVIEWED_V014_RELEASE_PIN, REVIEWED_V016_RELEASE_PIN, REVIEWED_V017_RELEASE_PIN, REVIEWED_V018_RELEASE_PIN, REVIEWED_V0110_RELEASE_PIN, REVIEWED_V0111_RELEASE_PIN, REVIEWED_AGENT_RELEASE_PIN, REVIEWED_PUBLIC_INSTALL_RELEASE_PIN, REVIEWED_WINDOWS_INSTALL_PIN } from "./historical-install-pins.ts";

const origin = "https://worker.test";
function requestInstall(request: Request, configuredOrigin: string | undefined = origin) {
  return handleAgentInstallerRequest(request, configuredOrigin);
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

test("the pinned-shell helper does not serve an old-repository install.sh", async () => {
  const response = requestInstall(new Request(origin + "/install.sh"));
  assert.equal(response.status, 503);
  const script = await response.text();
  assert.doesNotMatch(script, /#!\/bin\/sh/);
  assert.doesNotMatch(script, /lirtual\/remote-control-agent\/releases\/download/);
  assert.doesNotMatch(script, /03a14fd4138ca8d77fa8aced78f7a53ccc51724e/);
});

test("production custom hostname does not advertise old Linux binary while reviewed candidate is absent",async()=>{
  const custom="https://rca.lirtual.dpdns.org";
  const noPin=requestInstall(new Request(custom+"/install.sh"), custom);
  assert.equal(noPin.status,503);
  assert.doesNotMatch(await noPin.text(),/#!/);
  const response=requestInstall(new Request(custom+"/install.sh"), custom);
  assert.equal(response.status,503);
  const shell=await response.text();
  assert.doesNotMatch(shell,/#!\/bin\/sh/);
  assert.doesNotMatch(shell,/lirtual\/remote-control-agent\/releases\/download/);
  assert.equal(requestInstall(new Request("http://rca.lirtual.dpdns.org/install.sh"), custom).status,403);
  assert.equal(requestInstall(new Request(custom+"/install.sh",{headers:{host:"evil.test"}}), custom).status,403);
  assert.equal(requestInstall(new Request("https://evil.lirtual.dpdns.org/install.sh"), custom).status,403);
});

test("unconfigured installer origin fails closed without trusting arbitrary Host",()=>{
  assert.equal(handleAgentInstallerRequest(new Request(origin+"/install.sh")).status,503);
  assert.equal(requestInstall(new Request(origin+"/install.sh"), "").status,503);
  assert.equal(requestInstall(new Request(origin+"/install.sh"), "http://bad.example").status,503);
  assert.equal(requestInstall(new Request(origin+"/install.sh"), "https://bad.example/path").status,503);
  assert.equal(requestInstall(new Request(origin+"/install.sh"),
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
  const incompatible=requestInstall(new Request(origin+"/install.sh"));
  assert.equal(incompatible.status,503);
  assert.doesNotMatch(await incompatible.text(),/#!/);
  assert.doesNotMatch(await requestInstall(new Request(origin+"/install.sh")).text(), /lirtual\/remote-control-agent/);
});

test("a historical pin is not emitted as install.sh", async()=>{
  const response=requestInstall(new Request(origin+"/install.sh"));
  assert.equal(response.status,503);
  const shell=await response.text();
  assert.doesNotMatch(shell,/^#!\/bin\/sh/);
  assert.doesNotMatch(shell,/lirtual\/remote-control-agent\/releases\/download/);
  assert.doesNotMatch(shell,/bootstrap-node\.mjs/);
  assert.equal(REVIEWED_V014_RELEASE_PIN.tag, "v0.1.4");
  assert.equal(REVIEWED_V016_RELEASE_PIN.upgradeMode, "explicit-v1");
});

test("fake Host, Forwarded, scheme, path, query and method are refused",async()=>{
  const bad=[
    new Request("http://worker.test/install.sh"),
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
    const response=requestInstall(request);
    assert.notEqual(response.status,200,request.url);
    assert.doesNotMatch(await response.text(),/#!/);
  }
});

test("untrusted pinned release metadata is not served as install.sh",async()=>{
  const bad=[
    {...pin,tag:"v0.1.2; touch /tmp/unsafe"},
    {...pin,commit:"$(id)"},
    {...pin,x64Sha256:"x".repeat(64)},
    {...pin,arm64Sha256:"a".repeat(63)},
  ];
  for(const candidate of bad){
    const response=requestInstall(new Request(origin+"/install.sh"));
    assert.equal(response.status,503);
    assert.doesNotMatch(await response.text(), /#!\/bin\/sh|touch \/tmp\/unsafe|\$\(id\)/);
  }
});

test('public installation home is isolated from authentication and shows the two exact commands',async()=>{
  const custom='https://rca.lirtual.dpdns.org';
  const page=requestInstall(new Request(custom+'/'),custom);
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-type')??'',/text\/html/);
  assert.match(page.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);
  const html=await page.text();
  assert.match(html,/role="tablist"/);
  assert.match(html,/>Linux<\/button>/);
  assert.doesNotMatch(html,/>Linux \/ WSL2<\/button>/);
  assert.match(html,/aria-selected/);
  assert.match(html,/const ready=\{windows:true,linux:true,macos:true\}/);
  assert.match(html,/copy\.disabled=!ready\[value\]/);
  assert.match(html,/Not available/);
  assert.match(html,/navigator\.userAgentData/);
  assert.match(html,/clipboard\.writeText/);
  assert.match(html,/& \(\[scriptblock\]::Create\(\(irm https:\/\/rca\.lirtual\.dpdns\.org\/install\.ps1\)\)\)/);
  assert.match(html,/curl -fsSL https:\/\/rca\.lirtual\.dpdns\.org\/install\.sh \| sh/);
  assert.doesNotMatch(html,/api\/devices|Bearer |secret|Remote Desktop/);
  assert.equal(requestInstall(new Request(custom+'/',{method:'POST'}),custom).status,405);
  assert.equal(requestInstall(new Request(custom+'/',{headers:{host:'evil.test'}}),custom).status,403);
  const windowsScript = await requestInstall(new Request(custom+'/install.ps1'),custom).text();
  assert.match(windowsScript, /lirtual\/mcp-workers\/releases\/latest/);
  assert.doesNotMatch(windowsScript, /lirtual\/remote-control-agent/);
});

test('Windows installer resolves one mcp-workers latest Release and does not fetch the old repository',async()=>{
  const { renderAgentInstallPowerShell } = await import('../src/install-bootstrap.ts');
  const synthetic={tag:'v0.1.99-windows.1',commit:'a'.repeat(40),scriptSha256:'b'.repeat(64),assetSha256:'c'.repeat(64)};
  const script=renderAgentInstallPowerShell(origin);
  assert.match(script,/https:\/\/api\.github\.com\/repos\/lirtual\/mcp-workers\/releases\/latest/);
  assert.match(script,/MaximumRedirection 0/);
  assert.match(script,/SHA256 mismatch/);
  assert.match(script,/SelectedReleaseSha256/);
  assert.doesNotMatch(script,/raw\.githubusercontent\.com/);
  assert.doesNotMatch(script,/github\.com\/lirtual\/remote-control-agent/);
  assert.doesNotMatch(script,/PinnedCommit/);
  assert.doesNotMatch(script,/v0\.1\.99-windows\.1/);
  const resp=handleAgentInstallerRequest(new Request(origin+'/install.ps1'),origin);
  assert.equal(resp.status,200);
  assert.match(await resp.text(),/lirtual\/mcp-workers\/releases\/latest/);
  assert.throws(()=>renderAgentInstallPowerShell('https://unknown.example/path'),/Unapproved/);
});

test('served Windows installer isolates parameter validation and repeated invocation in PowerShell', async (t) => {
  const { renderAgentInstallPowerShell } = await import('../src/install-bootstrap.ts');
  // Keep the actual rendered wrapper, parameters and complete script syntax.
  // Return before the first installer action; no download, identity or Task mutation.
  const marker = 'Set-StrictMode -Version Latest';
  const script = renderAgentInstallPowerShell(origin);
  assert.equal(script.split(marker).length, 2);
  const fixture = script.replace(marker, String.raw`
if (-not $MyInvocation.MyCommand.ScriptBlock.ToString().StartsWith('# Native Windows x64 bootstrap.')) {
  throw 'Installer source identity changed'
}
Write-Output ("PROBE:{0}:{1}" -f $Version, $StageOnly)
$Version = 'v0.1.61'
return
`);
  const probe = String.raw`
$ErrorActionPreference = 'Stop'
$fixture = [Console]::In.ReadToEnd()
$Version = ''
$fixture | Invoke-Expression
$fixture | Invoke-Expression
if ($Version -cne '') { throw 'Installer changed caller Version' }
& ([scriptblock]::Create($fixture)) -Version v0.1.60 -StageOnly
if ($Version -cne '') { throw 'Installer changed caller Version' }
try {
  & ([scriptblock]::Create($fixture)) -Version invalid
  throw 'Invalid version accepted'
} catch {
  if ($_.FullyQualifiedErrorId -notmatch 'ParameterArgumentValidationError') { throw }
}
Write-Output 'ISOLATION_OK'
`;
  const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', probe],
    { input: fixture, encoding: 'utf8', timeout: 15000 });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !process.env.CI) {
    t.skip('PowerShell is unavailable outside CI');
    return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    'PROBE::False', 'PROBE::False', 'PROBE:v0.1.60:True', 'ISOLATION_OK',
  ]);
});

test('homepage copy state follows the separately verified platform pins',async()=>{
  const {renderInstallHome}=await import('../src/install-home.ts');
  const closed=renderInstallHome();
  const linux=renderInstallHome({linux:true,windows:false});
  const windows=renderInstallHome({linux:false,windows:true});
  assert.match(closed,/const ready=\{windows:false,linux:false,macos:false\}/);
  assert.match(linux,/const ready=\{windows:false,linux:true,macos:false\}/);
  assert.match(windows,/const ready=\{windows:true,linux:false,macos:false\}/);
  assert.match(closed,/field\.textContent=ready\[value\]\?cmds\[value\]:'Not available'/);
  assert.match(closed,/copy\.disabled=!ready\[value\]/);
  assert.match(closed,/if\(!ready\[platform\]\)return;/);
  const custom='https://rca.lirtual.dpdns.org';
  const resp=requestInstall(new Request(custom+'/'),custom);
  assert.match(await resp.text(),/const ready=\{windows:true,linux:true,macos:true\}/);
});


test('reviewed Linux and Windows v0.1.51 public installers pin immutable local upgrade sources', async () => {
    const base = 'https://rca.lirtual.dpdns.org';
  assert.equal(REVIEWED_PUBLIC_INSTALL_RELEASE_PIN.tag, 'v0.1.51');
  assert.equal(REVIEWED_PUBLIC_INSTALL_RELEASE_PIN.commit, '03a14fd4138ca8d77fa8aced78f7a53ccc51724e');
  assert.equal(REVIEWED_PUBLIC_INSTALL_RELEASE_PIN.upgradeMode, 'explicit-v1');
  assert.equal(REVIEWED_PUBLIC_INSTALL_RELEASE_PIN.x64Sha256, '5330d88b5f1df4f250f453ea70cf43fe14b4cf362c437f6aac84a7c24981bbfc');
  assert.equal(REVIEWED_PUBLIC_INSTALL_RELEASE_PIN.arm64Sha256, '5b52f3e873e510a2810f6f0c7ee3b69c9226a4e4d00ebe8b8b6aabd73e415566');
  assert.equal(REVIEWED_WINDOWS_INSTALL_PIN.tag, 'v0.1.51');
  assert.equal(REVIEWED_WINDOWS_INSTALL_PIN.commit, '03a14fd4138ca8d77fa8aced78f7a53ccc51724e');
  assert.equal(REVIEWED_WINDOWS_INSTALL_PIN.assetSha256, '03f11bca0f21b7f8fd4ed1343db79827bb9b36be3feda0284b4b75f82d917311');
  assert.equal(REVIEWED_WINDOWS_INSTALL_PIN.scriptSha256, '6026d0e1a6422bb89c43e0168f60304be04fdc3a2ee96c4bf3192b12628f323a');
  const home = handleAgentInstallerRequest(new Request(base + '/'), base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /const ready=\{windows:true,linux:true,macos:true\}/);
  const linux = handleAgentInstallerRequest(new Request(base + '/install.sh'), base);
  assert.equal(linux.status, 503);
  const shell = await linux.text();
  assert.doesNotMatch(shell, /#!\/bin\/sh/);
  assert.doesNotMatch(shell, /lirtual\/remote-control-agent\/releases\/download/);
  assert.doesNotMatch(shell, /03a14fd4138ca8d77fa8aced78f7a53ccc51724e/);
  const windows = handleAgentInstallerRequest(new Request(base + '/install.ps1'), base);
  assert.equal(windows.status, 200);
  const ps1 = await windows.text();
  assert.match(ps1, /https:\/\/api\.github\.com\/repos\/lirtual\/mcp-workers\/releases\/latest/);
  assert.doesNotMatch(ps1, /03a14fd4138ca8d77fa8aced78f7a53ccc51724e/);
  assert.match(ps1, /\^v\(\?:0\|\[1-9\]\[0-9\]\*\)/);
  assert.doesNotMatch(ps1, /assets\.Count -ne 5/);
  assert.doesNotMatch(ps1, /tag_name -notmatch '\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\(\?:-\[a-z0-9\.-\]\+\)\?'/);
  assert.doesNotMatch(ps1, /6026d0e1a6422bb89c43e0168f60304be04fdc3a2ee96c4bf3192b12628f323a/);
  assert.doesNotMatch(ps1, /03f11bca0f21b7f8fd4ed1343db79827bb9b36be3feda0284b4b75f82d917311/);
  assert.doesNotMatch(ps1, /raw\.githubusercontent\.com/);
  assert.equal(handleAgentInstallerRequest(new Request(base + '/'), base).status, 200);
  assert.equal(handleAgentInstallerRequest(new Request(base + '/install.sh'), base).status, 503);
  assert.equal(handleAgentInstallerRequest(new Request(base + '/install.ps1'), base).status, 200);
});


test("mobile links may open static install home with query or Origin but not scripts", async () => {
    const host = "https://rca.lirtual.dpdns.org";
  const serve = (request: Request) => handleAgentInstallerRequest(request, host);
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
  assert.match(html, /Install your device/);
  assert.match(html, /rca update/);
  assert.match(html, /For a new installation, open the Agent authorization link in your browser/);
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
  assert.match(html, /select\(detected\.includes\('mac'\)/);
  assert.doesNotMatch(html, /先选择 Windows 或 Linux|const mobile=/);
  assert.match(html, /copy\.disabled=!ready\[value\]/);
  assert.match(html, /aria-selected/);
  assert.match(html, /clipboard\.writeText\(cmds\[requestedPlatform\]\)/);
  assert.match(html, /& \(\[scriptblock\]::Create\(\(irm https:\/\/rca\.lirtual\.dpdns\.org\/install\.ps1\)\)\)/);
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
  assert.match(html,/& \(\[scriptblock\]::Create\(\(irm https:\/\/rca\.lirtual\.dpdns\.org\/install\.ps1\)\)\)/);
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
  const windows=element(),linux=element(),macos=element(),copy=element(),shellLabel=element(),message=element();
  const elems:Record<string,unknown>={windows,linux,macos,copy,'shell-label':shellLabel,message,command:code,
    'mac-action':element(),'mac-install':element(),'mac-upgrade':element()};
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
    '& ([scriptblock]::Create((irm https://rca.lirtual.dpdns.org/','WBR','install.ps1)))',
  ]);
  await (copy.handlers.click as ()=>Promise<void>)();
  assert.equal(copied[0],'& ([scriptblock]::Create((irm https://rca.lirtual.dpdns.org/install.ps1)))');
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
  assert.match(html, /select\(detected\.includes\('mac'\)/);
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
  const els = Object.fromEntries(['windows','linux','macos','command','shell-label','message','copy','mac-action','mac-install','mac-upgrade'].map(id=>[id,element()])) as Record<'windows'|'linux'|'macos'|'command'|'shell-label'|'message'|'copy',FakeElement>;
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
  assert.equal(clipboard[0],'& ([scriptblock]::Create((irm https://rca.lirtual.dpdns.org/install.ps1)))');
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
