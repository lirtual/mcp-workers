# Verify the exact native-only candidate inventory. Called only after a
# trusted outer ZIP digest has been verified (or for an owned installed version).
# Uses built-in PowerShell/.NET, never launches either Agent or Node.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+-rust-candidate\.[1-9][0-9]*$')][string]$Version
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$rootItem = Get-Item -LiteralPath $Root -Force
if (-not $rootItem.PSIsContainer -or
    ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Untrusted native bundle root'
}
$app = 'apps/remote-control-agent'
$files = @(
  'bin/rca-background.exe',
  "$app/.build/rca-standard-windows-candidate.exe",
  "$app/scripts/windows-private-store.ps1",
  "$app/scripts/windows-user-task.ps1",
  "$app/scripts/windows-stage-install.ps1",
  "$app/scripts/verify-windows-native.ps1"
)
$dirs = @('bin','apps',$app,"$app/.build","$app/scripts")
$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
# Inspect each directory before traversing it. In particular, never follow
# junctions or symbolic links to validate an external file as a bundle member.
function Visit-Bundle([string]$directory,[string]$relative) {
  foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
    $name = if ($relative) { "$relative/$($item.Name)" } else { $item.Name }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not $seen.Add($name)) { throw 'Untrusted native bundle entry' }
    if ($item.PSIsContainer) {
      if ($name -cnotin $dirs) { throw 'Unreviewed native bundle directory' }
      Visit-Bundle $item.FullName $name
    } elseif ($name -cne 'bundle.json' -and $name -cnotin $files) {
      throw 'Unreviewed native bundle file'
    }
  }
}
Visit-Bundle $rootItem.FullName ''
foreach ($name in @('bundle.json') + $files + $dirs) {
  if (-not $seen.Contains($name)) { throw 'Incomplete native bundle inventory' }
}
$manifest = Get-Content -LiteralPath (Join-Path $rootItem.FullName 'bundle.json') -Raw | ConvertFrom-Json
if ($manifest.name -cne 'remote-control-agent' -or $manifest.version -cne $Version -or
    $manifest.target -cne 'windows-x64' -or $manifest.artifact_schema -ne 1 -or
    $manifest.device_protocol -ne 2 -or $manifest.preview -ne $true -or
    $manifest.upgrade_profile -cne 'paired-full-v1' -or
    $manifest.artifact_profile -cne 'rust-native-only-v1' -or
    $manifest.agent_runtime -cne 'rust-standard-windows-v1' -or
    $manifest.runtime_profile -cne 'standard-windows-rust-runtime-v1' -or
    $null -ne $manifest.PSObject.Properties['node'] -or
    $null -ne $manifest.PSObject.Properties['browser_runtime'] -or
    @($manifest.modules).Count -ne 0) {
  throw 'Unreviewed native-only Windows manifest'
}
$hashes = @($manifest.hashes.PSObject.Properties)
if ($hashes.Count -ne $files.Count) { throw 'Unreviewed native bundle hashes' }
foreach ($name in $files) {
  $record = @($hashes | Where-Object { $_.Name -ceq $name })
  if ($record.Count -ne 1 -or $record[0].Value -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Missing native bundle checksum'
  }
  $actual = (Get-FileHash -LiteralPath (Join-Path $rootItem.FullName $name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $record[0].Value) { throw 'Native bundle checksum mismatch' }
}
Write-Output 'Verified native-only Windows candidate inventory'
