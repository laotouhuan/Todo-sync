param([string]$JavaPath = 'D:\android studio\jbr\bin\java.exe')
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'extract.mjs')
if ($LASTEXITCODE -ne 0) { throw '实际源码函数抽取失败。' }
$moduleCache = Join-Path $env:USERPROFILE '.gradle\caches\modules-2\files-2.1'
function Find-CachedJar([string]$Coordinate) {
    $location = Join-Path $moduleCache $Coordinate
    $result = @(Get-ChildItem -LiteralPath $location -Filter '*.jar' -Recurse -File)
    if ($result.Count -ne 1) { throw "缓存依赖缺失或不唯一：$Coordinate" }
    return $result[0].FullName
}
$stdlib = Find-CachedJar 'org.jetbrains.kotlin\kotlin-stdlib\2.0.21'
$json = Find-CachedJar 'org.jetbrains.kotlinx\kotlinx-serialization-json-jvm\1.7.3'
$serialization = Find-CachedJar 'org.jetbrains.kotlinx\kotlinx-serialization-core-jvm\1.7.3'
$annotations = Find-CachedJar 'org.jetbrains\annotations\13.0'
$compilerJars = @(
    (Find-CachedJar 'org.jetbrains.kotlin\kotlin-compiler-embeddable\2.0.21'),
    $stdlib,
    (Find-CachedJar 'org.jetbrains.kotlin\kotlin-script-runtime\2.0.21'),
    (Find-CachedJar 'org.jetbrains.kotlin\kotlin-reflect\1.6.10'),
    (Find-CachedJar 'org.jetbrains.kotlin\kotlin-daemon-embeddable\2.0.21'),
    (Find-CachedJar 'org.jetbrains.intellij.deps\trove4j\1.0.20200330'),
    (Find-CachedJar 'org.jetbrains.kotlinx\kotlinx-coroutines-core-jvm\1.6.4'),
    $annotations
)
$build = Join-Path $PSScriptRoot 'build'
$classes = Join-Path $build 'classes'
New-Item -ItemType Directory -Path $classes -Force | Out-Null
$dependencies = @($stdlib, $json, $serialization, $annotations) -join [IO.Path]::PathSeparator
& $JavaPath '-Dfile.encoding=UTF-8' '-cp' ($compilerJars -join [IO.Path]::PathSeparator) 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler' '-no-stdlib' '-no-reflect' '-classpath' $dependencies '-jvm-target' '17' '-d' $classes (Join-Path $build 'Probe.kt')
if ($LASTEXITCODE -ne 0) { throw "Kotlin打卡纯函数实验编译失败：$LASTEXITCODE" }
@{ mainClass = 'ProbeKt'; classpath = @($classes, $stdlib, $json, $serialization, $annotations); java = $JavaPath } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'launch.json') -Encoding utf8
Write-Host '打卡纯函数实验构建完成；仅验证抽取的函数，不代表Android完整验收。'
