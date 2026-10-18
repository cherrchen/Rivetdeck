param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [ValidateSet('x64', 'arm64')]
  [string]$Architecture,

  [string]$ShortcutName = 'Rivetdeck'
)

$ErrorActionPreference = 'Stop'

# Compile the uninstall data helper and run its native safety tests first; the helper
# is rebuilt here even though beforePack already built it, so the safety suite runs
# wherever this smoke runs.
& (Join-Path $PSScriptRoot 'prepare-windows-uninstall-helper.ps1') -TestCleanup

$installer = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$installDirectory = Join-Path $env:RUNNER_TEMP "dsh-installer-smoke-$Architecture"
# Exercise package members beyond MAX_PATH while keeping the launcher path short enough for NSIS.
$installDirectory = Join-Path $installDirectory ('deep-installation-directory-' * 3)
$installDirectory = Join-Path $installDirectory 'Rivetdeck'
if (Test-Path -LiteralPath $installDirectory) {
  throw "Installer smoke directory already exists: $installDirectory"
}

$install = Start-Process -FilePath $installer -ArgumentList @(
  '/S',
  '/currentuser',
  "/D=$installDirectory"
) -WindowStyle Hidden -Wait -PassThru
if ($install.ExitCode -ne 0) {
  throw "Installer exited with code $($install.ExitCode)."
}

$application = Join-Path $installDirectory 'Rivetdeck.exe'
$manifest = Join-Path $installDirectory 'resources\app\package.json'
$uninstaller = Join-Path $installDirectory 'Uninstall Rivetdeck.exe'
try {
  $requiredFiles = @(
    $application,
    $manifest,
    (Join-Path $installDirectory 'resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'),
    (Join-Path $installDirectory 'resources\core-runtime\node.exe'),
    (Join-Path $installDirectory 'resources\network-runtime\dsh-electron-network-runtime.exe'),
    $uninstaller
  )
  foreach ($path in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Installer did not create required file: $path"
    }
  }

  & node -e 'const fs = require("node:fs"); const path = require("node:path"); const root = process.argv[1]; let longest = 0; for (const file of fs.readdirSync(root, { recursive: true })) { const absolute = path.join(root, file); if (fs.statSync(absolute).isFile()) longest = Math.max(longest, absolute.length); } if (longest <= 260) throw new Error("Installer smoke did not exercise MAX_PATH"); console.log("Verified installed files beyond MAX_PATH:", longest);' $installDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Installed deep-path files could not be read.' }

  $lock = Get-Content -LiteralPath (Join-Path $installDirectory 'resources\app\toolchains.lock.json') -Raw | ConvertFrom-Json
  $nodeVersion = & (Join-Path $installDirectory 'resources\core-runtime\node.exe') --version
  if ($LASTEXITCODE -ne 0 -or $nodeVersion.Trim() -ne "v$($lock.node.version)") {
    throw "Packaged Node.js failed: $nodeVersion"
  }
  foreach ($forbidden in @('resources\toolchains\node', 'resources\toolchains\python', 'resources\core-runtime\node_modules')) {
    if (Test-Path -LiteralPath (Join-Path $installDirectory $forbidden)) { throw "Optional runtime leaked into installer: $forbidden" }
  }

  $packagedManifest = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  if ($packagedManifest.name -ne 'rivetdeck') {
    throw "Packaged application name is '$($packagedManifest.name)', expected 'rivetdeck'."
  }

  $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) "$ShortcutName.lnk"
  $startMenuShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) "$ShortcutName.lnk"
  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcutPath in @($desktopShortcut, $startMenuShortcut)) {
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
      throw "Installer did not create shortcut: $shortcutPath"
    }
    $target = $shell.CreateShortcut($shortcutPath).TargetPath
    if ($target -ne $application) {
      throw "Shortcut $shortcutPath targets '$target', expected '$application'."
    }
  }

  # Resource presence alone cannot detect startup dependencies removed by installer extraction.
  & node (Join-Path $PSScriptRoot 'smoke-runtime-setup.mjs') $application --offline --startup-only
  if ($LASTEXITCODE -ne 0) {
    throw "Installed Desktop failed zero-runtime startup with code $LASTEXITCODE."
  }
} finally {
  # Layered cleanup coverage: rebuildables and pure caches go, preferences and browser
  # persistence stay; a foreign entry skips the whole inventory-checked target; a recorded
  # DSH_HOME overlapping a candidate protects it entirely.
  $userData = Join-Path $env:APPDATA 'Rivetdeck'
  $updaterCache = Join-Path $env:LOCALAPPDATA 'rivetdeck-updater'
  $residueLog = Join-Path $env:APPDATA 'Rivetdeck-uninstall-residue.log'
  $historyFile = Join-Path $installDirectory 'rivetdeck-path-history.ini'
  if (-not (Test-Path -LiteralPath $historyFile -PathType Leaf)) {
    throw "Installer did not seed the path-history record: $historyFile"
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $userData 'managed-toolchains\node') | Out-Null
  Set-Content -LiteralPath (Join-Path $userData 'managed-toolchains\node\active.json') -Value '{}'
  # A foreign entry must fail inventory verification so the whole target is skipped.
  Set-Content -LiteralPath (Join-Path $userData 'managed-toolchains\foreign.exe') -Value 'x'
  New-Item -ItemType Directory -Force -Path (Join-Path $userData 'Cache') | Out-Null
  Set-Content -LiteralPath (Join-Path $userData 'Cache\data_0') -Value 'x'
  # A recorded DSH_HOME overlapping a cleanup candidate protects it entirely.
  Add-Content -LiteralPath $historyFile -Value "dshHome=$(Join-Path $userData 'Cache')"
  New-Item -ItemType Directory -Force -Path (Join-Path $userData 'Partitions\worker_1\GPUCache') | Out-Null
  Set-Content -LiteralPath (Join-Path $userData 'Partitions\worker_1\GPUCache\gpu.bin') -Value 'x'
  New-Item -ItemType Directory -Force -Path (Join-Path $userData 'Partitions\worker_1\IndexedDB') | Out-Null
  Set-Content -LiteralPath (Join-Path $userData 'Partitions\worker_1\IndexedDB\db') -Value 'x'
  Set-Content -LiteralPath (Join-Path $userData 'Local State') -Value 'x'
  Set-Content -LiteralPath (Join-Path $userData 'desktop-preferences.json') -Value '{}'
  Set-Content -LiteralPath (Join-Path $userData 'Cookies') -Value 'x'
  New-Item -ItemType Directory -Force -Path (Join-Path $updaterCache 'pending') | Out-Null
  Set-Content -LiteralPath (Join-Path $updaterCache 'installer.exe') -Value 'x'

  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -WindowStyle Hidden -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) {
    throw "Uninstaller exited with code $($uninstall.ExitCode)."
  }

  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-Path -LiteralPath $application) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $application) {
    throw "Uninstaller left the application executable in place: $application"
  }

  foreach ($removed in @(
      (Join-Path $userData 'Partitions\worker_1\GPUCache'),
      $updaterCache)) {
    if (Test-Path -LiteralPath $removed) { throw "Uninstaller left a cleanup target: $removed" }
  }
  foreach ($kept in @(
      (Join-Path $userData 'desktop-preferences.json'),
      (Join-Path $userData 'Cookies'),
      (Join-Path $userData 'Local State'),
      (Join-Path $userData 'Partitions\worker_1\IndexedDB\db'),
      (Join-Path $userData 'managed-toolchains'),
      (Join-Path $userData 'Cache'))) {
    if (-not (Test-Path -LiteralPath $kept)) { throw "Uninstaller removed preserved data: $kept" }
  }
  if (-not (Test-Path -LiteralPath $residueLog -PathType Leaf)) {
    throw "Skipped cleanup targets produced no residue report: $residueLog"
  }
  if (-not (Select-String -LiteralPath $residueLog -Pattern 'managed-toolchains' -Quiet)) {
    throw "Residue report does not list the inventory-skipped target."
  }
  if (-not (Select-String -LiteralPath $residueLog -Pattern 'Cache' -Quiet)) {
    throw "Residue report does not list the protection-overlapped target."
  }
}
