$ErrorActionPreference = 'Stop'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'build\runtime.json') | ConvertFrom-Json
& $manifest.java '-Dfile.encoding=UTF-8' '-cp' $manifest.classpath $manifest.mainClass
exit $LASTEXITCODE
