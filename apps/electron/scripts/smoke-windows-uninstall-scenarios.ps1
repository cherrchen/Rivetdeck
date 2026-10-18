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
$migratedHistory = Join-Path $env:APPDATA 'rivetdeck-path-history.ini'
$historyName = 'rivetdeck-path-history.ini'

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
  foreach ($path in @($userData, $updaterCache, $residueLog, $migratedHistory)) {
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-To([string]$Dir) {
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', '/currentuser', "/D=$Dir") -WindowStyle Hidden -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer exited with code $($install.ExitCode)." }
  Assert-Exists (Join-Path $Dir 'Rivetdeck.exe') 'install must complete'
  Assert-Exists (Join-Path $Dir 'Uninstall Rivetdeck.exe') 'install must complete'
  Assert-Exists (Join-Path $Dir $historyName) 'a fresh install seeds the path-history record'
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
  Set-Content -LiteralPath (Join-Path $installDirectory $historyName) -Value "complete=0`r`n"
  Uninstall-From $installDirectory '--delete-app-data'
  Assert-Exists (Join-Path $userData 'desktop-preferences.json') 'incomplete history never fully removes userData'
  Assert-Exists (Join-Path $userData 'Cookies') 'incomplete history never fully removes userData'
  Assert-Missing (Join-Path $userData 'Cache') 'tiered cleanup still applies'
  Assert-Residue 'Rivetdeck'

  # Scenario 3: --delete-app-data with a damaged protection claim refuses every target.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  Set-Content -LiteralPath (Join-Path $installDirectory $historyName) -Value "complete=1`r`ndshHome=relative\path`r`n"
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
  Assert-Exists $migratedHistory 'the record migrates for the succeeding install'

  # Scenario 5: /KEEP_APP_DATA, passed when the installer replaces an old uninstaller, preserves all data.
  Reset-State
  Install-To $installDirectory
  Plant-UserData
  Uninstall-From $installDirectory '/KEEP_APP_DATA'
  Assert-Exists (Join-Path $userData 'Cache\data_0') 'uninstaller replacement never deletes data'
  Assert-Exists $migratedHistory 'the record migrates for the succeeding install'

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
  Add-Content -LiteralPath (Join-Path $installDirectory $historyName) -Value "userData=$extraRoot"
  Uninstall-From $installDirectory
  Assert-Missing (Join-Path $extraRoot 'Cache') 'recorded userData roots get tiered cleanup'
  Assert-Exists (Join-Path $extraRoot 'desktop-preferences.json') 'recorded userData roots keep protected data'

  Write-Output 'All uninstall data-cleanup scenarios passed.'
} catch {
  # Diagnostics for the next failure: the residue report and the surviving tree identify
  # which branch the uninstaller took (skipped vs tiered vs full removal).
  Write-Output "residue log: $(Test-Path -LiteralPath $residueLog)"
  if (Test-Path -LiteralPath $residueLog) { Get-Content -LiteralPath $residueLog }
  Write-Output "history seed: $(Test-Path -LiteralPath (Join-Path $installDirectory $historyName))"
  if (Test-Path -LiteralPath (Join-Path $installDirectory $historyName)) {
    Get-Content -LiteralPath (Join-Path $installDirectory $historyName)
  }
  Write-Output "userData contents:"
  Get-ChildItem -LiteralPath $userData -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { Write-Output $_.FullName }
  throw
} finally {
  Reset-State
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
