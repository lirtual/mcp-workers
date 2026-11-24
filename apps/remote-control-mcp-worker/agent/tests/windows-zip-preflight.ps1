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
  foreach ($case in @('old','new','unknown','duplicate','traversal')) {
    $zipPath=Join-Path $root ($case+'.zip')
    $zip=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Create)
    try {
      $entries=@($names)
      switch ($case) {
        new {$entries+= $session}
        unknown {$entries+='apps/remote-control-agent/.build/extra.exe'}
        duplicate {$entries+=@($session,$session.ToUpperInvariant())}
        traversal {$entries+='apps/../extra.exe'}
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
