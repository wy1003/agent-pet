function Resolve-AgentPetDataRoot {
    param(
        [string]$DataRoot
    )

    if ($DataRoot) {
        return [IO.Path]::GetFullPath($DataRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    }
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is unavailable. The Agent Pet data directory cannot be resolved."
    }

    $preferred = Join-Path $env:LOCALAPPDATA "AgentPet"
    $legacy = Join-Path $env:LOCALAPPDATA "CodexTaskCompanion"
    $allowed = @(
        [IO.Path]::GetFullPath($preferred).TrimEnd([IO.Path]::DirectorySeparatorChar),
        [IO.Path]::GetFullPath($legacy).TrimEnd([IO.Path]::DirectorySeparatorChar)
    )

    if ($env:APPDATA) {
        $recordPath = Join-Path $env:APPDATA "Agent Pet\data-location.json"
        if (Test-Path -LiteralPath $recordPath) {
            try {
                $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
                $recorded = [IO.Path]::GetFullPath([string]$record.localRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
                if ($allowed -contains $recorded -and (Test-Path -LiteralPath $recorded)) {
                    return $recorded
                }
            } catch {}
        }
    }

    $preferredMarker = Join-Path $preferred "engines\GPT-SoVITS\installation.json"
    $legacyMarker = Join-Path $legacy "engines\GPT-SoVITS\installation.json"
    if (Test-Path -LiteralPath $preferredMarker) { return $preferred }
    if (Test-Path -LiteralPath $legacyMarker) { return $legacy }
    if (Test-Path -LiteralPath $preferred) { return $preferred }
    if (Test-Path -LiteralPath $legacy) { return $legacy }
    return $preferred
}
