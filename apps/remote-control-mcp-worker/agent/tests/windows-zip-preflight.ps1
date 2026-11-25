param([string]$Installer)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Installer parse failure' }
$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Expand-SafeArchive'},$true)
if (-not $fn) { throw 'Missing archive preflight' }
. ([scriptblock]::Create($fn.Extent.Text))
# Test the real pinned-release resolver without contacting GitHub. The
# detached worker must use the exact selected stable tag/digest, never Latest.
$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Resolve-ReviewedNativeRelease'},$true)
if (-not $fn) { throw 'Missing pinned Release resolver' }
. ([scriptblock]::Create($fn.Extent.Text))
$script:fixtureRequests=@()
function Invoke-WebRequest {
  param($Uri,$Headers,$MaximumRedirection,[switch]$UseBasicParsing,$TimeoutSec)
  $script:fixtureRequests+= [string]$Uri
  [pscustomobject]@{StatusCode=200; Content=($script:fixtureRelease | ConvertTo-Json -Depth 8 -Compress)}
}
$sha='a'*64
foreach ($stable in @($true,$false)) {
  $tag=if ($stable) {'v0.1.58'} else {'v0.1.58-rust-candidate.6'}
  $url="https://github.com/lirtual/mcp-workers/releases/download/$tag/remote-control-agent-$tag-windows-x64.zip"
  $asset=[pscustomobject]@{name="remote-control-agent-$tag-windows-x64.zip";state='uploaded';digest=('sha256:'+$sha);browser_download_url=$url;size=7000000}
  $script:fixtureRelease=[pscustomobject]@{immutable=$true;draft=$false;prerelease=(-not $stable);tag_name=$tag;assets=@($asset)}
  $script:fixtureRequests=@()
  $chosen=Resolve-ReviewedNativeRelease $tag $sha $stable
  if ($chosen.Tag -cne $tag -or $chosen.Sha -cne $sha -or $chosen.Url -cne $url -or
      $script:fixtureRequests.Count -ne 1 -or
      $script:fixtureRequests[0] -cne "https://api.github.com/repos/lirtual/mcp-workers/releases/tags/$tag") {
    throw 'Unexpected pinned Release selection'
  }
  foreach ($case in @('wrong-prerelease','mutable','wrong-digest','duplicate','wrong-url','wrong-tag')) {
    $script:fixtureRelease=[pscustomobject]@{immutable=$true;draft=$false;prerelease=(-not $stable);tag_name=$tag;assets=@($asset)}
    switch ($case) {
      'wrong-prerelease' {$script:fixtureRelease.prerelease=$stable}
      'mutable' {$script:fixtureRelease.immutable=$false}
      'wrong-digest' {$script:fixtureRelease.assets=@([pscustomobject]@{name=$asset.name;state='uploaded';digest=('sha256:'+('b'*64));browser_download_url=$url;size=7000000})}
      'duplicate' {$script:fixtureRelease.assets=@($asset,$asset)}
      'wrong-url' {$script:fixtureRelease.assets=@([pscustomobject]@{name=$asset.name;state='uploaded';digest=$asset.digest;browser_download_url='https://example.invalid/asset';size=7000000})}
      'wrong-tag' {$script:fixtureRelease.tag_name='v0.1.99'}
    }
    $ok=$false
    try {$null=Resolve-ReviewedNativeRelease $tag $sha $stable; $ok=$true} catch {}
    if ($ok) {throw "Unsafe pinned Release accepted: $case"}
  }
  $before=$script:fixtureRequests.Count
  $ok=$false
  try {$null=Resolve-ReviewedNativeRelease $tag $sha (-not $stable); $ok=$true} catch {}
  if ($ok -or $script:fixtureRequests.Count -ne $before) {throw 'Wrong pin class reached the network'}
}
'WINDOWS_PINNED_RELEASE_CONTRACT_PASS'
# Stable Latest must satisfy the shared publication contract before any
# read-only comparison. Reuse the installer resolver and mock only HTTP.
foreach ($functionName in @('Resolve-LatestAgentRelease','Get-LatestUpdateStatus')) {
  $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $functionName},$true)
  if (-not $fn) { throw "Missing $functionName" }
  . ([scriptblock]::Create($fn.Extent.Text))
}
function New-LatestFixture {
  $tag='v0.1.60'
  $assets=@(foreach ($target in @('linux-x64-glibc','linux-arm64-glibc','windows-x64','darwin-arm64','darwin-x64')) {
    $extension=if ($target -eq 'windows-x64') {'zip'} else {'tar.gz'}
    $name="remote-control-agent-$tag-$target.$extension"
    [pscustomobject]@{name=$name;state='uploaded';digest=('sha256:'+('a'*64));browser_download_url="https://github.com/lirtual/mcp-workers/releases/download/$tag/$name";size=7000000}
  })
  [pscustomobject]@{immutable=$true;draft=$false;prerelease=$false;tag_name=$tag;html_url="https://github.com/lirtual/mcp-workers/releases/tag/$tag";assets=$assets}
}
$script:fixtureRelease=New-LatestFixture
foreach ($case in @(@('v0.1.59','update_available'),@('v0.1.60','up_to_date'),@('v0.1.60-rust-candidate.1','update_available'),@('v0.1.61','older_latest'),@('v00.1.60','unknown'))) {
  $script:fixtureRequests=@()
  $result=Get-LatestUpdateStatus $case[0]
  if ($result.installed_version -cne $case[0] -or $result.status -cne $case[1] -or $script:fixtureRequests.Count -gt 1) {
    throw "Wrong Latest comparison: $($case -join ',')"
  }
  if ($case[1] -ne 'unknown' -and ($result.latest_version -cne 'v0.1.60' -or $script:fixtureRequests.Count -ne 1)) { throw 'Latest observation missing' }
}
foreach ($bad in @('wrong-repo','string-immutable','string-size','fraction-size','missing-platform','duplicate','bad-digest','wrong-url','mutable')) {
  $script:fixtureRelease=New-LatestFixture
  switch ($bad) {
    'wrong-repo' {$script:fixtureRelease.html_url='https://example.invalid/release'}
    'string-immutable' {$script:fixtureRelease.immutable='true'}
    'string-size' {$script:fixtureRelease.assets[2].size='7000000'}
    'fraction-size' {$script:fixtureRelease.assets[2].size=7000000.5}
    'missing-platform' {$script:fixtureRelease.assets=@($script:fixtureRelease.assets[0..3])}
    'duplicate' {$script:fixtureRelease.assets+= $script:fixtureRelease.assets[2]}
    'bad-digest' {$script:fixtureRelease.assets[2].digest='sha256:wrong'}
    'wrong-url' {$script:fixtureRelease.assets[2].browser_download_url='https://example.invalid/asset'}
    'mutable' {$script:fixtureRelease.immutable=$false}
  }
  $script:fixtureRequests=@()
  $result=Get-LatestUpdateStatus 'v0.1.59'
  if ($result.status -cne 'unknown' -or $null -ne $result.latest_version -or $script:fixtureRequests.Count -ne 1) { throw "Unsafe Latest accepted: $bad" }
}
'WINDOWS_LATEST_CHECK_CONTRACT_PASS'
Remove-Item Function:\Invoke-WebRequest
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root=Join-Path ([IO.Path]::GetTempPath()) ('rca-zip-contract-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
try {
  $names=@('bundle.json','rca.cmd','bin/rca-background.exe',
    'apps/remote-control-agent/.build/rca-standard-windows-candidate.exe',
    'apps/remote-control-agent/scripts/windows-private-store.ps1',
    'apps/remote-control-agent/scripts/windows-user-task.ps1',
    'apps/remote-control-agent/scripts/windows-stage-install.ps1',
    'apps/remote-control-agent/scripts/verify-windows-native.ps1')
  $session='apps/remote-control-agent/.build/rca-session-windows-candidate.exe'
  foreach ($case in @('old','new','unknown','duplicate','traversal','node')) {
    $zipPath=Join-Path $root ($case+'.zip')
    $zip=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Create)
    try {
      $entries=@($names)
      switch ($case) {
        new {$entries+= $session}
        unknown {$entries+='apps/remote-control-agent/.build/extra.exe'}
        duplicate {$entries+=@($session,$session.ToUpperInvariant())}
        traversal {$entries+='apps/../extra.exe'}
        node {$entries+='bin/node.exe'}
      }
      foreach ($name in $entries) {
        $entry=$zip.CreateEntry($name); $stream=$entry.Open()
        try {$stream.WriteByte(1)} finally {$stream.Dispose()}
      }
    } finally {$zip.Dispose()}
    $dest=Join-Path $root $case
    $null=New-Item -ItemType Directory -Path $dest
    $ok=$true
    try {Expand-SafeArchive $zipPath $dest} catch {$ok=$false}
    if ($ok -ne ($case -in @('old','new'))) {throw "Archive preflight unexpected result: $case"}
    if ($case -eq 'new' -and -not (Test-Path -LiteralPath (Join-Path $dest $session))) {throw 'Missing extracted Session entry'}
  }
  'WINDOWS_ZIP_PREFLIGHT_PASS'
} finally {Remove-Item -LiteralPath $root -Recurse -Force}
