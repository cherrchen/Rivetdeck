# Uninstall data-cleanup scenarios beyond the default lifecycle covered by
# smoke-windows-installer.ps1: each scenario runs a full install/seed/uninstall/assert
# cycle against one installer artifact. Covers the branches a default /S uninstall
# cannot reach: --delete-app-data gating, update and replacement preservation flags,
# locked-file residue, junction safety, and recorded extra userData roots.
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'

$installer = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$userData = Join-Path $env:APPDATA 'Rivetdeck'
$updaterCache = Join-Path $env:LOCALAPPDATA 'rivetdeck-updater'
$residueLog = Join-Path $env:APPDATA 'Rivetdeck-uninstall-residue.log'
# The path-history record lives beside the default userData so the app can always write
# it; it survives install-directory removal by design.
$historyFile = Join-Path $env:APPDATA 'rivetdeck-path-history.ini'

function Assert-Exists([string]$Path, [string]$Because) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Missing $Path ($Because)" }
}
function Assert-Missing([string]$Path, [string]$Because) {
  if (Test-Path -LiteralPath $Path) { throw "Unexpected $Path ($Because)" }
}
function Assert-Residue([string]$Pattern) {
  Assert-Exists $residueLog 'skipped cleanup must be reported'
  if (-not (Select-String -LiteralPath $residueLog -Pattern $Pattern -Quiet)) {
    throw "Residue report lacks '$Pattern'"
  }
}

# A scenario always starts from a clean machine state so leftovers cannot mask a skip.
function Reset-State {
  foreach ($path in @($userData, $updaterCache, $residueLog, $historyFile)) {
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-To([string]$Dir) {
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', '/currentuser', "/D=$Dir") -WindowStyle Hidden -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer exited with code $($install.ExitCode)." }
  Assert-Exists (Join-Path $Dir 'Rivetdeck.exe') 'install must complete'
  Assert-Exists (Join-Path $Dir 'Uninstall Rivetdeck.exe') 'install must complete'
  Assert-Exists $historyFile 'a fresh install seeds the path-history record'
}

function Uninstall-From([string]$Dir, [string[]]$ExtraArgs = @()) {
  $uninstall = Start-Process -FilePath (Join-Path $Dir 'Uninstall Rivetdeck.exe') -ArgumentList (@('/S', '/currentuser') + $ExtraArgs) -WindowStyle Hidden -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with code $($uninstall.ExitCode)." }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Test-Path -LiteralPath (Join-Path $Dir 'Rivetdeck.exe')) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  Assert-Missing (Join-Path $Dir 'Rivetdeck.exe') 'uninstall must remove the install directory'
}

# Minimal attributed userData: one product marker plus representative preserved content.
function Plant-UserData {
  New-Item -ItemType Directory -Force -Path (Join-Path $userData 'Cache') | Out-Null
  Set-Content -LiteralPath (Join-Path $userData 'Cache\data_0') -Value 'x'
  Set-Content -LiteralPath (Join-Path $userData 'Local State') -Value 'x'
  Set-Content -LiteralPath (Join-Path $userData 'desktop-preferences.json') -Value '{}'
  Set-Content -LiteralPath (Join-Path $userData 'Cookies') -Value 'x'
}

$scratch = Join-Path $env:RUNNER_TEMP 'dsh-uninstall-scenarios'
Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
$installDirectory = Join-Path $scratch 'install'

try {
  # Scenario 1: --delete-app-data with a complete seeded record removes the whole root.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  New-Item -ItemType Directory -Force -Path (Join-Path $updaterCache 'pending') | Out-Null
  Uninstall-From $installDirectory '--delete-app-data'
  Assert-Missing $userData 'complete history plus the flag removes all userData'
  Assert-Missing $updaterCache 'the updater cache is a cleanup target'

  # Scenario 2: --delete-app-data with an incomplete record falls back to tiered cleanup.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  Set-Content -LiteralPath $historyFile -Value "complete=0`r`n"
  Uninstall-From $installDirectory '--delete-app-data'
  Assert-Exists (Join-Path $userData 'desktop-preferences.json') 'incomplete history never fully removes userData'
  Assert-Exists (Join-Path $userData 'Cookies') 'incomplete history never fully removes userData'
  Assert-Exists (Join-Path $userData 'Cache\data_0') 'incomplete history cannot prove cache isolation'
  Assert-Residue 'Rivetdeck'

  # Legacy homes can occupy updater staging or a managed runtime generation.
  foreach ($purge in @($false, $true)) {
    Reset-State
    Install-To $installDirectory
    Plant-UserData
    Set-Content -LiteralPath $historyFile -Value "complete=0`r`n"
    $updaterHome = Join-Path $updaterCache 'pending\home'
    $runtimeHome = Join-Path $userData 'managed-toolchains\node\24.5.0\win32-x64\3f8a1c2e-0000-4abc-9def-0123456789ab\home'
    foreach ($legacyHomePath in @($updaterHome, $runtimeHome)) {
      New-Item -ItemType Directory -Force -Path $legacyHomePath | Out-Null
      Set-Content -LiteralPath (Join-Path $legacyHomePath 'sessions.jsonl') -Value 'retained'
    }
    if ($purge) { Uninstall-From $installDirectory '--delete-app-data' }
    else { Uninstall-From $installDirectory }
    Assert-Exists (Join-Path $updaterHome 'sessions.jsonl') 'incomplete history preserves updater subtrees'
    Assert-Exists (Join-Path $runtimeHome 'sessions.jsonl') 'incomplete history preserves runtime subtrees'
    Assert-Residue 'updater isolation requires complete history'
    Assert-Residue 'runtime isolation requires complete history'
  }

  # An unwritable report must not prevent program removal or remove retained user data.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  Set-Content -LiteralPath $historyFile -Value "complete=0`r`n"
  Set-Content -LiteralPath $residueLog -Value 'old report'
  $heldReport = [IO.File]::Open($residueLog, 'Open', 'Read', 'None')
  try {
    Uninstall-From $installDirectory
  } finally {
    $heldReport.Dispose()
  }
  Assert-Exists (Join-Path $userData 'Cache\data_0') 'failed reporting does not permit cache deletion'
  if ((Get-Content -LiteralPath $residueLog -Raw).Trim() -ne 'old report') { throw 'Locked residue report was replaced.' }

  # Scenario 3: --delete-app-data with a damaged protection claim refuses every target.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  Set-Content -LiteralPath $historyFile -Value "complete=1`r`ndshHome=relative\path`r`n"
  New-Item -ItemType Directory -Force -Path (Join-Path $updaterCache 'pending') | Out-Null
  Uninstall-From $installDirectory '--delete-app-data'
  Assert-Exists (Join-Path $userData 'Cache\data_0') 'an unresolvable protection claim blocks every deletion'
  Assert-Exists $updaterCache 'an unresolvable protection claim blocks every deletion'
  Assert-Residue 'protected'

  # Scenario 4: the --updated flag an update passes to the old uninstaller preserves all data.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  Uninstall-From $installDirectory '--updated'
  Assert-Exists (Join-Path $userData 'Cache\data_0') 'updates never delete data'
  Assert-Exists (Join-Path $userData 'Cookies') 'updates never delete data'
  Assert-Exists $historyFile 'the record survives for the succeeding install'

  # Scenario 5: /KEEP_APP_DATA, passed when the installer replaces an old uninstaller, preserves all data.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  Uninstall-From $installDirectory '/KEEP_APP_DATA'
  Assert-Exists (Join-Path $userData 'Cache\data_0') 'uninstaller replacement never deletes data'
  Assert-Exists $historyFile 'the record survives for the succeeding install'

  # Scenario 6: a locked file inside a removal target is tolerated and reported.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  $locked = Join-Path $userData 'Cache\locked.bin'
  Set-Content -LiteralPath $locked -Value 'x'
  $held = [IO.File]::Open($locked, 'Open', 'Read', 'None')
  try {
    Uninstall-From $installDirectory
  } finally {
    if ($held) { $held.Dispose() }
  }
  Assert-Exists $locked 'a locked file survives a best-effort uninstall'
  Assert-Residue 'Cache'

  # Scenario 7: a junction inside a removal target is unlinked without reaching the target.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  $junctionTarget = Join-Path $scratch 'elsewhere-target'
  New-Item -ItemType Directory -Force -Path $junctionTarget | Out-Null
  Set-Content -LiteralPath (Join-Path $junctionTarget 'keep.me') -Value 'x'
  New-Item -ItemType Junction -Path (Join-Path $userData 'Cache\linked') -Target $junctionTarget | Out-Null
  Uninstall-From $installDirectory
  Assert-Missing (Join-Path $userData 'Cache') 'the cache root is removed'
  Assert-Exists (Join-Path $junctionTarget 'keep.me') 'junction targets are never followed'

  # Scenario 8: a recorded extra userData root receives the same tiered cleanup.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  $extraRoot = Join-Path $scratch 'extra-userdata'
  New-Item -ItemType Directory -Force -Path (Join-Path $extraRoot 'Cache') | Out-Null
  Set-Content -LiteralPath (Join-Path $extraRoot 'Cache\data_0') -Value 'x'
  Set-Content -LiteralPath (Join-Path $extraRoot 'Local State') -Value 'x'
  Set-Content -LiteralPath (Join-Path $extraRoot 'desktop-preferences.json') -Value '{}'
  Add-Content -LiteralPath $historyFile -Value "userData=$extraRoot"
  Uninstall-From $installDirectory
  Assert-Missing (Join-Path $extraRoot 'Cache') 'recorded userData roots get tiered cleanup'
  Assert-Exists (Join-Path $extraRoot 'desktop-preferences.json') 'recorded userData roots keep protected data'

  # An older uninstall leaves data without registration or a history record.
  Reset-State
  Plant-UserData
  $legacyHome = Join-Path $userData 'Cache\shared-home'
  New-Item -ItemType Directory -Force -Path $legacyHome | Out-Null
  Set-Content -LiteralPath (Join-Path $legacyHome 'sessions.jsonl') -Value 'retained'
  Install-To $installDirectory
  if (-not (Select-String -LiteralPath $historyFile -Pattern '^complete=0$' -Quiet)) {
    throw 'Reinstall over legacy user data must seed incomplete history.'
  }
  Uninstall-From $installDirectory '--delete-app-data'
  Assert-Exists (Join-Path $legacyHome 'sessions.jsonl') 'legacy homes inside caches stay protected'
  Assert-Residue 'Cache'

  # A legacy updater cache alone cannot establish complete path history.
  foreach ($purge in @($false, $true)) {
    Reset-State
    $legacyUpdaterHome = Join-Path $updaterCache 'pending\shared-home'
    New-Item -ItemType Directory -Force -Path $legacyUpdaterHome | Out-Null
    Set-Content -LiteralPath (Join-Path $legacyUpdaterHome 'sessions.jsonl') -Value 'retained'
    Assert-Missing $userData 'only the legacy updater cache survives'
    Assert-Missing $historyFile 'legacy installs have no path history'
    Install-To $installDirectory
    if (-not (Select-String -LiteralPath $historyFile -Pattern '^complete=0$' -Quiet)) {
      throw 'Reinstall over a legacy updater cache must seed incomplete history.'
    }
    if ($purge) { Uninstall-From $installDirectory '--delete-app-data' }
    else { Uninstall-From $installDirectory }
    Assert-Exists (Join-Path $legacyUpdaterHome 'sessions.jsonl') 'legacy homes inside the updater cache stay protected'
    Assert-Residue 'updater isolation requires complete history'
  }

  # A recorded home alias outside userData protects its real target inside userData.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  $sharedHome = Join-Path $userData 'Cache\shared-home'
  New-Item -ItemType Directory -Force -Path $sharedHome | Out-Null
  Set-Content -LiteralPath (Join-Path $sharedHome 'sessions.jsonl') -Value 'retained'
  $homeAlias = Join-Path $scratch 'home-alias'
  New-Item -ItemType Junction -Path $homeAlias -Target $sharedHome | Out-Null
  try {
    Add-Content -LiteralPath $historyFile -Value "dshHome=$homeAlias"
    Uninstall-From $installDirectory '--delete-app-data'
    Assert-Exists (Join-Path $sharedHome 'sessions.jsonl') 'a junction alias protects its target'
    Assert-Residue 'protected'
  } finally {
    [IO.Directory]::Delete($homeAlias)
  }

  Write-Output 'All uninstall data-cleanup scenarios passed.'
} catch {
  # Diagnostics for the next failure: the residue report and the surviving tree identify
  # which branch the uninstaller took (skipped vs tiered vs full removal).
  Write-Output "residue log: $(Test-Path -LiteralPath $residueLog)"
  if (Test-Path -LiteralPath $residueLog) { Get-Content -LiteralPath $residueLog }
  Write-Output "history record: $(Test-Path -LiteralPath $historyFile)"
  if (Test-Path -LiteralPath $historyFile) {
    Get-Content -LiteralPath $historyFile
  }
  Write-Output "userData contents:"
  Get-ChildItem -LiteralPath $userData -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { Write-Output $_.FullName }
  throw
} finally {
  Reset-State
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
