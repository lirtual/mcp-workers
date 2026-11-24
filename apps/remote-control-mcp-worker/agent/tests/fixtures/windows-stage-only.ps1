# CI-only staging of an independently hash-pinned native baseline.
# Reuse the real installer functions, never perform onboarding or task writes.
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+(?:-rust-candidate\.[1-9][0-9]*)?$')][string]$Version,
  [Parameter(Mandatory=$true)][string]$OfflineArchive,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Isolated hosted Windows CI required' }
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $me.User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowedSids = @($userSid.Value,$systemSid.Value)
$root = Join-Path $env:LOCALAPPDATA 'mcp-workers/remote-control'
$programs = Join-Path $root 'programs'
$target = Join-Path $programs "$Version-windows-x64"
$installer = (Resolve-Path (Join-Path $PSScriptRoot '../../install.ps1')).Path
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Installer parse failed' }
foreach ($functionName in @('Assert-PrivateFolder','Ensure-PrivateFolder','Assert-ArchiveDigest','Expand-SafeArchive')) {
  $fn = $ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $functionName},$true)
  if (-not $fn) { throw 'Missing installer stage contract' }
  . ([scriptblock]::Create($fn.Extent.Text))
}
if (Test-Path -LiteralPath (Join-Path $root 'v2-identity.pem')) { throw 'Unexpected existing fixture identity' }
if (Test-Path -LiteralPath $target) { throw 'Unexpected existing fixture program' }
Assert-ArchiveDigest $OfflineArchive $ExpectedSha256
Ensure-PrivateFolder (Split-Path -Parent $root)
Ensure-PrivateFolder $root
Ensure-PrivateFolder $programs
$stage = Join-Path $programs ('.stage-' + [guid]::NewGuid().ToString('N'))
Ensure-PrivateFolder $stage
try {
  Expand-SafeArchive $OfflineArchive $stage
  & (Join-Path $PSScriptRoot '../../scripts/verify-windows-native.ps1') -Root $stage -Version $Version
  if (Test-Path -LiteralPath $target) { throw 'Refusing to overwrite fixture' }
  [IO.Directory]::Move($stage,$target)
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
