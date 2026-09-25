param(
    [string]$Pr
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $PSScriptRoot 'resolve_upstream.py'

if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "Required helper is missing: $helper"
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    throw "Python is required. Install Python and ensure 'python' is available on PATH."
}

$arguments = @('-B', $helper)
if ($PSBoundParameters.ContainsKey('Pr')) {
    [int]$resolvedPr = 0
    if (-not [int]::TryParse($Pr, [ref]$resolvedPr) -or $resolvedPr -le 0) {
        throw '-Pr must be a positive integer.'
    }
    $arguments += @('--pr', $resolvedPr)
}

Push-Location -LiteralPath $repoRoot
try {
    & $python.Source @arguments
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}
