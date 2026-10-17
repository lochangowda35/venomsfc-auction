$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$python = Join-Path $root "backend\.venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Python environment is missing. Follow README first-time dependency setup."
}

# Native tools log to stderr; rely on exit codes below instead.
$ErrorActionPreference = "Continue"
Push-Location (Join-Path $root "frontend")
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed. See the error above." }
} finally {
    Pop-Location
}

Push-Location (Join-Path $root "backend")
try {
    & $python -m flask --app app db upgrade
    if ($LASTEXITCODE -ne 0) { throw "Database migration failed. Check PostgreSQL and backend\.env." }
    & $python -m flask --app app db-check
    if ($LASTEXITCODE -ne 0) { throw "Database connection failed. See README database setup." }

    # Public mode: HTTPS-only host cookie and per-visitor login limits behind Cloudflare.
    $env:SESSION_COOKIE_SECURE = "1"
    $env:TRUST_CLOUDFLARE = "1"

    $cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
    if (-not (Test-Path -LiteralPath $cloudflared)) {
        Write-Warning "cloudflared is not installed; the site will only work on this laptop."
    } elseif (Get-Process cloudflared -ErrorAction SilentlyContinue) {
        Write-Host "Cloudflare tunnel is already running."
    } else {
        $tunnel = Start-Process -FilePath $cloudflared -ArgumentList "tunnel", "run", "venomsfc" -WindowStyle Hidden -PassThru
        Write-Host "Cloudflare tunnel started."
    }
    Write-Host ""
    Write-Host "Public site: https://www.venomsfc.in  (host: /host, TV: /display)"
    Write-Host "Sign in as host through https://www.venomsfc.in/host, not 127.0.0.1."
    Write-Host "Keep this window open. Ctrl+C stops the site (server and tunnel)."
    & $python -c "from dotenv import load_dotenv; load_dotenv('.env'); from waitress import serve; from app import create_app; serve(create_app(), host='127.0.0.1', port=5000, threads=16)"
    if ($LASTEXITCODE -ne 0) { throw "Server stopped with an error. Check whether port 5000 is occupied." }
} finally {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id }
    Pop-Location
}
