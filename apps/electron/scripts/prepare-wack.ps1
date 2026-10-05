# Install Microsoft's certification tools on a disposable Windows qualification runner.
param([Parameter(Mandatory = $true)][string]$ReportDirectory)
$ErrorActionPreference = 'Stop'
$appCert = "${env:ProgramFiles(x86)}/Windows Kits/10/App Certification Kit/appcert.exe"
$minimumVersion = [version]'10.0.26100.9457'
if ((Test-Path $appCert) -and (Get-Item $appCert).VersionInfo.FileVersionRaw -ge $minimumVersion) {
  Write-Host 'Windows App Certification Kit meets the selected SDK version.'
  return
}
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
$installer = Join-Path $ReportDirectory 'winsdksetup.exe'
$process = $null
try {
  # Windows SDK 10.0.26100.9457 from the official SDK download catalog.
  Invoke-WebRequest 'https://go.microsoft.com/fwlink/?linkid=2382321' -OutFile $installer
  $signature = Get-AuthenticodeSignature $installer
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(,|$)') { throw 'Windows SDK installer must have a valid Microsoft signature.' }
  @{ sha256 = (Get-FileHash $installer -Algorithm SHA256).Hash; signer = $signature.SignerCertificate.Subject } | ConvertTo-Json | Set-Content (Join-Path $ReportDirectory 'sdk-installer.json')
  $log = Join-Path $ReportDirectory 'sdk-install.log'
  $process = Start-Process $installer -ArgumentList @('/quiet', '/norestart', '/features', 'OptionId.WindowsSoftwareLogoToolkit', 'OptionId.SigningTools', '/log', ('"' + $log + '"')) -PassThru
  if (-not $process.WaitForExit(600000)) { $process.Kill($true); $process.WaitForExit(); throw 'Windows SDK certification-tool installation timed out.' }
  if ($process.ExitCode -notin @(0, 3010)) { throw "Windows SDK installation failed: exit $($process.ExitCode). See sdk-install.log." }
  if (-not (Test-Path $appCert)) { throw 'Windows SDK installation did not provide App Certification Kit.' }
  @{ version = (Get-Item $appCert).VersionInfo.FileVersion; path = $appCert } | ConvertTo-Json | Set-Content (Join-Path $ReportDirectory 'installed-toolkit.json')
  Write-Host "WACK_INSTALLED $appCert"
} finally {
  if ($process) { $process.Dispose() }
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
}
