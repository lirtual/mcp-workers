# Windows native Remote Control user task; only interactive user logon.
# Does not create an elevated service, use a password or touch cloud grants.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Enable','Start','Stop','Disable','Status','Switch','Endpoint','VerifyActivation','RecoverNativeUpgrade')][string]$Action,
  [string]$Endpoint, [string]$Entry, [string]$Node,
  [string]$Version, [ValidateSet('Upgrade','Rollback')][string]$Direction,
  [string]$Generation,
  [switch]$CIInjectFailure
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not $env:LOCALAPPDATA) {
  throw 'Native Windows user session required'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.IsSystem) { throw 'System identity rejected' }
$sid = $identity.User.Value
$name = 'RCA-Remote-Control-v2-' + $sid.Replace('-', '_')
$root = [IO.Path]::GetFullPath([IO.Path]::Combine(
  $env:LOCALAPPDATA,'mcp-workers','remote-control','programs'))
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
function Check-Program([string]$nodePath, [string]$entryPath) {
  if ($nodePath -match '[";]' -or $entryPath -match '[";]') { throw 'Invalid program path' }
  $n = [IO.Path]::GetFullPath($nodePath)
  $e = [IO.Path]::GetFullPath($entryPath)
  if (-not $n.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase) -or
      -not $e.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Only private versioned program directories are allowed'
  }
  $relNode = $n.Substring($root.Length + 1)
  $relEntry = $e.Substring($root.Length + 1)
  $version = ($relNode -split '\\')[0]
  $entryPaths = @(
    ($version + '\apps\remote-control-agent\src\windows-v2.js'),
    ($version + '\apps\remote-control-agent\.build\rca-standard-windows-candidate.exe')
  )
  if ($version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?-windows-x64$' -or
      $relNode -notin @(($version + '\bin\node.exe'), ($version + '\bin\rca-background.exe')) -or
      $relEntry -notin $entryPaths) {
    throw 'Untrusted Agent version or entrypoint'
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
  if ($arguments -cmatch '^"([^"]+)" run --endpoint "(https://[A-Za-z0-9.-]+(?::[0-9]+)?/)"$') {
    $entryPath = $Matches[1]
    $endpointValue = $Matches[2]
    $generationValue = $null
  } elseif ($arguments -cmatch '^"([^"]+)" --service --endpoint "(https://[A-Za-z0-9.-]+(?::[0-9]+)?/)" --generation "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})"$') {
    $entryPath = $Matches[1]
    $endpointValue = $Matches[2]
    $generationValue = $Matches[3]
  } else {
    throw 'Untrusted scheduled task arguments'
  }
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
if ($Action -ne 'VerifyActivation' -and $Generation) { throw 'Unexpected generation argument' }
function Confirm-NativeActivation([string]$Version,[string]$Generation) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
  # A fresh signed activation receipt must belong to this exact running
  # user Task and its child executable. Running alone is never sufficient.
  Check-Existing
  if ($Version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$' -or
      $Generation -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or
      $Endpoint -or $Node -or $Entry -or $CIInjectFailure) {
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
    $raw = & $rustEntry --verify-activation-proof $Generation
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
  if ($Direction) { throw 'Unexpected switch direction' }
  $null = Confirm-NativeActivation $Version $Generation
  'authenticated-activation-observed'
  exit 0
}
if ($Action -eq 'Status') {
  if (-not $task) {
    '{"installed":false,"running":false,"autostart":"at-user-logon"}'
    exit 0
  }
  Check-Existing
  $running = ($task.State -eq 'Running')
  '{"installed":true,"running":' + $running.ToString().ToLowerInvariant() + ',"autostart":"at-user-logon"}'
  exit 0
}
if ($Action -eq 'Endpoint') {
  Check-Existing
  (Read-TaskLaunch $task.Actions[0]).Endpoint
  exit 0
}
if ($Action -eq 'Enable') {
  if (Test-Path -LiteralPath ([IO.Path]::Combine([IO.Path]::GetDirectoryName($root),'windows-native-upgrade.json'))) {
    throw 'Unreconciled native upgrade'
  }
  if ($task) { throw 'Cannot overwrite an existing scheduled task' }
  if (-not $Node -or -not $Entry -or -not $Endpoint) {
    throw 'Explicit native entrypoint and endpoint required'
  }
  if ($Endpoint -cnotmatch '^https://[A-Za-z0-9.-]+(?::[0-9]+)?/$') {
    throw 'Untrusted HTTPS endpoint'
  }
  Check-Program $Node $Entry
  # Use a reviewed no-window launcher; Windows Job Object owns child Node.
  $background = [IO.Path]::Combine([IO.Path]::GetDirectoryName($Node),'rca-background.exe')
  Check-Program $background $Entry
  $arguments = '"' + $Entry + '" run --endpoint "' + $Endpoint + '"'
  $scheduledAction = New-ScheduledTaskAction -Execute $background -Argument $arguments -WorkingDirectory ([IO.Path]::GetDirectoryName($Entry))
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $name -Action $scheduledAction -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
  'enabled'
  exit 0
}


function Invoke-AgentUpgradeFreeze([string]$keyPath,[string]$action) {
  if ($action -cnotin @('freeze','verify-frozen','release')) { throw 'Invalid upgrade action' }
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
      $pending = $reader.ReadLineAsync()
      if (-not $pending.Wait(10000)) { throw 'Agent upgrade pipe response not confirmed' }
      $answer = $pending.GetAwaiter().GetResult()
      $expected = if ($action -ceq 'release') { 'released' } else { 'ready' }
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
  $native = $null -ne $profile -and $profile.Value -ceq 'rust-native-only-v1'
  $runtime = $manifest.PSObject.Properties['agent_runtime']
  $isRust = $null -ne $runtime -and $runtime.Value -ceq 'rust-standard-windows-v1'
  if ($null -ne $runtime -and $runtime.Value -cnotin @('node-standard-windows-v2','rust-standard-windows-v1')) {
    throw 'Unreviewed installed runtime'
  }
  $launcher = [IO.Path]::Combine($directory,'bin','rca-background.exe')
  $nodeExe = [IO.Path]::Combine($directory,'bin','node.exe')
  $scripts = [IO.Path]::Combine($directory,'apps','remote-control-agent','scripts')
  $entry = if ($isRust) {
    [IO.Path]::Combine($directory,'apps','remote-control-agent','.build','rca-standard-windows-candidate.exe')
  } else { [IO.Path]::Combine($directory,'apps','remote-control-agent','src','windows-v2.js') }
  Check-Program $launcher $entry
  if ($native) {
    & (Join-Path $scripts 'verify-windows-native.ps1') -Root $directory -Version $versionTag | Out-Null
  } else {
    & $nodeExe (Join-Path $scripts 'verify-windows-preview.mjs') $directory | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Original installed version verification failed' }
  }
  [pscustomobject]@{ Root=$directory; Tag=$versionTag; Native=$native; Rust=$isRust;
    Launcher=$launcher; Entry=$entry; Process=$(if ($isRust) {$entry} else {$nodeExe}); Scripts=$scripts }
}

function New-ReviewedAction($program,[string]$endpointValue,[string]$generationValue) {
  if ($endpointValue -cnotmatch '^https://[A-Za-z0-9.-]+(?::[0-9]+)?/$') { throw 'Invalid saved endpoint' }
  if ($program.Rust) {
    if ($generationValue -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { throw 'Invalid saved generation' }
    $arguments = '"' + $program.Entry + '" --service --endpoint "' + $endpointValue + '" --generation "' + $generationValue + '"'
  } else {
    if ($generationValue) { throw 'Unexpected Node generation' }
    $arguments = '"' + $program.Entry + '" run --endpoint "' + $endpointValue + '"'
  }
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
function Get-OwnedAgentProcess($program) {
  $matches = @(Get-CimInstance Win32_Process -Filter ("Name = '" + [IO.Path]::GetFileName($program.Process) + "'") -ErrorAction Stop |
    Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$program.Process,[StringComparison]::OrdinalIgnoreCase) })
  if ($matches.Count -ne 1 -or (Invoke-CimMethod -InputObject $matches[0] -MethodName GetOwnerSid).Sid -cne $sid) {
    throw 'Unique owner Agent process not confirmed'
  }
  $parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [uint32]$matches[0].ParentProcessId) -ErrorAction Stop
  if (-not $parent -or -not [string]::Equals($parent.ExecutablePath,$program.Launcher,[StringComparison]::OrdinalIgnoreCase) -or
      (Invoke-CimMethod -InputObject $parent -MethodName GetOwnerSid).Sid -cne $sid) { throw 'Owner Agent launcher not confirmed' }
  $matches[0]
}
function Wait-VersionExited($program) {
  $prefix = $program.Root.TrimEnd('\') + '\'
  for ($i=0; $i -lt 40; $i++) {
    $live = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'rca-background.exe' OR Name = 'rca-standard-windows-candidate.exe'" -ErrorAction Stop |
      Where-Object {
        if ($_.ExecutablePath) {
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
function Wait-OwnedAgent($program,$expectedAction) {
  for ($i=0; $i -lt 40; $i++) {
    $observed = Read-OwnedTask
    if (-not (Test-SameAction $observed.Actions[0] $expectedAction)) { throw 'Task action drift' }
    if ($observed.State -eq 'Running') {
      try { return Get-OwnedAgentProcess $program } catch { }
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

function Check-UpgradeStore {
  & (Join-Path $PSScriptRoot 'windows-private-store.ps1') -Action Check -Directory $identityRoot
  if ((Get-Content -LiteralPath ($identityFile + '.install-mode') -Raw) -cne ("permanent" + [char]10)) {
    throw 'Existing permanent owner Agent required'
  }
}
function Freeze-OwnedAgent($program,$expectedAction,[bool]$recovering=$false) {
  $observed = Read-OwnedTask
  if ($observed.State -ne 'Running' -or -not (Test-SameAction $observed.Actions[0] $expectedAction)) {
    throw 'Agent task changed before freeze'
  }
  $process = Get-OwnedAgentProcess $program
  if ($recovering) {
    try { Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen' }
    catch { Invoke-AgentUpgradeFreeze $identityFile 'freeze' }
  } else { Invoke-AgentUpgradeFreeze $identityFile 'freeze' }
  Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen'
  $after = Read-OwnedTask
  $currentProcess = Get-OwnedAgentProcess $program
  if ($after.State -ne 'Running' -or -not (Test-SameAction $after.Actions[0] $expectedAction) -or
      $currentProcess.ProcessId -ne $process.ProcessId -or $currentProcess.CreationDate -ne $process.CreationDate) {
    throw 'Agent changed during freeze'
  }
}
function Restore-NativeOriginal($record,$original,$target,$oldAction,$newAction) {
  Assert-UpgradeIdentity $record
  $current = Read-OwnedTask
  if (Test-SameAction $current.Actions[0] $newAction) {
    if ($current.State -eq 'Running') {
      Freeze-OwnedAgent $target $newAction $true
      Stop-ScheduledTask -TaskName $name -ErrorAction Stop
    }
    Wait-VersionExited $target
    Assert-UpgradeState $target $record
    $current = Read-OwnedTask
    if ($current.State -eq 'Running' -or -not (Test-SameAction $current.Actions[0] $newAction)) {
      throw 'Target Task changed during rollback'
    }
    Set-ScheduledTask -TaskName $name -Action $oldAction -ErrorAction Stop | Out-Null
  } elseif (-not (Test-SameAction $current.Actions[0] $oldAction)) {
    throw 'Unknown Task action; no automatic recovery permitted'
  }
  Wait-VersionExited $target
  Assert-UpgradeIdentity $record
  $current = Read-OwnedTask
  if (-not (Test-SameAction $current.Actions[0] $oldAction)) { throw 'Previous task action not restored' }
  if ($current.State -eq 'Running') {
    $null = Get-OwnedAgentProcess $original
    Invoke-AgentUpgradeFreeze $identityFile 'release'
  } else {
    Wait-VersionExited $original
    Assert-UpgradeState $target $record
    Start-ScheduledTask -TaskName $name -ErrorAction Stop
  }
  $null = Wait-OwnedAgent $original $oldAction
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
function Read-NativeJournal($stream) {
  $reader = [IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$false,4096,$true)
  try { $record = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  if ($record.schema -ne 1 -or
      $record.key_hash -cnotmatch '^[A-F0-9]{64}$' -or $record.id_hash -cnotmatch '^[A-F0-9]{64}$' -or
      $record.original -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$' -or
      $record.target -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+-rust-candidate\.[1-9][0-9]*$' -or
      [version](($record.target.Substring(1) -split '-')[0]) -le [version](($record.original.Substring(1) -split '-')[0])) {
    throw 'Unreviewed native upgrade journal'
  }
  $record
}
function Invoke-NativeUpgrade([string]$oldVersion,[string]$newVersion,$launch) {
  Check-UpgradeStore
  $original = Get-ReviewedProgram $oldVersion
  $target = Get-ReviewedProgram $newVersion
  if (-not $target.Native -or -not $target.Rust) { throw 'Reviewed Node-free Rust candidate required' }
  $oldAction = New-ReviewedAction $original $launch.Endpoint $launch.Generation
  $generationValue = [guid]::NewGuid().ToString('D')
  $newAction = New-ReviewedAction $target $launch.Endpoint $generationValue
  $observed = Read-OwnedTask
  if ($observed.State -ne 'Running' -or -not (Test-SameAction $observed.Actions[0] $oldAction)) {
    throw 'Existing reviewed running Task required'
  }
  Wait-VersionExited $target
  $raw = & $target.Entry --cli status
  if ($LASTEXITCODE -ne 0) { throw 'Candidate local identity validation failed' }
  $localStatus = $raw | ConvertFrom-Json
  if ($localStatus.identity_present -ne $true -or
      $localStatus.device_id -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { throw 'Existing paired identity required' }
  $record = [pscustomobject]@{ schema=1; original=$oldVersion; target=$newVersion;
    endpoint=$launch.Endpoint; original_generation=$launch.Generation; target_generation=$generationValue;
    key_hash=(Get-FileHash -LiteralPath $identityFile -Algorithm SHA256).Hash;
    id_hash=(Get-FileHash -LiteralPath ($identityFile + '.device-id') -Algorithm SHA256).Hash }
  Assert-UpgradeIdentity $record
  $bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress))
  $stream = [IO.File]::Open($nativeJournal,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  & (Join-Path $PSScriptRoot 'windows-private-store.ps1') -Action Seal -Directory $identityRoot -FileName 'windows-native-upgrade.json'
  $stream = Open-NativeJournal
  $complete = $false
  $restored = $false
  $frozen = $false
  $stage = 'freeze'
  try {
    $saved = Read-NativeJournal $stream
    if (($saved | ConvertTo-Json -Compress) -cne ($record | ConvertTo-Json -Compress)) { throw 'Journal changed' }
    Freeze-OwnedAgent $original $oldAction
    $frozen = $true
    Assert-UpgradeIdentity $record
    $stage = 'stop original'
    Stop-ScheduledTask -TaskName $name -ErrorAction Stop
    Wait-VersionExited $original
    Assert-UpgradeState $target $record
    $observed = Read-OwnedTask
    if ($observed.State -eq 'Running' -or -not (Test-SameAction $observed.Actions[0] $oldAction)) {
      throw 'Original Task changed after stop'
    }
    $stage = 'switch task'
    Set-ScheduledTask -TaskName $name -Action $newAction -ErrorAction Stop | Out-Null
    $observed = Read-OwnedTask
    if (-not (Test-SameAction $observed.Actions[0] $newAction)) { throw 'New Task action not persisted' }
    Wait-VersionExited $original
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
    $observed = Read-OwnedTask
    if ($observed.State -ne 'Running' -or -not (Test-SameAction $observed.Actions[0] $newAction)) {
      throw 'Task changed after activation observation'
    }
    Wait-VersionExited $original
    Assert-UpgradeIdentity $record
    $complete = $true
  } catch {
    Write-Verbose ('Native upgrade failure at ' + $stage + ': ' + $_.Exception.Message)
    # A lost freeze response is uncertain. Preserve the journal rather than
    # changing the task or releasing somebody else's possible freeze.
    if ($frozen) {
      try { Restore-NativeOriginal $record $original $target $oldAction $newAction; $restored = $true }
      catch { Write-Verbose ('Native restore refused: ' + $_.Exception.Message) }
    }
  } finally {
    $stream.Dispose()
    if ($complete -or $restored) { Remove-Item -LiteralPath $nativeJournal -ErrorAction Stop }
  }
  if ($complete) { return 'switched-authenticated-upgrade' }
  if ($restored) { throw ('Native upgrade refused at ' + $stage + '; previous task restored') }
  throw ('Native upgrade uncertain at ' + $stage + '; journal retained; attended recovery required')
}
function Invoke-NativeRecovery {
  $stream = Open-NativeJournal
  $restored = $false
  try {
    $record = Read-NativeJournal $stream
    $original = Get-ReviewedProgram $record.original
    $target = Get-ReviewedProgram $record.target
    if (-not $target.Native -or -not $target.Rust) { throw 'Unreviewed recovery target' }
    $oldAction = New-ReviewedAction $original $record.endpoint $record.original_generation
    $newAction = New-ReviewedAction $target $record.endpoint $record.target_generation
    Restore-NativeOriginal $record $original $target $oldAction $newAction
    $restored = $true
  } finally {
    $stream.Dispose()
    if ($restored) { Remove-Item -LiteralPath $nativeJournal -ErrorAction Stop }
  }
  'previous-task-restored'
}
if ($Action -eq 'RecoverNativeUpgrade') {
  if ($Version -or $Direction -or $Endpoint -or $Node -or $Entry -or $CIInjectFailure) { throw 'Unexpected recovery arguments' }
  Invoke-NativeRecovery
  exit 0
}
if (Test-Path -LiteralPath $nativeJournal) { throw 'Unreconciled native upgrade; preserve versions and recover explicitly' }

if ($Action -eq 'Switch') {
  # Transactional local program switch. Both versions are installed and
  # verified before touching the sole same-owner logon task.
  Check-Existing
  if ($Endpoint -or $Node -or $Entry -or
      $Version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$' -or
      $Direction -notin @('Upgrade','Rollback')) { throw 'Untrusted switch arguments' }
  $marker = [IO.Path]::Combine($env:LOCALAPPDATA,'mcp-workers','remote-control','v2-identity.pem.owner-stopped')
  $ownerStopped = Test-Path -LiteralPath $marker
  if ($Direction -eq 'Rollback' -and $ownerStopped) {
    throw 'Owner-stopped identity cannot roll back to an unchecked runtime'
  }
  $oldAction = $task.Actions[0]
  $oldArguments = [string]$oldAction.Arguments
  $oldLaunch = Read-TaskLaunch $oldAction
  $oldEntry = $oldLaunch.Entry
  $originalEndpoint = $oldLaunch.Endpoint
  $oldNode = [IO.Path]::GetFullPath([string]$oldAction.Execute)
  Check-Program $oldNode $oldEntry
  $oldRelative = $oldNode.Substring($root.Length + 1)
  $oldDir = ($oldRelative -split '\\')[0]
  $oldVersion = $oldDir.Substring(0, $oldDir.Length - '-windows-x64'.Length)
  $oldNumber = [version](($oldVersion.Substring(1) -split '-')[0])
  $newNumber = [version](($Version.Substring(1) -split '-')[0])
  if (($Direction -eq 'Upgrade' -and $newNumber -le $oldNumber) -or
      ($Direction -eq 'Rollback' -and $newNumber -ge $oldNumber)) {
    throw 'Invalid version upgrade/rollback direction'
  }
  $candidate = [IO.Path]::Combine($root,($Version + '-windows-x64'))
  $nextNode = [IO.Path]::Combine($candidate,'bin','node.exe')
  $nextBackground = [IO.Path]::Combine($candidate,'bin','rca-background.exe')
  # Legacy RC1/RC2 remains available for explicit rollback only.
  $nextActionExe = if (Test-Path -LiteralPath $nextBackground -PathType Leaf) { $nextBackground } else { $nextNode }
  if ($Direction -eq 'Upgrade' -and $nextActionExe -ne $nextBackground) { throw 'Background launcher required for new version' }
  $nextEntry = [IO.Path]::Combine($candidate,'apps','remote-control-agent','src','windows-v2.js')
  Assert-PrivateVersion $candidate
  # No global PATH dependency; verify the exact newly installed package.
  $manifestPath = [IO.Path]::Combine($candidate,'bundle.json')
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.version -cne $Version -or
      $manifest.upgrade_profile -cnotin @('read-only-no-shell-v1', 'paired-full-v1') -or
      ($Direction -eq 'Upgrade' -and $manifest.upgrade_profile -cne 'paired-full-v1')) {
    throw 'Unreviewed Windows package version or capability profile'
  }
  # Published Node bundles predate agent_runtime; under StrictMode, inspect the JSON property collection before reading it.
  $runtimeProperty = $manifest.PSObject.Properties['agent_runtime']
  $runtime = if ($null -ne $runtimeProperty -and -not [string]::IsNullOrWhiteSpace([string]$runtimeProperty.Value)) {
    [string]$runtimeProperty.Value
  } else { 'node-standard-windows-v2' }
  if ($runtime -ceq 'rust-standard-windows-v1') {
    $nextEntry = [IO.Path]::Combine($candidate,'apps','remote-control-agent','.build','rca-standard-windows-candidate.exe')
  } elseif ($runtime -ceq 'node-standard-windows-v2') {
    $nextEntry = [IO.Path]::Combine($candidate,'apps','remote-control-agent','src','windows-v2.js')
  } else { throw 'Unreviewed Windows runtime profile' }
  Check-Program $nextActionExe $nextEntry
  $profile = $manifest.PSObject.Properties['artifact_profile']
  if ($null -ne $profile -and $profile.Value -ceq 'rust-native-only-v1') {
    if ($Direction -cne 'Upgrade' -or $ownerStopped -or $CIInjectFailure) { throw 'Native-only cutover requires owner-ON upgrade' }
    Invoke-NativeUpgrade $oldVersion $Version $oldLaunch
    exit 0
  }
  $oldManifest = Get-Content -LiteralPath (Join-Path (Join-Path $root $oldDir) 'bundle.json') -Raw | ConvertFrom-Json
  $oldProfile = $oldManifest.PSObject.Properties['artifact_profile']
  if ($null -ne $oldProfile -and $oldProfile.Value -ceq 'rust-native-only-v1') {
    throw 'Native Agent requires guarded upgrade or attended recovery'
  }
  $validator = [IO.Path]::Combine($candidate,'apps','remote-control-agent','scripts','verify-windows-preview.mjs')
  & $nextNode $validator $candidate | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Candidate package manifest verification failed' }
  # Validate the existing paired identity with the reviewed Node CLI; this
  # is a local read-only check and does not launch either runtime or call cloud.
  $statusEntry = [IO.Path]::Combine($candidate,'apps','remote-control-agent','src','windows-v2.js')
  & $nextNode $statusEntry status | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Candidate local identity validation failed' }
  if ($runtime -ceq 'rust-standard-windows-v1') {
    $generation = [guid]::NewGuid().ToString('D')
    $newArgs = '"' + $nextEntry + '" --service --endpoint "' + $originalEndpoint + '" --generation "' + $generation + '"'
  } else {
    $newArgs = '"' + $nextEntry + '" run --endpoint "' + $originalEndpoint + '"'
  }
  $newAction = New-ScheduledTaskAction -Execute $nextActionExe -Argument $newArgs -WorkingDirectory ([IO.Path]::GetDirectoryName($nextEntry))
  $wasRunning = ($task.State -eq 'Running')
  if ($Direction -eq 'Upgrade' -and
      $env:RCA_UNATTENDED_UPGRADE -ceq 'owner-approved-task-v1') {
    $identityFile = [IO.Path]::Combine($env:LOCALAPPDATA,
      'mcp-workers','remote-control','v2-identity.pem')
    Invoke-AgentUpgradeFreeze $identityFile 'verify-frozen'
  }
  $changed = $false
  try {
    if ($wasRunning) { Stop-ScheduledTask -TaskName $name -ErrorAction Stop }
    Set-ScheduledTask -TaskName $name -Action $newAction -ErrorAction Stop | Out-Null
    $changed = $true
    if ($CIInjectFailure) {
      if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Failure injection unavailable outside CI' }
      throw 'Isolated CI switch failure injection'
    }
    $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
    Check-Existing
    if (-not [string]::Equals([string]$task.Actions[0].Execute,$nextActionExe,[StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$task.Actions[0].Arguments,$newArgs,[StringComparison]::Ordinal)) {
      throw 'Task switch was not persisted'
    }
    if ($wasRunning -and -not $ownerStopped) {
      Start-ScheduledTask -TaskName $name -ErrorAction Stop
      Start-Sleep -Seconds 2
      $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
      if ($task.State -ne 'Running') { throw 'Updated Agent exited immediately' }
    }
    # This proves only local version switching, NOT signed WSS liveness.
    Write-Output ('switched-local-' + $Direction.ToLowerInvariant())
    exit 0
  } catch {
    $rollbackOkay = $false
    try {
      # Restore the saved original action without changing principal,
      # trigger, Worker endpoint, cloud grant or identity material.
      if ($changed) { Set-ScheduledTask -TaskName $name -Action $oldAction -ErrorAction Stop | Out-Null }
      $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
      Check-Existing
      if (-not [string]::Equals([string]$task.Actions[0].Execute,$oldNode,[StringComparison]::OrdinalIgnoreCase) -or
          -not [string]::Equals([string]$task.Actions[0].Arguments,$oldArguments,[StringComparison]::Ordinal)) {
        throw 'Previous task action not restored'
      }
      if ($wasRunning -and -not $ownerStopped) { Start-ScheduledTask -TaskName $name -ErrorAction Stop }
      $rollbackOkay = $true
    } catch { $rollbackOkay = $false }
    if ($rollbackOkay) { throw 'Local version switch refused; previous task restored' }
    throw 'Local version switch failed and task restore is uncertain; manual check required'
  }
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
