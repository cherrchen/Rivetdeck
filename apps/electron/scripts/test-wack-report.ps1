# Exercise the same WACK assessment used by native qualification.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wack-report.ps1')
function New-TestReport([string]$RequiredResult, [string]$OptionalResult, [string]$Overall) {
  return [xml]"<REPORT APP_TYPE='Centennial' PARTIAL_RUN='FALSE' OVERALL_RESULT='$Overall'><REQUIREMENTS><REQUIREMENT><TEST NAME='DPI' OPTIONAL='FALSE'><RESULT><![CDATA[$RequiredResult]]></RESULT></TEST><TEST NAME='Blocked executables' OPTIONAL='TRUE'><RESULT>$OptionalResult</RESULT></TEST></REQUIREMENT></REQUIREMENTS></REPORT>"
}
$pass = Get-StoreWackAssessment (New-TestReport 'PASS' 'PASS' 'PASS')
if (-not $pass.requiredPassed -or $pass.requiredCount -ne 1 -or $pass.advisories.Count -ne 0) { throw 'Passing required checks were rejected.' }
$advisory = Get-StoreWackAssessment (New-TestReport 'PASS' 'FAIL' 'WARNING')
if (-not $advisory.requiredPassed -or $advisory.advisories.Count -ne 1 -or $advisory.advisories[0].name -cne 'Blocked executables') { throw 'Optional failure must remain an advisory.' }
foreach ($result in @('WARNING', 'FAIL')) {
  $failed = Get-StoreWackAssessment (New-TestReport $result 'PASS' $result)
  if ($failed.requiredPassed -or $failed.failures.Count -ne 1 -or $failed.failures[0].result -cne $result) { throw 'Required warning or failure must block qualification.' }
}
foreach ($invalid in @(
  "<REPORT APP_TYPE='Centennial' PARTIAL_RUN='FALSE' OVERALL_RESULT='PASS'><REQUIREMENTS /></REPORT>",
  "<REPORT APP_TYPE='Centennial' PARTIAL_RUN='FALSE' OVERALL_RESULT='PASS'><REQUIREMENTS><REQUIREMENT><TEST NAME='Unknown' OPTIONAL='MAYBE'><RESULT>PASS</RESULT></TEST></REQUIREMENT></REQUIREMENTS></REPORT>",
  (New-TestReport 'PASS' 'PASS' 'PASS').OuterXml.Replace('PARTIAL_RUN="FALSE"', 'PARTIAL_RUN="TRUE"'),
  (New-TestReport 'PASS' 'PASS' 'PASS').OuterXml.Replace('APP_TYPE="Centennial"', 'APP_TYPE="Unknown"'),
  (New-TestReport 'PASS' 'PASS' 'UNKNOWN').OuterXml,
  (New-TestReport 'UNKNOWN' 'PASS' 'PASS').OuterXml,
  (New-TestReport 'PASS' 'PASS' 'FAIL').OuterXml
)) {
  $rejected = $false
  try { Get-StoreWackAssessment ([xml]$invalid) | Out-Null } catch { $rejected = $true }
  if (-not $rejected) { throw 'Incomplete or contradictory WACK report was accepted.' }
}
Write-Host 'WACK_REPORT_VERIFIED: required pass, optional advisory, required warning/failure, and seven invalid reports.'
