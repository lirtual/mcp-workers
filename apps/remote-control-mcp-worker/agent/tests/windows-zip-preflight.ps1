param([string]$Installer)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Installer parse failure' }
$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Expand-SafeArchive'},$true)
if (-not $fn) { throw 'Missing archive preflight' }
. ([scriptblock]::Create($fn.Extent.Text))
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
