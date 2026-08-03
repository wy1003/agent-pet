[CmdletBinding()]
param(
    [ValidateSet("CU126", "CU128", "CPU")]
    [string]$Device,

    [ValidateSet("HF", "HF-Mirror", "ModelScope")]
    [string]$Source,

    [string]$Version = "d523079fc05d9a8028d6085bffe4a2757c32abb6",

    [string]$MicromambaVersion = "2.6.2-1",

    [string]$DataRoot,

    [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "agent-pet-paths.ps1")

function Read-Choice {
    param(
        [string]$Prompt,
        [hashtable]$Choices
    )

    while ($true) {
        Write-Host ""
        Write-Host $Prompt
        foreach ($key in ($Choices.Keys | Sort-Object)) {
            Write-Host "  $key. $($Choices[$key])"
        }
        $selected = Read-Host "Enter a number"
        if ($Choices.ContainsKey($selected)) {
            return $selected
        }
        Write-Host "Invalid choice. Try again." -ForegroundColor Yellow
    }
}

function Invoke-Checked {
    param(
        [string]$Command,
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Download {
    param(
        [string]$Uri,
        [string]$Destination
    )

    Write-Host "Downloading: $Uri"
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
    $download = Get-Item -LiteralPath $Destination
    if ($download.Length -le 0) {
        throw "The downloaded file is empty: $Uri"
    }
}

function Enable-VisiblePipProgress {
    param(
        [string]$InstallerPath
    )

    $marker = "Codex Task Companion: visible pip progress"
    $content = Get-Content -LiteralPath $InstallerPath -Raw
    if ($content.Contains($marker)) {
        return
    }

    $pattern = '(?ms)^function Invoke-Pip \{.*?^function Invoke-Download'
    $replacement = @'
function Invoke-Pip {
    param (
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Args
    )

    # Codex Task Companion: visible pip progress
    Write-Host "[PIP]: pip install $Args" -ForegroundColor Cyan
    & pip install --progress-bar on @Args
    if ($LASTEXITCODE -ne 0) {
        throw "Pip install $Args failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Download
'@
    $updated = [regex]::Replace($content, $pattern, $replacement, 1)
    if ($updated -eq $content) {
        throw "The pinned GPT-SoVITS installer format changed; visible pip progress could not be enabled safely."
    }
    $updated | Set-Content -LiteralPath $InstallerPath -Encoding UTF8
}

if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is unavailable. The installation directory cannot be resolved."
}

if (-not $Device) {
    $deviceChoice = Read-Choice "Select the inference device:" @{
        "1" = "NVIDIA CUDA 12.8 (new GPU and driver)"
        "2" = "NVIDIA CUDA 12.6"
        "3" = "CPU (most compatible, but slower)"
    }
    $Device = @{ "1" = "CU128"; "2" = "CU126"; "3" = "CPU" }[$deviceChoice]
}

if (-not $Source) {
    $sourceChoice = Read-Choice "Select the dependency and base-model source:" @{
        "1" = "ModelScope (recommended in mainland China)"
        "2" = "Hugging Face mirror"
        "3" = "Hugging Face"
    }
    $Source = @{ "1" = "ModelScope"; "2" = "HF-Mirror"; "3" = "HF" }[$sourceChoice]
}

$managedRoot = Resolve-AgentPetDataRoot -DataRoot $DataRoot
$engineRoot = Join-Path $managedRoot "engines\GPT-SoVITS"
$installationMarker = Join-Path $engineRoot "installation.json"
$runtimeRoot = Join-Path $engineRoot "runtime"
$micromamba = Join-Path $runtimeRoot "micromamba.exe"
$mambaRoot = Join-Path $engineRoot "mamba-root"
$environmentRoot = Join-Path $engineRoot "env"
$sourceRoot = Join-Path $engineRoot "source"
$sourceRevisionMarker = Join-Path $sourceRoot ".codex-source-revision"
$downloadRoot = Join-Path $engineRoot "downloads"
$shimRoot = Join-Path $runtimeRoot "shims"
$repository = "https://github.com/RVC-Boss/GPT-SoVITS"
$micromambaUrl = "https://github.com/mamba-org/micromamba-releases/releases/download/$MicromambaVersion/micromamba-win-64.exe"
$micromambaChecksumUrl = "https://github.com/mamba-org/micromamba-releases/releases/download/$MicromambaVersion/micromamba-win-64.sha256"
$sourceArchiveUrl = "$repository/archive/$Version.zip"
$previousDevice = ""
if (Test-Path -LiteralPath $installationMarker) {
    try {
        $previousInstallation = Get-Content -LiteralPath $installationMarker -Raw | ConvertFrom-Json
        $previousDevice = [string]$previousInstallation.device
    } catch {
        $previousDevice = ""
    }
}
$deviceChanged = $previousDevice -and $previousDevice -ne $Device

Write-Host ""
Write-Host "GPT-SoVITS isolated on-demand installation" -ForegroundColor Cyan
Write-Host "  Official repository: $repository"
Write-Host "  GPT-SoVITS version: $Version"
Write-Host "  Portable micromamba: $MicromambaVersion"
Write-Host "  Device: $Device"
Write-Host "  Download source: $Source"
Write-Host "  Isolated root: $engineRoot"
Write-Host ""
Write-Host "Everything is stored under the isolated root shown above."
Write-Host "No system Python or Conda is used. User PATH, registry, and shell profiles are not modified."
Write-Host "Deleting this root removes the runtime, package caches, source, and official base models."
Write-Host "Several gigabytes of disk space may be required."
Write-Host "Character voice packs are not downloaded or distributed by Agent Pet."

if (-not $Yes) {
    $confirmation = Read-Host "Type YES to continue"
    if ($confirmation -cne "YES") {
        Write-Host "Installation cancelled."
        exit 0
    }
}

New-Item -ItemType Directory -Force -Path $runtimeRoot, $downloadRoot, $shimRoot | Out-Null

if (-not (Test-Path $micromamba)) {
    $micromambaDownload = Join-Path $downloadRoot "micromamba.exe.download"
    $micromambaChecksum = Join-Path $downloadRoot "micromamba.sha256"
    Write-Host "Downloading portable micromamba..." -ForegroundColor Cyan
    Invoke-Download $micromambaUrl $micromambaDownload
    Invoke-Download $micromambaChecksumUrl $micromambaChecksum
    $expectedHash = ((Get-Content -LiteralPath $micromambaChecksum -Raw).Trim() -split "\s+")[0]
    $actualHash = (Get-FileHash -LiteralPath $micromambaDownload -Algorithm SHA256).Hash
    if ($actualHash -ine $expectedHash) {
        Remove-Item -LiteralPath $micromambaDownload -Force -ErrorAction SilentlyContinue
        throw "Portable micromamba checksum verification failed."
    }
    Move-Item -LiteralPath $micromambaDownload -Destination $micromamba -Force
    Remove-Item -LiteralPath $micromambaChecksum -Force
}
Invoke-Checked $micromamba @("--version")

$installedSourceRevision = if (Test-Path -LiteralPath $sourceRevisionMarker) {
    (Get-Content -LiteralPath $sourceRevisionMarker -Raw).Trim()
} else {
    ""
}
$sourceReady = (
    (Test-Path -LiteralPath (Join-Path $sourceRoot "api_v2.py")) -and
    (Test-Path -LiteralPath (Join-Path $sourceRoot "install.ps1")) -and
    $installedSourceRevision -eq $Version
)

if (-not $sourceReady) {
    if (Test-Path -LiteralPath $sourceRoot) {
        Write-Host "Replacing incomplete or outdated managed source..." -ForegroundColor Yellow
        Remove-Item -LiteralPath $sourceRoot -Recurse -Force
    }
    $sourceArchive = Join-Path $downloadRoot "gpt-sovits-$Version.zip"
    $extractRoot = Join-Path $downloadRoot "source-extract"
    Write-Host "Downloading the pinned GPT-SoVITS source archive..." -ForegroundColor Cyan
    Invoke-Download $sourceArchiveUrl $sourceArchive
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $sourceArchive -DestinationPath $extractRoot -Force
    $extractedDirectory = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
    if (-not $extractedDirectory) {
        throw "The GPT-SoVITS source archive did not contain a directory."
    }
    Move-Item -LiteralPath $extractedDirectory.FullName -Destination $sourceRoot
    $Version | Set-Content -LiteralPath $sourceRevisionMarker -Encoding ASCII
    Remove-Item -LiteralPath $sourceArchive -Force
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
} else {
    Write-Host "Existing GPT-SoVITS source found. Source download skipped."
}

$env:MAMBA_ROOT_PREFIX = $mambaRoot
$env:PIP_CACHE_DIR = Join-Path $engineRoot "pip-cache"
$env:PIP_CONFIG_FILE = "NUL"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
$env:PIP_DEFAULT_TIMEOUT = "120"
$env:PIP_PROGRESS_BAR = "on"
if ($Source -in @("ModelScope", "HF-Mirror")) {
    $env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple"
    Write-Host "Python dependency mirror: Tsinghua TUNA" -ForegroundColor Cyan
} else {
    $env:PIP_INDEX_URL = "https://pypi.org/simple"
    Write-Host "Python dependency source: PyPI" -ForegroundColor Cyan
}
$env:HF_HOME = Join-Path $engineRoot "model-cache\huggingface"
$env:MODELSCOPE_CACHE = Join-Path $engineRoot "model-cache\modelscope"
$env:XDG_CACHE_HOME = Join-Path $engineRoot "cache"
$env:PYTHONNOUSERSITE = "1"

if (-not (Test-Path (Join-Path $environmentRoot "python.exe"))) {
    Write-Host "Creating an isolated Python 3.10 environment..." -ForegroundColor Cyan
    Invoke-Checked $micromamba @(
        "--no-rc", "create", "--yes", "--prefix", $environmentRoot,
        "--channel", "conda-forge", "python=3.10", "pip"
    )
} else {
    Write-Host "Existing isolated Python environment found. Dependency checks will continue."
}

$condaShim = Join-Path $shimRoot "conda.cmd"
$shimLines = @(
    "@echo off",
    ('"{0}" --no-rc %* --prefix "{1}"' -f $micromamba, $environmentRoot)
)
$shimLines | Set-Content -LiteralPath $condaShim -Encoding ASCII

$environmentPath = @(
    $shimRoot,
    $environmentRoot,
    (Join-Path $environmentRoot "Scripts"),
    (Join-Path $environmentRoot "Library\bin"),
    (Join-Path $environmentRoot "Library\usr\bin")
) -join ";"
$env:PATH = "$environmentPath;$env:PATH"
$env:CONDA_PREFIX = $environmentRoot

if ($deviceChanged) {
    Write-Host "Reconfiguring PyTorch from $previousDevice to $Device..." -ForegroundColor Cyan
    Remove-Item -LiteralPath $installationMarker -Force -ErrorAction SilentlyContinue
    Invoke-Checked (Join-Path $environmentRoot "python.exe") @(
        "-m", "pip", "uninstall", "--yes", "torch", "torchcodec", "torchvision", "torchaudio"
    )
}

$officialInstaller = Join-Path $sourceRoot "install.ps1"
if (-not (Test-Path $officialInstaller)) {
    throw "The official installer was not found: $officialInstaller"
}
Enable-VisiblePipProgress $officialInstaller

Write-Host "Running the official GPT-SoVITS dependency installer inside the isolated environment..." -ForegroundColor Cyan
$scriptHost = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if (-not $scriptHost) {
    $scriptHost = Get-Command powershell.exe -ErrorAction Stop
}
Push-Location $sourceRoot
try {
    & $scriptHost.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File $officialInstaller -Device $Device -Source $Source
    if ($LASTEXITCODE -ne 0) {
        throw "The official GPT-SoVITS installer failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$installation = [ordered]@{
    repository = $repository
    version = $Version
    runtime = "portable-micromamba"
    micromambaVersion = $MicromambaVersion
    device = $Device
    source = $Source
    isolatedRoot = $engineRoot
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$installation | ConvertTo-Json | Set-Content -Path $installationMarker -Encoding UTF8

Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $env:PIP_CACHE_DIR -Recurse -Force -ErrorAction SilentlyContinue
& $micromamba --no-rc clean --all --yes | Out-Null

Write-Host ""
Write-Host "GPT-SoVITS installation completed." -ForegroundColor Green
Write-Host "No persistent system environment changes were made."
Write-Host "Run start-gpt-sovits.cmd from the project root to start the local API."
