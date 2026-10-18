# Compiles the x86 uninstall data helper embedded in the NSIS uninstaller. The NSIS System
# plugin executes x86 code only, so vcvars32 is used even on x64 hosts.
# -TestCleanup additionally compiles and runs the native safety tests in a scratch directory.
[CmdletBinding()]
param([string]$OutputDirectory, [switch]$TestCleanup)
$ErrorActionPreference = 'Stop'

$electronRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$installerDir = Join-Path $electronRoot 'installer'
$testsDir = Join-Path $electronRoot 'tests'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $electronRoot '.electron-build/nsis' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $output | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Uninstall helper compilation requires Visual Studio C++ Build Tools and a Windows SDK.' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ Build Tools are missing.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars32.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw "vcvars32.bat missing at $vcvars." }

$source = Join-Path $installerDir 'uninstall-data.cpp'
$library = Join-Path $output 'rivetdeck-uninstall.dll'
$compileScript = Join-Path $output 'compile-uninstall-helper.cmd'
[IO.File]::WriteAllLines($compileScript, @(
    '@echo off',
    ('call "{0}" >nul' -f $vcvars),
    'if errorlevel 1 exit /b %errorlevel%',
    ('cl /nologo /LD /MT /O1 /W4 /WX /EHsc "{0}" /Fo"{1}" /link /OUT:"{2}" /IMPLIB:"{3}" shell32.lib ole32.lib uuid.lib advapi32.lib' -f
        $source, (Join-Path $output 'uninstall-data.obj'), $library, (Join-Path $output 'rivetdeck-uninstall.lib'))
), [Text.Encoding]::Default)
& $env:ComSpec /d /c $compileScript
if ($LASTEXITCODE -ne 0) { throw 'Uninstall data helper compilation failed.' }
if (-not (Test-Path -LiteralPath $library)) { throw "Expected output missing: $library" }
Write-Output "Built $library"

if ($TestCleanup) {
    $cleanupSource = [IO.Path]::GetFullPath((Join-Path $testsDir 'windows-uninstall-data.cpp'))
    # UAC installer detection demands elevation from unmanifested executables named after installation.
    $cleanupExecutable = Join-Path $output 'data-cleanup-test.exe'
    $cleanupScript = Join-Path $output 'compile-data-cleanup-test.cmd'
    [IO.File]::WriteAllLines($cleanupScript, @(
        '@echo off',
        ('call "{0}" >nul' -f $vcvars),
        'if errorlevel 1 exit /b %errorlevel%',
        ('cl /nologo /MT /W4 /WX /EHsc "{0}" /Fo"{1}" /Fe"{2}" /link shell32.lib ole32.lib uuid.lib advapi32.lib' -f
            $cleanupSource, (Join-Path $output 'data-cleanup-test.obj'), $cleanupExecutable)
    ), [Text.Encoding]::Default)
    & $env:ComSpec /d /c $cleanupScript
    if ($LASTEXITCODE -ne 0) { throw 'Uninstall data test compilation failed.' }
    & $cleanupExecutable (Join-Path $output ('cleanup-' + [Guid]::NewGuid().ToString('N')))
    if ($LASTEXITCODE -ne 0) { throw 'Uninstall data regression failed.' }
    Write-Output 'Uninstall data safety tests passed.'
}
