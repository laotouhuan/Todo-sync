# run-tests.ps1
# One-click testing script for Windows and Android

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "🚀 Starting All-Platform Automated Tests..." -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$success = $true

# 1. Windows Tests
Write-Host "`n🔍 Running Windows tests..." -ForegroundColor Yellow
Push-Location windows
try {
    Write-Host "  -> Running check-build..."
    node tests/check-build.mjs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Windows check-build failed!" -ForegroundColor Red
        $success = $false
    } else {
        Write-Host "  -> Running unit and logic tests..."
        node --test tests/test-dateUtils.mjs
        node --test tests/test-dataLogic.mjs
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ Windows unit/logic tests failed!" -ForegroundColor Red
            $success = $false
        } else {
            Write-Host "✅ Windows tests passed successfully!" -ForegroundColor Green
        }
    }
} catch {
    Write-Host "❌ Exception occurred while running Windows tests: $_" -ForegroundColor Red
    $success = $false
}
Pop-Location

# 2. Android Tests
Write-Host "`n🔍 Running Android tests..." -ForegroundColor Yellow
Push-Location android
try {
    if (-not $env:JAVA_HOME) {
        $env:JAVA_HOME = "D:\android studio\jbr"
    }
    Write-Host "  -> Running Android unit tests..."
    ./gradlew testDebugUnitTest
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Android unit tests failed!" -ForegroundColor Red
        $success = $false
    } else {
        Write-Host "✅ Android tests passed successfully!" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Exception occurred while running Android tests: $_" -ForegroundColor Red
    $success = $false
}
Pop-Location

Write-Host "`n==========================================" -ForegroundColor Cyan
if ($success) {
    Write-Host "🎉 All tests passed successfully! Safe to commit or build." -ForegroundColor Green
} else {
    Write-Host "❌ Test run failed. Please check the logs above." -ForegroundColor Red
    exit 1
}
