# Builds a C# 5 program with the .NET Framework's own compiler (Framework64\v4.0.30319\csc.exe,
# as ENVIRONMENT.md names it). Usage:  .\build.ps1 [-Out x.exe] [a.cs b.cs ...]
param(
    [string]$Out = 's3cab-restore.exe',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Src
)
if (-not $Src) { $Src = @('src\S3.cs', 'src\Core.cs', 'src\Restore.cs') }
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$files = @($Src | ForEach-Object { Join-Path $root $_ })
& $csc /nologo /target:exe /optimize+ /warn:4 /debug- ('/out:' + (Join-Path $root $Out)) $files
if ($LASTEXITCODE -ne 0) { Write-Output 'BUILD FAILED'; exit 1 }
Write-Output ('built ' + (Join-Path $root $Out))
