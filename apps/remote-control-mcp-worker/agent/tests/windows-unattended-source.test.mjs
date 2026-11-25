import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const text=readFileSync(fileURLToPath(new URL("../install.ps1",import.meta.url)),"utf8");
test("unattended Windows opt-in is limited to a running, already-paired owner task",()=>{
  for(const part of [
    "RCA_UNATTENDED_UPGRADE -ceq 'owner-approved-task-v1'",
    "RCA_UNATTENDED_UPGRADE -ceq 'launch-approved-task-v1'",
    "New-ScheduledTaskPrincipal -UserId $me.Name -LogonType Interactive -RunLevel Limited",
    "New-ScheduledTask -Action $taskAction -Principal $taskPrincipal -Settings $taskSettings",
    "Start-ScheduledTask -TaskName $name -ErrorAction Stop",
    "upgrade-result-",
    "upgrade-claim-",
    "[IO.FileMode]::CreateNew",
    "-not $alreadyPaired -or -not $task",
    "$task.State -ne 'Running'",
    ".owner-stopped",
    "-not $detachedUpgrade -and -not (Confirm-Upgrade",
    "Local switch returned; independent signed-WSS verification required.",
    "if ($detachedUpgrade -and $StageOnly)",
    "https://api.github.com/repos/lirtual/mcp-workers/releases/latest",
    "SelectedTag",
    "SelectedReleaseSha256",
    "No stable Agent Release is published",
    "GitHub rate limit reached; installation stopped",
    "Windows x64 Agent asset is missing",
    "Owner STOP preserved. Agent was not started.",
    "redirects -eq 3",
    "GitHub Release asset redirect limit exceeded",
    "ZIP links forbidden",
    "Release asset size mismatch",
  ]) assert(text.includes(part),part);
  assert.equal(text.split("releases/latest").length,2);
  assert.equal(text.includes("PinnedCommit"),false);
  assert.equal(text.includes("raw.githubusercontent.com"),false);
  assert.equal(text.includes("github.com/lirtual/remote-control-agent"),false);
  const task=readFileSync(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  assert(task.includes("Assert-UpgradeIdentity $record"));
  assert(task.includes("NamedPipeClientStream"));
  assert(task.includes("Agent is busy, absent or not frozen"));
});


test("detached Windows Task switch refuses unfrozen Agent immediately before stop",()=>{
  const task=readFileSync(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  assert(task.includes("Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen'"));
  const check=task.indexOf("Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen'");
  const stop=task.indexOf("Stop-ScheduledTask -TaskName $name",check);
  assert(check>=0&&stop>check);
  assert(text.includes("RCA_UNATTENDED_UPGRADE -ceq 'owner-approved-task-v1'"));
  assert(task.includes("Freeze-OwnedAgent $original $oldAction"));
});

test("native detached upgrade admits only reviewed existing Task switch, not onboarding",()=>{
  assert.match(text,/\$nativeDetachedUpgrade = \$detachedUpgrade -and \$upgradeExisting -and \$alreadyPaired -and/);
  assert.ok(text.includes("Resolve-ReviewedNativeRelease $Version $releaseSha $true"));
  const complete=text.slice(text.indexOf("function Complete-NativeInstall"),text.indexOf("function Confirm-Upgrade"));
  assert.ok(complete.includes("if ($detachedUpgrade -and -not $nativeDetachedUpgrade)"));
  assert.ok(complete.includes("if (-not $nativeDetachedUpgrade -and ([Console]::IsInputRedirected"));
  assert.ok(complete.includes("if ($detachedUpgrade) { throw 'Owner STOP blocks detached native upgrade' }"));
  assert.ok(complete.indexOf("-Action Switch -Version $Version -Direction Upgrade") < complete.indexOf("if ($detachedUpgrade) { throw 'Detached native installation is not permitted' }"));
  assert.ok(complete.indexOf("if ($detachedUpgrade) { throw 'Detached native installation is not permitted' }") < complete.indexOf("--pair-local"));
});

test("attended Latest update is limited to existing installation and the bare CLI verbs",()=>{
  const builder=readFileSync(fileURLToPath(new URL("../scripts/build-windows-preview.mjs",import.meta.url)),"utf8");
  assert(builder.includes('if "%~1"=="update" if "%2"=="" goto :attended_update'));
  assert(builder.includes('if "%~1"=="upgrade" if "%2"=="" goto :attended_update'));
  assert(builder.includes('--cli %*'));
  assert(builder.includes('windows-stage-install.ps1" -UpdateOnly'));
  const entry=text.indexOf('$attendedBinding = $null');
  const preflight=text.indexOf('$attendedBinding = Get-AttendedUpdateBinding',entry);
  const latest=text.indexOf('$latest = Resolve-LatestAgentRelease',preflight);
  assert(entry>=0&&preflight>entry&&latest>preflight);
  const complete=text.slice(text.indexOf("function Complete-NativeInstall"),text.indexOf("function Confirm-Upgrade"));
  assert(complete.indexOf("Assert-AttendedUpdateTarget")<complete.indexOf("-Action Switch -Version"));
  assert(complete.includes("Update cannot install or pair a device"));
  assert(complete.includes("Owner STOP blocks attended native upgrade"));
});

test("automatic dispatch and result use one operation ID and uncertain outcomes retain evidence",()=>{
  const task=readFileSync(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  assert.match(text,/-AutomaticOperation '\{4\}'" -f .*\$operation/);
  assert.match(text,/-AutomaticOperation \$AutomaticOperation/);
  assert.match(task,/operation_id=\$AutomaticOperation/);
  assert.match(text,/\$result -in @\('local_switch_returned','pre_switch_refused'\) -and -not \(Test-Path/);
  assert.match(text,/\$Automatic -and \$detachedUpgrade -and -not \$automaticSwitchDispatched/);
  assert.match(text,/Write-Output 'automatic-pre-switch-refused'/);
  assert.match(task,/\[bool\]\$Automatic -ne \[bool\]\$AutomaticOperation/);
});


test("attended Windows installer identifies the verified package manager without changing PATH",()=>{
  const complete=text.slice(text.indexOf("function Complete-NativeInstall"),text.indexOf("function Confirm-Upgrade"));
  const verified=complete.indexOf("verify-windows-native.ps1");
  const manager=complete.indexOf("Join-Path $directory 'rca.cmd'");
  const hint=complete.indexOf('Write-Host "Local manager for this verified package: $managerCommand --help');
  assert.ok(verified>=0&&manager>verified&&hint>manager);
  assert.ok(complete.includes('if (-not $detachedUpgrade) {\n    Write-Host "Local manager for this verified package: $managerCommand --help'));
  assert.ok(complete.includes('$managerCommand update --auto off'));
  assert.ok(complete.includes('$managerCommand status'));
});
