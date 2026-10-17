$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$python = Join-Path $root "backend\.venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Python environment is missing. Follow README first-time dependency setup."
}

Push-Location (Join-Path $root "frontend")
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend build failed. See the error above."
    }
} finally {
    Pop-Location
}

Push-Location (Join-Path $root "backend")
try {
    & $python -m flask --app app db upgrade
    if ($LASTEXITCODE -ne 0) {
        throw "Database migration failed. Check PostgreSQL and backend\.env."
    }
    & $python -m flask --app app db-check
    if ($LASTEXITCODE -ne 0) {
        throw "Database connection failed. See README database setup."
    }
    & $python -m flask --app app prepare-official-teams
    if ($LASTEXITCODE -ne 0) {
        throw "Official team setup requires review. Existing records have not been replaced."
    }
    Write-Host ""
    Write-Host "Host:       http://127.0.0.1:5000/host"
    Write-Host "TV:         http://127.0.0.1:5000/display"
    Write-Host "Spectators: http://127.0.0.1:5000/"
    Write-Host "Local computer only. Keep this terminal open; Ctrl+C stops the server."
    & $python -m flask --app app run --host 127.0.0.1 --port 5000
    if ($LASTEXITCODE -ne 0) {
        throw "Local server stopped with an error. Check whether port 5000 is occupied."
    }
} finally {
    Pop-Location
}
