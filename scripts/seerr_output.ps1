function Format-MaintenanceDuration {
    param([TimeSpan]$Elapsed)
    if ($Elapsed.TotalHours -ge 1) { return $Elapsed.ToString('h\:mm\:ss') }
    if ($Elapsed.TotalMinutes -ge 1) { return ('{0}m{1:00}s' -f [int]$Elapsed.TotalMinutes, $Elapsed.Seconds) }
    return ('{0:0.0}s' -f $Elapsed.TotalSeconds)
}

function Test-MaintenanceTerminalHyperlinks {
    $override = [string]$env:MAINTENANCE_TERMINAL_HYPERLINKS
    if ($override -in @('always', '1', 'true')) { return $true }
    if ($override -in @('never', '0', 'false')) { return $false }
    if ([Console]::IsOutputRedirected) { return $false }
    return [bool](
        $env:WT_SESSION -or
        $env:TERM_PROGRAM -in @('vscode', 'Windows_Terminal', 'WezTerm.app', 'iTerm.app') -or
        ($env:TERM -and $env:TERM -ne 'dumb')
    )
}

function Format-MaintenanceTerminalLink {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$Target,
        [string]$Fallback
    )
    if (Test-MaintenanceTerminalHyperlinks) {
        $escape = [char]27
        $terminator = "$escape\"
        $uri = if ($Target -match '^https?://') {
            $Target
        } else {
            [Uri]::new([IO.Path]::GetFullPath($Target)).AbsoluteUri
        }
        return "$escape]8;;$uri$terminator$Label$escape]8;;$terminator"
    }
    if ($Fallback) {
        $fallbackLabel = $Label.TrimEnd(']')
        return "${fallbackLabel}: $Fallback]"
    }
    return "$Label ($Target)"
}

function Get-MaintenanceConsolePrefix {
    return [string]$env:MAINTENANCE_OUTPUT_PREFIX
}

function New-MaintenanceRunOutput {
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [Parameter(Mandatory)][ValidateSet('validation', 'prepare-pr')][string]$Kind,
        [Parameter(Mandatory)][string]$LegacyLogPath,
        [string]$RunDirectoryRoot
    )
    $runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID
    $runDirectory = if ($RunDirectoryRoot) {
        Join-Path $RunDirectoryRoot $runId
    } else {
        Join-Path $RepositoryRoot ".logs\$Kind\$runId"
    }
    New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
    [pscustomobject]@{
        Kind = $Kind
        RunDirectory = [IO.Path]::GetFullPath($runDirectory)
        SummaryPath = [IO.Path]::GetFullPath((Join-Path $runDirectory 'summary.txt'))
        LegacyLogPath = [IO.Path]::GetFullPath($LegacyLogPath)
        StageLogs = [Collections.Generic.List[string]]::new()
        LegacyLogPublished = $false
        CurrentStageLog = $null
        CurrentStageWriter = $null
        CurrentStageName = $null
        CurrentStageNumber = 0
        TotalStages = 0
        Timer = [Diagnostics.Stopwatch]::StartNew()
        StageTimer = $null
    }
}

function Write-MaintenanceRunLog {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)][string]$Message)
    $line = '{0} {1}' -f [DateTimeOffset]::Now.ToString('o'), $Message
    Add-Content -LiteralPath $Context.SummaryPath -Value $line -Encoding UTF8
    Write-MaintenanceStageLog $Context $Message
}

function Write-MaintenanceStageLog {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Message
    )
    if ($Context.CurrentStageWriter) {
        $Context.CurrentStageWriter.WriteLine($Message)
    }
}

function Close-MaintenanceStageWriter {
    param([Parameter(Mandatory)]$Context)
    if ($Context.CurrentStageWriter) {
        $Context.CurrentStageWriter.Dispose()
        $Context.CurrentStageWriter = $null
    }
}

function Publish-MaintenanceLegacyLog {
    param([Parameter(Mandatory)]$Context)
    if ($Context.LegacyLogPublished) { return $true }

    $snapshotPath = Join-Path $Context.RunDirectory 'compatibility.log'
    try {
        $lines = [Collections.Generic.List[string]]::new()
        $lines.Add("Maintenance $($Context.Kind) compatibility log - $(Get-Date -Format o)")
        $lines.Add('')
        $lines.Add('=== Run summary ===')
        if (Test-Path -LiteralPath $Context.SummaryPath) {
            foreach ($line in Get-Content -LiteralPath $Context.SummaryPath) { $lines.Add([string]$line) }
        }
        foreach ($stageLog in $Context.StageLogs) {
            $lines.Add('')
            $lines.Add("=== Stage log: $([IO.Path]::GetFileName($stageLog)) ===")
            if (Test-Path -LiteralPath $stageLog) {
                foreach ($line in Get-Content -LiteralPath $stageLog) { $lines.Add([string]$line) }
            }
        }

        [IO.File]::WriteAllLines($snapshotPath, $lines, [Text.UTF8Encoding]::new($false))
        [IO.File]::Copy($snapshotPath, $Context.LegacyLogPath, $true)
        $Context.LegacyLogPublished = $true
        return $true
    } catch {
        $message = "Compatibility log could not be refreshed: $($_.Exception.Message)"
        Add-Content -LiteralPath $Context.SummaryPath -Value ('{0} {1}' -f [DateTimeOffset]::Now.ToString('o'), $message) -Encoding UTF8 -ErrorAction SilentlyContinue
        Write-Warning "$message Complete logs remain available at $($Context.RunDirectory)."
        return $false
    }
}

function Start-MaintenanceStage {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][int]$Number,
        [Parameter(Mandatory)][int]$Total,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$LogName
    )
    $Context.CurrentStageNumber = $Number
    $Context.TotalStages = $Total
    $Context.CurrentStageName = $Name
    $Context.CurrentStageLog = [IO.Path]::GetFullPath((Join-Path $Context.RunDirectory $LogName))
    $Context.StageLogs.Add($Context.CurrentStageLog)
    $Context.StageTimer = [Diagnostics.Stopwatch]::StartNew()
    $stream = [IO.File]::Open($Context.CurrentStageLog, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $Context.CurrentStageWriter = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
    $Context.CurrentStageWriter.AutoFlush = $true
    Write-MaintenanceStageLog $Context "Stage: $Name"
    Write-MaintenanceStageLog $Context "Started: $(Get-Date -Format o)"
    $link = Format-MaintenanceTerminalLink '[log]' $Context.CurrentStageLog ([IO.Path]::GetFileName($Context.CurrentStageLog))
    if ($env:MAINTENANCE_OUTPUT_COMPACT -eq '1') {
        Write-Host ((Get-MaintenanceConsolePrefix) + ('[{0}/{1}] {2} [RUN]  {3}' -f $Number, $Total, $Name, $link))
    } else {
        Write-Host ((Get-MaintenanceConsolePrefix) + ('[{0}/{1}] {2} [RUN]  {3}' -f $Number, $Total, $Name, $link))
    }
    Write-MaintenanceRunLog $Context "Stage started: $Name; Log=$($Context.CurrentStageLog)"
}

function Complete-MaintenanceStage {
    param([Parameter(Mandatory)]$Context)
    $Context.StageTimer.Stop()
    $duration = Format-MaintenanceDuration $Context.StageTimer.Elapsed
    Write-MaintenanceRunLog $Context "Stage passed: $($Context.CurrentStageName); Duration=$duration"
    Close-MaintenanceStageWriter $Context
    if ($env:MAINTENANCE_OUTPUT_COMPACT -eq '1') {
        Write-Host ((Get-MaintenanceConsolePrefix) + ('[{0}/{1}] {2} [PASS] {3}' -f $Context.CurrentStageNumber, $Context.TotalStages, $Context.CurrentStageName, $duration))
    } else {
        Write-Host ('[{0}/{1}] {2} [PASS] {3} -> {4}' -f $Context.CurrentStageNumber, $Context.TotalStages, $Context.CurrentStageName, $duration, $Context.CurrentStageLog)
    }
    $Context.CurrentStageLog = $null
    $Context.CurrentStageName = $null
}

function Get-MaintenanceErrorExcerpt {
    param([Parameter(Mandatory)][string]$LogPath, [int]$MaximumLines = 16)
    if (-not (Test-Path -LiteralPath $LogPath)) { return @() }
    $lines = @(Get-Content -LiteralPath $LogPath)
    $matches = @($lines | Where-Object {
        $_ -match '(?i)(^|\s)(error|exception|failed|failure|fatal)(:|\s)' -or
        $_ -match '(^|\s)e:\s+.+:\d+(?::\d+)?'
    })
    if ($matches.Count) { return @($matches | Select-Object -Last $MaximumLines) }
    return @($lines | Select-Object -Last $MaximumLines)
}

function Fail-MaintenanceStage {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)][string]$Reason)
    if ($Context.StageTimer) { $Context.StageTimer.Stop() }
    $duration = if ($Context.StageTimer) { Format-MaintenanceDuration $Context.StageTimer.Elapsed } else { '0.0s' }
    $logPath = $Context.CurrentStageLog
    Write-MaintenanceRunLog $Context "Stage failed: $($Context.CurrentStageName); Duration=$duration; Reason=$Reason"
    Close-MaintenanceStageWriter $Context
    $prefix = Get-MaintenanceConsolePrefix
    Write-Host ($prefix + ('[{0}/{1}] {2} [FAIL] {3}' -f $Context.CurrentStageNumber, $Context.TotalStages, $Context.CurrentStageName, $duration)) -ForegroundColor Red
    Write-Host ''
    Write-Host "FAILED: $($Context.CurrentStageName)" -ForegroundColor Red
    Write-Host $Reason
    if ($logPath) {
        Write-Host ''
        Write-Host 'Relevant output:'
        Get-MaintenanceErrorExcerpt $logPath | ForEach-Object { Write-Host "  $_" }
        Write-Host ''
        Write-Host "Full log: $logPath"
    }
}

function Complete-MaintenanceRun {
    param([Parameter(Mandatory)]$Context, [Parameter(Mandatory)][string]$Message)
    $Context.Timer.Stop()
    $duration = Format-MaintenanceDuration $Context.Timer.Elapsed
    Write-MaintenanceRunLog $Context "$Message; Total=$duration"
    if ($env:MAINTENANCE_OUTPUT_COMPACT -ne '1') {
        Write-Host ''
        Write-Host $Message
        Write-Host "Total: $duration"
        Write-Host "Logs: $($Context.RunDirectory)"
    }
}

function Invoke-MaintenanceLoggedCommand {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$DisplayCommand,
        [switch]$EchoOutput
    )
    Write-MaintenanceRunLog $Context "Command: $DisplayCommand"
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            $line = [string]$_
            Write-MaintenanceStageLog $Context $line
            if ($EchoOutput) { Write-Host $line }
        }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
}
