import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";

const windows=process.platform==="win32"?test:test.skip;
// Use the actual controller's process-exit filter, with an independently
// supplied live-process snapshot. No Windows task or process is terminated.
windows("native switch excludes only its exact management caller, not an Agent or reused PID",async()=>{
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const fn=source.match(/^function Wait-VersionExited\([\s\S]*?^\}/m)?.[0];
  assert(fn);
  const callerFn=source.match(/^function Get-LocalSwitchCaller\([\s\S]*?^\}/m)?.[0];
  assert(callerFn);
  const command=fn+'\n'+callerFn+String.raw`
$ErrorActionPreference='Stop'
$root='C:\Users\fixture\programs\v0.1.58-windows-x64'
$program=[pscustomobject]@{Root=$root}
$sid='fixture-owner'
$caller=[pscustomobject]@{ProcessId=100;CreationDate=1;ExecutablePath=($root+'\apps\remote-control-agent\.build\rca-standard-windows-candidate.exe')}
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
$originalCommand=$script:parent.CommandLine
$script:parent.CommandLine=$originalCommand -replace '--cli upgrade','--cli update'
if (-not (Get-LocalSwitchCaller 'Upgrade' 'v0.1.59-rust-candidate.1')) { throw 'Native update alias caller not recognized' }
if (Get-LocalSwitchCaller 'Upgrade' 'v0.1.60-rust-candidate.1') { throw 'Wrong alias target accepted' }
$script:parent.CommandLine=$originalCommand

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

windows("native Stable promotion retains forward-only journal validation",async()=>{
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const fn=source.match(/^function Test-NativeForwardVersion\([\s\S]*?^\}/m)?.[0];
  assert(fn);
  const command=fn+String.raw`
$ErrorActionPreference='Stop'
if (-not (Test-NativeForwardVersion 'v0.1.56' 'v0.1.58')) { throw 'Stable forward denied' }
if (-not (Test-NativeForwardVersion 'v0.1.58-rust-candidate.5' 'v0.1.58')) { throw 'Stable promotion denied' }
if (-not (Test-NativeForwardVersion 'v0.1.56' 'v0.1.58-rust-candidate.5')) { throw 'Candidate forward denied' }
if (Test-NativeForwardVersion 'v0.1.58-rust-candidate.3' 'v0.1.58-rust-candidate.5') { throw 'Same number candidate admitted' }
if (Test-NativeForwardVersion 'v0.1.58' 'v0.1.58') { throw 'Same Stable admitted' }
if (Test-NativeForwardVersion 'v0.1.59' 'v0.1.58') { throw 'Downgrade admitted' }
if (Test-NativeForwardVersion 'v0.1.58' 'v0.1.59-beta.1') { throw 'Unknown profile admitted' }
Write-Output 'native-forward-pass'
`;
  const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"native-forward-pass");
});

windows("activation proof polling rejects pending proof without a misleading runtime failure",async()=>{
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const probe=source.match(/^  try \{\r?\n(?:    #[^\r\n]*\r?\n)*    \$raw = & \$rustEntry --verify-activation-proof \$Generation[^\r\n]*\r?\n    if \(\$LASTEXITCODE[^\r\n]*\r?\n    \$proof = \$raw \| ConvertFrom-Json\r?\n  \} catch \{ throw 'Signed WSS activation not confirmed' \}/m)?.[0];
  assert(probe);
  const dir=await mkdtemp(path.join(os.tmpdir(),"rca-proof-probe-"));
  try {
    const {writeFile}=await import("node:fs/promises");
    const fixture=path.join(dir,"probe.cmd");
    await writeFile(fixture,'@echo off\r\nif "%2"=="ready" (\r\n echo {"state":"connected"}\r\n exit /b 0\r\n)\r\necho Windows Rust candidate refused or session failed. 1>&2\r\nexit /b 1\r\n');
    const command="$ErrorActionPreference='Stop'\n$rustEntry='"+fixture.replaceAll("'","''")+"'\n$Generation='pending'\ntry {\n"+probe+"\nthrow 'Pending proof unexpectedly accepted'\n} catch { if ($_.Exception.Message -ne 'Signed WSS activation not confirmed') { throw } }\n$Generation='ready'\n"+probe+"\nif ($proof.state -cne 'connected') { throw 'Successful proof lost' }\nWrite-Output 'activation-probe-pass'";
    const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{windowsHide:true,encoding:"utf8",timeout:10000});
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),"activation-probe-pass");
    assert.equal(result.stderr,"");
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("native upgrade admission distinguishes explicit Busy from unknown Freeze ownership",async t=>{
  const shell=process.platform==="win32"?"powershell.exe":"pwsh";
  if(spawnSync(shell,["-NoProfile","-Command","exit 0"]).error){t.skip("PowerShell unavailable");return;}
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const fn=source.match(/^function Freeze-OwnedAgent\([\s\S]*?^\}/m)?.[0];
  assert(fn);
  const command=fn+String.raw`
$ErrorActionPreference='Stop'
$identityFile='synthetic-key'
$script:answer='busy'
$script:commands=@()
function Read-OwnedTask { [pscustomobject]@{State='Running';Actions=@('old')} }
function Test-SameAction { $true }
function Get-OwnedAgentProcess { [pscustomobject]@{ProcessId=1;CreationDate=2} }
function Invoke-AgentUpgradeFreeze($key,$action,$allowBusy=$false) {
  $script:commands+= $action
  if ($action -eq 'freeze') {
    if ($script:answer -eq 'unknown') { throw 'lost response' }
    if ($script:answer -eq 'busy') {
      if ($allowBusy) { return 'busy' }
      throw 'Agent is busy, absent or not frozen'
    }
  }
}
if ((Freeze-OwnedAgent 'old' 'old' $false $true) -cne 'busy') {throw 'Explicit busy not deferred'}
if (($script:commands -join ',') -cne 'freeze') {throw 'Busy must not verify or release'}
$script:answer='unknown';$script:commands=@()
try { Freeze-OwnedAgent 'old' 'old' $false $true; throw 'Unknown accepted' }
catch {if ($_.Exception.Message -cne 'lost response') {throw}}
if (($script:commands -join ',') -cne 'freeze') {throw 'Unknown must not verify or release'}
$script:answer='ready';$script:commands=@()
if (Freeze-OwnedAgent 'old' 'old' $false $true) {throw 'Ready not admitted'}
if (($script:commands -join ',') -cne 'freeze,verify-frozen') {throw 'Ready must verify'}
Write-Output 'freeze-admission-pass'
`;
  const result=spawnSync(shell,["-NoProfile","-NonInteractive","-Command",command],
    {encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"freeze-admission-pass");
});

test("native Freeze reply requires exact LF rather than partial EOF",async t=>{
  const shell=process.platform==="win32"?"powershell.exe":"pwsh";
  if(spawnSync(shell,["-NoProfile","-Command","exit 0"]).error){t.skip("PowerShell unavailable");return;}
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const fn=source.match(/^function Read-AgentUpgradeReply\([\s\S]*?^\}/m)?.[0];
  assert(fn);
  const command=fn+'\n'+String.raw`
$ErrorActionPreference='Stop'
foreach($value in @('busy','ready','released')){
  $reader=[IO.StringReader]::new($value+[char]10)
  if ((Read-AgentUpgradeReply $reader) -cne $value) {throw 'Exact response not accepted'}
  $reader=[IO.StringReader]::new($value)
  try {Read-AgentUpgradeReply $reader;throw 'Partial response accepted'}
  catch {if ($_.Exception.Message -cne 'Agent upgrade pipe response not confirmed') {throw}}
}
Write-Output 'strict-frame-pass'
`;
  const result=spawnSync(shell,["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"strict-frame-pass");
});

test("automatic result suppresses only a verified failed target and preserves history on busy",async t=>{
  const shell=process.platform==="win32"?"powershell.exe":"pwsh";
  if(spawnSync(shell,["-NoProfile","-Command","exit 0"]).error){t.skip("PowerShell unavailable");return;}
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const fn=source.match(/^function Test-AutomaticResultTransition\([\s\S]*?^\}/m)?.[0];
  assert(fn);
  const command=fn+String.raw`
$ErrorActionPreference='Stop'
$prior=[pscustomobject]@{status='failed_recovered';target_version='v0.1.62'}
if (Test-AutomaticResultTransition $prior 'v0.1.62' 'admit') {throw 'Failed target admitted'}
if (-not (Test-AutomaticResultTransition $prior 'v0.1.63' 'admit')) {throw 'New target refused'}
if (Test-AutomaticResultTransition $prior 'v0.1.63' 'waiting_idle') {throw 'Busy overwrote failure evidence'}
if (-not (Test-AutomaticResultTransition $prior 'v0.1.63' 'success')) {throw 'Success did not replace failure'}
if (-not (Test-AutomaticResultTransition $null 'v0.1.63' 'waiting_idle')) {throw 'Initial busy result refused'}
Write-Output 'automatic-result-pass'
`;
  const result=spawnSync(shell,["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"automatic-result-pass");
});

test("automatic switch accepts only the original installer binding",async t=>{
  const shell=process.platform==="win32"?"powershell.exe":"pwsh";
  if(spawnSync(shell,["-NoProfile","-Command","exit 0"]).error){t.skip("PowerShell unavailable");return;}
  const installer=await readFile(fileURLToPath(new URL("../install.ps1",import.meta.url)),"utf8");
  const controller=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const functions=[installer.match(/^function Get-UpdateBindingDigest\([\s\S]*?^\}/m)?.[0],
    controller.match(/^function Assert-AutomaticSwitchBinding\([\s\S]*?^\}/m)?.[0]];
  assert(functions.every(Boolean));
  const command=functions.join("\n")+String.raw`
$ErrorActionPreference='Stop'
$binding=[pscustomobject]@{version='v0.1.62';key_hash=('A'*64);id_hash=('B'*64);execute='C:\Owner Path\rca.exe';arguments='--endpoint "https://example.invalid/"';working_directory='C:\Owner Path'}
$record=[pscustomobject]@{original=$binding.version;key_hash=$binding.key_hash;id_hash=$binding.id_hash}
$action=[pscustomobject]@{Execute=$binding.execute;Arguments=$binding.arguments;WorkingDirectory=$binding.working_directory}
$AutomaticBinding=Get-UpdateBindingDigest $binding
Assert-AutomaticSwitchBinding $record $action
foreach($field in @('original','key_hash','id_hash','Execute','Arguments','WorkingDirectory')){
  $obj=if($field -cin @('original','key_hash','id_hash')){$record}else{$action}
  $before=$obj.$field
  $obj.$field='changed'
  try{Assert-AutomaticSwitchBinding $record $action;throw 'Changed target admitted'}
  catch{if($_.Exception.Message -cne 'Original automatic update target changed'){throw}}
  finally{$obj.$field=$before}
}
Write-Output 'switch-binding-pass'
`;
  const result=spawnSync(shell,["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"switch-binding-pass");
});
