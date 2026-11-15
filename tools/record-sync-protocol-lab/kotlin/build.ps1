param([string]$JavaPath = 'D:\android studio\jbr\bin\java.exe')
$ErrorActionPreference = 'Stop'
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
$outputRoot = Join-Path $PSScriptRoot 'build'
$classes = Join-Path $outputRoot 'classes'
New-Item -ItemType Directory -Path $classes -Force | Out-Null
$runtime = @($classes, $stdlib, $json, $serialization, $annotations) -join [IO.Path]::PathSeparator
$dependencies = @($stdlib, $json, $serialization, $annotations) -join [IO.Path]::PathSeparator
$canonicalSource = Join-Path $PSScriptRoot '../../../android/app/src/main/java/com/todo/app/data/recordsync/CanonicalRecordJson.kt'
& $JavaPath '-Dfile.encoding=UTF-8' '-cp' ($compilerJars -join [IO.Path]::PathSeparator) 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler' '-no-stdlib' '-no-reflect' '-classpath' $dependencies '-jvm-target' '17' '-d' $classes (Join-Path $PSScriptRoot 'Main.kt') $canonicalSource
if ($LASTEXITCODE -ne 0) { throw "Kotlin 编译失败：$LASTEXITCODE" }
$manifest = @{ java = $JavaPath; classpath = $runtime; mainClass = 'MainKt'; implementation = 'standalone-kotlin-protocol-lab' }
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot 'runtime.json') -Encoding utf8
@{ mainClass = 'MainKt'; classpath = @($classes, $stdlib, $json, $serialization, $annotations) } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot 'launch.json') -Encoding utf8
Write-Host 'Kotlin实验工具构建完成；运行参数见 kotlin/build/runtime.json。'
