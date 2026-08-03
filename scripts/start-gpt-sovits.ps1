[CmdletBinding()]
param(
    [string]$Address = "127.0.0.1",
    [ValidateRange(1, 65535)]
    [int]$Port = 9880,
    [string]$DataRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "agent-pet-paths.ps1")

if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is unavailable. The GPT-SoVITS installation directory cannot be resolved."
}

$managedRoot = Resolve-AgentPetDataRoot -DataRoot $DataRoot
$engineRoot = Join-Path $managedRoot "engines\GPT-SoVITS"
$environmentRoot = Join-Path $engineRoot "env"
$sourceRoot = Join-Path $engineRoot "source"
$apiScript = Join-Path $sourceRoot "api_v2.py"
$python = Join-Path $environmentRoot "python.exe"

if (-not (Test-Path $apiScript) -or -not (Test-Path $python)) {
    throw "GPT-SoVITS has not been installed. Run setup-gpt-sovits.cmd first."
}

$env:MAMBA_ROOT_PREFIX = Join-Path $engineRoot "mamba-root"
$env:PIP_CACHE_DIR = Join-Path $engineRoot "pip-cache"
$env:PIP_CONFIG_FILE = "NUL"
$env:HF_HOME = Join-Path $engineRoot "model-cache\huggingface"
$env:MODELSCOPE_CACHE = Join-Path $engineRoot "model-cache\modelscope"
$env:XDG_CACHE_HOME = Join-Path $engineRoot "cache"
$env:PYTHONNOUSERSITE = "1"
$environmentPath = @(
    $environmentRoot,
    (Join-Path $environmentRoot "Scripts"),
    (Join-Path $environmentRoot "Library\bin"),
    (Join-Path $environmentRoot "Library\usr\bin")
) -join ";"
$env:PATH = "$environmentPath;$env:PATH"
$env:CONDA_PREFIX = $environmentRoot

Write-Host "Starting the isolated GPT-SoVITS API at http://${Address}:$Port" -ForegroundColor Cyan
Write-Host "Keep this window open. Closing it stops the voice service."
Set-Location $sourceRoot
& $python $apiScript -a $Address -p $Port
exit $LASTEXITCODE
