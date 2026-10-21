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
# it; protection survives removal while cleanup candidates belong to one install epoch.
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
  $beforeHistory = Get-Content -LiteralPath $historyFile -Raw
  Uninstall-From $installDirectory '--updated'
  if ((Get-Content -LiteralPath $historyFile -Raw) -cne $beforeHistory) { throw 'Update retired the active history.' }
  Assert-Exists (Join-Path $userData 'Cache\data_0') 'updates never delete data'
  Assert-Exists (Join-Path $userData 'Cookies') 'updates never delete data'
  Assert-Exists $historyFile 'the record survives for the succeeding install'

  # Scenario 5: /KEEP_APP_DATA, passed when the installer replaces an old uninstaller, preserves all data.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  $beforeHistory = Get-Content -LiteralPath $historyFile -Raw
  Install-To $installDirectory
  if ((Get-Content -LiteralPath $historyFile -Raw) -cne $beforeHistory) { throw 'Replacement changed the active history.' }
  Uninstall-From $installDirectory '/KEEP_APP_DATA'
  if ((Get-Content -LiteralPath $historyFile -Raw) -cne $beforeHistory) { throw 'Replacement retired the active history.' }
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

  # A fresh default-root seed cannot attest an older custom root discovered at startup.
  foreach ($purge in @($false, $true)) {
    Reset-State
    $legacyRoot = Join-Path $scratch ('legacy-custom-userdata-' + $purge)
    $legacyHome = Join-Path $legacyRoot 'Cache\shared-home'
    New-Item -ItemType Directory -Force -Path $legacyHome | Out-Null
    Set-Content -LiteralPath (Join-Path $legacyRoot 'desktop-preferences.json') -Value '{}'
    $legacySession = Join-Path $legacyHome 'sessions.jsonl'
    Set-Content -LiteralPath $legacySession -Value 'retained session'
    $beforeSession = Get-Content -LiteralPath $legacySession -Raw
    Install-To $installDirectory
    if (-not (Select-String -LiteralPath $historyFile -Pattern '^complete=1$' -Quiet)) {
      throw 'The custom-root regression requires a fresh complete installer seed.'
    }
    & node (Join-Path $PSScriptRoot 'smoke-runtime-setup.mjs') (Join-Path $installDirectory 'Rivetdeck.exe') --offline --startup-only --user-data-dir $legacyRoot
    if ($LASTEXITCODE -ne 0) { throw 'Custom-root Desktop startup failed.' }
    if ((Get-Content -LiteralPath $legacySession -Raw) -cne $beforeSession) {
      throw 'Startup changed the historical session before uninstall.'
    }
    if (-not (Select-String -LiteralPath $historyFile -Pattern '^complete=0$' -Quiet)) {
      throw 'Discovering a custom userData root must make history incomplete.'
    }
    if (-not (Select-String -LiteralPath $historyFile -SimpleMatch "userData=$legacyRoot" -Quiet)) {
      throw 'Packaged startup did not record the custom userData root.'
    }
    if (Select-String -LiteralPath $historyFile -SimpleMatch "dshHome=$legacyHome" -Quiet) {
      throw 'The legacy home must remain unknown to exercise incomplete-history protection.'
    }
    if ($purge) { Uninstall-From $installDirectory '--delete-app-data' }
    else { Uninstall-From $installDirectory }
    Assert-Exists $legacySession 'newly discovered custom roots may contain historical homes'
    if ((Get-Content -LiteralPath $legacySession -Raw) -cne $beforeSession) {
      throw 'Uninstall changed a historical session in the custom userData root.'
    }
    Assert-Residue ([regex]::Escape((Join-Path $legacyRoot 'Cache')))
    Assert-Residue 'cache isolation requires complete history'
  }

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

  # Retired roots may be repurposed while retaining an old product marker. Neither
  # tiered nor full cleanup in a later install may reach that previous epoch's roots.
  foreach ($purge in @($false, $true)) {
    Reset-State
    Install-To $installDirectory
    $retiredRoot = Join-Path $scratch ('retired-userdata-' + $purge)
    New-Item -ItemType Directory -Force -Path $retiredRoot | Out-Null
    Set-Content -LiteralPath (Join-Path $retiredRoot 'desktop-preferences.json') -Value '{}'
    $historicalHome = Join-Path $scratch ('retired-home-' + $purge)
    New-Item -ItemType Directory -Force -Path $historicalHome | Out-Null
    Set-Content -LiteralPath (Join-Path $historicalHome 'sessions.jsonl') -Value 'retained'
    Add-Content -LiteralPath $historyFile -Value "userData=$retiredRoot`r`ndshHome=$historicalHome"
    Uninstall-From $installDirectory
    if (-not (Select-String -LiteralPath $historyFile -Pattern '^retired=1$' -Quiet)) {
      throw 'A real uninstall must retire cleanup candidates.'
    }
    # Simulate a previous uninstaller that failed to retire its record; reinstall must
    # also recognize the absence of registration and close that old epoch.
    if ($purge) {
      Set-Content -LiteralPath $historyFile -Value "complete=1`r`nuserData=$retiredRoot`r`ndshHome=$historicalHome"
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $retiredRoot 'Cache') | Out-Null
    Set-Content -LiteralPath (Join-Path $retiredRoot 'Cache\foreign-data') -Value 'repurposed'
    New-Item -ItemType Directory -Force -Path (Join-Path $retiredRoot 'electron\toolchains\bin') | Out-Null
    Set-Content -LiteralPath (Join-Path $retiredRoot 'electron\toolchains\bin\npm.cmd') -Value 'repurposed'
    Install-To $installDirectory
    if ($purge) { Uninstall-From $installDirectory '--delete-app-data' }
    else { Uninstall-From $installDirectory }
    Assert-Exists (Join-Path $retiredRoot 'Cache\foreign-data') 'old cache candidates must not cross install epochs'
    Assert-Exists (Join-Path $retiredRoot 'electron\toolchains\bin\npm.cmd') 'even verified old candidates must be retired'
    Assert-Exists (Join-Path $historicalHome 'sessions.jsonl') 'home protection survives retirement'
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
