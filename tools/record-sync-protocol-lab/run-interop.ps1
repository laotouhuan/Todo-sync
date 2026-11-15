param([string]$ReportPath)
$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Push-Location $workspaceRoot
try {
    # 只构建独立实验项目；不修改或编译Windows／Android应用。
    $manifest = Join-Path $PSScriptRoot 'rust\Cargo.toml'
    & cargo check --locked --offline --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) { throw 'Rust实验编译检查失败；请检查本机依赖缓存。' }
    & cargo test --locked --offline --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) { throw 'Rust实验测试失败。' }
    & cargo build --locked --offline --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) { throw 'Rust实验可执行文件构建失败。' }
    & (Join-Path $PSScriptRoot 'kotlin\build.ps1')
    if ($ReportPath) { & node (Join-Path $PSScriptRoot 'run-interop.mjs') $ReportPath }
    else { & node (Join-Path $PSScriptRoot 'run-interop.mjs') }
    if ($LASTEXITCODE -ne 0) { throw '三语言互通验证未通过；请查看报告。' }
} finally {
    Pop-Location
}
