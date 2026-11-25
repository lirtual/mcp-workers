# Windows native Remote Control user task; only interactive user logon.
# Does not create an elevated service, use a password or touch cloud grants.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Start','Stop','Restart','Uninstall','Disable','Status','Switch','Endpoint','VerifyActivation','RecoverNativeUpgrade','ActivateNative','EnableNative','ConfirmStopped','VerifyAutomatic')][string]$Action,
  [string]$Endpoint,
  [string]$Version, [ValidateSet('Upgrade')][string]$Direction,
  [string]$Generation,
  [switch]$Automatic,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$AutomaticBinding,
  [ValidatePattern('^[0-9a-f]{32}$')][string]$AutomaticOperation
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not $env:LOCALAPPDATA) {
  throw 'Native Windows user session required'
}
# An owner controller may be launched from PowerShell 7 or a restricted
# inherited PSModulePath. Resolve Utility from this Windows PowerShell
# installation, not the caller's module search path (notably Get-FileHash).
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.IsSystem) { throw 'System identity rejected' }
$sid = $identity.User.Value
$name = 'RCA-Remote-Control-v2-' + $sid.Replace('-', '_')
$root = [IO.Path]::GetFullPath([IO.Path]::Combine(
  $env:LOCALAPPDATA,'mcp-workers','remote-control','programs'))
$tasks = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ieq $name })
if ($tasks.Count -gt 1) { throw 'Ambiguous owner Task' }
$task = if ($tasks.Count -eq 1) { $tasks[0] } else { $null }
function Check-Program([string]$launcherPath, [string]$entryPath) {
  if ($launcherPath -match '[";]' -or $entryPath -match '[";]') { throw 'Invalid program path' }
  $n = [IO.Path]::GetFullPath($launcherPath)
  $e = [IO.Path]::GetFullPath($entryPath)
  if (-not $n.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase) -or
      -not $e.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Only private versioned program directories are allowed'
  }
  $relative = $n.Substring($root.Length + 1)
  $version = ($relative -split '\\')[0]
  if ($version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-rust-candidate\.[1-9][0-9]*)?-windows-x64$' -or
      $relative -ine ($version + '\bin\rca-background.exe') -or
      $e.Substring($root.Length + 1) -ine ($version + '\apps\remote-control-agent\.build\rca-standard-windows-candidate.exe')) {
    throw 'Untrusted native Agent version or entrypoint; reinstall retired Node Agents'
  }
  foreach ($file in @($n,$e)) {
    $item = Get-Item -LiteralPath $file -Force
    if ($item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Linked or missing program entry'
    }
  }
}
function Read-TaskLaunch([object]$actionInfo) {
  $arguments = [string]$actionInfo.Arguments
  if ($arguments -cnotmatch '^"([^"]+)" --service --endpoint "(https://[A-Za-z0-9.-]+(?::[0-9]+)?/)" --generation "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})"$') {
    throw 'Untrusted native scheduled task arguments; reinstall retired Node Agents'
  }
  $entryPath = $Matches[1]
  $endpointValue = $Matches[2]
  $generationValue = $Matches[3]
  Check-Program ([string]$actionInfo.Execute) $entryPath
  return [pscustomobject]@{ Entry = $entryPath; Endpoint = $endpointValue; Generation = $generationValue }
}
function Check-Existing {
  if (-not $task) { throw 'Agent task not installed' }
  # Task Scheduler may return the principal as a local account name,
  # DOMAIN\user, or SID. Resolve to the same immutable Windows SID rather
  # than weakening the owner boundary with string/name comparisons.
  try {
    $principalId = [string]$task.Principal.UserId
    if ($principalId -match '^S-1-[0-9]+(?:-[0-9]+)+$') {
      $taskUserSid = ([Security.Principal.SecurityIdentifier]::new($principalId)).Value
    } else {
      $account = [Security.Principal.NTAccount]::new($principalId)
      $taskUserSid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
    }
  } catch {
    throw 'Task principal identity cannot be verified'
  }
  if ($taskUserSid -cne $sid -or
      [string]$task.Principal.RunLevel -ne 'Limited' -or
      [string]$task.Principal.LogonType -notin @('Interactive','InteractiveToken') -or
      $task.Actions.Count -ne 1 -or $task.Triggers.Count -ne 1) {
    throw 'Task identity, permissions or trigger changed'
  }
  $actionInfo = $task.Actions[0]
  $null = Read-TaskLaunch $actionInfo
  if ([string]$task.Triggers[0].CimClass.CimClassName -notlike '*LogonTrigger') {
    throw 'Unexpected task trigger'
  }
}
if ($Automatic -and $Action -ne 'Switch') { throw 'Automatic authority is only valid for Switch' }
if ([bool]$Automatic -ne [bool]$AutomaticBinding -or [bool]$Automatic -ne [bool]$AutomaticOperation) { throw 'Automatic switch requires its original target binding' }
if ($Action -ne 'VerifyActivation' -and $Generation) { throw 'Unexpected generation argument' }
function Confirm-NativeActivation([string]$Version,[string]$Generation) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
  # A fresh signed activation receipt must belong to this exact running
  # user Task and its child executable. Running alone is never sufficient.
  Check-Existing
  if ($Version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$' -or
      $Generation -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') {
    throw 'Invalid expected activation identity'
  }
  $versionDir = [IO.Path]::Combine($root,$Version + '-windows-x64')
  $launcher = [IO.Path]::Combine($versionDir,'bin','rca-background.exe')
  $rustEntry = [IO.Path]::Combine($versionDir,'apps','remote-control-agent','.build','rca-standard-windows-candidate.exe')
  $launch = Read-TaskLaunch $task.Actions[0]
  if ($task.State -ne 'Running' -or $launch.Generation -cne $Generation -or
      -not [string]::Equals([string]$task.Actions[0].Execute,$launcher,[StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$launch.Entry,$rustEntry,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Expected native Task is not running'
  }
  try {
    # A missing proof is normal during bounded startup polling. Keep the
    # exit-code and proof validation authoritative; report only the contextual failure.
    $raw = & $rustEntry --verify-activation-proof $Generation 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Native activation receipt unavailable' }
    $proof = $raw | ConvertFrom-Json
  } catch { throw 'Signed WSS activation not confirmed' }
  if ($proof.generation -cne $Generation -or $proof.state -cne 'connected' -or
      $proof.pid -le 0 -or $proof.pid -gt [uint32]::MaxValue) {
    throw 'Signed WSS activation not confirmed'
  }
  $agentProcess = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [uint32]$proof.pid)
  if (-not $agentProcess -or
      -not [string]::Equals([string]$agentProcess.ExecutablePath,$rustEntry,[StringComparison]::OrdinalIgnoreCase) -or
      (Invoke-CimMethod -InputObject $agentProcess -MethodName GetOwnerSid).Sid -cne $sid) {
    throw 'Signed WSS activation process not confirmed'
  }
  $parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [uint32]$agentProcess.ParentProcessId)
  if (-not $parent -or
      -not [string]::Equals([string]$parent.ExecutablePath,$launcher,[StringComparison]::OrdinalIgnoreCase) -or
      (Invoke-CimMethod -InputObject $parent -MethodName GetOwnerSid).Sid -cne $sid) {
    throw 'Signed WSS activation launcher not confirmed'
  }
  $startedAt = ([DateTimeOffset]([datetime]$agentProcess.CreationDate)).ToUnixTimeMilliseconds()
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($proof.at -lt $startedAt -or $proof.at -gt $now -or $now - $proof.at -gt 90000) {
    throw 'Signed WSS activation evidence is stale'
  }
  $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
  Check-Existing
  $currentLaunch = Read-TaskLaunch $task.Actions[0]
  if ($task.State -ne 'Running' -or $currentLaunch.Generation -cne $Generation -or
      $currentLaunch.Endpoint -cne $launch.Endpoint -or
      -not [string]::Equals([string]$task.Actions[0].Execute,$launcher,[StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$currentLaunch.Entry,$rustEntry,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Expected native Task changed during activation observation'
  }
  return $true
}
if ($Action -eq 'VerifyActivation') {
  if ($Direction -or $Endpoint) { throw 'Unexpected activation arguments' }
  $null = Confirm-NativeActivation $Version $Generation
  'authenticated-activation-observed'
  exit 0
}
if ($Action -eq 'Endpoint') {
  Check-Existing
  (Read-TaskLaunch $task.Actions[0]).Endpoint
  exit 0
}
function Register-OwnedTask($scheduledAction) {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $name -Action $scheduledAction -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
}
# The protocol's LF is mandatory; ReadLineAsync alone also accepts partial EOF.
function Read-AgentUpgradeReply($reader) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $chars = [char[]]::new(1)
  $answer = ''
  for ($i=0; $i -lt 9; $i++) {
    $remaining = 10000 - [int]$clock.ElapsedMilliseconds
    if ($remaining -le 0) { throw 'Agent upgrade pipe response not confirmed' }
    $pending = $reader.ReadAsync($chars,0,1)
    if (-not $pending.Wait($remaining) -or $pending.GetAwaiter().GetResult() -ne 1) {
      throw 'Agent upgrade pipe response not confirmed'
    }
    if ($chars[0] -ceq [char]10) { return $answer }
    $answer += $chars[0]
  }
  throw 'Agent upgrade pipe response not confirmed'
}

function Invoke-AgentUpgradeFreeze([string]$keyPath,[string]$action,[bool]$allowBusy=$false) {
  if ($action -cnotin @('freeze','verify-frozen','verify-online','release')) { throw 'Invalid upgrade action' }
  $canonical = $keyPath.Replace('/','\').ToLowerInvariant()
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($sha.ComputeHash(
      [Text.Encoding]::UTF8.GetBytes($canonical))).Replace('-','').ToLowerInvariant().Substring(0,32)
  } finally { $sha.Dispose() }
  $pipe = [IO.Pipes.NamedPipeClientStream]::new(
    '.', 'rca-upgrade-' + $hash, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None)
  try {
    $pipe.Connect(10000)
    # The protocol accepts only ASCII action names and exact LF.
    # StreamWriter with Encoding.UTF8 would prepend a BOM to the first frame.
    $requestBytes = [Text.Encoding]::ASCII.GetBytes($action + "`n")
    $pipe.Write($requestBytes,0,$requestBytes.Length)
    $pipe.Flush()
    $reader = [IO.StreamReader]::new($pipe,[Text.Encoding]::ASCII,$false,1024,$true)
    try {
      $answer = Read-AgentUpgradeReply $reader
      $expected = if ($action -ceq 'release') { 'released' } else { 'ready' }
      if ($allowBusy -and $action -ceq 'freeze' -and $answer -ceq 'busy') { return 'busy' }
      if ($answer -cne $expected) { throw 'Agent is busy, absent or not frozen' }
    } finally { $reader.Dispose() }
  } finally { $pipe.Dispose() }
}

function Assert-PrivateVersion([string]$directory) {
  foreach ($folder in @($root, $directory)) {
    $item = Get-Item -LiteralPath $folder -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Untrusted version directory'
    }
    $acl = [IO.Directory]::GetAccessControl($folder)
    if (-not $acl.AreAccessRulesProtected -or
        $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) {
      throw 'Untrusted version owner'
    }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
          @($sid,'S-1-5-18') -notcontains $rule.IdentityReference.Value) {
        throw 'Unexpected version ACL'
      }
    }
  }
}

$identityRoot = [IO.Path]::GetDirectoryName($root)
$identityFile = [IO.Path]::Combine($identityRoot,'v2-identity.pem')
$nativeJournal = [IO.Path]::Combine($identityRoot,'windows-native-upgrade.json')

# Reconstruct actions only from validated, owner-private version directories;
# the durable journal does not contain arbitrary executable paths.
function Get-ReviewedProgram([string]$versionTag) {
  if ($versionTag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$') { throw 'Invalid installed version' }
  $directory = [IO.Path]::Combine($root,$versionTag + '-windows-x64')
  Assert-PrivateVersion $directory
  $manifestPath = Join-Path $directory 'bundle.json'
  $item = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Untrusted bundle manifest' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.version -cne $versionTag -or $manifest.upgrade_profile -cne 'paired-full-v1') {
    throw 'Unreviewed installed version'
  }
  $profile = $manifest.PSObject.Properties['artifact_profile']
  $runtime = $manifest.PSObject.Properties['agent_runtime']
  if ($null -eq $profile -or $profile.Value -cne 'rust-native-only-v1' -or
      $null -eq $runtime -or $runtime.Value -cne 'rust-standard-windows-v1') { throw 'Unreviewed installed native runtime' }
  $launcher = [IO.Path]::Combine($directory,'bin','rca-background.exe')
  $scripts = [IO.Path]::Combine($directory,'apps','remote-control-agent','scripts')
  $entry = [IO.Path]::Combine($directory,'apps','remote-control-agent','.build','rca-standard-windows-candidate.exe')
  Check-Program $launcher $entry
  & (Join-Path $scripts 'verify-windows-native.ps1') -Root $directory -Version $versionTag | Out-Null
  [pscustomobject]@{ Root=$directory; Tag=$versionTag; Launcher=$launcher; Entry=$entry; Process=$entry; Scripts=$scripts }
}

function New-ReviewedAction($program,[string]$endpointValue,[string]$generationValue) {
  if ($endpointValue -cnotmatch '^https://[A-Za-z0-9.-]+(?::[0-9]+)?/$') { throw 'Invalid saved endpoint' }
  if ($generationValue -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { throw 'Invalid saved generation' }
  $arguments = '"' + $program.Entry + '" --service --endpoint "' + $endpointValue + '" --generation "' + $generationValue + '"'
  New-ScheduledTaskAction -Execute $program.Launcher -Argument $arguments -WorkingDirectory ([IO.Path]::GetDirectoryName($program.Entry))
}
function Test-SameAction($a,$b) {
  [string]::Equals([string]$a.Execute,[string]$b.Execute,[StringComparison]::OrdinalIgnoreCase) -and
    [string]$a.Arguments -ceq [string]$b.Arguments -and
    [string]::Equals([string]$a.WorkingDirectory,[string]$b.WorkingDirectory,[StringComparison]::OrdinalIgnoreCase)
}
function Read-OwnedTask {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
  Check-Existing
  $task
}
function Get-OwnedAgentProcess($program,$managementCaller=$null) {
  $matches = @(Get-CimInstance Win32_Process -Filter ("Name = '" + [IO.Path]::GetFileName($program.Process) + "'") -ErrorAction Stop |
    Where-Object {
      $_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$program.Process,[StringComparison]::OrdinalIgnoreCase) -and
        (-not $managementCaller -or $_.ProcessId -ne $managementCaller.ProcessId -or $_.CreationDate -ne $managementCaller.CreationDate)
    })
  if ($matches.Count -ne 1 -or (Invoke-CimMethod -InputObject $matches[0] -MethodName GetOwnerSid).Sid -cne $sid) {
    throw 'Unique owner Agent process not confirmed'
  }
  $parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [uint32]$matches[0].ParentProcessId) -ErrorAction Stop
  if (-not $parent -or -not [string]::Equals($parent.ExecutablePath,$program.Launcher,[StringComparison]::OrdinalIgnoreCase) -or
      (Invoke-CimMethod -InputObject $parent -MethodName GetOwnerSid).Sid -cne $sid) { throw 'Owner Agent launcher not confirmed' }
  $matches[0]
}
# Management CLI and Agent may share the same versioned executable. Only
# the exact same-owner direct parent running a known local management
# command may be excluded from exit observation; never exclude a service.
function Get-LocalSwitchCaller([string]$directionValue,[string]$versionTag) {
  $controller = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $PID) -ErrorAction Stop
  $caller = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [uint32]$controller.ParentProcessId) -ErrorAction Stop
  if (-not $caller -or -not $caller.ExecutablePath -or -not $caller.CommandLine -or
      $caller.CreationDate -gt $controller.CreationDate) { return }
  $exe = [string]$caller.ExecutablePath
  $prefix = $root.TrimEnd('\') + '\'
  if (-not $exe.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { return }
  $relative = $exe.Substring($prefix.Length)
  $versionPrefix = '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?-windows-x64'
  $expected = '^"?' + [regex]::Escape($exe) + '"?\s+'
  if ($relative -match ($versionPrefix + '\\apps\\remote-control-agent\\\.build\\rca-standard-windows-candidate\.exe$')) {
    if ($directionValue -eq 'Upgrade') {
      $expected += '--cli\s+(?:upgrade|update)\s+--version\s+"?' + [regex]::Escape($versionTag) + '"?\s*$'
    } elseif ($directionValue -eq 'Recover') {
      $expected += '--cli\s+recover\s*$'
    } elseif ($directionValue -eq 'Restart') {
      $expected += '--cli\s+restart\s*$'
    } elseif ($directionValue -eq 'Status') {
      $expected += '--cli\s+(?:status|doctor)(?:\s+--json)?\s*$'
    } elseif ($directionValue -in @('RePair','Onboard')) {
      $command = if ($directionValue -eq 'RePair') {'re-pair'} else {'onboard'}
      $explicit = '--cli\s+' + $command + '\s+--endpoint\s+"?' + [regex]::Escape($versionTag) + '"?\s*$'
      $expected += if ($directionValue -eq 'Onboard') { '(?:' + $explicit + '|--cli\s+pair\s*$)' } else { $explicit }
    } else { return }
  } else { return }
  if ($caller.CommandLine -notmatch $expected -or
      (Invoke-CimMethod -InputObject $caller -MethodName GetOwnerSid -ErrorAction Stop).Sid -cne $sid) { return }
  $caller
}
function Wait-VersionExited($program,$managementCaller=$null) {
  $prefix = $program.Root.TrimEnd('\') + '\'
  for ($i=0; $i -lt 40; $i++) {
    $live = @(Get-CimInstance Win32_Process -Filter "Name = 'rca-background.exe' OR Name = 'rca-standard-windows-candidate.exe'" -ErrorAction Stop |
      Where-Object {
        if ($managementCaller -and $_.ProcessId -eq $managementCaller.ProcessId -and
            $_.CreationDate -eq $managementCaller.CreationDate -and
            [string]::Equals($_.ExecutablePath,$managementCaller.ExecutablePath,[StringComparison]::OrdinalIgnoreCase)) {
          $false
        } elseif ($_.ExecutablePath) {
          ([string]$_.ExecutablePath).StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)
        } else {
          # A relevant process with unknown owner/path cannot prove exit.
          $ownerInfo = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop
          $ownerInfo.ReturnValue -ne 0 -or $ownerInfo.Sid -ceq $sid
        }
      })
    if ($live.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }
  throw 'Previous Agent process exit not confirmed'
}
function Wait-OwnedAgent($program,$expectedAction,$managementCaller=$null) {
  for ($i=0; $i -lt 40; $i++) {
    $observed = Read-OwnedTask
    if (-not (Test-SameAction $observed.Actions[0] $expectedAction)) { throw 'Task action drift' }
    if ($observed.State -eq 'Running') {
      try { return Get-OwnedAgentProcess $program $managementCaller } catch { }
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'Restored owner Agent process not confirmed'
}
function Assert-UpgradeIdentity($record) {
  if ((Test-Path -LiteralPath ($identityFile + '.owner-stopped')) -or
      (Get-FileHash -LiteralPath $identityFile -Algorithm SHA256).Hash -cne $record.key_hash -or
      (Get-FileHash -LiteralPath ($identityFile + '.device-id') -Algorithm SHA256).Hash -cne $record.id_hash) {
    throw 'Owner STOP or paired identity changed during upgrade'
  }
}
function Assert-UpgradeState($program,$record) {
  Assert-UpgradeIdentity $record
  & $program.Entry --verify-upgrade-state
  if ($LASTEXITCODE -ne 0) { throw 'Receipt compatibility or private identity not confirmed' }
}

# Read-only observation must coexist with the existing exclusive writer
# lifecycle guard. The reader never requests write access.
function Read-UpgradeMode([string]$file) {
  $stream = [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  try {
    if ($stream.Length -ne 10) { throw 'Existing permanent owner Agent required' }
    $reader = [IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$false,128,$true)
    try { $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
}
function Check-UpgradeStore {
  & (Join-Path $PSScriptRoot 'windows-private-store.ps1') -Action Check -Directory $identityRoot
  if ((Read-UpgradeMode ($identityFile + '.install-mode')) -cne ("permanent" + [char]10)) {
    throw 'Existing permanent owner Agent required'
  }
}
# Reuse the installed Rust identity/policy reader and the live owner-local
# signed-connection observation. Running Task or historical proof is not enough.
function Test-AutomaticResultTransition($prior,[string]$target,[string]$action) {
  if ($prior -and $prior.status -ceq 'failed_recovered') {
    if ($action -ceq 'waiting_idle') { return $false }
    if ($action -ceq 'admit' -and $prior.target_version -ceq $target) { return $false }
  }
  return $true
}
function Get-NativeAutomaticResult {
  $file = $identityFile + '.native-upgrade-result'
  if (-not (Test-Path -LiteralPath $file)) { return }
  Check-UpgradeStore
  $item = Get-Item -LiteralPath $file -Force
  if ($item.Length -lt 1 -or $item.Length -gt 512) { throw 'Untrusted automatic update result' }
  $result = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  $stable = '^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$'
  if (@($result.PSObject.Properties).Count -ne 6 -or
      $result.device_id -isnot [string] -or
      $result.device_id -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or
      $result.operation_id -isnot [string] -or $result.operation_id -cnotmatch '^[a-f0-9]{32}$' -or
      $result.target_version -isnot [string] -or $result.target_version -cnotmatch $stable -or
      $result.installed_version -isnot [string] -or $result.installed_version -cnotmatch $stable -or
      ($result.updated_at_unix_ms -isnot [long] -and $result.updated_at_unix_ms -isnot [int]) -or
      $result.updated_at_unix_ms -lt 0 -or $result.updated_at_unix_ms -gt 9007199254740991 -or
      $result.status -isnot [string] -or $result.status -cnotin @('success','failed_recovered','waiting_idle') -or
      (($result.status -ceq 'success') -ne ($result.installed_version -ceq $result.target_version))) {
    throw 'Untrusted automatic update result'
  }
  if ($result.device_id -ceq (Get-Content -LiteralPath ($identityFile + '.device-id') -Raw).Trim()) { return $result }
}
function Write-NativeAutomaticResult($record,[string]$status) {
  Assert-UpgradeIdentity $record
  $prior = Get-NativeAutomaticResult
  if (-not (Test-AutomaticResultTransition $prior $record.target $status)) { return }
  $result = @{
    device_id=(Get-Content -LiteralPath ($identityFile + '.device-id') -Raw).Trim()
    operation_id=$AutomaticOperation
    target_version=$record.target
    installed_version=$(if ($status -ceq 'success') { $record.target } else { $record.original })
    status=$status
    updated_at_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  $file = $identityFile + '.native-upgrade-result'
  $stage = Join-Path $identityRoot ('.auto-result-' + [guid]::NewGuid().ToString('N'))
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Compress))
    $stream = [IO.File]::Open($stage,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $file) { [IO.File]::Replace($stage,$file,[NullString]::Value) }
    else { [IO.File]::Move($stage,$file) }
    Check-UpgradeStore
  } finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage } }
}
function Assert-AutomaticEligibility($program,$expectedAction,[string]$target='') {
  Check-UpgradeStore
  if ($program.Tag -cnotmatch '^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$') {
    throw 'Automatic update requires Stable'
  }
  foreach ($suffix in @('.owner-stopped','.activation-pending','.device-id.pending')) {
    if (Test-Path -LiteralPath ($identityFile + $suffix)) { throw 'Automatic update blocked by lifecycle state' }
  }
  $current = Read-OwnedTask
  if ($current.State -ne 'Running' -or -not (Test-SameAction $current.Actions[0] $expectedAction)) {
    throw 'Automatic update target changed'
  }
  $before = Get-OwnedAgentProcess $program
  $raw = & $program.Entry --cli status --json
  if ($LASTEXITCODE -ne 0) { throw 'Automatic update policy unconfirmed' }
  $facts = $raw | ConvertFrom-Json
  if ($facts.identity_present -ne $true -or $facts.automatic_update -cne 'on') {
    throw 'Automatic update policy is not enabled'
  }
  $prior = Get-NativeAutomaticResult
  if ($target -and -not (Test-AutomaticResultTransition $prior $target 'admit')) {
    throw 'Previously recovered failed version suppressed for automatic update'
  }
  Invoke-AgentUpgradeFreeze $identityFile 'verify-online'
  $after = Get-OwnedAgentProcess $program
  if ($after.ProcessId -ne $before.ProcessId -or $after.CreationDate -ne $before.CreationDate) {
    throw 'Automatic update Agent changed'
  }
}
function Freeze-OwnedAgent($program,$expectedAction,[bool]$recovering=$false,[bool]$allowBusy=$false,$managementCaller=$null) {
  $observed = Read-OwnedTask
  if ($observed.State -ne 'Running' -or -not (Test-SameAction $observed.Actions[0] $expectedAction)) {
    throw 'Agent task changed before freeze'
  }
  $process = Get-OwnedAgentProcess $program $managementCaller
  if ($recovering) {
    try { Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen' }
    catch { Invoke-AgentUpgradeFreeze $identityFile 'freeze' }
  } else {
    if ((Invoke-AgentUpgradeFreeze $identityFile 'freeze' $allowBusy) -ceq 'busy') { return 'busy' }
  }
  Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen'
  $after = Read-OwnedTask
  $currentProcess = Get-OwnedAgentProcess $program $managementCaller
  if ($after.State -ne 'Running' -or -not (Test-SameAction $after.Actions[0] $expectedAction) -or
      $currentProcess.ProcessId -ne $process.ProcessId -or $currentProcess.CreationDate -ne $process.CreationDate) {
    throw 'Agent changed during freeze'
  }
}
function Restore-NativeOriginal($record,$original,$target,$oldAction,$newAction,$managementCaller=$null) {
  Assert-UpgradeIdentity $record
  $current = Read-OwnedTask
  if (Test-SameAction $current.Actions[0] $newAction) {
    if ($current.State -eq 'Running') {
      Freeze-OwnedAgent $target $newAction $true $false $managementCaller
      Stop-ScheduledTask -TaskName $name -ErrorAction Stop
    }
    Wait-VersionExited $target $managementCaller
    Assert-UpgradeState $target $record
    $current = Read-OwnedTask
    if ($current.State -eq 'Running' -or -not (Test-SameAction $current.Actions[0] $newAction)) {
      throw 'Target Task changed during rollback'
    }
    Set-ScheduledTask -TaskName $name -Action $oldAction -ErrorAction Stop | Out-Null
  } elseif (-not (Test-SameAction $current.Actions[0] $oldAction)) {
    throw 'Unknown Task action; no automatic recovery permitted'
  }
  Wait-VersionExited $target $managementCaller
  Assert-UpgradeIdentity $record
  $current = Read-OwnedTask
  if (-not (Test-SameAction $current.Actions[0] $oldAction)) { throw 'Previous task action not restored' }
  if ($current.State -eq 'Running') {
    $null = Get-OwnedAgentProcess $original $managementCaller
    Invoke-AgentUpgradeFreeze $identityFile 'release'
  } else {
    Wait-VersionExited $original $managementCaller
    Assert-UpgradeState $target $record
    Start-ScheduledTask -TaskName $name -ErrorAction Stop
  }
  $null = Wait-OwnedAgent $original $oldAction $managementCaller
  Assert-UpgradeIdentity $record
}

# The journal doubles as the exclusive per-owner transaction lock. A killed
# updater cannot silently discard it; attended recovery never replays upgrade.
function Open-NativeJournal {
  Check-UpgradeStore
  $item = Get-Item -LiteralPath $nativeJournal -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $item.Length -lt 1 -or $item.Length -gt 4096) { throw 'Untrusted native upgrade journal' }
  [IO.File]::Open($nativeJournal,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}
# Forward native versions: numeric increase, or candidate to final Stable.
# Candidate-to-candidate replacement at the same number remains forbidden.
function Test-NativeForwardVersion([string]$original,[string]$target) {
  if ($original -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$' -or
      $target -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-rust-candidate\.[1-9][0-9]*)?$') { return $false }
  $old = [version](($original.Substring(1) -split '-')[0])
  $new = [version](($target.Substring(1) -split '-')[0])
  return ($new -gt $old -or ($new -eq $old -and
      $original -cmatch '-rust-candidate\.[1-9][0-9]*$' -and $target -cnotmatch '-'))
}
function Read-NativeJournal($stream) {
  $reader = [IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$false,4096,$true)
  try { $record = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  if ($record.schema -ne 1 -or
      $record.key_hash -cnotmatch '^[A-F0-9]{64}$' -or $record.id_hash -cnotmatch '^[A-F0-9]{64}$' -or
      -not (Test-NativeForwardVersion $record.original $record.target)) {
    throw 'Unreviewed native upgrade journal'
  }
  $record
}
# Match the installer digest of the reviewed version, identity and exact Task.
function Assert-AutomaticSwitchBinding($record,$action) {
  $bytes = [Text.Encoding]::UTF8.GetBytes((@($record.original,$record.key_hash,$record.id_hash,
    [string]$action.Execute,[string]$action.Arguments,[string]$action.WorkingDirectory) | ConvertTo-Json -Compress))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
  if ($digest -cne $AutomaticBinding) { throw 'Original automatic update target changed' }
}
function Invoke-NativeUpgrade([string]$oldVersion,[string]$newVersion,$launch) {
  $managementCaller = Get-LocalSwitchCaller 'Upgrade' $newVersion
  Check-UpgradeStore
  $original = Get-ReviewedProgram $oldVersion
  $target = Get-ReviewedProgram $newVersion
  $oldAction = New-ReviewedAction $original $launch.Endpoint $launch.Generation
  $generationValue = [guid]::NewGuid().ToString('D')
  $newAction = New-ReviewedAction $target $launch.Endpoint $generationValue
  $observed = Read-OwnedTask
  if ($observed.State -ne 'Running' -or -not (Test-SameAction $observed.Actions[0] $oldAction)) {
    throw 'Existing reviewed running Task required'
  }
  if ($Automatic) {
    if ($newVersion -cnotmatch '^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$') { throw 'Automatic target must be Stable' }
    Assert-AutomaticEligibility $original $oldAction $newVersion
  }
  Wait-VersionExited $target $managementCaller
  $raw = & $target.Entry --cli status --json
  if ($LASTEXITCODE -ne 0) { throw 'Candidate local identity validation failed' }
  $localStatus = $raw | ConvertFrom-Json
  if ($localStatus.identity_present -ne $true -or
      $localStatus.device_id -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { throw 'Existing paired identity required' }
  $record = [pscustomobject]@{ schema=1; original=$oldVersion; target=$newVersion;
    endpoint=$launch.Endpoint; original_generation=$launch.Generation; target_generation=$generationValue;
    key_hash=(Get-FileHash -LiteralPath $identityFile -Algorithm SHA256).Hash;
    id_hash=(Get-FileHash -LiteralPath ($identityFile + '.device-id') -Algorithm SHA256).Hash }
  Assert-UpgradeIdentity $record
  if ($Automatic) { Assert-AutomaticSwitchBinding $record $observed.Actions[0] }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress))
  $stream = [IO.File]::Open($nativeJournal,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  & (Join-Path $PSScriptRoot 'windows-private-store.ps1') -Action Seal -Directory $identityRoot -FileName 'windows-native-upgrade.json'
  $stream = Open-NativeJournal
  $complete = $false
  $restored = $false
  $frozen = $false
  $deferred = $false
  $switchStarted = $false
  $stage = 'freeze'
  try {
    $saved = Read-NativeJournal $stream
    if (($saved | ConvertTo-Json -Compress) -cne ($record | ConvertTo-Json -Compress)) { throw 'Journal changed' }
    if ((Freeze-OwnedAgent $original $oldAction $false $true $managementCaller) -ceq 'busy') {
      $deferred = $true
      throw 'Agent busy; no switch attempted'
    }
    $frozen = $true
    Assert-UpgradeIdentity $record
    if ($Automatic) {
      # Serialize the final consent observation with the existing policy lock.
      # OFF can proceed after the switch has been admitted, not before it.
      $modeGuard = [IO.File]::Open(($identityFile + '.install-mode'),
        [IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
      try {
        Assert-AutomaticEligibility $original $oldAction $newVersion
        Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen'
        Assert-UpgradeIdentity $record
        $switchStarted = $true
        $stage = 'stop original'
        Stop-ScheduledTask -TaskName $name -ErrorAction Stop
      } finally { $modeGuard.Dispose() }
    } else {
      $switchStarted = $true
      $stage = 'stop original'
      Stop-ScheduledTask -TaskName $name -ErrorAction Stop
    }
    Wait-VersionExited $original $managementCaller
    Assert-UpgradeState $target $record
    $observed = Read-OwnedTask
    if ($observed.State -eq 'Running' -or -not (Test-SameAction $observed.Actions[0] $oldAction)) {
      throw 'Original Task changed after stop'
    }
    $stage = 'switch task'
    Set-ScheduledTask -TaskName $name -Action $newAction -ErrorAction Stop | Out-Null
    $observed = Read-OwnedTask
    if (-not (Test-SameAction $observed.Actions[0] $newAction)) { throw 'New Task action not persisted' }
    Wait-VersionExited $original $managementCaller
    Assert-UpgradeIdentity $record
    Start-ScheduledTask -TaskName $name -ErrorAction Stop
    $stage = 'signed WSS'
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    $confirmed = $false
    while ($deadline.Elapsed.TotalSeconds -lt 90) {
      try { $confirmed = Confirm-NativeActivation $newVersion $generationValue } catch { $confirmed = $false }
      if ($confirmed) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not $confirmed) { throw 'New Rust signed WSS not confirmed' }
    if ($Automatic) { Invoke-AgentUpgradeFreeze $identityFile 'verify-online' }
    $observed = Read-OwnedTask
    if ($observed.State -ne 'Running' -or -not (Test-SameAction $observed.Actions[0] $newAction)) {
      throw 'Task changed after activation observation'
    }
    Wait-VersionExited $original $managementCaller
    Assert-UpgradeIdentity $record
    $complete = $true
  } catch {
    Write-Verbose ('Native upgrade failure at ' + $stage + ': ' + $_.Exception.Message)
    # A lost freeze response is uncertain. Preserve the journal rather than
    # changing the task or releasing somebody else's possible freeze.
    if ($frozen) {
      try {
        if (-not $switchStarted) {
          Assert-UpgradeIdentity $record
          $current = Read-OwnedTask
          if ($current.State -ne 'Running' -or -not (Test-SameAction $current.Actions[0] $oldAction)) {
            throw 'Original Task changed before release'
          }
          Invoke-AgentUpgradeFreeze $identityFile 'release'
          $deferred = $true
        } else {
          Restore-NativeOriginal $record $original $target $oldAction $newAction $managementCaller
          if ($Automatic) {
            $deadline = [Diagnostics.Stopwatch]::StartNew()
            $confirmed = $false
            while ($deadline.Elapsed.TotalSeconds -lt 90) {
              try { $confirmed = Confirm-NativeActivation $oldVersion $launch.Generation } catch { $confirmed = $false }
              if ($confirmed) { break }
              Start-Sleep -Milliseconds 500
            }
            if (-not $confirmed) { throw 'Previous signed WSS not confirmed' }
            Invoke-AgentUpgradeFreeze $identityFile 'verify-online'
          }
          $restored = $true
        }
      } catch { Write-Verbose ('Native restore refused: ' + $_.Exception.Message) }
    }
  } finally {
    try {
      if ($Automatic -and ($complete -or $restored -or $deferred)) {
        $status = if ($complete) {'success'} elseif ($restored) {'failed_recovered'} else {'waiting_idle'}
        # Commit the result while the journal is held; failed writes retain intent.
        Write-NativeAutomaticResult $record $status
      }
    } finally { $stream.Dispose() }
    if ($complete -or $restored -or $deferred) {
      Remove-Item -LiteralPath $nativeJournal -ErrorAction Stop
    }
  }
  if ($Automatic -and $deferred) { return 'automatic-waiting-idle' }
  if ($Automatic -and $restored) { return 'automatic-failed-recovered' }
  if ($deferred) { throw 'Native upgrade deferred; Agent busy; retry later' }
  if ($complete) { return 'switched-authenticated-upgrade' }
  if ($restored) { throw ('Native upgrade refused at ' + $stage + '; previous task restored') }
  throw ('Native upgrade uncertain at ' + $stage + '; journal retained; attended recovery required')
}
function Invoke-NativeRecovery {
  $managementCaller = Get-LocalSwitchCaller 'Recover' ''
  $stream = Open-NativeJournal
  $restored = $false
  try {
    $record = Read-NativeJournal $stream
    $original = Get-ReviewedProgram $record.original
    $target = Get-ReviewedProgram $record.target
    $oldAction = New-ReviewedAction $original $record.endpoint $record.original_generation
    $newAction = New-ReviewedAction $target $record.endpoint $record.target_generation
    Restore-NativeOriginal $record $original $target $oldAction $newAction $managementCaller
    $restored = $true
  } finally {
    $stream.Dispose()
    if ($restored) { Remove-Item -LiteralPath $nativeJournal -ErrorAction Stop }
  }
  'previous-task-restored'
}
if ($Action -eq 'RecoverNativeUpgrade') {
  if ($Version -or $Direction -or $Endpoint) { throw 'Unexpected recovery arguments' }
  Invoke-NativeRecovery
  exit 0
}
if ($Action -ne 'Status' -and (Test-Path -LiteralPath $nativeJournal)) { throw 'Unreconciled native upgrade; preserve versions and recover explicitly' }

if ($Action -eq 'ConfirmStopped') {
  if ($Version -or $Direction -or
      $Endpoint -cnotmatch '^https://[A-Za-z0-9.-]+(?::[0-9]+)?/$') { throw 'Unexpected stopped-check arguments' }
  Check-Existing
  $launch = Read-TaskLaunch $task.Actions[0]
  if ($task.State -eq 'Running' -or $launch.Endpoint -cne $Endpoint) { throw 'Existing Task is not stopped at the expected endpoint' }
  $action = $task.Actions[0]
  $caller = Get-LocalSwitchCaller 'RePair' $Endpoint
  if (-not $caller) { $caller = Get-LocalSwitchCaller 'Onboard' $Endpoint }
  Wait-VersionExited ([pscustomobject]@{Root=$root}) $caller
  $task = Read-OwnedTask
  if ($task.State -eq 'Running' -or -not (Test-SameAction $task.Actions[0] $action)) { throw 'Task changed during exit observation' }
  'stopped-confirmed'
  exit 0
}

if ($Action -eq 'EnableNative') {
  if ($Direction -or
      $Endpoint -cnotmatch '^https://[A-Za-z0-9.-]+(?::[0-9]+)?/$' -or
      $Version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-rust-candidate\.[1-9][0-9]*)?$') { throw 'Unreviewed native enable' }
  Check-UpgradeStore
  if ($task) { throw 'Cannot overwrite an existing scheduled task' }
  $modeGuard = [IO.File]::Open(($identityFile + '.install-mode'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
  try {
    $program = Get-ReviewedProgram $Version
    $record = [pscustomobject]@{
      key_hash=(Get-FileHash -LiteralPath $identityFile -Algorithm SHA256).Hash
      id_hash=(Get-FileHash -LiteralPath ($identityFile + '.device-id') -Algorithm SHA256).Hash
    }
    $raw = & $program.Entry --verify-enable-pairing $Endpoint
    if ($LASTEXITCODE -ne 0) { throw 'Signed permanent grant not confirmed' }
    $approved = $raw | ConvertFrom-Json
    Assert-UpgradeIdentity $record
    if ($approved.device_id -cne (Get-Content -LiteralPath ($identityFile + '.device-id') -Raw).Trim()) {
      throw 'Signed identity changed before enable'
    }
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      throw 'Cannot overwrite an existing scheduled task'
    }
    Register-OwnedTask (New-ReviewedAction $program $Endpoint ([guid]::NewGuid().ToString('D')))
  } finally { $modeGuard.Dispose() }
  'enabled'
  exit 0
}

if ($Action -eq 'ActivateNative') {
  if ($Direction -or
      $Endpoint -cnotmatch '^https://[A-Za-z0-9.-]+(?::[0-9]+)?/$' -or
      $Version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-rust-candidate\.[1-9][0-9]*)?$') {
    throw 'Unreviewed native initial activation'
  }
  Check-UpgradeStore
  $program = Get-ReviewedProgram $Version
  $pending = $identityFile + '.activation-pending'
  # The existing activation intent doubles as the exclusive activation lock.
  # Read-only observers can inspect it; another installer cannot consume it.
  $stream = [IO.File]::Open($pending,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
  $confirmed = $false
  try {
    $record = [pscustomobject]@{
      key_hash=(Get-FileHash -LiteralPath $identityFile -Algorithm SHA256).Hash
      id_hash=(Get-FileHash -LiteralPath ($identityFile + '.device-id') -Algorithm SHA256).Hash
    }
    $raw = & $program.Entry --verify-initial-pairing $Endpoint
    if ($LASTEXITCODE -ne 0) { throw 'Signed initial identity not confirmed' }
    $approved = $raw | ConvertFrom-Json
    Assert-UpgradeIdentity $record
    if ($approved.device_id -cne (Get-Content -LiteralPath ($identityFile + '.device-id') -Raw).Trim()) {
      throw 'Signed identity changed before activation'
    }
    $previous = $null
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
      Check-Existing
      $launch = Read-TaskLaunch $task.Actions[0]
      if (-not $launch.Generation -or $launch.Endpoint -cne $Endpoint) { throw 'Unrelated existing Task' }
      $previous = New-ReviewedAction $program $Endpoint $launch.Generation
      if (-not (Test-SameAction $task.Actions[0] $previous)) { throw 'Unrelated existing Task action' }
      if ($task.State -eq 'Running') {
        try { $confirmed = Confirm-NativeActivation $Version $launch.Generation } catch { $confirmed = $false }
        if (-not $confirmed) {
          Freeze-OwnedAgent $program $previous $true
          Stop-ScheduledTask -TaskName $name -ErrorAction Stop
        }
      }
    }
    if (-not $confirmed) {
      Wait-VersionExited ([pscustomobject]@{Root=$root})
      Assert-UpgradeState $program $record
      $generationValue = [guid]::NewGuid().ToString('D')
      $action = New-ReviewedAction $program $Endpoint $generationValue
      $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      if ($task) {
        Check-Existing
        if (-not $previous -or $task.State -eq 'Running' -or -not (Test-SameAction $task.Actions[0] $previous)) {
          throw 'Pending Task changed before retry'
        }
        Set-ScheduledTask -TaskName $name -Action $action -ErrorAction Stop | Out-Null
      } else {
        Register-OwnedTask $action
      }
      Start-ScheduledTask -TaskName $name -ErrorAction Stop
      $deadline = [Diagnostics.Stopwatch]::StartNew()
      while ($deadline.Elapsed.TotalSeconds -lt 90) {
        try { $confirmed = Confirm-NativeActivation $Version $generationValue } catch { $confirmed = $false }
        if ($confirmed) { break }
        Start-Sleep -Milliseconds 500
      }
      if (-not $confirmed) {
        # Remove only our exact unconfirmed Task, after freeze/exit evidence.
        # Unknown ownership or a lost freeze response preserves the intent.
        $task = Read-OwnedTask
        if (-not (Test-SameAction $task.Actions[0] $action)) { throw 'Activation Task changed; intent retained' }
        if ($task.State -eq 'Running') {
          Freeze-OwnedAgent $program $action $true
          Stop-ScheduledTask -TaskName $name -ErrorAction Stop
        }
        Wait-VersionExited $program
        $task = Read-OwnedTask
        if ($task.State -eq 'Running' -or -not (Test-SameAction $task.Actions[0] $action)) {
          throw 'Activation Task uncertain; intent retained'
        }
        Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
        throw 'Signed WSS not confirmed; Task removed and activation intent retained'
      }
    }
    Assert-UpgradeIdentity $record
  } finally { $stream.Dispose() }
  if (-not $confirmed) { throw 'Native initial activation not confirmed' }
  Remove-Item -LiteralPath $pending -ErrorAction Stop
  'authenticated-initial-activation'
  exit 0
}

if ($Action -eq 'Status') {
  if (-not $task) {
    '{"installed":false,"running":false,"autostart":"at-user-logon"}'
    exit 0
  }
  Check-Existing
  $running = ($task.State -eq 'Running')
  $launch = Read-TaskLaunch $task.Actions[0]
  $versionDir = [IO.Path]::GetFullPath($launch.Entry).Substring($root.Length + 1).Split('\')[0]
  $installed = $versionDir.Substring(0, $versionDir.Length - '-windows-x64'.Length)
  $activity = $null
  $result = $null
  if (Test-Path -LiteralPath $nativeJournal) { $activity = 'needs_attention' }
  if (-not $activity) {
    try {
      $idPath = $identityFile + '.device-id'
      if (Test-Path -LiteralPath $idPath) {
        Check-UpgradeStore
        $autoName = 'RCA-Upgrade-' + (Get-Content -LiteralPath $idPath -Raw).Trim().Replace('-','')
        if (@(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ieq $autoName }).Count -ne 0) {
          $activity = 'unknown'
        }
      }
    } catch { $activity = 'unknown' }
  }
  try {
    $result = Get-NativeAutomaticResult
    if ($result) {
      $current = $result.installed_version -ceq $installed
      $result | Add-Member -NotePropertyName current -NotePropertyValue $current
      if (-not $activity -and $current) {
        $activity = switch ($result.status) {
          'success' {'success'}
          'failed_recovered' {'recovered'}
          'waiting_idle' {'waiting_idle'}
        }
      }
    }
  } catch { if (-not $activity) { $activity = 'unknown' }; $result = @{status='unknown'} }
  $localService = if ($running) {'running_unverified'} else {'not_running'}
  $signed = 'unconfirmed'
  $lastOnline = $null
  if ($running) {
    try {
      $program = [pscustomobject]@{Process=$launch.Entry;Launcher=$task.Actions[0].Execute}
      $caller = Get-LocalSwitchCaller 'Status' ''
      $before = Get-OwnedAgentProcess $program $caller
      $localService = 'running_observed'
      $raw = & $launch.Entry --verify-activation-proof $launch.Generation 2>$null
      if ($LASTEXITCODE -ne 0) { throw 'Prior signed activation not observed' }
      $lastOnline = ($raw | ConvertFrom-Json).at
      Invoke-AgentUpgradeFreeze $identityFile 'verify-online'
      $after = Get-OwnedAgentProcess $program $caller
      $again = Read-OwnedTask
      if ($again.State -eq 'Running' -and (Test-SameAction $again.Actions[0] $task.Actions[0]) -and
          $after.ProcessId -eq $before.ProcessId -and $after.CreationDate -eq $before.CreationDate) {
        $signed = 'connected_observed'
      }
    } catch { }
  }
  @{installed=$true;running=$running;autostart='at-user-logon';version=$installed;
    local_service=$localService;signed_wss=$signed;last_online_unix_ms=$lastOnline;
    automatic_update_activity=$activity;automatic_update_result=$result} | ConvertTo-Json -Compress -Depth 4
  exit 0
}
if ($Action -eq 'VerifyAutomatic') {
  if ($Endpoint -or $Direction) { throw 'Unexpected automatic eligibility arguments' }
  Check-Existing
  if (Test-Path -LiteralPath $nativeJournal) { throw 'Unresolved native upgrade' }
  $launch = Read-TaskLaunch $task.Actions[0]
  $relative = [IO.Path]::GetFullPath([string]$task.Actions[0].Execute).Substring($root.Length + 1)
  $directory = ($relative -split '\\')[0]
  $installed = $directory.Substring(0,$directory.Length - '-windows-x64'.Length)
  $program = Get-ReviewedProgram $installed
  $expected = New-ReviewedAction $program $launch.Endpoint $launch.Generation
  Assert-AutomaticEligibility $program $expected $Version
  'automatic-eligible'
  exit 0
}
if ($Action -eq 'Uninstall') {
  if ($Version -or $Direction -or $Endpoint -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
    throw 'Explicit local owner terminal required for uninstall'
  }
  Check-UpgradeStore
  $modeGuard = [IO.File]::Open(($identityFile + '.install-mode'),
    [IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
  try {
    function Get-UninstallPrograms {
      $items = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
      foreach ($item in $items) {
        if (-not $item.PSIsContainer -or $item.Name -cnotmatch '^(v[0-9]+\.[0-9]+\.[0-9]+(?:-rust-candidate\.[1-9][0-9]*)?)-windows-x64$') {
          throw 'Unreviewed installed program; preserve files'
        }
        Get-ReviewedProgram $Matches[1]
      }
    }
    function Assert-UninstallAvailable {
      foreach ($file in @($nativeJournal,($identityFile + '.activation-pending'),($identityFile + '.device-id.pending'))) {
        if (Test-Path -LiteralPath $file) { throw 'Unresolved lifecycle transaction; recover before uninstall' }
      }
      $id = (Get-Content -LiteralPath ($identityFile + '.device-id') -Raw).Trim()
      if ($id -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { throw 'Unconfirmed paired identity' }
      $autoName = 'RCA-Upgrade-' + $id.Replace('-','')
      foreach ($job in @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -like 'RCA-Upgrade-*' })) {
        if ($job.TaskName -ieq $autoName -or $job.State -in @('Running','Queued','Unknown')) {
          throw 'Outstanding upgrade task; inspect before uninstall'
        }
      }
    }
    Assert-UninstallAvailable
    $programs = @(Get-UninstallPrograms)
    if ($programs.Count -eq 0) { throw 'No reviewed installed software' }
    Write-Host ("Uninstall {0} reviewed Agent version(s) and startup mechanism? Identity, receipts and cloud authorization are retained." -f $programs.Count)
    $answer = Read-Host 'Confirm [y/N]'
    if ($answer -notmatch '^\s*(y|yes)\s*$') { throw 'Owner declined' }
    Assert-UninstallAvailable
    if (((@((Get-UninstallPrograms).Tag) | Sort-Object) -join ',') -cne ((@($programs.Tag) | Sort-Object) -join ',')) {
      throw 'Installed inventory changed'
    }
    if ($task) {
      $task = Read-OwnedTask
      $launch = Read-TaskLaunch $task.Actions[0]
      $tag = ([IO.Path]::GetFullPath($launch.Entry).Substring($root.Length + 1).Split('\')[0]) -replace '-windows-x64$',''
      $program = Get-ReviewedProgram $tag
      $expected = New-ReviewedAction $program $launch.Endpoint $launch.Generation
      if (-not (Test-SameAction $task.Actions[0] $expected)) { throw 'Task definition changed' }
      if ($task.State -eq 'Running') {
        $before = Get-OwnedAgentProcess $program
        if ((Invoke-AgentUpgradeFreeze $identityFile 'freeze' $true) -ceq 'busy') { throw 'Agent busy; uninstall deferred' }
        try {
          Assert-UninstallAvailable
          $task = Read-OwnedTask
          $current = Get-OwnedAgentProcess $program
          if ($task.State -ne 'Running' -or -not (Test-SameAction $task.Actions[0] $expected) -or
              $current.ProcessId -ne $before.ProcessId -or $current.CreationDate -ne $before.CreationDate) { throw 'Uninstall target changed' }
          Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen'
          Stop-ScheduledTask -TaskName $name -ErrorAction Stop
          Wait-VersionExited ([pscustomobject]@{Root=$root})
        } finally {
          $same = $false
          try {
            $current = Get-OwnedAgentProcess $program
            $same = $current.ProcessId -eq $before.ProcessId -and $current.CreationDate -eq $before.CreationDate
          } catch { }
          if ($same) { Invoke-AgentUpgradeFreeze $identityFile 'release' }
        }
      }
      Wait-VersionExited ([pscustomobject]@{Root=$root})
      $task = Read-OwnedTask
      if ($task.State -eq 'Running' -or -not (Test-SameAction $task.Actions[0] $expected)) { throw 'Owned Task exit unconfirmed' }
      Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
    }
    Assert-UninstallAvailable
    if (@(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ieq $name }).Count) {
      throw 'Task removal unconfirmed'
    }
    Wait-VersionExited ([pscustomobject]@{Root=$root})
    foreach ($program in $programs) {
      $null = Get-ReviewedProgram $program.Tag
      Remove-Item -LiteralPath $program.Root -Recurse -Force -ErrorAction Stop
    }
    if (@(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop).Count) { throw 'Software removal incomplete' }
    @{status='uninstalled';removed_versions=@($programs.Tag);identity_preserved=$true;receipts_preserved=$true;cloud_revocation='not_performed'} | ConvertTo-Json -Compress
  } finally { $modeGuard.Dispose() }
  exit 0
}
if ($Action -eq 'Restart') {
  if ($Version -or $Direction -or $Endpoint) { throw 'Unexpected restart arguments' }
  Check-Existing
  Check-UpgradeStore
  $caller = Get-LocalSwitchCaller 'Restart' ''
  if (-not $caller) { throw 'Explicit local restart caller required' }
  foreach ($suffix in @('.owner-stopped','.activation-pending','.device-id.pending')) {
    if (Test-Path -LiteralPath ($identityFile + $suffix)) { throw 'Owner STOP or lifecycle pending blocks restart' }
  }
  $launch = Read-TaskLaunch $task.Actions[0]
  $tag = ([IO.Path]::GetFullPath($launch.Entry).Substring($root.Length + 1).Split('\')[0]) -replace '-windows-x64$',''
  $program = Get-ReviewedProgram $tag
  $expected = New-ReviewedAction $program $launch.Endpoint $launch.Generation
  $record = @{ key_hash=(Get-FileHash -LiteralPath $identityFile -Algorithm SHA256).Hash;
    id_hash=(Get-FileHash -LiteralPath ($identityFile + '.device-id') -Algorithm SHA256).Hash }
  $before = Get-OwnedAgentProcess $program $caller
  $recheck = {
    Assert-UpgradeIdentity $record
    if (Test-Path -LiteralPath $nativeJournal) { throw 'Upgrade transaction blocks restart' }
    $observed = Read-OwnedTask
    $process = Get-OwnedAgentProcess $program $caller
    if ($observed.State -ne 'Running' -or -not (Test-SameAction $observed.Actions[0] $expected) -or
        $process.ProcessId -ne $before.ProcessId -or $process.CreationDate -ne $before.CreationDate) {
      throw 'Restart target changed'
    }
  }
  & $recheck
  Invoke-AgentUpgradeFreeze $identityFile 'verify-online'
  if ((Invoke-AgentUpgradeFreeze $identityFile 'freeze' $true) -ceq 'busy') { throw 'Agent busy; restart deferred' }
  try {
    & $recheck
    Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen'
    & $recheck
    Stop-ScheduledTask -TaskName $name -ErrorAction Stop
    Wait-VersionExited $program $caller
    Assert-UpgradeIdentity $record
    $observed = Read-OwnedTask
    if ($observed.State -eq 'Running' -or -not (Test-SameAction $observed.Actions[0] $expected)) {
      throw 'Task changed after stop'
    }
    Start-ScheduledTask -TaskName $name -ErrorAction Stop
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($deadline.Elapsed.TotalSeconds -lt 60) {
      try {
        $after = Get-OwnedAgentProcess $program $caller
        if ($after.ProcessId -ne $before.ProcessId -or $after.CreationDate -ne $before.CreationDate) {
          $observed = Read-OwnedTask
          if ($observed.State -eq 'Running' -and (Test-SameAction $observed.Actions[0] $expected)) {
            Invoke-AgentUpgradeFreeze $identityFile 'verify-online'
            $confirmed = Get-OwnedAgentProcess $program $caller
            if ($confirmed.ProcessId -eq $after.ProcessId -and $confirmed.CreationDate -eq $after.CreationDate) {
              Assert-UpgradeIdentity $record
              '{"local":"restarted","signed_wss":"connected_observed"}'
              exit 0
            }
          }
        }
      } catch { }
      Start-Sleep -Milliseconds 500
    }
    throw 'Replacement signed Agent unconfirmed; inspect local status'
  } finally {
    # Only the original process can own the freeze we acquired.
    $same = $false
    try {
      $observed = Get-OwnedAgentProcess $program $caller
      $same = $observed.ProcessId -eq $before.ProcessId -and $observed.CreationDate -eq $before.CreationDate
    } catch { }
    if ($same) { Invoke-AgentUpgradeFreeze $identityFile 'release' }
  }
}
if ($Action -eq 'Switch') {
  Check-Existing
  if ($Endpoint -or $Direction -cne 'Upgrade' -or
      $Version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-rust-candidate\.[1-9][0-9]*)?$') { throw 'Untrusted native switch arguments' }
  $marker = [IO.Path]::Combine($env:LOCALAPPDATA,'mcp-workers','remote-control','v2-identity.pem.owner-stopped')
  if (Test-Path -LiteralPath $marker) { throw 'Native-only cutover requires owner-ON upgrade' }
  $oldAction = $task.Actions[0]
  $oldLaunch = Read-TaskLaunch $oldAction
  $relative = [IO.Path]::GetFullPath([string]$oldAction.Execute).Substring($root.Length + 1)
  $oldDir = ($relative -split '\\')[0]
  $oldVersion = $oldDir.Substring(0,$oldDir.Length - '-windows-x64'.Length)
  if (-not (Test-NativeForwardVersion $oldVersion $Version)) { throw 'Invalid native upgrade direction' }
  Invoke-NativeUpgrade $oldVersion $Version $oldLaunch
  exit 0
}

Check-Existing
switch ($Action) {
  Start   { Start-ScheduledTask -TaskName $name -ErrorAction Stop; 'start-requested' }
  Stop    { Stop-ScheduledTask -TaskName $name -ErrorAction Stop; 'stop-requested' }
  Disable {
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $name -ErrorAction Stop }
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
    # Preserve protected private key, device ID and cloud grant.
    'disabled'
  }
}
