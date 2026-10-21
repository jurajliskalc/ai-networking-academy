# Starts AI Networking Academy locally on http://127.0.0.1:8740.
# Uses Node.js from .tools/node (portable, project-local) or from PATH; downloads a portable Node.js
# LTS (checksum-verified) into .tools/node if neither exists. Rebuilds the site when content or source
# changed since the last build. No system-wide install, no admin rights.
param([int]$Port = 8740, [switch]$Rebuild, [switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$nodeDir = Join-Path $root ".tools\node"
$nodeVersion = "v24.21.0"

if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
    $sys = Get-Command node -ErrorAction SilentlyContinue
    if ($sys) {
        $nodeDir = Split-Path -Parent $sys.Source
    } else {
        Write-Host "[setup] Downloading portable Node.js $nodeVersion ..."
        New-Item -ItemType Directory -Force (Join-Path $root ".tools") | Out-Null
        $zip = Join-Path $root ".tools\node-$nodeVersion-win-x64.zip"
        Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip" -OutFile $zip -UseBasicParsing
        $sums = (Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
        $expected = (($sums -split "`n") | Where-Object { $_ -match "node-$nodeVersion-win-x64.zip" }).Split(" ")[0]
        $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
        if ($expected -ne $actual) { Remove-Item $zip; throw "Node.js checksum mismatch" }
        Expand-Archive $zip -DestinationPath (Join-Path $root ".tools") -Force
        Remove-Item $zip
        Rename-Item (Join-Path $root ".tools\node-$nodeVersion-win-x64") "node"
        $nodeDir = Join-Path $root ".tools\node"
    }
}
$env:PATH = "$nodeDir;$env:PATH"

$fe = Join-Path $root "frontend"
Push-Location $fe
try {
    $installed = "node_modules\.package-lock.json"
    $stale = (-not (Test-Path $installed)) -or ((Get-Item "package-lock.json").LastWriteTime -gt (Get-Item $installed).LastWriteTime)
    if ($stale) {
        Write-Host "[setup] Installing packages (npm ci) ..."
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    }
    $built = "dist\index.html"
    $needBuild = $Rebuild -or -not (Test-Path $built)
    if (-not $needBuild) {
        $builtAt = (Get-Item $built).LastWriteTime
        $newer = Get-ChildItem -Recurse -File (Join-Path $root "content"), "src", "scripts" | Where-Object { $_.LastWriteTime -gt $builtAt } | Select-Object -First 1
        $needBuild = $null -ne $newer
    }
    if ($needBuild) {
        Write-Host "[build] Validating content and building the site ..."
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "build failed (see errors above)" }
    }
    Write-Host ""
    Write-Host "  AI Networking Academy  ->  http://127.0.0.1:$Port"
    Write-Host "  Close this window or press Ctrl+C to stop."
    Write-Host ""
    $viteArgs = @("vite", "preview", "--port", "$Port", "--strictPort", "--host", "127.0.0.1")
    if (-not $NoBrowser) { $viteArgs += "--open" }
    & npx @viteArgs
} finally {
    Pop-Location
}
