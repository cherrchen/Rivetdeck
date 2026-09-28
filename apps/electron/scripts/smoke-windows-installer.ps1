param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [ValidateSet('x64', 'arm64')]
  [string]$Architecture
)

$ErrorActionPreference = 'Stop'

$installer = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$installDirectory = Join-Path $env:RUNNER_TEMP "dsh-installer-smoke-$Architecture"
if (Test-Path -LiteralPath $installDirectory) {
  throw "Installer smoke directory already exists: $installDirectory"
}

$install = Start-Process -FilePath $installer -ArgumentList @(
  '/S',
  '/currentuser',
  "/D=$installDirectory"
) -Wait -PassThru
if ($install.ExitCode -ne 0) {
  throw "Installer exited with code $($install.ExitCode)."
}

$application = Join-Path $installDirectory 'DeepSeek Harness.exe'
$manifest = Join-Path $installDirectory 'resources\app\package.json'
$uninstaller = Join-Path $installDirectory 'Uninstall DeepSeek Harness.exe'
$requiredFiles = @(
  $application,
  $manifest,
  (Join-Path $installDirectory 'resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'),
  (Join-Path $installDirectory 'resources\toolchains\node\node.exe'),
  (Join-Path $installDirectory 'resources\toolchains\python\python.exe'),
  (Join-Path $installDirectory 'resources\network-runtime\dsh-electron-network-runtime.exe'),
  $uninstaller
)
foreach ($path in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Installer did not create required file: $path"
  }
}

$nodeVersion = & (Join-Path $installDirectory 'resources\toolchains\node\node.exe') --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion.Trim() -ne 'v24.17.0') {
  throw "Packaged Node.js failed: $nodeVersion"
}
$python = Join-Path $installDirectory 'resources\toolchains\python\python.exe'
$pythonVersion = & $python --version
if ($LASTEXITCODE -ne 0 -or $pythonVersion.Trim() -ne 'Python 3.14.7') {
  throw "Packaged Python failed: $pythonVersion"
}
& $python -m pip --version
if ($LASTEXITCODE -ne 0) { throw 'Packaged pip failed.' }

$packagedManifest = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if ($packagedManifest.name -ne 'deepseek-harness-desktop') {
  throw "Packaged application name is '$($packagedManifest.name)', expected 'deepseek-harness-desktop'."
}

$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness.lnk'
$startMenuShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'DeepSeek Harness.lnk'
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

$uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -Wait -PassThru
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
