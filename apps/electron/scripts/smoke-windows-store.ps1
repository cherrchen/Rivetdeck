# Test a signed copy on a disposable Windows runner; keep the unsigned submission intact.
param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$Architecture,
  [Parameter(Mandatory = $true)][string]$ReportDirectory,
  [switch]$RunCertificationKit
)
$ErrorActionPreference = 'Stop'
# Bound each owned process tree so a stuck application shutdown cannot suppress later checks.
function Invoke-QualificationNode([string[]]$Arguments, [int]$TimeoutSeconds) {
  $start = [Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $child = [Diagnostics.Process]::Start($start)
  $stdout = $child.StandardOutput.ReadToEndAsync()
  $stderr = $child.StandardError.ReadToEndAsync()
  try {
    $timedOut = -not $child.WaitForExit($TimeoutSeconds * 1000)
    if ($timedOut) {
      try { $child.Kill($true) }
      catch [InvalidOperationException] { if (-not $child.HasExited) { throw } }
      $child.WaitForExit()
      Write-Host "Store qualification command timed out after $TimeoutSeconds seconds: $($Arguments[0])"
    }
    $logName = [IO.Path]::GetFileNameWithoutExtension($Arguments[0]) + $(if ($Arguments -contains '--startup-only') { '-startup' } else { '' })
    $output = $stdout.GetAwaiter().GetResult()
    $errors = $stderr.GetAwaiter().GetResult()
    Set-Content (Join-Path $ReportDirectory "$logName.stdout.log") $output
    Set-Content (Join-Path $ReportDirectory "$logName.stderr.log") $errors
    Write-Host $output
    Write-Host $errors
    return [pscustomobject]@{ exitCode = $child.ExitCode; timedOut = $timedOut }
  } finally { $child.Dispose() }
}
$identity = Get-Content (Join-Path $PSScriptRoot '../windows-store.json') -Raw | ConvertFrom-Json
if (Get-AppxPackage -Name $identity.identityName) { throw 'Refusing to replace an existing Rivetdeck installation.' }
$source = (Resolve-Path $PackagePath).Path
$originalHash = (Get-FileHash $source -Algorithm SHA256).Hash
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('rivetdeck-store-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
$report = [ordered]@{
  architecture = $Architecture
  version = $identity.version
  sha256 = $originalHash
  os = [Environment]::OSVersion.VersionString
  sessionId = (Get-Process -Id $PID).SessionId
  installed = $false
  startup = $false
  plugins = $false
  runtimes = $false
  wack = 'not-run'
  uninstalled = $false
}
$certificate = $null
$trusted = $null
$installed = $null
try {
  $signTool = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $signTool) { throw 'Windows SDK SignTool is required for the installation test.' }
  $certificate = New-SelfSignedCertificate -Type Custom -Subject $identity.publisher -FriendlyName 'Rivetdeck disposable Store smoke' -KeyUsage DigitalSignature -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  $publicCertificate = Join-Path $scratch 'test.cer'
  Export-Certificate -Cert $certificate -FilePath $publicCertificate | Out-Null
  $trusted = Import-Certificate -FilePath $publicCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'
  $signed = Join-Path $scratch 'installation.appx'
  Copy-Item $source $signed
  & $signTool.FullName sign /fd SHA256 /sha1 $certificate.Thumbprint /s My $signed
  if ($LASTEXITCODE -ne 0) { throw 'Test-only AppX signing failed.' }
  Add-AppxPackage -Path $signed
  $installed = Get-AppxPackage -Name $identity.identityName
  if (-not $installed -or $installed.Version -ne $identity.version -or $installed.Architecture.ToString().ToLowerInvariant() -ne $Architecture -or $installed.PackageFamilyName -cne 'CherrchenSoftware.Rivetdeck_kn3vx7pp0q1ha') {
    throw 'Installed Store package identity differs from Partner Center.'
  }
  $report.installed = $true
  $report.packageFullName = $installed.PackageFullName
  $application = Join-Path $installed.InstallLocation 'app/Rivetdeck.exe'
  $failures = [Collections.Generic.List[string]]::new()
  $code = Invoke-QualificationNode -Arguments @((Join-Path $PSScriptRoot 'smoke-runtime-setup.mjs'), $application, '--offline', '--startup-only', '--store', '--artifacts', (Join-Path $ReportDirectory 'startup')) -TimeoutSeconds 300
  $report.startupProcess = $code
  $report.startup = -not $code.timedOut -and $code.exitCode -eq 0
  if (-not $report.startup) { $failures.Add('Installed AppX startup smoke failed.') }
  $code = Invoke-QualificationNode -Arguments @((Join-Path $PSScriptRoot 'smoke-core-plugins.mjs'), (Join-Path $installed.InstallLocation 'app/resources/core-runtime/node.exe'), (Join-Path $installed.InstallLocation 'app/resources/app'), '--store-executable', $application) -TimeoutSeconds 300
  $report.pluginsProcess = $code
  $report.plugins = -not $code.timedOut -and $code.exitCode -eq 0
  if (-not $report.plugins) { $failures.Add('Installed AppX Core plugin smoke failed.') }
  $code = Invoke-QualificationNode -Arguments @((Join-Path $PSScriptRoot 'smoke-runtime-setup.mjs'), $application, '--install', '--store', '--artifacts', (Join-Path $ReportDirectory 'runtimes')) -TimeoutSeconds 1200
  $report.runtimesProcess = $code
  $report.runtimes = -not $code.timedOut -and $code.exitCode -eq 0
  if (-not $report.runtimes) { $failures.Add('Installed AppX managed runtime lifecycle failed.') }
  if ($failures.Count -eq 0) { Write-Host "STORE_INSTALLATION_VERIFIED $Architecture $($identity.version)" }
  if ($RunCertificationKit) {
    try {
      $appCert = "${env:ProgramFiles(x86)}/Windows Kits/10/App Certification Kit/appcert.exe"
      $report.wack = 'unavailable'
      if (-not (Test-Path $appCert)) { throw 'Windows App Certification Kit is not installed on this runner.' }
      if ($report.sessionId -eq 0) { throw 'WACK requires an active user session; this runner is in Session 0.' }
      & $appCert reset
      if ($LASTEXITCODE -ne 0) { throw 'WACK reset failed.' }
      $report.wack = 'running'
      $wackReport = Join-Path $ReportDirectory 'wack.xml'
      & $appCert test -packagefullname $installed.PackageFullName -reportoutputpath $wackReport
      $report.wackExitCode = $LASTEXITCODE
      if (-not (Test-Path $wackReport)) { throw 'WACK did not produce an XML report.' }
      [xml]$results = Get-Content $wackReport -Raw
      $report.wack = $results.REPORT.OVERALL_RESULT
      if ($report.wackExitCode -ne 0 -or $report.wack -notmatch '^(PASS|PASSED)$') { throw "WACK failed: $($report.wack), exit $($report.wackExitCode). See wack.xml." }
    } catch { $failures.Add($_.Exception.Message) }
  }
  if ($failures.Count -gt 0) { throw ($failures -join ' ') }
} catch {
  $report.error = $_.Exception.Message
  throw
} finally {
  try {
    # Remove only the package and certificates acquired by this invocation.
    if ($installed) {
      Remove-AppxPackage -Package $installed.PackageFullName
      if (Get-AppxPackage -Name $identity.identityName) { throw 'Store package remained registered after uninstall.' }
      $report.uninstalled = $true
    }
    if ((Get-FileHash $source -Algorithm SHA256).Hash -cne $originalHash) { throw 'Unsigned submission package changed during qualification.' }
  } finally {
    if ($trusted) { Remove-Item "Cert:\LocalMachine\TrustedPeople\$($trusted.Thumbprint)" }
    if ($certificate) { Remove-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -DeleteKey }
    Remove-Item $scratch -Recurse -Force
    $report | ConvertTo-Json | Set-Content (Join-Path $ReportDirectory 'installation.json')
  }
}
