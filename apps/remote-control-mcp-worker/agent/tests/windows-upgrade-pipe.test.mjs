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

test("automatic one-shot cleanup matches the full original Task definition",async t=>{
  const shell=process.platform==="win32"?"powershell.exe":"pwsh";
  if(spawnSync(shell,["-NoProfile","-Command","exit 0"]).error){t.skip("PowerShell unavailable");return;}
  const source=await readFile(fileURLToPath(new URL("../install.ps1",import.meta.url)),"utf8");
  const fn=source.match(/^function Test-AutomaticTaskDefinition\([\s\S]*?^\}/m)?.[0];
  assert(fn);
  const command=fn+String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$name='RCA-Upgrade-synthetic'
$sid='S-1-5-21-123'
$exe='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$argsText='-NoProfile -File "C:\Owner Path\runner.ps1"'
$task=[pscustomobject]@{TaskName=$name;TaskPath='\';Principal=[pscustomobject]@{RunLevel='Limited';LogonType='Interactive'};Triggers=@();Actions=@([pscustomobject]@{Execute=$exe;Arguments=$argsText;WorkingDirectory=''})}
function valid {Test-AutomaticTaskDefinition $task $name $sid $sid $exe $argsText}
if (-not (valid)) {throw 'Reviewed Task refused'}
foreach($entry in @(
  @{object=$task;field='TaskName';value='RCA-Foreign'},
  @{object=$task;field='TaskPath';value='\Other\'},
  @{object=$task.Principal;field='RunLevel';value='Highest'},
  @{object=$task.Principal;field='LogonType';value='Password'},
  @{object=$task;field='Triggers';value=@('unexpected')},
  @{object=$task.Actions[0];field='Execute';value='C:\Other.exe'},
  @{object=$task.Actions[0];field='Arguments';value='other'},
  @{object=$task.Actions[0];field='WorkingDirectory';value='C:\Other'})){
  $obj=$entry.object;$field=$entry.field;$before=$obj.$field
  $obj.$field=$entry.value
  if(valid){throw "Unreviewed Task accepted: $field"}
  $obj.$field=$before
}
if(Test-AutomaticTaskDefinition $task $name $sid 'S-1-5-18' $exe $argsText){throw 'Foreign principal accepted'}
Write-Output 'task-definition-pass'
`;
  const result=spawnSync(shell,["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"task-definition-pass");
});

test("read-only permanent mode observation coexists with the lifecycle writer guard",async t=>{
  if(process.platform!=="win32"){t.skip("Windows NTFS share modes required");return;}
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const fn=source.match(/^function Read-UpgradeMode\([\s\S]*?^\}/m)?.[0];
  assert(fn);
  const command=fn+String.raw`
$ErrorActionPreference='Stop'
$file=Join-Path ([IO.Path]::GetTempPath()) ('rca-mode-test-'+[guid]::NewGuid().ToString('N'))
try{
  [IO.File]::WriteAllBytes($file,[Text.Encoding]::UTF8.GetBytes("permanent"+[char]10))
  $guard=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
  try{
    if((Read-UpgradeMode $file) -cne ("permanent"+[char]10)){throw 'Mode read failed'}
    $blocked=$false
    try{$other=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read);$other.Dispose()}
    catch{$blocked=$true}
    if(-not $blocked){throw 'Competing writer admitted'}
  }finally{$guard.Dispose()}
}finally{Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue}
Write-Output 'mode-share-pass'
`;
  const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"mode-share-pass");
});

test("#1035 Windows normal restart keeps owner intent and refuses busy or changed process",async t=>{
  const shell=process.platform==="win32"?"powershell.exe":"pwsh";
  if(spawnSync(shell,["-NoProfile","-Command","exit 0"]).error){t.skip("PowerShell unavailable");return;}
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const body=source.slice(source.indexOf("if ($Action -eq 'Restart') {"),source.indexOf("if ($Action -eq 'Switch') {"));
  assert(body.includes("Wait-VersionExited"));
  const fn=body.replace("if ($Action -eq 'Restart') {","function Invoke-TestRestart {").replace("exit 0","return");
  const command=fn+String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$dir=Join-Path ([IO.Path]::GetTempPath()) ('rca-restart-contract-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($dir)
try {
  $root=$dir
  $identityFile=Join-Path $dir 'key'
  $nativeJournal=Join-Path $dir 'journal'
  [IO.File]::WriteAllText($identityFile,'synthetic')
  [IO.File]::WriteAllText($identityFile+'.device-id','aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  $name='fixture';$Version='';$Direction='';$Endpoint=''
  $script:events=@();$script:pidValue=100;$script:busy=$false;$script:failure=$false
  $script:task=[pscustomobject]@{State='Running';Actions=@('reviewed')}
  function Check-Existing {}
  function Check-UpgradeStore {}
  function Get-LocalSwitchCaller { @{ProcessId=200;CreationDate=1} }
  function Read-TaskLaunch { @{Entry=($root+'\v1.2.3-windows-x64\entry');Endpoint='https://example.test/';Generation='fixture'} }
  function Get-ReviewedProgram { @{Tag='v1.2.3'} }
  function New-ReviewedAction { 'reviewed' }
  function Get-OwnedAgentProcess {
    if ($script:task.State -ne 'Running') { throw 'No Agent' }
    [pscustomobject]@{ProcessId=$script:pidValue;CreationDate=1}
  }
  function Assert-UpgradeIdentity { if(Test-Path ($identityFile+'.owner-stopped')){throw 'STOP changed'} }
  function Read-OwnedTask { $script:task }
  function Test-SameAction($a,$b) { $a -ceq $b }
  function Invoke-AgentUpgradeFreeze($key,$action,$allowBusy=$false) {
    $script:events+=@($action)
    if ($action -eq 'freeze' -and $script:busy) { return 'busy' }
  }
  function Stop-ScheduledTask {
    $script:events+=@('stop-task')
    if ($script:failure) { throw 'Fixture stop failed' }
    $script:task.State='Ready'
  }
  function Wait-VersionExited { if($script:task.State -eq 'Running'){throw 'Old process remains'} }
  function Start-ScheduledTask {
    $script:events+=@('start-task')
    $script:task.State='Running';$script:pidValue=101
  }
  function Start-Sleep {}
  function Refused([string]$expectedMessage) {
    try { Invoke-TestRestart | Out-Null }
    catch {
      if ($_.Exception.Message -cne $expectedMessage) {
        throw ('Expected refusal: '+$expectedMessage+'; actual: '+$_.Exception.Message+
          '; events: '+($script:events -join ','))
      }
      return
    }
    throw 'Unexpected restart success'
  }
  [IO.File]::WriteAllText($identityFile+'.owner-stopped','stopped')
  Refused 'Owner STOP or lifecycle pending blocks restart'
  if($script:events.Count){throw 'STOP reached freeze'}
  Remove-Item -LiteralPath ($identityFile+'.owner-stopped')
  $script:busy=$true;Refused 'Agent busy; restart deferred'
  if(($script:events -join ',') -ne 'verify-online,freeze'){throw ('Wrong busy trace: '+($script:events -join ','))}
  $script:busy=$false;$script:failure=$true;$script:events=@()
  Refused 'Fixture stop failed'
  if(($script:events -join ',') -ne 'verify-online,freeze,verify-frozen,stop-task,release'){throw 'Wrong failed restart cleanup'}
  $script:failure=$false;$script:events=@()
  $result=Invoke-TestRestart | ConvertFrom-Json
  if($result.local -ne 'restarted' -or $result.signed_wss -ne 'connected_observed'){throw 'Wrong restart receipt'}
  if(($script:events -join ',') -ne 'verify-online,freeze,verify-frozen,stop-task,start-task,verify-online'){throw 'Wrong successful restart path'}
  if([IO.File]::ReadAllText($identityFile) -ne 'synthetic' -or (Test-Path ($identityFile+'.owner-stopped'))){throw 'Identity or intent changed'}
  'restart-contract-pass'
} finally { Remove-Item -LiteralPath $dir -Recurse -Force }
`;
  const result=spawnSync(shell,["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,encoding:"utf8",timeout:15000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"restart-contract-pass");
});

test("#1035 Windows read-only status is allowed with a pending journal",async t=>{
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const gate=source.split("\n").find(line=>line.includes("Unreconciled native upgrade; preserve versions"));
  assert(gate);
  const shell=process.platform==="win32"?"powershell.exe":"pwsh";
  if(spawnSync(shell,["-NoProfile","-Command","exit 0"]).error){t.skip("PowerShell unavailable");return;}
  const command=String.raw`
$ErrorActionPreference='Stop'
$nativeJournal='fixture'
function Test-Path { return $true }
$Action='Status'
`+gate+String.raw`
foreach($Action in @('Switch','Restart','Stop','Start','Uninstall','VerifyAutomatic')){
  $refused=$false
  try {
`+gate+String.raw`
  }catch{$refused=$true}
  if(-not $refused){throw "Pending journal admitted $Action"}
}
'journal-read-pass'
`;
  const result=spawnSync(shell,["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"journal-read-pass");
});

test("#1035 Windows freeze and restore observe the same reviewed management caller",async t=>{
  const shell=process.platform==="win32"?"powershell.exe":"pwsh";
  if(spawnSync(shell,["-NoProfile","-Command","exit 0"]).error){t.skip("PowerShell unavailable");return;}
  const source=await readFile(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  const functions=["Freeze-OwnedAgent","Wait-OwnedAgent"].map(name=>{
    const fn=source.match(new RegExp("^function "+name+"\\([\\s\\S]*?^\\}","m"))?.[0];
    assert(fn,name);return fn;
  });
  const command=functions.join("\n")+String.raw`
$ErrorActionPreference='Stop'
$identityFile='fixture-key'
$script:caller=[pscustomobject]@{ProcessId=200;CreationDate=1}
$script:required=$true
$script:observations=0
$script:pidValue=100
$script:freezeCount=0
function Read-OwnedTask { [pscustomobject]@{State='Running';Actions=@('reviewed')} }
function Test-SameAction($a,$b) { $a -ceq $b }
function Get-OwnedAgentProcess($program,$managementCaller=$null) {
  $script:observations++
  if ($script:required -and (-not $managementCaller -or
      $managementCaller.ProcessId -ne $script:caller.ProcessId -or
      $managementCaller.CreationDate -ne $script:caller.CreationDate)) {
    throw 'Exact management caller evidence was lost'
  }
  if (-not $script:required -and $managementCaller) { throw 'Unexpected caller exclusion' }
  [pscustomobject]@{ProcessId=$script:pidValue;CreationDate=2}
}
function Invoke-AgentUpgradeFreeze($key,$command,$busy=$false) {
  $script:freezeCount++
}
function Start-Sleep {}
Freeze-OwnedAgent 'fixture' 'reviewed' $false $false $script:caller
$observed=Wait-OwnedAgent 'fixture' 'reviewed' $script:caller
if ($observed.ProcessId -ne 100 -or $script:observations -ne 3 -or $script:freezeCount -ne 2) {
  throw 'Incorrect reviewed process observation'
}
$script:required=$false
Freeze-OwnedAgent 'fixture' 'reviewed'
$observed=Wait-OwnedAgent 'fixture' 'reviewed'
if ($observed.ProcessId -ne 100 -or $script:observations -ne 6) { throw 'Ordinary caller contract changed' }
'caller-propagation-pass'
`;
  const result=spawnSync(shell,["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,encoding:"utf8",timeout:15000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),"caller-propagation-pass");
});
