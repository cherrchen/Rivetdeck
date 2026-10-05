param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [ValidateSet('x64', 'arm64')]
  [string]$Architecture,

  [string]$ShortcutName = 'DeepSeek Harness'
)

$ErrorActionPreference = 'Stop'

$installer = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$installDirectory = Join-Path $env:RUNNER_TEMP "dsh-installer-smoke-$Architecture"
# Exercise package members beyond MAX_PATH while keeping the launcher path short enough for NSIS.
$installDirectory = Join-Path $installDirectory ('deep-installation-directory-' * 3)
$installDirectory = Join-Path $installDirectory 'DeepSeek Harness'
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

$application = Join-Path $installDirectory 'DeepSeek Harness.exe'
$manifest = Join-Path $installDirectory 'resources\app\package.json'
$uninstaller = Join-Path $installDirectory 'Uninstall DeepSeek Harness.exe'
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
  if ($packagedManifest.name -ne 'deepseek-harness-desktop') {
    throw "Packaged application name is '$($packagedManifest.name)', expected 'deepseek-harness-desktop'."
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
}
