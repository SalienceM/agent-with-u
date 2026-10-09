param([Parameter(Mandatory=$true)][string]$Jdk, [Parameter(Mandatory=$true)][string]$JdtHome)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'engine-providers/awu-jdt-diagnostics.jar'
$classes = Join-Path $root '../.qa/engine-jdt-diagnostics/classes'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$classpath = (Get-ChildItem -LiteralPath (Join-Path $JdtHome 'plugins') -Filter '*.jar' | ForEach-Object FullName) -join [IO.Path]::PathSeparator
& (Join-Path $Jdk 'bin/javac.exe') --release 21 -encoding UTF-8 -classpath $classpath -d $classes (Join-Path $PSScriptRoot 'src/awu/engine/VersionedDiagnostics.java')
if ($LASTEXITCODE -ne 0) { throw 'Versioned diagnostic compile failed' }
& (Join-Path $Jdk 'bin/jar.exe') --create --date=2026-10-09T00:00:00Z --file $output --manifest (Join-Path $PSScriptRoot 'MANIFEST.MF') -C $classes . -C $PSScriptRoot plugin.xml
if ($LASTEXITCODE -ne 0) { throw 'Versioned diagnostic packaging failed' }
Get-FileHash -Algorithm SHA256 -LiteralPath $output
