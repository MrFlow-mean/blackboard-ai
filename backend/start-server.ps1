Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Info([string]$msg) { Write-Host $msg -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host $msg -ForegroundColor Yellow }
function Err([string]$msg)  { Write-Host $msg -ForegroundColor Red }

function HasCmd([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function NodeMajorVersion {
  $v = (& node -p "process.versions.node" 2>$null)
  if (-not $v) { return $null }
  $m = [regex]::Match($v, '^(\d+)\.')
  if (-not $m.Success) { return $null }
  return [int]$m.Groups[1].Value
}

$BackendDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $BackendDir

Info "== Backend launcher =="
Info ("Dir: " + $BackendDir)

if (-not (HasCmd "node")) { Err "Node.js not found. Please install Node.js 18+."; exit 1 }
if (-not (HasCmd "npm")) { Err "npm not found. Please reinstall Node.js."; exit 1 }

$major = NodeMajorVersion
if ($null -eq $major) {
  Warn "Cannot detect Node version; will continue."
} elseif ($major -lt 18) {
  Warn ("Node version < 18 (major: {0}). Will install node-fetch@2 for compatibility." -f $major)
}

if (-not (Test-Path ".\package.json")) {
  Err "package.json not found. Run this script inside the backend folder."
  exit 1
}

if (-not (Test-Path ".\.env")) {
  Warn ".env not found. Creating a template .env (no real keys)."
  @(
    "# Configure at least one:"
    "OPENAI_API_KEY="
    "OPENROUTER_API_KEY="
    ""
    "# Optional:"
    "OPENAI_API_BASE=https://api.openai.com"
    "OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview-2024-12-17"
    "OPENAI_REALTIME_VOICE=alloy"
    ""
    "OPENROUTER_API_BASE=https://openrouter.ai/api"
    "OPENROUTER_MODEL=deepseek/deepseek-chat"
  ) | Out-File -FilePath ".\.env" -Encoding utf8
}

$needInstall = $false
if (-not (Test-Path ".\node_modules\ws")) { $needInstall = $true }

if ($needInstall) {
  Info "Installing deps (npm install)..."
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit code: $LASTEXITCODE)" }
} else {
  Info "Deps already installed."
}

if ($null -ne $major -and $major -lt 18) {
  Info "Node < 18: installing node-fetch@2 (--no-save)..."
  & npm install node-fetch@2 --no-save
  if ($LASTEXITCODE -ne 0) { throw "node-fetch install failed (exit code: $LASTEXITCODE)" }
}

Info ""
Info "Starting server (npm start)..."
Info "WS: ws://localhost:3002"
Info "Health: http://localhost:3002/health"
Info ""

& npm start
exit $LASTEXITCODE

