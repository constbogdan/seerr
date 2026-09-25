[CmdletBinding()]
param(
    [ValidateSet('Fast', 'Standard', 'Full')]
    [string]$Level = 'Fast',
    [string[]]$TestFilter = @(),
    [string[]]$ChangedPath = @()
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$policyScript = Join-Path $PSScriptRoot 'mosaic_validation_policy.py'
$config = Import-PowerShellDataFile -LiteralPath (Join-Path $PSScriptRoot 'prepare-pr.config.psd1')
$runDirectory = Join-Path ([IO.Path]::GetTempPath()) ("seerr-validation-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runDirectory | Out-Null

function Get-TextHash([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($bytes)
        return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-GitText([string[]]$Arguments) {
    $errorPath = Join-Path ([IO.Path]::GetTempPath()) ("seerr-git-stderr-" + [guid]::NewGuid().ToString('N') + '.log')
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $lines = @(& git @Arguments 2> $errorPath)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        $diagnostic = if (Test-Path -LiteralPath $errorPath) {
            (Get-Content -LiteralPath $errorPath -Raw).Trim()
        } else { '' }
        throw "Git inspection failed: git $($Arguments[0]). $diagnostic"
    }
    if (Test-Path -LiteralPath $errorPath) { [IO.File]::Delete($errorPath) }
    return ($lines -join "`n").TrimEnd()
}

function Get-RepositorySnapshot {
    $head = Get-GitText @('rev-parse', 'HEAD')
    $headTree = Get-GitText @('rev-parse', 'HEAD^{tree}')
    $index = Get-TextHash (Get-GitText @('diff', '--cached', '--binary', 'HEAD', '--'))
    $working = Get-TextHash (Get-GitText @('diff', '--binary', '--'))
    $untracked = @(Get-GitText @('ls-files', '--others', '--exclude-standard') -split "`n" | Where-Object { $_ })
    $untrackedIdentity = foreach ($path in $untracked) {
        "$path`0$(Get-GitText @('hash-object', '--', $path))"
    }
    return [pscustomobject]@{
        Head = $head
        HeadTree = $headTree
        Index = $index
        Working = $working
        Untracked = Get-TextHash ($untrackedIdentity -join "`n")
    }
}

function Assert-RepositorySnapshot($Expected, [string]$Stage) {
    $actual = Get-RepositorySnapshot
    $drift = [Collections.Generic.List[string]]::new()
    foreach ($field in @('Head', 'HeadTree', 'Index', 'Working', 'Untracked')) {
        if ($actual.$field -cne $Expected.$field) { $drift.Add($field) }
    }
    if ($drift.Count) {
        throw "$Stage changed the reviewed repository snapshot ($($drift -join ', ')); inspect and rerun validation."
    }
}

function Find-Python {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { throw "Python is required for validation policy and offline tests. Install Python and expose 'python' on PATH." }
    return $python.Source
}

function Find-Pnpm {
    $name = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'pnpm.cmd' } else { 'pnpm' }
    $pnpm = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $pnpm) { throw "pnpm is required and '$name' is unavailable on PATH." }
    return $pnpm.Source
}

function Get-ValidationPlan([string]$Python) {
    $arguments = @('-B', $policyScript)
    if ($ChangedPath.Count) {
        foreach ($path in $ChangedPath) { $arguments += @('--path', $path) }
    } else {
        $arguments += @('--base', "$($config.OriginRemote)/$($config.BaseBranch)", '--head', 'HEAD', '--include-working-tree')
    }
    foreach ($filter in @($TestFilter | Where-Object { $_ })) { $arguments += @('--test-filter', $filter) }
    $planOutput = @(& $Python @arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Validation classification failed:`n$($planOutput -join [Environment]::NewLine)" }
    return (($planOutput -join "`n") | ConvertFrom-Json)
}

function Assert-WorkflowInventory {
    $expectedPath = Join-Path $repoRoot 'docs/downstream-workflow-inventory.txt'
    $expected = @(Get-Content -LiteralPath $expectedPath | Where-Object { $_ })
    [string[]]$actual = @(
        Get-ChildItem -LiteralPath (Join-Path $repoRoot '.github/workflows') -File |
            Where-Object { $_.Extension -in @('.yml', '.yaml') } |
            ForEach-Object Name
    )
    [Array]::Sort($actual, [StringComparer]::Ordinal)
    if (($expected -join "`n") -cne ($actual -join "`n")) {
        throw 'Workflow inventory changed; review inherited workflow safety and update the inventory explicitly.'
    }
}

function Invoke-ValidationStage {
    param([int]$Number, [int]$Total, $Stage, $Snapshot)
    Write-Host "[$Number/$Total] $($Stage.Name) [RUN]"
    $logPath = Join-Path $runDirectory $Stage.Log
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    if ($Stage.Action) {
        try {
            $lines = @(& $Stage.Action 2>&1)
            $exitCode = 0
        } catch {
            $lines = @($_.Exception.Message)
            $exitCode = 1
        }
    } else {
        $lines = @(& $Stage.File @($Stage.Args) 2>&1)
        $exitCode = $LASTEXITCODE
    }
    $ErrorActionPreference = $previousErrorAction
    $lines | Set-Content -LiteralPath $logPath -Encoding utf8
    $lines | ForEach-Object { Write-Host $_ }
    try {
        Assert-RepositorySnapshot $Snapshot $Stage.Name
    } catch {
        Write-Host "[$Number/$Total] $($Stage.Name) [FAIL]"
        throw
    }
    if ($exitCode -ne 0) {
        Write-Host "[$Number/$Total] $($Stage.Name) [FAIL]"
        throw "$($Stage.Name) failed with exit code $exitCode. Full log: $logPath"
    }
    Write-Host "[$Number/$Total] $($Stage.Name) [PASS]"
}

try {
    Set-Location -LiteralPath $repoRoot
    foreach ($name in @(
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'SYNC_APP_ID',
        'SYNC_APP_PRIVATE_KEY',
        'SYNC_PUBLISH_TOKEN'
    )) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }

    $python = Find-Python
    $pnpm = Find-Pnpm
    $node = (Get-Command node -ErrorAction Stop).Source
    $validationConfig = Join-Path $runDirectory 'config'
    New-Item -ItemType Directory -Path $validationConfig | Out-Null
    $env:CONFIG_DIRECTORY = $validationConfig
    $plan = Get-ValidationPlan $python
    $selectedTests = @($plan.focusedTests | Where-Object { $_ })
    $effectiveMode = if ($Level -eq 'Full') {
        'full'
    } elseif ($Level -eq 'Fast' -and $plan.validationMode -eq 'full') {
        if ($selectedTests.Count) { 'focused' } else { 'scoped' }
    } else {
        $plan.validationMode
    }

    Write-Host 'Seerr validation'
    Write-Host "Requested level: $Level"
    Write-Host "Required hosted mode: $($plan.validationMode)"
    Write-Host "Selected local path: $effectiveMode"
    Write-Host "Validation risk: $($plan.validationRisk)"
    if ($Level -eq 'Fast' -and $plan.validationMode -eq 'full') {
        Write-Host 'Fast provides bounded local feedback only; authoritative Downstream validation still requires Full.'
    }

    $stages = [Collections.Generic.List[object]]::new()
    $scopedPaths = @($plan.paths | ForEach-Object { $_.path } | Where-Object { Test-Path -LiteralPath (Join-Path $repoRoot $_) })
    $formattedPaths = @($scopedPaths | Where-Object { $_ -match '\.(cjs|css|js|json|md|mdx|mjs|ts|tsx|ya?ml)$' })
    $isFullPath = $Level -eq 'Full' -or ($Level -eq 'Standard' -and $plan.validationMode -eq 'full')
    $offlinePatterns = if ($isFullPath) {
        @('test_*.py')
    } elseif ($Level -eq 'Fast') {
        @($plan.localFastOfflinePatterns | Where-Object { $_ })
    } elseif ($plan.offlineTestPattern) {
        @($plan.offlineTestPattern)
    } else {
        @()
    }
    foreach ($offlinePattern in $offlinePatterns) {
        $multipleOfflinePatterns = $offlinePatterns.Count -gt 1
        $offlineName = if ($multipleOfflinePatterns) { "Offline tooling tests ($offlinePattern)" } else { 'Offline tooling tests' }
        $offlineLog = if ($multipleOfflinePatterns) {
            "offline-tests-$([IO.Path]::GetFileNameWithoutExtension($offlinePattern)).log"
        } else {
            'offline-tests.log'
        }
        $stages.Add([pscustomobject]@{ Name = $offlineName; Log = $offlineLog; File = $python; Args = @('-B', 'scripts/run_offline_tests.py', '--pattern', $offlinePattern); Display = "python -B scripts/run_offline_tests.py --pattern '$offlinePattern'" })
    }

    if (-not $isFullPath -and $formattedPaths.Count) {
        $stages.Add([pscustomobject]@{ Name = 'Changed-scope formatting'; Log = 'format-check.log'; File = $pnpm; Args = @('exec', 'prettier', '--check', '--') + $formattedPaths })
    }
    if (-not $isFullPath -and $effectiveMode -eq 'focused' -and $selectedTests.Count) {
        $stages.Add([pscustomobject]@{ Name = 'Focused tests'; Log = 'focused-tests.log'; File = $pnpm; Args = @('test') + $selectedTests })
    }
    if ($isFullPath) {
        $stages.Add([pscustomobject]@{ Name = 'Install dependencies'; Log = 'install.log'; File = $pnpm; Args = @('install', '--frozen-lockfile') })
        $stages.Add([pscustomobject]@{ Name = 'Internationalization consistency'; Log = 'i18n.log'; File = $node; Args = @('bin/check-i18n.js') })
        $stages.Add([pscustomobject]@{ Name = 'Formatting'; Log = 'format-check.log'; File = $pnpm; Args = @('format:check') })
        $stages.Add([pscustomobject]@{ Name = 'Lint'; Log = 'lint.log'; File = $pnpm; Args = @('lint') })
        $stages.Add([pscustomobject]@{ Name = 'Typecheck'; Log = 'typecheck.log'; File = $pnpm; Args = @('typecheck') })
        $stages.Add([pscustomobject]@{ Name = 'Unit tests'; Log = 'tests.log'; File = $pnpm; Args = @('test') })
        $stages.Add([pscustomobject]@{ Name = 'Build'; Log = 'build.log'; File = $pnpm; Args = @('build') })
        $stages.Add([pscustomobject]@{ Name = 'Workflow inventory'; Log = 'workflow-inventory.log'; Action = { Assert-WorkflowInventory } })
    }
    $stages.Add([pscustomobject]@{ Name = 'Git whitespace check'; Log = 'git-diff-check.log'; File = 'git'; Args = @('diff', '--check') })

    $snapshot = Get-RepositorySnapshot

    for ($index = 0; $index -lt $stages.Count; $index++) {
        $stage = $stages[$index]
        Invoke-ValidationStage ($index + 1) $stages.Count $stage $snapshot
    }
    Write-Host "SUCCESS: $Level validation completed ($effectiveMode)."
    Write-Host "Logs: $runDirectory"
    $global:LASTEXITCODE = 0
} catch {
    Write-Error $_.Exception.Message
    Write-Host "Logs: $runDirectory"
    exit 1
} finally {
    Set-Location -LiteralPath $repoRoot
}
