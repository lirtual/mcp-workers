import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const text=readFileSync(fileURLToPath(new URL("../install.ps1",import.meta.url)),"utf8");
test("unattended Windows opt-in is limited to a running, already-paired owner task",()=>{
  for(const part of [
    "Invoke-AgentUpgradeFreeze $identityFile 'freeze'",
    "Invoke-AgentUpgradeFreeze $identityFile 'release'",
    "NamedPipeClientStream",
    "Agent is busy, absent or not frozen",
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
  assert(task.includes("if ($wasRunning -and -not $ownerStopped)"));
});


test("detached Windows Task switch refuses unfrozen Agent immediately before stop",()=>{
  const task=readFileSync(fileURLToPath(new URL("../scripts/windows-user-task.ps1",import.meta.url)),"utf8");
  assert(task.includes("Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen'"));
  const check=task.indexOf("Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen'");
  const stop=task.indexOf("Stop-ScheduledTask -TaskName $name",check);
  assert(check>=0&&stop>check);
  assert(task.includes("RCA_UNATTENDED_UPGRADE -ceq 'owner-approved-task-v1'"));
});
