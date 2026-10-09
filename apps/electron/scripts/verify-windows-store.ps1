# Inspect the unsigned AppX submission payload without installing or modifying it.
param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$Architecture
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('rivetdeck-appx-' + [guid]::NewGuid().ToString('N'))
try {
  [System.IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path $PackagePath).Path, $temporary)
  $identity = Get-Content (Join-Path $PSScriptRoot '../windows-store.json') -Raw | ConvertFrom-Json
  [xml]$manifest = Get-Content (Join-Path $temporary 'AppxManifest.xml') -Raw
  if ($manifest.Package.Identity.Name -cne $identity.identityName -or
      $manifest.Package.Identity.Publisher -cne $identity.publisher -or
      $manifest.Package.Identity.Version -cne $identity.version -or
      $manifest.Package.Identity.ProcessorArchitecture -cne $Architecture -or
      $manifest.Package.Properties.PublisherDisplayName -cne $identity.publisherDisplayName) {
    throw 'AppX identity, publisher, version, or architecture differs from the Store submission configuration.'
  }
  $application = $manifest.Package.Applications.Application
  if ($application.Id -cne 'Rivetdeck' -or $application.EntryPoint -cne 'Windows.FullTrustApplication') {
    throw 'AppX must declare the Rivetdeck full-trust desktop application.'
  }
  $required = @(
    'app/Rivetdeck.exe',
    'app/resources/app/lib/main.js',
    'app/resources/core-runtime/node.exe',
    'app/resources/network-runtime/dsh-electron-network-runtime.exe',
    'assets/StoreLogo.png',
    'assets/Square44x44Logo.png',
    'assets/Square150x150Logo.png',
    'assets/Wide310x150Logo.png'
  )
  foreach ($file in $required) {
    if (-not (Test-Path (Join-Path $temporary $file) -PathType Leaf)) { throw "AppX is missing $file" }
  }
  $metadata = Get-Content (Join-Path $temporary 'app/resources/app/package.json') -Raw | ConvertFrom-Json
  if ($metadata.distribution -cne 'microsoft-store') { throw 'AppX is missing Store-only runtime metadata.' }
  if (Get-ChildItem $temporary -Filter 'app-update.yml' -Recurse) { throw 'Store submission must not contain GitHub updater metadata.' }
  Write-Host "STORE_PACKAGE_VERIFIED $Architecture $($identity.version)"
} finally {
  if (Test-Path $temporary) { Remove-Item $temporary -Recurse -Force }
}
