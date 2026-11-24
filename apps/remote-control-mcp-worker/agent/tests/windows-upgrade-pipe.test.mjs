import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createConnection} from "node:net";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import {createAgentExecutionEngine} from "../src/execution.ts";
import {startUpgradeControl,upgradeSocketPath} from "../src/upgrade-control.ts";

const windows=process.platform==="win32"?test:test.skip;
function requestPipe(pipe,action){
  return new Promise((resolve,reject)=>{
    const socket=createConnection(pipe);
    let text="";
    socket.setTimeout(2000,()=>{socket.destroy();reject(Error("pipe timeout"));});
    socket.on("error",reject);
    socket.on("connect",()=>socket.write(action+"\n"));
    socket.on("data",data=>{
      text+=data.toString();
      if(text.endsWith("\n")){socket.end();resolve(text.trim());}
    });
  });
}
async function requestPowershell(key,action,fromTask=false){
  const target=fromTask?"../scripts/windows-user-task.ps1":"../install.ps1";
  const source=await readFile(fileURLToPath(new URL(target,import.meta.url)),"utf8");
  // Extract only the top-level freeze function. Later Task lifecycle
  // functions and their owner-specific initialization are not part of IPC.
  const functionText=source.match(/^function Invoke-AgentUpgradeFreeze\(([\s\S]*?^\})/m)?.[1];
  assert(functionText,"reviewed Windows PowerShell freeze function missing");
  const diagnostic=functionText.replace(
    "  $pipe = [IO.Pipes.NamedPipeClientStream]::new(",
    "  Write-Output ('RCA_PIPE_HASH:' + $hash)\n  $pipe = [IO.Pipes.NamedPipeClientStream]::new(");
  assert.notEqual(diagnostic,functionText);
  const command="function Invoke-AgentUpgradeFreeze("+diagnostic+
    "\nInvoke-AgentUpgradeFreeze '"+key.replaceAll("'","''")+"' '"+action+"'";
  const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let output="",errors="";
  child.stdout.on("data",x=>output+=x);
  child.stderr.on("data",x=>errors+=x);
  const exit=await new Promise((resolve,reject)=>{
    child.once("error",reject);
    child.once("close",resolve);
  });
  return {exit,output,errors};
}
windows("Windows same-user private pipe freezes all admissions; native PowerShell interoperates",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"rca-pipe-ci-"));
  const key=path.join(dir,"v2-identity.pem");
  const execution=createAgentExecutionEngine({receiptDirectory:path.join(dir,"receipts")});
  let control;
  try {
    assert(upgradeSocketPath(key).startsWith(String.raw`\\.\pipe\rca-upgrade-`));
    control=await startUpgradeControl(execution,key);
    assert.equal(await requestPipe(upgradeSocketPath(key),"freeze"),"ready");
    assert.equal(await requestPipe(upgradeSocketPath(key),"freeze"),"busy");
    assert.equal(await requestPipe(upgradeSocketPath(key),"verify-frozen"),"ready");
    const verified=await requestPowershell(key,"verify-frozen");
    assert.equal(verified.output.trim(),"RCA_PIPE_HASH:"+upgradeSocketPath(key).slice(-32),
      "Node and Windows PowerShell must derive the same pipe name");
    assert.equal(verified.errors,"","Windows PowerShell verification must not emit errors");
    assert.equal(verified.exit,0);
    const taskVerified=await requestPowershell(key,"verify-frozen",true);
    assert.equal(taskVerified.errors,"");
    assert.equal(taskVerified.exit,0);
    const denied=await execution.executeTool({tool:"get_file_info",arguments:{path:dir}},
      new AbortController().signal);
    assert.equal(denied?.status,503);
    const released=await requestPowershell(key,"release");
    assert.equal(released.errors,"","Windows PowerShell release must not emit errors");
    assert.equal(released.exit,0);
    assert.equal(execution.verifyUpgradeFreeze(),false);
    assert.equal(execution.freezeForUpgrade(),true,"owner release restores freeze admission");
    assert.equal(await requestPipe(upgradeSocketPath(key),"release"),"released");
    assert.equal((await requestPowershell(key,"verify-frozen")).exit!==0,true,
      "unfrozen Agent must not satisfy a new Task switch");
  }finally{
    await control?.close();
    await execution.close();
    await rm(dir,{recursive:true,force:true});
  }
});

// Use the actual controller's process-exit filter, with an independently
// supplied live-process snapshot. No Windows task or process is terminated.
windows("legacy switch excludes only its exact management caller, not an Agent or reused PID",async()=>{
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const fn=source.match(/^function Wait-VersionExited\([\s\S]*?^\}/m)?.[0];
  assert(fn);
  const callerFn=source.match(/^function Get-LocalSwitchCaller\([\s\S]*?^\}/m)?.[0];
  assert(callerFn);
  const command=fn+'\n'+callerFn+String.raw`
$ErrorActionPreference='Stop'
$root='C:\Users\fixture\programs\v0.0.1-ci-windows-x64'
$program=[pscustomobject]@{Root=$root}
$sid='fixture-owner'
$caller=[pscustomobject]@{ProcessId=100;CreationDate=1;ExecutablePath=($root+'\bin\node.exe')}
function Get-CimInstance { $script:rows }
function Start-Sleep {}
$script:rows=@($caller)
Wait-VersionExited $program $caller
function Assert-Blocked {
  param($candidate)
  $script:rows=@($caller,$candidate)
  try { Wait-VersionExited $program $caller; throw 'Unexpected success' }
  catch { if ($_.Exception.Message -ne 'Previous Agent process exit not confirmed') {throw} }
}
Assert-Blocked ([pscustomobject]@{ProcessId=101;CreationDate=1;ExecutablePath=$caller.ExecutablePath})
Assert-Blocked ([pscustomobject]@{ProcessId=100;CreationDate=2;ExecutablePath=$caller.ExecutablePath})
Assert-Blocked ([pscustomobject]@{ProcessId=102;CreationDate=1;ExecutablePath=($root+'\bin\rca-background.exe')})
$script:rows=@($caller)
try { Wait-VersionExited $program; throw 'Unexpected strict success' }
catch { if ($_.Exception.Message -ne 'Previous Agent process exit not confirmed') {throw} }
# Actual native-management caller classification. Mock only OS process
# enumeration, not command/path/SID/PID validation in the controller.
$root='C:\Users\fixture\programs'
$exe=$root+'\v0.1.58-rust-candidate.1-windows-x64\apps\remote-control-agent\.build\rca-standard-windows-candidate.exe'
$script:parent=[pscustomobject]@{ProcessId=100;CreationDate=1;ExecutablePath=$exe;CommandLine=('"' + $exe + '" --cli upgrade --version v0.1.59-rust-candidate.1')}
$script:owner='fixture-owner'
function Get-CimInstance {
  param($ClassName,$Filter)
  if ($Filter -eq ('ProcessId = '+$PID)) { return [pscustomobject]@{ParentProcessId=100;CreationDate=2} }
  $script:parent
}
function Invoke-CimMethod { [pscustomobject]@{Sid=$script:owner} }
if (-not (Get-LocalSwitchCaller 'Upgrade' 'v0.1.59-rust-candidate.1')) { throw 'Native upgrade caller not recognized' }
if (Get-LocalSwitchCaller 'Upgrade' 'v0.1.60-rust-candidate.1') { throw 'Wrong target caller accepted' }
$script:parent.CommandLine='"'+$exe+'" --service --endpoint "https://example.test/" --generation "test"'
if (Get-LocalSwitchCaller 'Upgrade' 'v0.1.59-rust-candidate.1') { throw 'Service excluded from exit observation' }
$script:parent.CommandLine='"'+$exe+'" --cli recover'
if (-not (Get-LocalSwitchCaller 'Recover' '')) { throw 'Native recovery caller not recognized' }
$script:parent.CommandLine='"'+$exe+'" --cli re-pair --endpoint https://example.test/'
if (-not (Get-LocalSwitchCaller 'RePair' 'https://example.test/')) { throw 'Native repair caller not recognized' }
$script:owner='another-owner'
if (Get-LocalSwitchCaller 'RePair' 'https://example.test/') { throw 'Foreign owner excluded' }
Write-Output 'exit-filter-pass'
`;
  const shell="powershell.exe";
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(shell,["-NoProfile","-NonInteractive","-Command",command],{windowsHide:true});
    let stdout="",stderr="";
    child.stdout.on("data",x=>stdout+=x);
    child.stderr.on("data",x=>stderr+=x);
    child.on("error",reject);
    child.on("close",code=>resolve({code,stdout,stderr}));
  });
  assert.equal(result.code,0,result.stderr);
  assert.equal(result.stdout.trim(),"exit-filter-pass");
});

windows("verified stage filesystem retry is bounded and never retries unrelated refusals",async()=>{
  const source=await readFile(fileURLToPath(new URL("../install.ps1",import.meta.url)),"utf8");
  const fn=source.match(/^function Invoke-StageFileOperation\([\s\S]*?^\}/m)?.[0];
  assert(fn);
  const command=fn+String.raw`
$ErrorActionPreference='Stop'
function Start-Sleep {}
$script:attempts=0
Invoke-StageFileOperation {
  $script:attempts++
  if ($script:attempts -lt 3) { throw [IO.IOException]::new('sharing fixture',-2147024864) }
}
if ($script:attempts -ne 3) { throw 'Expected sharing recovery' }
$script:attempts=0
try {
  Invoke-StageFileOperation { $script:attempts++; throw [IO.IOException]::new('persistent sharing fixture',-2147024864) }
  throw 'Unexpected success'
} catch { if ($_.Exception.Message -ne 'persistent sharing fixture') { throw } }
if ($script:attempts -ne 8) { throw 'Wrong retry limit' }
$script:attempts=0
try {
  Invoke-StageFileOperation { $script:attempts++; throw 'Target already exists; refuse stage promotion' }
  throw 'Unexpected success'
} catch { if ($_.Exception.Message -ne 'Target already exists; refuse stage promotion') { throw } }
if ($script:attempts -ne 1) { throw 'Unrelated failure retried' }
Write-Output 'stage-retry-pass'
`;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{windowsHide:true});
    let stdout="",stderr="";
    child.stdout.on("data",x=>stdout+=x);
    child.stderr.on("data",x=>stderr+=x);
    child.on("error",reject);
    child.on("close",code=>resolve({code,stdout,stderr}));
  });
  assert.equal(result.code,0,result.stderr);
  assert.equal(result.stdout.trim(),"stage-retry-pass");
});
