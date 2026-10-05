# Desktop Bridge optional tests are advisory: https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/windows-desktop-bridge-app-tests#required-versus-optional-tests
function Get-StoreWackAssessment([xml]$Results) {
  if ($Results.REPORT.APP_TYPE -cne 'Centennial') { throw 'Expected a Desktop Bridge WACK report.' }
  if ($Results.REPORT.PARTIAL_RUN -cne 'FALSE') { throw 'Expected a complete WACK test run.' }
  $overall = [string]$Results.REPORT.OVERALL_RESULT
  if ($overall -cnotmatch '^(PASS|PASSED|WARNING|FAIL|FAILED)$') { throw 'Unrecognized WACK overall result.' }
  $tests = @($Results.SelectNodes('/REPORT/REQUIREMENTS/REQUIREMENT/TEST'))
  foreach ($test in $tests) {
    if ($test.OPTIONAL -cnotin @('TRUE', 'FALSE') -or [string]$test.SelectSingleNode('RESULT').InnerText -cnotmatch '^(PASS|PASSED|WARNING|FAIL|FAILED)$') {
      throw 'Unrecognized WACK test requirement or result.'
    }
  }
  $required = @($tests | Where-Object { $_.OPTIONAL -ceq 'FALSE' })
  if ($required.Count -eq 0) { throw 'WACK report has no required tests.' }
  $failures = @($required | Where-Object { [string]$_.SelectSingleNode('RESULT').InnerText -cnotmatch '^(PASS|PASSED)$' } | ForEach-Object {
    @{ name = [string]$_.NAME; result = [string]$_.SelectSingleNode('RESULT').InnerText }
  })
  $advisories = @($tests | Where-Object { $_.OPTIONAL -ceq 'TRUE' -and [string]$_.SelectSingleNode('RESULT').InnerText -cnotmatch '^(PASS|PASSED)$' } | ForEach-Object {
    @{ name = [string]$_.NAME; result = [string]$_.SelectSingleNode('RESULT').InnerText }
  })
  if ($overall -cmatch '^(FAIL|FAILED)$' -and $failures.Count -eq 0) { throw 'WACK overall failure contradicts required test results.' }
  return [pscustomobject]@{ requiredPassed = $failures.Count -eq 0; requiredCount = $required.Count; failures = $failures; advisories = $advisories }
}
