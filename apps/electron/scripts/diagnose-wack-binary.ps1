# Run under Windows PowerShell, matching WACK's .NET Framework COM interop.
param(
  [Parameter(Mandatory = $true)][string]$KitDirectory,
  [Parameter(Mandatory = $true)][string]$BinaryPath,
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$ManifestTool,
  [Parameter(Mandatory = $true)][string]$ScratchDirectory,
  [Parameter(Mandatory = $true)][string]$ReportDirectory
)
$ErrorActionPreference = 'Stop'
$report = [ordered]@{}
function Read-DpiManifest([string]$Path) {
  $scanner = $null
  try {
    $scanner = New-Object Microsoft.Windows.SoftwareLogo.BinaryInfo.Interop.BinaryInfoClass
    $scanner.LoadBinary($Path)
    return @{ perMonitorV2 = $scanner.IsPerMonitorV2DPIAwarenessSet() }
  } catch {
    $error = $_.Exception.GetBaseException()
    return @{ error = $error.Message; type = $error.GetType().FullName; hresult = $error.HResult }
  } finally {
    if ($scanner) {
      try { $scanner.UnloadBinary() } catch { Write-Warning "Binary scanner unload failed: $($_.Exception.Message)" }
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($scanner) | Out-Null
    }
  }
}
try {
  $interop = Get-ChildItem $KitDirectory -Recurse -Filter Microsoft.Windows.SoftwareLogo.BinaryInfo.Interop.dll | Select-Object -First 1
  if (-not $interop) { throw 'WACK BinaryInfo interop assembly was not found.' }
  Add-Type -Path $interop.FullName
  $report.original = Read-DpiManifest $BinaryPath
  # This variant is diagnostic only and never enters the submission package.
  [xml]$manifest = Get-Content $ManifestPath -Raw
  $namespaces = [Xml.XmlNamespaceManager]::new($manifest.NameTable)
  $namespaces.AddNamespace('asm', 'urn:schemas-microsoft-com:asm.v3')
  $settings = $manifest.SelectSingleNode('/descendant::asm:windowsSettings', $namespaces)
  if (-not $settings) { throw 'Executable manifest has no Windows settings element.' }
  $dpi = $manifest.CreateElement('dpiAwareness', 'http://schemas.microsoft.com/SMI/2016/WindowsSettings')
  $dpi.InnerText = 'PerMonitorV2, PerMonitor'
  $settings.AppendChild($dpi) | Out-Null
  $variantManifest = Join-Path $ScratchDirectory 'dpi-variant.manifest'
  $manifest.Save($variantManifest)
  $variant = Join-Path $ScratchDirectory 'dpi-variant.exe'
  Copy-Item $BinaryPath $variant
  & $ManifestTool '-nologo' "-manifest:$variantManifest" "-outputresource:$variant;#1"
  if ($LASTEXITCODE -ne 0) { throw 'Manifest Tool could not produce the diagnostic binary variant.' }
  $report.perMonitorV2Variant = Read-DpiManifest $variant
} catch {
  $report.diagnosticError = $_.Exception.Message
} finally {
  $report | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $ReportDirectory 'binary-analysis.json')
}
