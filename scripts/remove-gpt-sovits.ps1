[CmdletBinding()]
param(
    [string]$DataRoot,
    [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "agent-pet-paths.ps1")

if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is unavailable. The GPT-SoVITS installation directory cannot be resolved."
}

$companionRoot = Resolve-AgentPetDataRoot -DataRoot $DataRoot
$enginesRoot = Join-Path $companionRoot "engines"
$engineRoot = Join-Path $enginesRoot "GPT-SoVITS"
$resolvedEnginesRoot = [IO.Path]::GetFullPath($enginesRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedEngineRoot = [IO.Path]::GetFullPath($engineRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$requiredPrefix = $resolvedEnginesRoot + [IO.Path]::DirectorySeparatorChar

if (-not $resolvedEngineRoot.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a directory outside the application engines directory: $resolvedEngineRoot"
}

Write-Host ""
Write-Host "Remove the isolated GPT-SoVITS runtime" -ForegroundColor Cyan
Write-Host "  Target: $resolvedEngineRoot"
Write-Host ""
Write-Host "This removes the portable runtime, Python environment, source, official base models, and caches."
Write-Host "Application settings and imported character voice packs are preserved."
Write-Host "Close the GPT-SoVITS service window before continuing."

if (-not (Test-Path -LiteralPath $resolvedEngineRoot)) {
    Write-Host "The isolated GPT-SoVITS runtime is not installed. Nothing was removed."
    exit 0
}

if (-not $Yes) {
    $confirmation = Read-Host "Type REMOVE to continue"
    if ($confirmation -cne "REMOVE") {
        Write-Host "Cleanup cancelled."
        exit 0
    }
}

Remove-Item -LiteralPath $resolvedEngineRoot -Recurse -Force

if (Test-Path -LiteralPath $resolvedEngineRoot) {
    throw "The isolated GPT-SoVITS runtime could not be removed completely."
}

Write-Host ""
Write-Host "The isolated GPT-SoVITS runtime was removed." -ForegroundColor Green
Write-Host "No system Python, Conda, PATH, registry, or shell-profile cleanup is necessary."
