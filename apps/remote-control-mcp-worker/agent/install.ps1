# Native Windows x64 bootstrap. One mcp-workers latest stable Release per attempt.
# Verify GitHub Release immutability + official SHA256 BEFORE extracting/executing.
[CmdletBinding()]
param(
  [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$')][string]$Version,
  [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$')][string]$SelectedTag,
  [ValidatePattern('^[a-f0-9]{64}$')][string]$SelectedReleaseSha256,
  [string]$OfflineArchive,
  [string]$ExpectedSha256,
  [switch]$StageOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    -not [Environment]::Is64BitOperatingSystem -or -not $env:LOCALAPPDATA -or
    $env:LOCALAPPDATA -notmatch '^[A-Za-z]:[\\/]') {
  throw 'Native 64-bit Windows with a local user profile required'
}
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $me.User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowedSids = @($userSid.Value, $systemSid.Value)
$root = [IO.Path]::Combine($env:LOCALAPPDATA, 'mcp-workers', 'remote-control')
$profile = Get-Item -LiteralPath $env:LOCALAPPDATA -Force
if (-not $profile.PSIsContainer -or
    ($profile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Reparse-point profiles are unsupported'
}
function Assert-PrivateFolder([string]$folder) {
  $item = Get-Item -LiteralPath $folder -Force
  if (-not $item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Unexpected folder type'
  }
  $acl = [IO.Directory]::GetAccessControl($folder)
  if (-not $acl.AreAccessRulesProtected -or
      $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $userSid.Value) {
    throw 'Unsafe folder ownership/inheritance'
  }
  $ownerFull = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $allowedSids -notcontains $rule.IdentityReference.Value) {
      throw 'Unexpected folder ACL grant'
    }
    if ($rule.IdentityReference.Value -eq $userSid.Value -and
        (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq
          [Security.AccessControl.FileSystemRights]::FullControl)) { $ownerFull = $true }
  }
  if (-not $ownerFull) { throw 'Owner lacks full control' }
}
function Ensure-PrivateFolder([string]$folder) {
  if (Test-Path -LiteralPath $folder) { Assert-PrivateFolder $folder; return }
  $null = [IO.Directory]::CreateDirectory($folder)
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($userSid)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($sid in @($userSid, $systemSid)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($folder, $acl)
  Assert-PrivateFolder $folder
}
function Download-ApprovedAsset([string]$firstUri, [string]$dest, [long]$expectedSize) {
  # Do not let an HTTP redirect select a new release source or an internal URL.
  Add-Type -AssemblyName System.Net.Http
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(120)
  $uri = [Uri]::new($firstUri)
  try {
    for ($redirects = 0; $redirects -le 3; $redirects++) {
      if ($uri.Scheme -cne 'https' -or $uri.Port -ne 443 -or
          $uri.UserInfo -or $uri.Fragment -or
          (($redirects -eq 0 -and
            ($uri.AbsoluteUri -cne $firstUri -or $uri.Host -cne 'github.com' -or
             $uri.AbsolutePath -cnotlike '/lirtual/mcp-workers/releases/download/*')) -or
           ($redirects -gt 0 -and $uri.Host -cnotin @(
              'release-assets.githubusercontent.com', 'objects.githubusercontent.com')))) {
        throw 'Unexpected GitHub Release asset redirect'
      }
      $response = $client.GetAsync($uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
      try {
        $status = [int]$response.StatusCode
        if ($status -in @(301,302,303,307,308)) {
          if (-not $response.Headers.Location -or $redirects -eq 3) {
            throw 'GitHub Release asset redirect limit exceeded'
          }
          $uri = [Uri]::new($uri, $response.Headers.Location)
          continue
        }
        if ($status -ne 200 -or
            ($response.Content.Headers.ContentLength -ne $null -and
             ($response.Content.Headers.ContentLength -gt 100000000 -or
              ($expectedSize -gt 0 -and $response.Content.Headers.ContentLength -ne $expectedSize)))) {
          throw 'Untrusted GitHub Release asset response'
        }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [IO.File]::Open($dest, [IO.FileMode]::CreateNew,
                                     [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
          $buffer = [byte[]]::new(65536)
          [long]$total = 0
          while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $count
            if ($total -gt 100000000) { throw 'Oversized GitHub Release asset' }
            $outputStream.Write($buffer, 0, $count)
          }
          if ($expectedSize -gt 0 -and $total -ne $expectedSize) { throw 'Release asset size mismatch' }
          $outputStream.Flush($true)
        } finally {
          $outputStream.Dispose()
          $inputStream.Dispose()
        }
        return
      } finally { $response.Dispose() }
    }
    throw 'GitHub Release asset redirect limit exceeded'
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Resolve-LatestAgentRelease {
  # One lookup. 403/429/404 stop here; do not retry or read another repository.
  $uri = 'https://api.github.com/repos/lirtual/mcp-workers/releases/latest'
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'rca-windows-latest-installer' }
  try {
    $response = Invoke-WebRequest -Uri $uri -Headers $headers -MaximumRedirection 0 -UseBasicParsing -TimeoutSec 30
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 404) { throw 'No stable Agent Release is published' }
    if ($code -eq 403 -or $code -eq 429) { throw 'GitHub rate limit reached; installation stopped' }
    throw 'GitHub latest Release lookup failed'
  }
  if ([int]$response.StatusCode -ne 200) { throw 'GitHub latest Release lookup failed' }
  $release = $response.Content | ConvertFrom-Json
  if ($release.immutable -ne $true -or $release.draft -ne $false -or $release.prerelease -ne $false -or
      $release.tag_name -cnotmatch '^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$') {
    throw 'Latest Agent Release is not a stable immutable Agent Release'
  }
  $tag = [string]$release.tag_name
  $specs = @(
    @{ target = 'linux-x64-glibc'; ext = 'tar.gz' },
    @{ target = 'linux-arm64-glibc'; ext = 'tar.gz' },
    @{ target = 'windows-x64'; ext = 'zip' },
    @{ target = 'darwin-arm64'; ext = 'tar.gz' },
    @{ target = 'darwin-x64'; ext = 'tar.gz' }
  )
  $assets = @($release.assets)
  $platformName = '^remote-control-agent-v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?-(?:linux-x64-glibc|linux-arm64-glibc|windows-x64|darwin-arm64|darwin-x64)\.(?:tar\.gz|zip)$'
  foreach ($asset in $assets) {
    $name = [string]$asset.name
    $known = $false
    foreach ($spec in $specs) {
      if ($name -ceq "remote-control-agent-$tag-$($spec.target).$($spec.ext)") { $known = $true }
    }
    if (-not $known -and $name -cmatch $platformName) {
      throw 'Latest Agent Release is not a stable immutable Agent Release'
    }
  }
  $windows = $null
  foreach ($spec in $specs) {
    $name = "remote-control-agent-$tag-$($spec.target).$($spec.ext)"
    $matched = @($assets | Where-Object { $_.name -ceq $name })
    if ($matched.Count -ne 1) { throw 'Latest Agent Release is missing a platform asset' }
    $asset = $matched[0]
    $expectedUri = "https://github.com/lirtual/mcp-workers/releases/download/$tag/$name"
    if ($asset.digest -cnotmatch '^sha256:[a-f0-9]{64}$') {
      throw 'Latest Agent Release is missing an official SHA-256'
    }
    if ($asset.state -ne 'uploaded' -or $asset.browser_download_url -cne $expectedUri -or
        $asset.size -lt 100000 -or $asset.size -gt 100000000) {
      throw 'Untrusted GitHub Release asset digest/URL'
    }
    if ($spec.target -ceq 'windows-x64') { $windows = $asset }
  }
  if (-not $windows) { throw 'Windows x64 Agent asset is missing' }
  return @{ Tag = $tag; Sha = $windows.digest.Substring(7); Url = [string]$windows.browser_download_url; Size = [long]$windows.size }
}
function Resolve-ReviewedNativeRelease([string]$tag,[string]$sha) {
  # Explicit owner pin: one official tag lookup, no mutable tag or fallback.
  if ($tag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+-rust-candidate\.[1-9][0-9]*$' -or
      $sha -cnotmatch '^[a-f0-9]{64}$') { throw 'Reviewed native candidate tag and SHA-256 required' }
  $uri = "https://api.github.com/repos/lirtual/mcp-workers/releases/tags/$tag"
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'rca-windows-reviewed-installer' }
  $response = Invoke-WebRequest -Uri $uri -Headers $headers -MaximumRedirection 0 -UseBasicParsing -TimeoutSec 30
  if ([int]$response.StatusCode -ne 200) { throw 'Reviewed native Release lookup failed' }
  $release = $response.Content | ConvertFrom-Json
  if ($release.immutable -ne $true -or $release.draft -ne $false -or
      $release.prerelease -ne $true -or $release.tag_name -cne $tag) {
    throw 'Selected native Release is not the reviewed immutable prerelease'
  }
  $name = "remote-control-agent-$tag-windows-x64.zip"
  $expected = "https://github.com/lirtual/mcp-workers/releases/download/$tag/$name"
  $assets = @($release.assets | Where-Object { $_.name -ceq $name })
  if ($assets.Count -ne 1 -or $assets[0].state -ne 'uploaded' -or
      $assets[0].digest -cne ('sha256:' + $sha) -or $assets[0].browser_download_url -cne $expected -or
      $assets[0].size -lt 100000 -or $assets[0].size -gt 100000000) {
    throw 'Reviewed native asset digest, URL or size does not match'
  }
  return @{ Tag=$tag; Sha=$sha; Url=$expected; Size=[long]$assets[0].size }
}
function Assert-ArchiveDigest([string]$file, [string]$sha) {
  if ($sha -cnotmatch '^[a-f0-9]{64}$') { throw 'SHA256 must be the official digest' }
  $item = Get-Item -LiteralPath $file -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $item.Length -lt 100000 -or $item.Length -gt 100000000) {
    throw 'Untrusted ZIP asset file'
  }
  # Use the built-in .NET hash implementation rather than depending on
  # automatic PowerShell module discovery in a fresh restricted user profile.
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open,
      [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { $digest = $hash.ComputeHash($stream) }
    finally { $stream.Dispose() }
    $actual = [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
  } finally { $hash.Dispose() }
  if ($actual -cne $sha) { throw 'Release asset SHA256 mismatch' }
}
function Expand-SafeArchive([string]$file, [string]$folder) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($file)
  try {
    $entries = @($zip.Entries)
    if ($entries.Count -lt 8 -or $entries.Count -gt 70) { throw 'Unexpected ZIP member count' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    foreach ($entry in $entries) {
      $name = $entry.FullName
      if ($name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or
          $name.Contains('//') -or $name -match '(^|/)\.{1,2}(/|$)' -or
          $name -match '[^\x20-\x7e]' -or -not $seen.Add($name)) {
        throw 'ZIP traversal, alias or duplicate'
      }
      $allowedDir = $name -cmatch '^(?:bin|apps|apps/remote-control-agent|apps/remote-control-agent/src|apps/remote-control-agent/scripts|apps/remote-control-agent/\.build)/$'
      $allowedFile = $name -cmatch '^(?:bin/(?:node\.exe|rca-background\.exe)|rca\.cmd|bundle\.json|apps/remote-control-agent/(?:package\.json|(?:src/[a-z0-9-]+\.js|\.build/rca-(?:standard|session)-windows-candidate\.exe)|scripts/(?:(?:windows-private-store|windows-session-private-store|windows-user-task|windows-stage-install|windows-upgrade-once|verify-windows-native)\.ps1|verify-windows-preview\.mjs)))$'
      if (($name.EndsWith('/') -and -not $allowedDir) -or
          (-not $name.EndsWith('/') -and -not $allowedFile)) {
        if ($env:GITHUB_ACTIONS -eq 'true') {
          throw ('Unreviewed CI ZIP member: ' + $name)
        }
        throw 'Unreviewed ZIP member'
      }
      $unixKind = (($entry.ExternalAttributes -shr 16) -band 0xF000)
      if ($unixKind -eq 0xA000 -or $unixKind -eq 0x6000) { throw 'ZIP links forbidden' }
      if (-not $name.EndsWith('/')) {
        if ($entry.Length -lt 0 -or $entry.Length -gt 130000000) { throw 'Oversized ZIP entry' }
        $total += $entry.Length
        if ($total -gt 150000000) { throw 'ZIP expansion limit' }
      }
    }
    foreach ($entry in $entries) {
      $relative = $entry.FullName.TrimEnd('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
      $dest = [IO.Path]::Combine($folder, $relative)
      $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
      if ($entry.FullName.EndsWith('/')) { $null = [IO.Directory]::CreateDirectory($dest); continue }
      $inputStream = $entry.Open()
      try {
        $output = [IO.File]::Open($dest, [IO.FileMode]::CreateNew,
                                 [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $inputStream.CopyTo($output); $output.Flush($true) }
        finally { $output.Dispose() }
      } finally { $inputStream.Dispose() }
    }
  } finally { $zip.Dispose() }
}
# Windows may briefly retain an executable file handle after the verifier
# exits. Retry only the private staging filesystem operation, never the
# installer, the grant request, or the Task switch. Access-denied from a
# directory move can also be a loaded file; persistent denial still fails.
function Invoke-StageFileOperation([scriptblock]$operation) {
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    try { & $operation; return }
    catch {
      $cause = $_.Exception
      while ($cause.InnerException) { $cause = $cause.InnerException }
      $code = $cause.HResult -band 0xffff
      if ($attempt -eq 8 -or $code -notin @(5,32,33)) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}
# Inspect the task target without launching it. The packaged CLI performs
# the complete owner/ACL/task signature validation again before switching.
function Get-ExistingAgentVersion([string]$programs, [string]$taskExe) {
  if (-not $taskExe) { throw 'Existing Agent task has no executable' }
  $base = [IO.Path]::GetFullPath($programs).TrimEnd('\') + '\'
  $exe = [IO.Path]::GetFullPath($taskExe)
  if (-not $exe.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Existing Agent task is outside its private program folder'
  }
  $relative = $exe.Substring($base.Length)
  $matched = [regex]::Match($relative,
    '^(v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?)-windows-x64\\bin\\(?:node\.exe|rca-background\.exe)$',
    [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $matched.Success) { throw 'Unrecognized existing Agent task executable' }
  return $matched.Groups[1].Value
}
function Complete-ApprovedOnboarding([string]$launcher) {
  # The local installer is interactive. Missing grants require one remote MCP
  # owner approval; do not treat a task-start response as proof of WSS online.
  if (Test-Path -LiteralPath ($identityFile + '.owner-stopped')) {
    Write-Output 'Owner STOP preserved. Agent was not started.'
    return
  }
  & $launcher onboard --endpoint 'https://rca.lirtual.dpdns.org/'
  if ($LASTEXITCODE -ne 0) {
    throw 'Authorization incomplete. Identity kept.'
  }
}
# Attended verified native install. Detached production upgrade stays on
# its existing separate path; a console is mandatory for native activation.
function Complete-NativeInstall([string]$directory) {
  $scripts = Join-Path $directory 'apps/remote-control-agent/scripts'
  $entry = Join-Path $directory 'apps/remote-control-agent/.build/rca-standard-windows-candidate.exe'
  $controller = Join-Path $scripts 'windows-user-task.ps1'
  $ps = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $origin = 'https://rca.lirtual.dpdns.org/'
  if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
    throw 'Real owner console required for reviewed native install'
  }
  & (Join-Path $scripts 'verify-windows-native.ps1') -Root $directory -Version $Version | Out-Null
  & (Join-Path $scripts 'windows-private-store.ps1') -Action Check -Directory $root
  if (Test-Path -LiteralPath ($identityFile + '.owner-stopped')) {
    Write-Output 'Owner STOP preserved. Agent was not started.'
    return
  }
  if ($upgradeExisting) {
    & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controller -Action Switch -Version $Version -Direction Upgrade
    if ($LASTEXITCODE -ne 0) { throw 'Native upgrade refused or uncertain; review retained state' }
    return
  }
  $raw = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controller -Action Status
  if ($LASTEXITCODE -ne 0) { throw 'Existing Task status uncertain' }
  $state = $raw | ConvertFrom-Json
  $modePath = $identityFile + '.install-mode'
  if (Test-Path -LiteralPath $modePath) {
    $mode = (Get-Content -LiteralPath $modePath -Raw).Trim()
    if ($mode -cnotin @('permanent','temporary')) { throw 'Untrusted install mode' }
  } else {
    if ($state.installed -or (Test-Path -LiteralPath $identityFile) -or (Test-Path -LiteralPath $idFile)) {
      throw 'Existing identity requires explicit management'
    }
    Write-Host -NoNewline 'Install mode [1] permanent / [2] temporary: '
    try { $selected = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { throw 'Real owner console required' }
    Write-Host ''
    $mode = switch -CaseSensitive ($selected.Character) {
      '1' { 'permanent' }
      '2' { 'temporary' }
      default { throw 'Cancelled. No identity changes.' }
    }
  }
  if ($state.installed -and ($mode -eq 'temporary' -or -not (Test-Path -LiteralPath $idFile))) {
    throw 'Existing Task conflicts with pairing'
  }
  if ($state.installed -and $mode -ceq 'permanent' -and
      -not (Test-Path -LiteralPath ($identityFile + '.activation-pending'))) {
    & $entry --cli onboard --endpoint $origin
    if ($LASTEXITCODE -ne 0) { throw 'Native authorization reconciliation incomplete; existing identity retained' }
    return
  }
  $name = [Environment]::MachineName
  if (-not (Test-Path -LiteralPath $idFile)) {
    $entered = Read-Host ('Device name [' + $name + ']')
    if ($entered.Trim()) { $name = $entered.Trim() }
  }
  & $entry --pair-local $origin $name $mode
  if ($LASTEXITCODE -ne 0) { throw 'Native authorization incomplete; existing identity retained' }
  if ($mode -ceq 'temporary') {
    Write-Output 'Temporary foreground only. Closing the terminal disconnects, not revokes.'
    & $entry --cli run --endpoint $origin
    if ($LASTEXITCODE -ne 0) { throw 'Native foreground session refused' }
    return
  }
  if (-not (Test-Path -LiteralPath ($identityFile + '.activation-pending'))) {
    Write-Output 'Approved identity unchanged; no Task modification.'
    return
  }
  & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controller -Action ActivateNative -Version $Version -Endpoint $origin
  if ($LASTEXITCODE -ne 0) { throw 'Native initial activation incomplete; identity and intent retained' }
}

# Read a console key directly: PromptForChoice renders system-localized
# help/default text even when its title and choices are English.
# Read-Host can consume piped script input from "irm ... | iex".
function Confirm-Upgrade([object]$ui) {
  Write-Host -NoNewline 'Upgrade? [y/N] '
  try {
    $key = $ui.RawUI.ReadKey('NoEcho,IncludeKeyDown')
  } catch {
    Write-Host ''
    throw 'Interactive approval unavailable. No changes.'
  }
  Write-Host ''
  return [bool]($key.KeyDown -and
    ($key.Character -ceq 'y' -or $key.Character -ceq 'Y'))
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
      $answer = $reader.ReadLine()
      $expected = if ($action -ceq 'release') { 'released' } else { 'ready' }
      if ($answer -cne $expected) { throw 'Agent is busy, absent or not frozen' }
    } finally { $reader.Dispose() }
  } finally { $pipe.Dispose() }
}

# A Remote Control Shell may schedule the *reviewed official installer* in a
# separate same-user Windows Task. Never infer approval from missing TTY.
# This opt-in is only valid for an existing approved, currently running Task.
$detachedUpgrade = $env:RCA_UNATTENDED_UPGRADE -ceq 'owner-approved-task-v1'
$detachedRequest = $env:RCA_UNATTENDED_UPGRADE -ceq 'launch-approved-task-v1'
$temp = $null
$stage = $null
$promoted = $false
$primaryFailure = $false
$releaseUrl = $null
$releaseSha = $null
$releaseSize = [long]0
try {
  if ($OfflineArchive) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or -not $Version -or -not $ExpectedSha256) {
      throw 'Offline input is allowed only by explicit CI fixture'
    }
    $releaseSha = $ExpectedSha256
  } elseif ($SelectedTag) {
    if (-not $SelectedReleaseSha256) { throw 'Selected Release digest required' }
    $Version = $SelectedTag
    $releaseSha = $SelectedReleaseSha256
    $releaseUrl = "https://github.com/lirtual/mcp-workers/releases/download/$Version/remote-control-agent-$Version-windows-x64.zip"
    if ($Version -cmatch '^v[0-9]+\.[0-9]+\.[0-9]+-rust-candidate\.[1-9][0-9]*$' -and
        -not $StageOnly -and -not $detachedUpgrade -and -not $detachedRequest) {
      $reviewed = Resolve-ReviewedNativeRelease $Version $releaseSha
      $releaseUrl = $reviewed.Url
      $releaseSize = $reviewed.Size
    }
  } else {
    if ($Version -or $ExpectedSha256) { throw 'Live install resolves the latest Agent Release and does not accept a source pin' }
    $latest = Resolve-LatestAgentRelease
    $Version = [string]$latest.Tag
    $releaseSha = [string]$latest.Sha
    $releaseUrl = [string]$latest.Url
    $releaseSize = [long]$latest.Size
  }
  Ensure-PrivateFolder ([IO.Path]::Combine($env:LOCALAPPDATA, 'mcp-workers'))
  Ensure-PrivateFolder $root
  if (Test-Path -LiteralPath ([IO.Path]::Combine($root,'windows-native-upgrade.json'))) {
    throw 'Unreconciled native upgrade; recover before changing installed programs'
  }
  $programs = [IO.Path]::Combine($root, 'programs')
  Ensure-PrivateFolder $programs
  $target = [IO.Path]::Combine($programs, "$Version-windows-x64")
  $identityFile = [IO.Path]::Combine($root, 'v2-identity.pem')
  $idFile = $identityFile + '.device-id'
  $alreadyPaired = Test-Path -LiteralPath $idFile
  $userTaskName = 'RCA-Remote-Control-v2-' + $userSid.Value.Replace('-', '_')
  $task = Get-ScheduledTask -TaskName $userTaskName -ErrorAction SilentlyContinue
  if ($detachedUpgrade -and (-not $alreadyPaired -or -not $task -or
      $task.State -ne 'Running' -or
      (Test-Path -LiteralPath ($identityFile + '.owner-stopped')))) {
    throw 'Unattended upgrade requires an approved, running, owner-ON Agent'
  }
  if ($detachedUpgrade -and $StageOnly) { throw 'Detached upgrade cannot use stage-only mode' }

  if ($detachedRequest) {
    if ($StageOnly -or -not $alreadyPaired -or -not $task -or
        $task.State -ne 'Running' -or
        (Test-Path -LiteralPath ($identityFile + '.owner-stopped'))) {
      throw 'Remote upgrade requires an approved, running, owner-ON Agent'
    }
    $oldVersion = Get-ExistingAgentVersion $programs ([string]$task.Actions[0].Execute)
    if ([version]($Version.Substring(1)) -le [version]($oldVersion.Substring(1))) {
      throw 'Remote upgrade requires a strictly newer reviewed Release'
    }
    # The parent attempt already selected one latest snapshot. Do not look up latest again.
    $source = [string]$MyInvocation.MyCommand.ScriptBlock.ToString()
    if (-not $source.StartsWith('# Native Windows x64 bootstrap.')) {
      throw 'Cannot stage authenticated installer source'
    }
    $operation = [guid]::NewGuid().ToString('N')
    $name = 'RCA-Upgrade-' + $operation
    $installer = [IO.Path]::Combine($root,'upgrade-source-' + $operation + '.ps1')
    $runner = [IO.Path]::Combine($root,'upgrade-runner-' + $operation + '.ps1')
    $receipt = [IO.Path]::Combine($root,'upgrade-result-' + $operation + '.json')
    $claim = [IO.Path]::Combine($root,'upgrade-claim-' + $operation + '.txt')
    $claimQ = $claim.Replace("'", "''")
    $installerQ = $installer.Replace("'", "''")
    $receiptQ = $receipt.Replace("'", "''")
    $lines = @(
      '$ErrorActionPreference = ''Stop'''
      '$env:RCA_UNATTENDED_UPGRADE = ''owner-approved-task-v1'''
      # Before any switch: a rerun of the same OS Task must fail closed.
      ('$claim = [IO.File]::Open(''' + $claimQ + ''',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)')
      'try {'
      '  $bytes = [Text.Encoding]::UTF8.GetBytes(''claimed'')'
      '  $claim.Write($bytes,0,$bytes.Length); $claim.Flush($true)'
      '} finally { $claim.Dispose() }'
      'try {'
      ("  & '{0}' -SelectedTag '{1}' -SelectedReleaseSha256 '{2}'" -f $installerQ,$Version,$releaseSha)
      '  if (-not $?) { throw ''Local switch failed'' }'
      '  $result = ''local_switch_returned'''
      '} catch { $result = ''needs_attention'' }'
      ('$payload = @{ operation_id = ''' + $operation + '''; status = $result } | ConvertTo-Json -Compress')
      ('$stream = [IO.File]::Open(''' + $receiptQ + ''',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)')
      'try {'
      '  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)'
      '  $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true)'
      '} finally { $stream.Dispose() }'
    )
    $runnerSource = $lines -join [Environment]::NewLine
    # User-private path was ownership/ACL-checked above. No temp-path secrets.
    foreach ($filename in @($installer,$runner)) {
      $value = if ($filename -ceq $installer) { $source } else { $runnerSource }
      $handle = [IO.File]::Open($filename,[IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,[IO.FileShare]::None)
      try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($value)
        $handle.Write($bytes,0,$bytes.Length); $handle.Flush($true)
      } finally { $handle.Dispose() }
    }
    # Demand-start only; zero scheduled triggers prevents blind replay.
    $taskAction = New-ScheduledTaskAction -Execute ([IO.Path]::Combine($PSHOME,'powershell.exe')) -Argument (
      '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $runner + '"')
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $me.Name -LogonType Interactive -RunLevel Limited
    $taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    $definition = New-ScheduledTask -Action $taskAction -Principal $taskPrincipal -Settings $taskSettings
    Register-ScheduledTask -TaskName $name -InputObject $definition -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $name -ErrorAction Stop
    Write-Output ('Detached upgrade launched: ' + $name)
    Write-Output ('Result path: ' + $receipt)
    Write-Output 'Verify result, signed WSS, version, device ID and prior receipts independently.'
    return
  }

  $candidateOnboarding = $SelectedTag -cmatch '^v[0-9]+\.[0-9]+\.[0-9]+-rust-candidate\.[1-9][0-9]*$' -and
    -not $StageOnly -and -not $OfflineArchive -and -not $detachedUpgrade -and -not $detachedRequest
  # Only the official immutable Latest lookup (not an arbitrary stable pin,
  # offline fixture or detached task) can admit attended stable native install.
  $stableOnboarding = -not $SelectedTag -and -not $OfflineArchive -and
    -not $StageOnly -and -not $detachedUpgrade -and -not $detachedRequest
  $nativeOnboarding = $candidateOnboarding -or $stableOnboarding
  $upgradeExisting = $false
  if ($alreadyPaired) {
    if (-not (Test-Path -LiteralPath $identityFile -PathType Leaf)) {
      throw 'Existing device ID has no private key; refusing upgrade'
    }
    if (-not $task) {
      if (-not $nativeOnboarding -or -not (Test-Path -LiteralPath ($identityFile + '.install-mode'))) {
        throw 'Existing device has no user-logon task; use explicit device management'
      }
    } elseif ($task.Actions.Count -ne 1) {
      throw 'Unreviewed existing user-logon Task'
    }
    $oldVersion = if ($task) { Get-ExistingAgentVersion $programs ([string]$task.Actions[0].Execute) } else { $Version }
    if ($oldVersion -cne $Version) {
      $oldNumber = [version](($oldVersion.Substring(1) -split '-')[0])
      $newNumber = [version](($Version.Substring(1) -split '-')[0])
      $stablePromotion = $stableOnboarding -and ($newNumber -eq $oldNumber) -and
        $oldVersion -cmatch '^v[0-9]+\.[0-9]+\.[0-9]+-rust-candidate\.[1-9][0-9]*$'
      if ($newNumber -le $oldNumber -and -not $stablePromotion) { throw 'Automatic downgrade or same-version replacement refused' }
      Write-Output ("Agent: {0} -> {1}" -f $oldVersion, $Version)
      Write-Output 'Finish active operations before upgrading.'
      Write-Output ("Task: {0} (state preserved)" -f $task.State)
      # Console key comes from RawUI, not redirected pipeline stdin.
      # Any key other than Y (including Enter) is a safe cancellation.
      if (-not $StageOnly -and -not $detachedUpgrade -and -not (Confirm-Upgrade $Host.UI)) {
        Write-Output 'Cancelled. No changes.'
        return
      }
      $upgradeExisting = $true
    }
  } elseif ($task) {
    throw 'Existing user-logon task without an approved local identity; refusing new pairing'
  }
  if ($StageOnly -and -not $upgradeExisting) {
    throw 'Staging requires an existing paired device with a strictly newer target version'
  }
  if (Test-Path -LiteralPath $target) {
    Assert-PrivateFolder $target
    # Reuse only the explicitly reviewed immutable native candidate.
    # Never overwrite an already present program directory.
    $installedManifest = Get-Content -LiteralPath (Join-Path $target 'bundle.json') -Raw | ConvertFrom-Json
    $installedProfile = $installedManifest.PSObject.Properties['artifact_profile']
    if ($null -ne $installedProfile -and $installedProfile.Value -ceq 'rust-native-only-v1') {
      if (-not $nativeOnboarding) { throw 'Native-only bundle requires reviewed attended onboarding' }
      $temp = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('rca-' + [guid]::NewGuid().ToString('N') + '.zip'))
      Download-ApprovedAsset $releaseUrl $temp $releaseSize
      Assert-ArchiveDigest $temp $releaseSha
      $stage = [IO.Path]::Combine($programs, ('.stage-' + [guid]::NewGuid().ToString('N')))
      Ensure-PrivateFolder $stage
      Expand-SafeArchive $temp $stage
      & (Join-Path $stage 'apps/remote-control-agent/scripts/verify-windows-native.ps1') -Root $stage -Version $Version | Out-Null
      if ((Get-FileHash -LiteralPath (Join-Path $stage 'bundle.json') -Algorithm SHA256).Hash -cne
          (Get-FileHash -LiteralPath (Join-Path $target 'bundle.json') -Algorithm SHA256).Hash) {
        throw 'Installed candidate does not match reviewed asset'
      }
      # Run the trusted verifier from the reviewed ZIP against the installed
      # directory before executing any installed script or binary.
      & (Join-Path $stage 'apps/remote-control-agent/scripts/verify-windows-native.ps1') -Root $target -Version $Version | Out-Null
      Complete-NativeInstall $target
      return
    }
    if ($alreadyPaired -and -not $task) { throw 'Unreviewed existing identity without Task' }
    $nodeExisting = [IO.Path]::Combine($target,'bin','node.exe')
    $verifyExisting = [IO.Path]::Combine($target,'apps','remote-control-agent','scripts','verify-windows-preview.mjs')
    & $nodeExisting $verifyExisting $target | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Existing program manifest failed verification' }
    if ($StageOnly) {
      Write-Output ('Verified staging already exists: ' + $Version)
      return
    }
    if ($upgradeExisting) {
      $upgradeFrozen = $false
      try {
        if ($detachedUpgrade) { Invoke-AgentUpgradeFreeze $identityFile 'freeze'; $upgradeFrozen = $true }
        & ([IO.Path]::Combine($target,'rca.cmd')) upgrade --version $Version | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Upgrade failed. Task kept or restored.' }
      } finally {
        if ($upgradeFrozen) {
          try { Invoke-AgentUpgradeFreeze $identityFile 'release' }
          catch { } # Original Agent may already have been replaced.
        }
      }
      if ($detachedUpgrade) {
        Write-Output 'Local switch returned; independent signed-WSS verification required.'
      } else {
        Write-Output 'Upgraded. Checking authorization...'
        Complete-ApprovedOnboarding ([IO.Path]::Combine($target,'rca.cmd'))
      }
      return
    }
    if ($detachedUpgrade) {
      Write-Output 'Already installed; independent signed-WSS verification required.'
      return
    }
    if ($alreadyPaired) {
      $storedId = (Get-Content -LiteralPath $idFile -Raw).Trim()
      if ($storedId -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'Untrusted stored device ID' }
      Write-Output ('Device ID: ' + $storedId)
      Complete-ApprovedOnboarding ([IO.Path]::Combine($target,'rca.cmd'))
      return
    }
    Complete-ApprovedOnboarding ([IO.Path]::Combine($target,'rca.cmd'))
    return
  }
  $temp = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('rca-' + [guid]::NewGuid().ToString('N') + '.zip'))
  if ($OfflineArchive) {
    [IO.File]::Copy([IO.Path]::GetFullPath($OfflineArchive), $temp, $false)
    $expected = $ExpectedSha256
  } else {
    if ($ExpectedSha256) { throw 'Live checksum must come from immutable GitHub Release' }
    if (-not $releaseUrl -or -not $releaseSha) { throw 'Latest Agent Release was not resolved' }
    Download-ApprovedAsset $releaseUrl $temp $releaseSize
    $expected = $releaseSha
  }
  Assert-ArchiveDigest $temp $expected
  $stage = [IO.Path]::Combine($programs, ('.stage-' + [guid]::NewGuid().ToString('N')))
  Ensure-PrivateFolder $stage
  Expand-SafeArchive $temp $stage
  $manifest = Get-Content -LiteralPath ([IO.Path]::Combine($stage, 'bundle.json')) -Raw | ConvertFrom-Json
  if ($manifest.version -cne $Version) { throw 'Manifest version mismatch' }
  $profile = $manifest.PSObject.Properties['artifact_profile']
  if ($null -ne $profile -and $profile.Value -ceq 'rust-native-only-v1') {
    if (-not $StageOnly -and -not $nativeOnboarding) {
      throw 'Native-only Windows bundle requires reviewed attended onboarding'
    }
    # The outer reviewed ZIP SHA256 was checked before extraction.
    $verifier = Join-Path $stage 'apps/remote-control-agent/scripts/verify-windows-native.ps1'
    & $verifier -Root $stage -Version $Version | Out-Null
  } else {
    if ($alreadyPaired -and -not $task) { throw 'Unreviewed existing identity without Task' }
    $node = [IO.Path]::Combine($stage, 'bin', 'node.exe')
    $verifier = [IO.Path]::Combine($stage, 'apps', 'remote-control-agent',
                                  'scripts', 'verify-windows-preview.mjs')
    & $node $verifier $stage | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Bundle file manifest failed verification' }
  }
  Invoke-StageFileOperation {
    Assert-PrivateFolder $stage
    if (Test-Path -LiteralPath $target) { throw 'Target already exists; refuse stage promotion' }
    [IO.Directory]::Move($stage, $target)
  }
  $promoted = $true
  Write-Output "Installed: $Version"
  if ($StageOnly) {
    Write-Output ('Verified staging complete; running Agent task unchanged: ' + $Version)
    return
  }
  if ($null -ne $profile -and $profile.Value -ceq 'rust-native-only-v1') {
    Complete-NativeInstall $target
    return
  }
  if ($upgradeExisting) {
    $upgradeFrozen = $false
    try {
      if ($detachedUpgrade) { Invoke-AgentUpgradeFreeze $identityFile 'freeze'; $upgradeFrozen = $true }
      & ([IO.Path]::Combine($target,'rca.cmd')) upgrade --version $Version | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Upgrade failed. Task kept or restored.' }
    } finally {
      if ($upgradeFrozen) {
        try { Invoke-AgentUpgradeFreeze $identityFile 'release' }
        catch { } # Original Agent may already have been replaced.
      }
    }
    if ($detachedUpgrade) {
      Write-Output 'Local switch returned; independent signed-WSS verification required.'
    } else {
      Write-Output 'Upgraded. Checking authorization...'
      Complete-ApprovedOnboarding ([IO.Path]::Combine($target,'rca.cmd'))
    }
    return
  }
  Complete-ApprovedOnboarding ([IO.Path]::Combine($target,'rca.cmd'))
} catch {
  $primaryFailure = $true
  throw
} finally {
  # An exception during cleanup must not mask the primary install result.
  $cleanupFailed = $false
  if ($temp -and (Test-Path -LiteralPath $temp)) {
    try { Invoke-StageFileOperation { Remove-Item -LiteralPath $temp -Force -ErrorAction Stop } }
    catch { $cleanupFailed = $true }
  }
  if (-not $promoted -and $stage -and (Test-Path -LiteralPath $stage)) {
    try {
      Invoke-StageFileOperation {
        if (Test-Path -LiteralPath $stage) {
          Assert-PrivateFolder $stage
          Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop
        }
      }
    } catch { $cleanupFailed = $true }
  }
  if ($cleanupFailed) {
    if (-not $primaryFailure) { throw 'Private installer staging cleanup incomplete' }
    Write-Warning 'Private installer staging cleanup incomplete; original failure preserved'
  }
}
