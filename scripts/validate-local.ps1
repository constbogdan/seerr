[CmdletBinding()]
param(
    [ValidateSet('Fast', 'Standard', 'Full')]
    [string]$Level = 'Fast',
    [string[]]$TestFilter = @(),
    [string[]]$ChangedPath = @()
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$legacyLogPath = Join-Path $repoRoot 'validation.log'
$gradleWrapper = Join-Path $repoRoot 'gradlew.bat'
$policyScript = Join-Path $PSScriptRoot 'mosaic_validation_policy.py'
. (Join-Path $PSScriptRoot 'mosaic_output.ps1')

$output = New-MosaicRunOutput -RepositoryRoot $repoRoot -Kind validation -LegacyLogPath $legacyLogPath
Write-MosaicRunLog $output "Mosaic local validation ($Level)"

function Find-Python {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { throw "Python is required for validation policy and offline tests. Install Python and expose 'python' on PATH." }
    return $python.Source
}

function Initialize-JavaEnvironment {
    if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
        Write-MosaicRunLog $output "JAVA_HOME=$env:JAVA_HOME"
    } elseif (-not (Get-Command java.exe -ErrorAction SilentlyContinue)) {
        $androidStudioJbr = Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'
        if (-not (Test-Path -LiteralPath (Join-Path $androidStudioJbr 'bin\java.exe'))) {
            throw 'No Java runtime found. Set JAVA_HOME or install Android Studio with its bundled JBR.'
        }
        $env:JAVA_HOME = $androidStudioJbr
        Write-MosaicRunLog $output "JAVA_HOME discovered: $env:JAVA_HOME"
    }
    if ($env:JAVA_HOME) {
        $javaBin = Join-Path $env:JAVA_HOME 'bin'
        $normalizedJavaBin = $javaBin.TrimEnd('\')
        $pathEntries = @($env:PATH -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') })
        if ($normalizedJavaBin -notin $pathEntries) {
            $env:PATH = if ($env:PATH) { "$javaBin;$env:PATH" } else { $javaBin }
            Write-MosaicRunLog $output "Added Java to validation process PATH: $javaBin"
        }
    }
    $java = Get-Command java.exe -ErrorAction SilentlyContinue
    if (-not $java) { throw 'JAVA_HOME was resolved, but java.exe is still unavailable on the validation process PATH.' }
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $java.Source -version 2>&1 | Out-Null
    $javaExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorAction
    if ($javaExitCode -ne 0) { throw "java.exe could not execute (exit $javaExitCode)." }
    if (-not $env:GRADLE_USER_HOME) {
        if (-not $env:USERPROFILE) { throw 'USERPROFILE is unavailable. Set GRADLE_USER_HOME explicitly.' }
        $env:GRADLE_USER_HOME = Join-Path $env:USERPROFILE '.gradle'
    }
    Write-MosaicRunLog $output "java.exe=$($java.Source); GRADLE_USER_HOME=$env:GRADLE_USER_HOME"
}

function Get-ValidationPlan([string]$Python) {
    $arguments = @('-B', $policyScript)
    if ($ChangedPath.Count) {
        foreach ($path in $ChangedPath) { $arguments += @('--path', $path) }
    } else {
        $arguments += @('--base', 'origin/main', '--head', 'HEAD', '--include-working-tree')
    }
    foreach ($filter in @($TestFilter | Where-Object { $_ })) { $arguments += @('--test-filter', $filter) }
    $planOutput = @(& $Python @arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Validation classification failed:`n$($planOutput -join [Environment]::NewLine)" }
    return (($planOutput -join "`n") | ConvertFrom-Json)
}

function Find-PreCommit([string]$Python) {
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $Python -m pre_commit --version 2>&1 | Out-Null
    $available = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $previousErrorAction
    if ($available) { return [pscustomobject]@{ File = $Python; Prefix = @('-m', 'pre_commit'); Display = 'python -m pre_commit' } }
    throw "pre-commit is required. Install it once with 'python -m pip install pre-commit'; validation never installs global tooling."
}

function Invoke-StageCommand {
    param([int]$Number, [int]$Total, [string]$Name, [string]$LogName, [string]$File, [string[]]$Arguments, [string]$Display)
    Start-MosaicStage $output $Number $Total $Name $LogName
    $exitCode = Invoke-MosaicLoggedCommand $output $File $Arguments $Display
    if ($exitCode -ne 0) {
        if ($Name -like '*pre-commit*') {
            Write-MosaicStageLog $output 'Autofix hooks may have modified files. Inspect the working tree before rerunning validation.'
        }
        Fail-MosaicStage $output "Command exited with code $exitCode."
        $output.CurrentStageName = $null
        throw "$Name failed with exit code $exitCode."
    }
    Complete-MosaicStage $output
}

try {
    Set-Location -LiteralPath $repoRoot
    $python = Find-Python
    $plan = Get-ValidationPlan $python
    $effectiveMode = if ($Level -eq 'Full') {
        'full'
    } elseif ($Level -eq 'Fast' -and $TestFilter.Count) {
        'targeted-android'
    } elseif ($Level -eq 'Fast' -and $plan.validationMode -eq 'full') {
        'non-android'
    } else {
        $plan.validationMode
    }
    $selectedTests = if ($Level -eq 'Fast' -and $TestFilter.Count) {
        @($TestFilter)
    } else {
        @($plan.focusedTests)
    }
    if ($env:MOSAIC_OUTPUT_COMPACT -eq '1') {
        Write-Host ((Get-MosaicConsolePrefix) + "Validation: $Level $([char]0xB7) $effectiveMode")
    } else {
        Write-Host 'Mosaic validation'
        Write-Host "Requested level: $Level"
        Write-Host "Release relevance: $($plan.releaseRelevance)"
        Write-Host "Validation risk: $($plan.validationRisk)"
        Write-Host "Selected path: $effectiveMode"
        if ($effectiveMode -eq 'full' -and $Level -ne 'Full') { Write-Host "$Level escalated to Full: $($plan.reason)" }
        if ($Level -eq 'Fast' -and $plan.validationMode -eq 'full') { Write-Host 'Fast provides local feedback only; authoritative PR CI will run the required Full policy.' }
    }
    Write-MosaicRunLog $output "RequestedLevel=$Level; EffectiveMode=$effectiveMode; ReleaseRelevance=$($plan.releaseRelevance); ValidationRisk=$($plan.validationRisk); ChangedPaths=$(@($plan.paths).Count); Filters=$($selectedTests -join ',')"

    $stages = [Collections.Generic.List[object]]::new()
    $scopedPaths = @($plan.paths | ForEach-Object { $_.path } | Where-Object { Test-Path -LiteralPath (Join-Path $repoRoot $_) })
    $reviewedUntrackedPaths = @($plan.reviewedUntrackedPaths | Where-Object { Test-Path -LiteralPath (Join-Path $repoRoot $_) })
    $isFullPath = $effectiveMode -eq 'full'
    if ($isFullPath) {
        $preCommit = Find-PreCommit $python
        $stages.Add([pscustomobject]@{ Name = 'Repository-wide pre-commit'; Log = 'pre-commit.log'; File = $preCommit.File; Args = @($preCommit.Prefix + @('run', '--all-files')); Display = "$($preCommit.Display) run --all-files" })
        if ($reviewedUntrackedPaths.Count) {
            $stages.Add([pscustomobject]@{ Name = 'Reviewed untracked pre-commit'; Log = 'pre-commit-untracked.log'; File = $preCommit.File; Args = @($preCommit.Prefix + @('run', '--files') + $reviewedUntrackedPaths); Display = "$($preCommit.Display) run --files <reviewed untracked paths>" })
        }
    } else {
        $preCommit = Find-PreCommit $python
        $preCommitArguments = @($preCommit.Prefix + @('run'))
        $preCommitDisplay = "$($preCommit.Display) run"
        if ($scopedPaths.Count) {
            $preCommitArguments += @('--files') + $scopedPaths
            $preCommitDisplay += ' --files <changed paths>'
        } else {
            $preCommitArguments += '--all-files'
            $preCommitDisplay += ' --all-files'
        }
        $stages.Add([pscustomobject]@{ Name = 'Changed-scope pre-commit'; Log = 'pre-commit.log'; File = $preCommit.File; Args = $preCommitArguments; Display = $preCommitDisplay })
    }
    $offlinePatterns = if ($isFullPath) {
        @('test_*.py')
    } elseif ($Level -eq 'Fast') {
        @($plan.localFastOfflinePatterns | Where-Object { $_ })
    } elseif ($plan.offlineTestPattern) {
        @($plan.offlineTestPattern)
    } else {
        @()
    }
    $deferredOfflineToPr = (
        $Level -eq 'Fast' -and
        $plan.offlineTestPattern -and
        ($plan.offlineTestPattern -eq 'test_*.py' -or $plan.offlineTestPattern -notin $offlinePatterns)
    )
    if ($deferredOfflineToPr) {
        if ($env:MOSAIC_OUTPUT_COMPACT -ne '1') { Write-Host 'Fast deferred heavyweight or complete offline tooling to authoritative PR CI.' }
        Write-MosaicRunLog $output 'Heavyweight or complete offline tooling deferred to authoritative PR CI.'
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
    if ($effectiveMode -eq 'targeted-android') {
        Initialize-JavaEnvironment
        $gradleArgs = @()
        if ($Level -eq 'Standard') { $gradleArgs += ':app:compileDefaultDebugKotlin' }
        $gradleArgs += ':app:testDefaultDebugUnitTest'
        foreach ($filter in $selectedTests) { $gradleArgs += @('--tests', $filter) }
        $name = if ($Level -eq 'Fast') { 'Focused JVM tests' } else { 'Kotlin compile + focused JVM tests' }
        $stages.Add([pscustomobject]@{ Name = $name; Log = 'focused-android.log'; File = $gradleWrapper; Args = $gradleArgs; Display = '.\gradlew ' + ($gradleArgs -join ' ') })
    } elseif ($effectiveMode -eq 'full') {
        Initialize-JavaEnvironment
        $gradleArgs = @(':app:compileDefaultDebugKotlin', ':app:testDefaultDebugUnitTest', ':app:assembleDefaultDebug')
        $stages.Add([pscustomobject]@{ Name = 'Full default-debug validation'; Log = 'full-android.log'; File = $gradleWrapper; Args = $gradleArgs; Display = '.\gradlew ' + ($gradleArgs -join ' ') })
    }
    $stages.Add([pscustomobject]@{ Name = 'Git whitespace check'; Log = 'git-diff-check.log'; File = 'git'; Args = @('diff', '--check'); Display = 'git diff --check' })

    for ($index = 0; $index -lt $stages.Count; $index++) {
        $stage = $stages[$index]
        Invoke-StageCommand ($index + 1) $stages.Count $stage.Name $stage.Log $stage.File $stage.Args $stage.Display
    }
    Complete-MosaicRun $output "SUCCESS: $Level validation completed ($effectiveMode)."
    $global:LASTEXITCODE = 0
} catch {
    if ($output.CurrentStageName) { Fail-MosaicStage $output $_.Exception.Message }
    if ($output.Timer.IsRunning) { $output.Timer.Stop() }
    Write-MosaicRunLog $output "Validation failed: $($_.Exception.Message)"
    Write-Host "Logs: $($output.RunDirectory)"
    exit 1
} finally {
    Set-Location -LiteralPath $repoRoot
    if (Publish-MosaicLegacyLog $output) {
        if ($env:MOSAIC_OUTPUT_COMPACT -ne '1') { Write-Host "Compatibility log: $legacyLogPath" }
    }
}
