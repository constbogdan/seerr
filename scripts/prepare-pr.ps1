[CmdletBinding()]
param(
    [ValidateSet('Guided', 'Audit', 'Validate', 'Stage', 'Commit', 'Publish')]
    [string]$Phase = 'Guided',
    [string[]]$Files = @(),
    [string[]]$Exclude = @(),
    [ValidateSet('Fast', 'Full')]
    [string]$Level = 'Fast',
    [string[]]$TestFilter = @(),
    [string]$Title,
    [switch]$ConfirmScope,
    [switch]$ConfirmCommit,
    [switch]$ConfirmPublish,
    [switch]$NoFetch,
    [switch]$NonInteractive,
    [switch]$PreserveMergeCommit,
    [switch]$PreserveReconciledUpstreamMerge,
    [string]$ExpectedRemoteDraftHead,
    [string]$ExpectedOriginalCandidate,
    [string]$ExpectedCurrentMain,
    [string]$ExpectedReconciliationCommit,
    [string]$ExpectedMergeFirstParent,
    [string]$ExpectedMergeSecondParent,
    [string]$ExpectedMergeTree
)

if ($PreserveMergeCommit -and $PreserveReconciledUpstreamMerge) {
    throw 'Choose exactly one upstream merge-preservation mode.'
}
$preserveUpstreamCommit = $PreserveMergeCommit -or $PreserveReconciledUpstreamMerge

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $PSScriptRoot 'prepare-pr.config.psd1'
$config = Import-PowerShellDataFile -LiteralPath $configPath
. (Join-Path $PSScriptRoot 'mosaic_output.ps1')
$startingLocation = Get-Location
$runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID
$runRelativeDirectory = ".logs\prepare-pr\$runId"
$runDirectory = [IO.Path]::GetFullPath((Join-Path $repoRoot $runRelativeDirectory))
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$logPath = Join-Path $runDirectory 'prepare-pr.log'
$summaryPath = Join-Path $runDirectory 'summary.txt'
$logStream = [IO.FileStream]::new($logPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$logWriter = [IO.StreamWriter]::new($logStream, [Text.UTF8Encoding]::new($false))
$logWriter.AutoFlush = $true

function Write-PrepareLog([string]$Message) {
    $safeMessage = $Message -replace '(?i)(https?://)[^/@\s]+@', '$1[credentials-redacted]@'
    $line = "{0} {1}" -f [DateTimeOffset]::Now.ToString('o'), $safeMessage
    $logWriter.WriteLine($line)
    Add-Content -LiteralPath $summaryPath -Value $line -Encoding UTF8
    if ($script:stageLogPath) { Add-Content -LiteralPath $script:stageLogPath -Value $line -Encoding UTF8 }
}

Write-PrepareLog "Invocation started. Phase=$Phase RequestedLevel=$Level"
$script:conciseMode = $Phase -eq 'Guided'
$script:stageNumber = 0
$script:stageLogPath = $null
$script:stageTimer = $null
$script:prepareFailed = $false
$script:runTimer = [Diagnostics.Stopwatch]::StartNew()
$script:validationPlan = $null
$script:publishedPullRequest = $null
$script:totalStages = switch ($Phase) {
    'Guided' { 6 }
    'Audit' { 2 }
    'Validate' { if ($Files.Count) { 3 } else { 2 } }
    default { 2 }
}

function Complete-PrepareStage([string]$Status = 'PASS') {
    if (-not $script:stageLogPath) { return }
    $script:stageTimer.Stop()
    $elapsed = if ($script:stageTimer.Elapsed.TotalMinutes -ge 1) {
        '{0}m{1:00}s' -f [int]$script:stageTimer.Elapsed.TotalMinutes, $script:stageTimer.Elapsed.Seconds
    } else { '{0:0.0}s' -f $script:stageTimer.Elapsed.TotalSeconds }
    Write-PrepareLog "Phase $Status`: $($script:stageName); Duration=$elapsed; Log=$($script:stageLogPath)"
    Write-Host ('[{0}/{1}] {2} [{3}] {4}' -f $script:stageNumber, $script:totalStages, $script:stageName, $Status, $elapsed)
    if ($script:conciseMode) { Write-Host '' }
    $script:stageLogPath = $null
}

function Write-Section([string]$Name) {
    Complete-PrepareStage
    $script:stageNumber++
    $script:stageName = $Name
    $safeName = ($Name.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
    $script:stageLogPath = [IO.Path]::GetFullPath((Join-Path $runDirectory ("{0:00}-{1}.log" -f $script:stageNumber, $safeName)))
    $script:stageTimer = [Diagnostics.Stopwatch]::StartNew()
    Set-Content -LiteralPath $script:stageLogPath -Value "Stage: $Name`nStarted: $(Get-Date -Format o)" -Encoding UTF8
    $logLink = Format-MosaicTerminalLink '[log]' $script:stageLogPath ([IO.Path]::GetFileName($script:stageLogPath))
    Write-Host ('[{0}/{1}] {2} [RUN]  {3}' -f $script:stageNumber, $script:totalStages, $Name, $logLink)
    Write-PrepareLog "Phase started: $Name"
}

function Write-AuditDetail([string]$Name) {
    if (-not $script:conciseMode) {
        Write-Host ''
        Write-Host "--- $Name ---" -ForegroundColor Cyan
    }
    Write-PrepareLog "Audit detail: $Name"
}

function Get-PrepareValidationPlan([string[]]$Paths) {
    $fallback = [pscustomobject]@{
        releaseRelevance = 'unknown'
        releaseRequired = $true
        validationRisk = 'high'
        validationMode = 'full'
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    $policyScript = Join-Path $PSScriptRoot 'mosaic_validation_policy.py'
    if (-not $python -or -not (Test-Path -LiteralPath $policyScript -PathType Leaf)) {
        Write-PrepareLog 'Validation-path presentation fell back conservatively because Python or the existing policy script was unavailable.'
        return $fallback
    }
    $arguments = @('-B', $policyScript)
    foreach ($path in @($Paths)) { $arguments += @('--path', $path) }
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $python.Source @arguments 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        Write-PrepareLog "Validation-path presentation fell back conservatively because the existing policy exited $exitCode."
        return $fallback
    }
    try {
        $plan = ($output -join "`n") | ConvertFrom-Json
        Write-PrepareLog "Presentation policy: ReleaseRelevance=$($plan.releaseRelevance) ValidationRisk=$($plan.validationRisk) ValidationMode=$($plan.validationMode)"
        return $plan
    } catch {
        Write-PrepareLog 'Validation-path presentation fell back conservatively because the existing policy returned invalid JSON.'
        return $fallback
    }
}

function Get-ExpectedHostedPath([object]$Plan) {
    if ($Plan.releaseRelevance -eq 'unknown') { return 'Conservative Android Full authoritative validation' }
    if ($Plan.validationMode -eq 'non-android') { return 'Non-Android authoritative validation' }
    return 'Android Full authoritative validation'
}

function Invoke-Git {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [switch]$AllowFailure
    )
    $stderrPath = [IO.Path]::GetTempFileName()
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $rawOutput = @(& git -c core.quotepath=false @Arguments 2> $stderrPath)
        $exitCode = $LASTEXITCODE
        $errorOutput = if ((Get-Item -LiteralPath $stderrPath).Length) {
            $captured = @(Get-Content -LiteralPath $stderrPath)
            $nativeLines = @()
            foreach ($line in $captured) {
                if ($line -match '^At .+:\d+ char:\d+$') { break }
                if ($line -match '^\s*\+ ' -or $line -match '^\s*\+ CategoryInfo' -or $line -match '^\s*\+ FullyQualifiedErrorId') { continue }
                $nativeLines += ($line -replace '^git(?:\.exe)?\s*:\s*', '')
            }
            @($nativeLines)
        } else { @() }
    } finally {
        $ErrorActionPreference = $previousErrorAction
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
    $output = @($rawOutput | ForEach-Object { $_.ToString() })
    Write-PrepareLog "Git command: git $($Arguments -join ' ') (exit $exitCode)"
    @($output + $errorOutput) | Where-Object { $_ } | ForEach-Object { Write-PrepareLog "Git output: $_" }
    if ($exitCode -ne 0) {
        $details = @($output + $errorOutput) -join [Environment]::NewLine
        Write-PrepareLog "Git command failed (exit $exitCode): git $($Arguments -join ' ')"
        if ($details) { Write-PrepareLog "Git diagnostics: $details" }
    }
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') failed (exit $exitCode):`n$details"
    }
    return [pscustomobject]@{ Output = $output; ErrorOutput = @($errorOutput); ExitCode = $exitCode }
}

function Get-GitText([string[]]$Arguments) {
    return ((Invoke-Git -Arguments $Arguments).Output -join "`n").Trim()
}

function Normalize-Path([string]$Path) {
    $value = $Path.Trim().Replace('\', '/')
    while ($value.StartsWith('./')) { $value = $value.Substring(2) }
    if (-not $value -or [IO.Path]::IsPathRooted($value) -or $value -match '(^|/)\.\.(/|$)') {
        throw "Path must be a repository-relative path: '$Path'."
    }
    return $value
}

function Get-ChangedEntries {
    $lines = (Invoke-Git -Arguments @('status', '--short', '--untracked-files=all')).Output
    $entries = @()
    foreach ($line in $lines) {
        if (-not $line -or $line.Length -lt 4) { continue }
        $code = $line.Substring(0, 2)
        $pathText = $line.Substring(3).Trim()
        $paths = if ($pathText -match ' -> ') { @($pathText -split ' -> ', 2) } else { @($pathText) }
        foreach ($path in $paths) {
            $entries += [pscustomobject]@{
                Code = $code
                Path = Normalize-Path $path.Trim('"')
                Staged = $code -ne '??' -and $code[0] -ne ' '
                Unstaged = $code -eq '??' -or $code[1] -ne ' '
                Untracked = $code -eq '??'
            }
        }
    }
    return @($entries)
}

function Get-RepositorySlug([string]$Url) {
    $normalized = $Url.Trim() -replace '\.git$', ''
    if ($normalized -match 'github\.com[:/](?<slug>[^/]+/[^/]+)$') { return $Matches.slug }
    return $null
}

function Invoke-Gh {
    param(
        [Parameter(Mandatory)]
        [string]$CommandPath,
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [switch]$AllowFailure
    )
    $stderrPath = [IO.Path]::GetTempFileName()
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $rawOutput = @(& $CommandPath @Arguments 2> $stderrPath)
        $exitCode = $LASTEXITCODE
        $errorOutput = if ((Get-Item -LiteralPath $stderrPath).Length) {
            $captured = @(Get-Content -LiteralPath $stderrPath)
            $nativeLines = @()
            foreach ($line in $captured) {
                if ($line -match '^At .+:\d+ char:\d+$') { break }
                if ($line -match '^\s*\+ ' -or $line -match '^\s*\+ CategoryInfo' -or $line -match '^\s*\+ FullyQualifiedErrorId') { continue }
                $nativeLines += ($line -replace '^gh(?:\.exe)?\s*:\s*', '')
            }
            @($nativeLines)
        } else { @() }
    } finally {
        $ErrorActionPreference = $previousErrorAction
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
    $output = @($rawOutput | ForEach-Object { $_.ToString() })
    $diagnostics = @($output + $errorOutput)
    Write-PrepareLog "GitHub CLI command: gh $($Arguments -join ' ') (exit $exitCode)"
    if ($exitCode -ne 0) {
        $details = ($diagnostics -join [Environment]::NewLine).Trim()
        Write-PrepareLog "GitHub CLI command failed (exit $exitCode): gh $($Arguments -join ' ')"
        if ($details) { Write-PrepareLog "GitHub CLI diagnostics: $details" }
        if (-not $AllowFailure) {
            throw "gh $($Arguments -join ' ') failed (exit $exitCode):`n$details"
        }
    }
    return [pscustomobject]@{ Output = $diagnostics; ExitCode = $exitCode }
}

function ConvertFrom-GhJson([object]$Result, [string]$Description) {
    $value = ($Result.Output -join "`n").Trim()
    if (-not $value) { throw "GitHub CLI returned no $Description data." }
    try {
        return $value | ConvertFrom-Json
    } catch {
        throw "GitHub CLI returned invalid $Description JSON."
    }
}

function Get-PullRequestHeadRepository([object]$PullRequest) {
    if ($PullRequest.headRepository -and $PullRequest.headRepository.nameWithOwner) {
        return $PullRequest.headRepository.nameWithOwner
    }
    if ($PullRequest.headRepositoryOwner -and $PullRequest.headRepositoryOwner.login -and $PullRequest.headRepository.name) {
        return "$($PullRequest.headRepositoryOwner.login)/$($PullRequest.headRepository.name)"
    }
    return $null
}

function Get-AuthenticatedPullRequest(
    [string]$GhPath,
    [string]$Repository,
    [object]$Summary,
    [string]$ExpectedBranch,
    [string]$ExpectedHead
) {
    $view = Invoke-Gh -CommandPath $GhPath -Arguments @(
        'pr', 'view', [string]$Summary.number,
        '--repo', $Repository,
        '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,autoMergeRequest,mergedAt'
    )
    $pullRequest = ConvertFrom-GhJson $view 'pull-request'
    if ($pullRequest.number -ne $Summary.number -or $pullRequest.url -ne $Summary.url) {
        throw 'GitHub returned a different PR identity than the unique published candidate.'
    }
    $headRepository = Get-PullRequestHeadRepository $pullRequest
    if (-not $headRepository -or $headRepository -ine $Repository) {
        throw "PR head repository '$headRepository' does not match expected repository '$Repository'."
    }
    if ($pullRequest.baseRefName -cne $config.BaseBranch) {
        throw "PR base '$($pullRequest.baseRefName)' does not match expected '$($config.BaseBranch)'."
    }
    if ($pullRequest.headRefName -cne $ExpectedBranch) {
        throw "PR head branch '$($pullRequest.headRefName)' does not match expected '$ExpectedBranch'."
    }
    if ($pullRequest.headRefOid -cne $ExpectedHead) {
        throw "PR head '$($pullRequest.headRefOid)' does not match reviewed published HEAD '$ExpectedHead'."
    }
    if ($pullRequest.state -cne 'OPEN' -or $pullRequest.mergedAt) {
        throw "PR is not an open unmerged candidate (state=$($pullRequest.state))."
    }
    Write-PrepareLog "Authenticated PR #$($pullRequest.number). Repository=$Repository Base=$($pullRequest.baseRefName) Head=$($pullRequest.headRefName) HeadOid=$($pullRequest.headRefOid) Draft=$($pullRequest.isDraft)"
    return $pullRequest
}

function Enable-NativeAutoMerge(
    [string]$GhPath,
    [string]$Repository,
    [object]$Summary,
    [string]$ExpectedBranch,
    [string]$ExpectedHead
) {
    $pullRequest = Get-AuthenticatedPullRequest $GhPath $Repository $Summary $ExpectedBranch $ExpectedHead
    if ($pullRequest.isDraft) { throw 'PR is Draft; native auto-merge was not enabled.' }

    $method = [string]$config.AutoMergeMethod
    if ($method -cne 'merge') { throw "Unsupported prepare-pr auto-merge method '$method'." }
    $expectedMethod = $method.ToUpperInvariant()
    if ($pullRequest.autoMergeRequest) {
        if ($pullRequest.autoMergeRequest.mergeMethod -cne $expectedMethod) {
            throw "PR auto-merge is already configured with unexpected method '$($pullRequest.autoMergeRequest.mergeMethod)'."
        }
        if (-not $script:conciseMode) { Write-Host 'Auto-merge: already enabled for the exact reviewed head.' }
        Write-PrepareLog "Native auto-merge already enabled. PR=$($pullRequest.number) Head=$ExpectedHead Method=$expectedMethod"
        return 'already enabled'
    }

    $settingsResult = Invoke-Gh -CommandPath $GhPath -Arguments @('api', "repos/$Repository")
    $settings = ConvertFrom-GhJson $settingsResult 'repository-settings'
    if ($settings.full_name -ine $Repository) { throw 'GitHub returned settings for an unexpected repository.' }
    if (-not $settings.allow_merge_commit) {
        throw "Repository merge commits are disabled; '$method' cannot preserve the required exact-tree merge shape."
    }
    if (-not $settings.allow_auto_merge) {
        throw "Repository setting 'Allow auto-merge' is disabled. Enable it manually, then resume with '.\scripts\prepare-pr.ps1 -Phase Publish'. The PR remains open and unmerged."
    }

    # Re-read immediately before mutation. --match-head-commit supplies the atomic head guard.
    $pullRequest = Get-AuthenticatedPullRequest $GhPath $Repository $Summary $ExpectedBranch $ExpectedHead
    if ($pullRequest.isDraft) { throw 'PR became Draft before auto-merge; no merge authority was granted.' }
    if ($pullRequest.autoMergeRequest) {
        if ($pullRequest.autoMergeRequest.mergeMethod -cne $expectedMethod) {
            throw "PR auto-merge is already configured with unexpected method '$($pullRequest.autoMergeRequest.mergeMethod)'."
        }
        if (-not $script:conciseMode) { Write-Host 'Auto-merge: already enabled for the exact reviewed head.' }
        Write-PrepareLog "Native auto-merge became enabled before mutation. PR=$($pullRequest.number) Head=$ExpectedHead Method=$expectedMethod"
        return 'already enabled'
    }

    $merge = Invoke-Gh -CommandPath $GhPath -Arguments @(
        'pr', 'merge', [string]$pullRequest.number,
        '--repo', $Repository,
        '--auto', '--merge', '--match-head-commit', $ExpectedHead
    ) -AllowFailure
    if ($merge.ExitCode -ne 0) {
        $details = ($merge.Output -join [Environment]::NewLine).Trim()
        throw "GitHub could not enable native auto-merge for the exact reviewed head. The PR remains open; no direct merge or bypass was attempted.`n$details"
    }
    if (-not $script:conciseMode) { Write-Host 'Auto-merge: ENABLED' }
    Write-PrepareLog "Native auto-merge enabled. PR=$($pullRequest.number) Head=$ExpectedHead Method=$expectedMethod"
    return 'enabled'
}

function Get-OperationStates {
    $names = @('MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG')
    $active = @()
    foreach ($name in $names) {
        $path = Get-GitText @('rev-parse', '--git-path', $name)
        if (Test-Path -LiteralPath $path) { $active += $name }
    }
    return $active
}

function Assert-Preflight([switch]$RefreshBase) {
    Write-Section 'PREFLIGHT'
    $topLevel = Get-GitText @('rev-parse', '--show-toplevel')
    if ([IO.Path]::GetFullPath($topLevel) -ne [IO.Path]::GetFullPath($repoRoot)) {
        throw "Expected repository root '$repoRoot', but Git reported '$topLevel'."
    }
    $branch = Get-GitText @('branch', '--show-current')
    if (-not $branch) { throw 'Detached HEAD is not supported.' }
    if ($branch -eq $config.BaseBranch) { throw "Refusing to prepare or publish protected '$($config.BaseBranch)'." }
    $operations = @(Get-OperationStates)
    if ($operations.Count) { throw "An active Git operation must be completed or aborted manually first: $($operations -join ', ')." }
    $unmerged = Get-GitText @('diff', '--name-only', '--diff-filter=U')
    if ($unmerged) { throw "Unmerged paths remain:`n$unmerged" }

    foreach ($remoteName in @($config.OriginRemote, $config.UpstreamRemote)) {
        $remote = Invoke-Git -Arguments @('remote', 'get-url', $remoteName) -AllowFailure
        if ($remote.ExitCode -ne 0) { throw "Required remote '$remoteName' is missing." }
        $slug = Get-RepositorySlug ($remote.Output -join '')
        $expected = if ($remoteName -eq $config.OriginRemote) { $config.ExpectedOriginRepositories } else { $config.ExpectedUpstreamRepositories }
        if ($expected -cnotcontains $slug) { throw "Remote '$remoteName' points to unexpected repository '$slug'. Expected: $($expected -join ', ')." }
        if (-not $script:conciseMode) { Write-Host "$remoteName -> $slug" }
    }
    foreach ($requiredPath in @($config.ValidationScript, $config.PullRequestTemplate)) {
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $requiredPath) -PathType Leaf)) {
            throw "Required repository file is missing: $requiredPath"
        }
    }

    if ($RefreshBase -and -not $NoFetch) {
        if (-not $script:conciseMode) { Write-Host "Refreshing $($config.OriginRemote)/$($config.BaseBranch)..." }
        Invoke-Git -Arguments @('fetch', '--no-tags', $config.OriginRemote, $config.BaseBranch) | Out-Null
    }
    $baseRef = "$($config.OriginRemote)/$($config.BaseBranch)"
    $baseCommit = Get-GitText @('rev-parse', $baseRef)
    $head = Get-GitText @('rev-parse', 'HEAD')
    $ancestor = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $baseRef, 'HEAD') -AllowFailure
    if ($ancestor.ExitCode -ne 0) { throw "Current branch does not descend from validated $baseRef." }
    $trackingResult = Invoke-Git -Arguments @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}') -AllowFailure
    $tracking = if ($trackingResult.ExitCode -eq 0) { ($trackingResult.Output -join '').Trim() } else { '(none)' }
    $commits = @((Invoke-Git -Arguments @('log', '--oneline', "$baseRef..HEAD")).Output | Where-Object { $_ })
    $committedPaths = @(
        (Invoke-Git -Arguments @('diff', '--name-only', '--diff-filter=ACDMRTUXB', "$baseRef...HEAD", '--')).Output |
            Where-Object { $_ } |
            ForEach-Object { Normalize-Path $_ } |
            Sort-Object -Unique
    )
    $relationship = (Get-GitText @('rev-list', '--left-right', '--count', "$baseRef...HEAD")) -split '\s+'
    if (-not $script:conciseMode) {
        Write-Host "Branch: $branch"
        Write-Host "HEAD: $head"
        Write-Host "Base: $baseRef ($baseCommit)"
        Write-Host "Tracking: $tracking"
    }
    $remoteBranchRef = "refs/remotes/$($config.OriginRemote)/$branch"
    $remoteBranchKnown = (Invoke-Git -Arguments @('show-ref', '--verify', '--quiet', $remoteBranchRef) -AllowFailure).ExitCode -eq 0
    if (-not $script:conciseMode) {
        Write-Host "Known remote branch: $(if ($remoteBranchKnown) { $remoteBranchRef } else { '(none in local refs)' })"
        Write-Host "Relationship to ${baseRef}: ahead $($relationship[1]), behind $($relationship[0])"
        Write-Host "Branch-only commits: $($commits.Count)"
        Write-Host "Already committed PR paths: $($committedPaths.Count)"
    }
    if (-not $script:conciseMode) {
        $commits | ForEach-Object { Write-Host "  $_" }
        $committedPaths | ForEach-Object { Write-Host "  $_" }
    }
    Write-PrepareLog "Preflight passed. Branch=$branch Base=$baseRef BaseCommit=$baseCommit HEAD=$head Tracking=$tracking"
    return [pscustomobject]@{
        Branch = $branch
        Head = $head
        BaseRef = $baseRef
        BaseCommit = $baseCommit
        Tracking = $tracking
        BranchCommits = $commits
        CommittedPaths = $committedPaths
    }
}

function Test-Pattern([string]$Path, [string[]]$Patterns) {
    foreach ($pattern in $Patterns) { if ($Path -like $pattern) { return $true } }
    return $false
}

function Resolve-Scope([object[]]$Entries) {
    if (-not $Entries.Count) { throw 'No modified, deleted, staged, or untracked paths were found.' }
    [string[]]$candidatePaths = if ($Files.Count) { $Files | ForEach-Object { Normalize-Path $_ } | Sort-Object -Unique } else { $Entries.Path | Sort-Object -Unique }
    [string[]]$excludedPaths = @($Exclude | ForEach-Object { Normalize-Path $_ })

    Write-Section 'AUDIT CHANGES'
    if (-not $script:conciseMode) {
        for ($i = 0; $i -lt $candidatePaths.Count; $i++) {
            $entry = $Entries | Where-Object Path -eq $candidatePaths[$i] | Select-Object -First 1
            $code = if ($entry) { $entry.Code } else { '--' }
            Write-Host ("[{0}] {1} {2}" -f ($i + 1), $code, $candidatePaths[$i])
        }
    }
    $scope = @($candidatePaths | Where-Object { $_ -notin $excludedPaths } | Sort-Object -Unique)
    if (-not $scope.Count) { throw 'The confirmed scope cannot be empty.' }
    foreach ($path in $scope) {
        $entry = $Entries | Where-Object Path -eq $path | Select-Object -First 1
        if (-not $entry) { throw "Scoped path '$path' is not currently changed." }
        if ($entry.Untracked) {
            $ignored = Invoke-Git -Arguments @('check-ignore', '--no-index', '--quiet', '--', $path) -AllowFailure
            if ($ignored.ExitCode -eq 0) { throw "Refusing ignored untracked path '$path'." }
        }
        if ($path -ne '.vscode/tasks.json' -and (Test-Pattern $path $config.RefusedArtifactPatterns)) {
            throw "Refusing likely local, generated, or sensitive artifact '$path'."
        }
    }
    if (-not $script:conciseMode) { Write-Host "Working-tree scope: $($scope.Count) path(s)" }
    if (-not $script:conciseMode) { $scope | ForEach-Object { Write-Host "  $_" } }
    return $scope
}

function Assert-NoOutOfScope([string[]]$Scope, [object[]]$Entries) {
    $outside = @($Entries.Path | Where-Object { $_ -notin $Scope } | Sort-Object -Unique)
    if ($outside.Count) {
        throw "Out-of-scope dirty paths would make validation differ from the intended commit. Preserve them in a separate worktree, then rerun:`n$($outside -join [Environment]::NewLine)"
    }
}

function Get-ManifestHash([string[]]$Lines) {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($Lines -join "`n"))
        return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Get-GitObjectType([string]$Mode) {
    if ($Mode -eq '160000') { return 'commit' }
    return 'blob'
}

function Get-UntrackedFileMode([object]$Item) {
    if ($Item.PSObject.Properties.Name -contains 'LinkType' -and $Item.LinkType -eq 'SymbolicLink') { return '120000' }
    $isWindowsPlatform = if (Get-Variable IsWindows -ErrorAction SilentlyContinue) { $IsWindows } else { $env:OS -eq 'Windows_NT' }
    if (-not $isWindowsPlatform -and [IO.File].GetMethod('GetUnixFileMode', [type[]]@([string]))) {
        $unixMode = [IO.File]::GetUnixFileMode($Item.FullName)
        $executeBits = [IO.UnixFileMode]::UserExecute -bor [IO.UnixFileMode]::GroupExecute -bor [IO.UnixFileMode]::OtherExecute
        if (($unixMode -band $executeBits) -ne 0) { return '100755' }
    }
    return '100644'
}

function Get-WorkingEntryIdentity([string]$Path) {
    $fullPath = Join-Path $repoRoot $Path
    $indexEntry = (Invoke-Git -Arguments @('ls-files', '--stage', '--', $Path)).Output | Select-Object -First 1
    $indexMode = if ($indexEntry -and $indexEntry -match '^(?<mode>\d{6})\s+') { $Matches.mode } else { $null }
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
    if (-not $item) { return 'DELETE' }

    $rawLine = (Invoke-Git -Arguments @('diff', '--raw', '--no-abbrev', 'HEAD', '--', $Path)).Output | Select-Object -First 1
    $mode = if ($rawLine -and $rawLine -match '^:\d{6}\s+(?<mode>\d{6})\s+') { $Matches.mode } else { $indexMode }
    if (-not $mode) { $mode = Get-UntrackedFileMode $item }

    if ($mode -eq '160000') {
        $objectId = Get-GitText @('-C', $Path, 'rev-parse', 'HEAD')
    } else {
        $objectId = Get-GitText @('hash-object', '--path', $Path, '--', $Path)
    }
    $type = Get-GitObjectType $mode
    return "MODE=$mode`tTYPE=$type`tOID=$objectId"
}

function Get-WorkingSnapshotHash([string[]]$Scope) {
    $manifest = @()
    foreach ($path in @($Scope | Sort-Object -Unique)) {
        $manifest += "$path`t$(Get-WorkingEntryIdentity $path)"
    }
    return Get-ManifestHash $manifest
}

function Get-StagedSnapshotHash([string[]]$Scope) {
    $manifest = @()
    foreach ($path in @($Scope | Sort-Object -Unique)) {
        $entry = Invoke-Git -Arguments @('ls-files', '--stage', '--', $path)
        $line = ($entry.Output | Select-Object -First 1)
        if ($line -and $line -match '^(?<mode>\d{6})\s+(?<object>[0-9a-f]+)\s+\d+\s+') {
            $mode = $Matches.mode
            $objectId = $Matches.object
            $type = Get-GitObjectType $mode
            $manifest += "$path`tMODE=$mode`tTYPE=$type`tOID=$objectId"
        } else {
            $manifest += "$path`tDELETE"
        }
    }
    return Get-ManifestHash $manifest
}

function Get-StatePath {
    return Get-GitText @('rev-parse', '--git-path', 'wholphin-prepare-pr-state.json')
}

function Save-State([hashtable]$State) {
    $State.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Get-StatePath) -Encoding UTF8
}

function Load-State([object]$Preflight) {
    $path = Get-StatePath
    if (-not (Test-Path -LiteralPath $path)) { throw 'No resumable prepare-pr state exists. Run the guided workflow or Audit first.' }
    $state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($state.version -ne 2) { throw 'Saved prepare-pr state uses an unsupported version. Run Audit again.' }
    if ($state.branch -ne $Preflight.Branch -or $state.baseCommit -ne $Preflight.BaseCommit -or $state.branchHead -ne $Preflight.Head) {
        throw 'Saved prepare-pr state is stale because the branch, base, or HEAD changed. Run Audit again.'
    }
    return $state
}

function Show-Audit([string[]]$Scope, [object[]]$Entries, [object]$Preflight) {
    Write-AuditDetail 'COMPLETE EVENTUAL PR SCOPE'
    if (-not $script:conciseMode) { Write-Host "Already committed branch content: $(@($Preflight.CommittedPaths).Count) path(s) in $(@($Preflight.BranchCommits).Count) commit(s)" }
    if (-not $script:conciseMode) {
        @($Preflight.BranchCommits) | ForEach-Object { Write-Host "  commit: $_" }
        @($Preflight.CommittedPaths) | ForEach-Object { Write-Host "  committed: $_" }
    }
    if (-not $script:conciseMode) { Write-Host "Current working-tree candidates: $($Scope.Count) path(s)" }
    if (-not $script:conciseMode) { $Scope | ForEach-Object { Write-Host "  candidate: $_" } }
    $publicationPaths = @(@($Preflight.CommittedPaths) + $Scope | Sort-Object -Unique)
    if (-not $script:conciseMode) { Write-Host "TOTAL COMPLETE PR SCOPE: $($publicationPaths.Count) UNIQUE PATH(S)" -ForegroundColor Green }
    if (-not $script:conciseMode) { $publicationPaths | ForEach-Object { Write-Host "  PR: $_" } }

    Write-AuditDetail 'INTENDED SNAPSHOT'
    $scopedEntries = @($Entries | Where-Object Path -in $Scope)
    $added = @($scopedEntries | Where-Object { $_.Untracked -or $_.Code -match 'A' })
    $deleted = @($scopedEntries | Where-Object { $_.Code -match 'D' })
    $renamed = @($scopedEntries | Where-Object { $_.Code -match 'R' })
    $modified = @($scopedEntries | Where-Object { -not $_.Untracked -and $_.Code -match 'M' })
    if (-not $script:conciseMode) {
        Write-Host "Tracked modified candidates: $($modified.Count)"
        Write-Host "Added/new candidates (including untracked): $($added.Count)"
        Write-Host "Deleted: $($deleted.Count)"
        Write-Host "Rename path entries: $($renamed.Count)"
        Write-Host "Staged: $(@($scopedEntries | Where-Object Staged).Count)"
        Write-Host "Unstaged: $(@($scopedEntries | Where-Object Unstaged).Count)"
        Write-Host "Untracked/new files outside tracked diff statistics: $(@($scopedEntries | Where-Object Untracked).Count)"
    }
    if (-not $script:conciseMode) {
        Write-Host 'Tracked working-tree diff statistics (untracked/new files are listed separately below):'
        Invoke-Git -Arguments (@('diff', '--stat', 'HEAD', '--') + $Scope) | Select-Object -ExpandProperty Output | ForEach-Object { Write-Host $_ }
        Write-Host "Committed branch diff versus $($Preflight.BaseRef):"
        Invoke-Git -Arguments @('diff', '--stat', "$($Preflight.BaseRef)...HEAD") | Select-Object -ExpandProperty Output | ForEach-Object { Write-Host $_ }
    }
    $untracked = @($scopedEntries | Where-Object Untracked)
    if ($untracked.Count -and -not $script:conciseMode) { Write-Host 'Untracked/new files included in eventual PR scope:' }
    if (-not $script:conciseMode) { $untracked | ForEach-Object { Write-Host "  untracked/new: $($_.Path)" } }
    Write-PrepareLog "Audit scope: committedPaths=$(@($Preflight.CommittedPaths).Count) candidatePaths=$($Scope.Count) totalUniquePaths=$($publicationPaths.Count)"
    $publicationPaths | ForEach-Object { Write-PrepareLog "Audited publication path: $_" }

    $risks = @($publicationPaths | Where-Object { Test-Pattern $_ $config.HighRiskPatterns })
    if ($risks.Count -and -not $script:conciseMode) {
        Write-Host 'High-risk/review-sensitive paths:' -ForegroundColor Yellow
        $risks | ForEach-Object { Write-Host "  $_" }
    }

    $diffCheck = Invoke-Git -Arguments (@('diff', '--check', 'HEAD', '--') + $Scope) -AllowFailure
    if ($diffCheck.ExitCode -ne 0) { throw "git diff --check failed:`n$($diffCheck.Output -join [Environment]::NewLine)" }
    $committedDiffCheck = Invoke-Git -Arguments @('diff', '--check', "$($Preflight.BaseRef)...HEAD") -AllowFailure
    if ($committedDiffCheck.ExitCode -ne 0) { throw "Committed PR diff check failed:`n$($committedDiffCheck.Output -join [Environment]::NewLine)" }
    if (-not $script:conciseMode) { Write-Host 'git diff --check: PASS' }

    $markers = @()
    foreach ($path in $publicationPaths) {
        $fullPath = Join-Path $repoRoot $path
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
        try {
            $matches = Select-String -LiteralPath $fullPath -Pattern '^(<<<<<<< .+|=======|>>>>>>> .+)$' -ErrorAction Stop
            if ($matches) { $markers += $path }
        } catch { }
    }
    if ($markers.Count) { throw "Canonical conflict markers require review:`n$($markers -join [Environment]::NewLine)" }
    if (-not $script:conciseMode) { Write-Host 'Conflict-marker check: PASS' }
    return $risks
}

function Resolve-AndSaveScope([object]$Preflight) {
    $entries = @(Get-ChangedEntries)
    $committedOnly = -not $entries.Count
    if ($committedOnly) {
        if (-not @($Preflight.BranchCommits).Count -or -not @($Preflight.CommittedPaths).Count) {
            throw 'No modified, deleted, staged, untracked, or branch-only committed paths were found.'
        }
        if ($Files.Count -or $Exclude.Count) {
            throw 'Committed-only publication always uses the complete branch diff; -Files and -Exclude are not applicable.'
        }
        if ($Preflight.Branch -like $config.UpstreamSyncBranchPattern -and -not $preserveUpstreamCommit) {
            throw 'A committed-only upstream-sync branch requires the existing preserved native-merge identity arguments.'
        }
        Write-Section 'AUDIT CHANGES'
        if (-not $script:conciseMode) { Write-Host 'Working tree and index are clean; reviewing committed branch content only.' }
        $scope = @()
    } else {
        $scope = @(Resolve-Scope $entries)
    }
    Assert-NoOutOfScope $scope $entries
    $risks = @(Show-Audit $scope $entries $Preflight)
    $state = Save-ConfirmedScope $Preflight $scope $risks -CommittedOnly:$committedOnly
    $script:validationPlan = Get-PrepareValidationPlan @($state.publicationPaths)
    if ($script:conciseMode) {
        $pathLabel = if (@($state.publicationPaths).Count -eq 1) { 'path' } else { 'paths' }
        $separator = [char]0xB7
        Write-Host "Scope: $(@($state.publicationPaths).Count) $pathLabel $separator $($script:validationPlan.releaseRelevance) $separator $($script:validationPlan.validationRisk) risk"
    }
    return $state
}

function Save-ConfirmedScope([object]$Preflight, [string[]]$Scope, [string[]]$Risks, [switch]$CommittedOnly) {
    $snapshotHash = Get-WorkingSnapshotHash $Scope
    $state = @{
        version = 2
        branch = $Preflight.Branch
        baseRef = $Preflight.BaseRef
        baseCommit = $Preflight.BaseCommit
        branchHead = $Preflight.Head
        scope = $Scope
        committedPaths = @($Preflight.CommittedPaths)
        publicationPaths = @(@($Preflight.CommittedPaths) + $Scope | Sort-Object -Unique)
        branchCommits = @($Preflight.BranchCommits)
        intendedSnapshotHash = $snapshotHash
        highRiskPaths = $Risks
        localCheckLevel = $null
        stagedTree = $null
        stagedSnapshotHash = $null
        approvedTitle = $null
        completedPhase = 'ScopeConfirmed'
        committedOnly = [bool]$CommittedOnly
    }
    if ($CommittedOnly -and $Preflight.Branch -notlike $config.UpstreamSyncBranchPattern) {
        $tree = Get-GitText @('rev-parse', 'HEAD^{tree}')
        $approvedTitle = New-CommitTitle $Preflight $state
        if (-not $approvedTitle -or $approvedTitle -notmatch '^(feat|fix|chore|ci|docs|test|refactor)(\([^)]+\))?: .+') {
            throw 'Committed-only publication requires a supported Conventional Commit PR title; supply -Title if the branch name cannot provide one.'
        }
        $state.stagedTree = $tree
        $state.approvedTitle = $approvedTitle
        $state.commit = $Preflight.Head
        $state.completedPhase = 'Committed'
    }
    Save-State $state
    if ($CommittedOnly) {
        if (-not $script:conciseMode) { Write-Host "Committed-only scope confirmed. HEAD: $($Preflight.Head); tree: $(Get-GitText @('rev-parse', 'HEAD^{tree}'))" }
        Write-PrepareLog "Committed-only scope confirmed. Commit=$($Preflight.Head) Tree=$(Get-GitText @('rev-parse', 'HEAD^{tree}'))"
    } else {
        if (-not $script:conciseMode) { Write-Host "Scope confirmed. Intended snapshot: $snapshotHash" }
        Write-PrepareLog "Scope confirmed. IntendedSnapshot=$snapshotHash"
    }
    @($state.publicationPaths) | ForEach-Object { Write-PrepareLog "Confirmed publication path: $_" }
    return [pscustomobject]$state
}

function Assert-CommittedOnlyState([object]$Preflight, [object]$State) {
    if (-not $State.committedOnly) { return }
    if (@($State.scope).Count -or -not @($State.committedPaths).Count -or -not @($State.publicationPaths).Count) {
        throw 'Committed-only state has incomplete scope evidence. Run Audit again.'
    }
    if (@(Get-ChangedEntries).Count) { throw 'Committed-only publication requires a clean working tree and index.' }
    $expectedPaths = @($Preflight.CommittedPaths | Sort-Object -Unique)
    $recordedPaths = @($State.publicationPaths | Sort-Object -Unique)
    if (Compare-Object $expectedPaths $recordedPaths) {
        throw 'Committed-only branch scope changed after review. Run Audit again.'
    }
    if ($State.commit -ne $Preflight.Head) { throw 'Committed-only reviewed HEAD changed after Audit.' }
    $tree = Get-GitText @('rev-parse', 'HEAD^{tree}')
    if ($State.stagedTree -ne $tree) { throw 'Committed-only reviewed tree no longer matches HEAD.' }
}

function Invoke-LocalChecks([object]$Preflight, [object]$State, [string]$RequestedLevel) {
    Write-Section 'LOCAL CHECKS'
    if ($State.committedOnly -and $State.completedPhase -eq 'Committed') {
        Assert-CommittedOnlyState $Preflight $State
        Write-Host 'Skipped: clean committed-only branch; authoritative validation belongs to PR CI.'
        Write-PrepareLog 'Local checks skipped for authenticated committed-only scope.'
        Complete-PrepareStage -Status 'SKIP'
        return $State
    }
    $scope = @($State.scope)
    $entries = @(Get-ChangedEntries)
    Assert-NoOutOfScope $scope $entries
    $beforeSnapshot = Get-WorkingSnapshotHash $scope
    if ($beforeSnapshot -ne $State.intendedSnapshotHash) { throw 'The intended snapshot changed after scope confirmation. Run Audit again.' }

    $isUpstreamSync = $Preflight.Branch -like $config.UpstreamSyncBranchPattern
    $filters = @($TestFilter | Where-Object { $_ })
    if (-not $filters.Count -and $isUpstreamSync) {
        throw 'Upstream-sync preparation requires meaningful focused JVM test patterns before authoritative hosted Full. Supply -TestFilter.'
    }

    Write-PrepareLog "Local checks selected: $RequestedLevel; FocusedFilters=$($filters -join ',')"
    $arguments = @('-Level', $RequestedLevel)
    foreach ($filter in $filters) { $arguments += @('-TestFilter', $filter) }
    foreach ($path in @($State.publicationPaths)) { $arguments += @('-ChangedPath', $path) }
    if (-not $script:conciseMode) { Write-Host ".\$($config.ValidationScript) $($arguments -join ' ')" }
    $previousCompact = $env:MOSAIC_OUTPUT_COMPACT
    $previousPrefix = $env:MOSAIC_OUTPUT_PREFIX
    if ($script:conciseMode) {
        $env:MOSAIC_OUTPUT_COMPACT = '1'
        $env:MOSAIC_OUTPUT_PREFIX = '  '
    }
    try {
        & (Join-Path $repoRoot $config.ValidationScript) -Level $RequestedLevel -TestFilter $filters -ChangedPath @($State.publicationPaths)
        $validationExitCode = $LASTEXITCODE
    } finally {
        if ($null -eq $previousCompact) { Remove-Item Env:MOSAIC_OUTPUT_COMPACT -ErrorAction SilentlyContinue } else { $env:MOSAIC_OUTPUT_COMPACT = $previousCompact }
        if ($null -eq $previousPrefix) { Remove-Item Env:MOSAIC_OUTPUT_PREFIX -ErrorAction SilentlyContinue } else { $env:MOSAIC_OUTPUT_PREFIX = $previousPrefix }
    }
    $validationLog = Join-Path $repoRoot 'validation.log'
    if (Test-Path -LiteralPath $validationLog) {
        Add-Content -LiteralPath $script:stageLogPath -Value "`n--- $RequestedLevel local-check output ---" -Encoding UTF8
        Get-Content -LiteralPath $validationLog | Add-Content -LiteralPath $script:stageLogPath -Encoding UTF8
    }
    if ($validationExitCode -ne 0) {
        Write-PrepareLog "$RequestedLevel local checks failed with exit code $validationExitCode."
        $failedEntries = @(Get-ChangedEntries)
        $failedPaths = @($failedEntries.Path | Sort-Object -Unique)
        $failedOutside = @($failedPaths | Where-Object { $_ -notin $scope })
        $failedSnapshot = Get-WorkingSnapshotHash $scope
        if ($failedOutside.Count -or $failedSnapshot -ne $beforeSnapshot) {
            Write-Host 'Failed local checks/autofix changed the working tree. Nothing was staged.' -ForegroundColor Yellow
            $failedEntries | ForEach-Object { Write-Host "$($_.Code) $($_.Path)" }
            throw 'Review the diff and rerun Audit/Validate against the reviewed snapshot.'
        }
        throw "$RequestedLevel local checks failed with exit code $validationExitCode; the intended snapshot was unchanged."
    }
    Write-PrepareLog "$RequestedLevel local checks passed."

    $afterEntries = @(Get-ChangedEntries)
    $afterPaths = @($afterEntries.Path | Sort-Object -Unique)
    $scopePaths = @($scope | Sort-Object -Unique)
    $outside = @($afterPaths | Where-Object { $_ -notin $scopePaths })
    $afterSnapshot = Get-WorkingSnapshotHash $scope
    if ($outside.Count -or $afterSnapshot -ne $beforeSnapshot) {
        Write-Host 'Local checks or autofix changed the working tree. Nothing was staged.' -ForegroundColor Yellow
        $afterEntries | ForEach-Object { Write-Host "$($_.Code) $($_.Path)" }
        throw 'Review the diff and rerun Audit/Validate against the reviewed snapshot.'
    }

    $updated = @{}
    $State.psobject.Properties | ForEach-Object { $updated[$_.Name] = $_.Value }
    $updated.localCheckLevel = $RequestedLevel
    $updated.completedPhase = 'Checked'
    Save-State $updated
    if (-not $script:conciseMode) { Write-Host "Local checks passed for unchanged snapshot $afterSnapshot." }
    Write-PrepareLog "Local checks completed for unchanged snapshot $afterSnapshot."
    return [pscustomobject]$updated
}

function Invoke-Stage([object]$Preflight, [object]$State) {
    Write-Section 'STAGE CONFIRMED SCOPE'
    if ($State.committedOnly -and $State.completedPhase -eq 'Committed') {
        Assert-CommittedOnlyState $Preflight $State
        Write-Host 'Skipped: committed-only scope has no working-tree content to stage.'
        Write-PrepareLog 'Staging skipped for authenticated committed-only scope.'
        Complete-PrepareStage -Status 'SKIP'
        return $State
    }
    if ($State.completedPhase -ne 'Checked') { throw 'Current state has not passed local checks.' }
    $scope = @($State.scope)
    Assert-NoOutOfScope $scope @(Get-ChangedEntries)
    if ((Get-WorkingSnapshotHash $scope) -ne $State.intendedSnapshotHash) { throw 'Checked snapshot is stale. Run Audit and Validate again.' }
    $outsideStaged = @(Get-ChangedEntries | Where-Object { $_.Staged -and $_.Path -notin $scope })
    if ($outsideStaged.Count) { throw "Staged paths exist outside the confirmed scope:`n$($outsideStaged.Path -join [Environment]::NewLine)" }
    $pathsToAdd = @()
    foreach ($path in $scope) {
        $trackedInIndex = (Invoke-Git -Arguments @('ls-files', '--error-unmatch', '--', $path) -AllowFailure).ExitCode -eq 0
        if ((Test-Path -LiteralPath (Join-Path $repoRoot $path)) -or $trackedInIndex) { $pathsToAdd += $path }
    }
    if ($pathsToAdd.Count) { Invoke-Git -Arguments (@('add', '-A', '--') + $pathsToAdd) | Out-Null }
    $stagedSnapshotHash = Get-StagedSnapshotHash $scope
    $stagedTree = Get-GitText @('write-tree')
    if ($stagedSnapshotHash -ne $State.intendedSnapshotHash) { throw 'The staged snapshot does not match the reviewed intended snapshot.' }
    if ($script:conciseMode) {
        $shortStat = Get-GitText @('diff', '--cached', '--shortstat')
        if ($shortStat) { Write-Host $shortStat.Trim() }
    } else {
        Invoke-Git -Arguments @('status', '--short', '--untracked-files=all') | Select-Object -ExpandProperty Output | ForEach-Object { Write-Host $_ }
        Invoke-Git -Arguments @('diff', '--cached', '--stat') | Select-Object -ExpandProperty Output | ForEach-Object { Write-Host $_ }
        Write-Host "Staged tree: $stagedTree"
    }
    $updated = @{}
    $State.psobject.Properties | ForEach-Object { $updated[$_.Name] = $_.Value }
    $updated.stagedTree = $stagedTree
    $updated.stagedSnapshotHash = $stagedSnapshotHash
    $updated.completedPhase = 'Staged'
    Save-State $updated
    Write-PrepareLog "Staging completed. StagedSnapshot=$stagedSnapshotHash StagedTree=$stagedTree"
    return [pscustomobject]$updated
}

function New-CommitTitle([object]$Preflight, [object]$State) {
    if ($Title) { return $Title.Trim() }
    $parts = @($Preflight.Branch -split '/', 2)
    if ($parts.Count -ne 2) { return $null }
    $prefix = switch ($parts[0]) {
        'feature' { 'feat' }
        'feat' { 'feat' }
        'fix' { 'fix' }
        'chore' { 'chore' }
        'ci' { 'ci' }
        'docs' { 'docs' }
        'test' { 'test' }
        'refactor' { 'refactor' }
        default { $null }
    }
    $description = ($parts[1] -replace '[-_]+', ' ' -replace '\s+', ' ').Trim().ToLowerInvariant()
    if (-not $prefix -or -not $description) { return $null }
    return "${prefix}: $description"
}

function Invoke-Commit([object]$Preflight, [object]$State) {
    Write-Section 'COMMIT'
    if ($State.committedOnly -and $State.completedPhase -eq 'Committed') {
        Assert-CommittedOnlyState $Preflight $State
        Write-Host "Skipped: publishing existing commit $($State.commit); no commit or amend performed."
        Write-PrepareLog "Commit skipped for authenticated committed-only scope. Commit=$($State.commit) Tree=$($State.stagedTree)"
        Complete-PrepareStage -Status 'SKIP'
        return $State
    }
    if ($State.completedPhase -ne 'Staged') { throw 'Current state is not at the reviewed staged phase.' }
    if ((Get-GitText @('write-tree')) -ne $State.stagedTree) { throw 'The staged snapshot changed after review.' }
    $scope = @($State.scope)
    Assert-NoOutOfScope $scope @(Get-ChangedEntries)
    if ((Get-WorkingSnapshotHash $scope) -ne $State.intendedSnapshotHash) { throw 'The working snapshot changed after local checks/staging. Review it again.' }
    $commitTitle = New-CommitTitle $Preflight $State
    if (-not $commitTitle) { throw 'No honest conventional commit title could be generated from the task branch. Supply -Title.' }
    if ($commitTitle -notmatch '^(feat|fix|chore|ci|docs|test|refactor)(\([^)]+\))?: .+') { throw 'Commit title must use a supported Conventional Commit prefix.' }
    if ($script:conciseMode) {
        Write-Host $commitTitle
        $shortStat = Get-GitText @('diff', '--cached', '--shortstat')
        if ($shortStat) { Write-Host $shortStat.Trim() }
    } else {
        Write-Host "Title: $commitTitle"
        Invoke-Git -Arguments @('diff', '--cached', '--stat') | Select-Object -ExpandProperty Output | ForEach-Object { Write-Host $_ }
    }
    if ($preserveUpstreamCommit) {
        if ($Preflight.Branch -notlike $config.UpstreamSyncBranchPattern) { throw '-PreserveMergeCommit is restricted to an upstream-sync branch.' }
        foreach ($identity in @($ExpectedMergeFirstParent, $ExpectedMergeSecondParent, $ExpectedMergeTree)) {
            if ($identity -notmatch '^[0-9a-f]{40}$') { throw 'Preserved merge identity requires exact lowercase 40-character Git object IDs.' }
        }
        $commit = Get-GitText @('rev-parse', 'HEAD')
        $parents = @((Get-GitText @('show', '-s', '--format=%P', $commit)) -split '\s+' | Where-Object { $_ })
        if ($parents.Count -ne 2 -or $parents[0] -ne $ExpectedMergeFirstParent -or $parents[1] -ne $ExpectedMergeSecondParent) {
            throw 'HEAD is not the exact reviewed native upstream-resolution merge commit.'
        }
        if ((Get-GitText @('rev-parse', 'HEAD^{tree}')) -ne $ExpectedMergeTree) {
            throw 'HEAD tree differs from the reviewed native upstream-resolution tree.'
        }
        $remoteRef = "refs/heads/$($Preflight.Branch)"
        $remote = Invoke-Git -Arguments @('ls-remote', '--heads', $config.OriginRemote, $remoteRef) -AllowFailure
        if ($remote.ExitCode -ne 0) { throw 'Could not authenticate the existing Draft branch.' }
        $remoteHead = (($remote.Output | Select-Object -First 1) -split '\s+')[0]
        if ($PreserveReconciledUpstreamMerge) {
            foreach ($identity in @($ExpectedRemoteDraftHead, $ExpectedOriginalCandidate,
                                     $ExpectedCurrentMain, $ExpectedReconciliationCommit)) {
                if ($identity -notmatch '^[0-9a-f]{40}$') {
                    throw 'Reconciled upstream preservation requires exact lowercase 40-character Git object IDs.'
                }
            }
            if ($remoteHead -ne $ExpectedRemoteDraftHead) { throw 'Existing Draft branch moved; reconciled publication is refused.' }
            if ($ExpectedMergeFirstParent -ne $ExpectedReconciliationCommit) { throw 'Final merge first parent is not the authenticated reconciliation commit.' }
            $anchor = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $ExpectedOriginalCandidate, $ExpectedRemoteDraftHead) -AllowFailure
            if ($anchor.ExitCode -ne 0) { throw 'Remote Draft head does not descend from the original candidate.' }
            $reconciliationParents = @((Get-GitText @('show', '-s', '--format=%P', $ExpectedReconciliationCommit)) -split '\s+' | Where-Object { $_ })
            if ($ExpectedReconciliationCommit -eq $ExpectedRemoteDraftHead) {
                $containsMain = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $ExpectedCurrentMain, $ExpectedRemoteDraftHead) -AllowFailure
                if ($containsMain.ExitCode -ne 0) { throw 'Draft head does not contain authenticated current main.' }
            } elseif ($reconciliationParents.Count -ne 2 -or
                      $reconciliationParents[0] -ne $ExpectedRemoteDraftHead -or
                      $reconciliationParents[1] -ne $ExpectedCurrentMain) {
                throw 'Reconciliation commit does not have exact parents [remote Draft head, current main].'
            }
            if ((Get-GitText @('rev-parse', "$($config.OriginRemote)/$($config.BaseBranch)")) -ne $ExpectedCurrentMain) {
                throw 'Current protected main moved after reconciliation review.'
            }
            foreach ($ancestorIdentity in @($ExpectedRemoteDraftHead, $ExpectedCurrentMain, $ExpectedMergeSecondParent)) {
                $contains = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $ancestorIdentity, 'HEAD') -AllowFailure
                if ($contains.ExitCode -ne 0) { throw 'Final reconciled merge is missing an authenticated ancestor.' }
            }
        } elseif ($remoteHead -ne $ExpectedMergeFirstParent) {
            throw 'Existing Draft branch moved; preserved merge publication is refused.'
        }
        $commitTitle = Get-GitText @('show', '-s', '--format=%s', 'HEAD')
        if ($script:conciseMode) { Write-Host 'Preserving reviewed native merge commit.' } else { Write-Host "Preserving existing merge commit: $commit" }
    } else {
        $commitResult = Invoke-Git -Arguments @('commit', '-m', $commitTitle)
        if (-not $script:conciseMode) { $commitResult.Output | ForEach-Object { Write-Host $_ } }
        $commit = Get-GitText @('rev-parse', 'HEAD')
    }
    $committedTree = Get-GitText @('rev-parse', 'HEAD^{tree}')
    if ($committedTree -ne $State.stagedTree) {
        Write-PrepareLog "Commit tree mismatch. Commit=$commit CommittedTree=$committedTree ReviewedTree=$($State.stagedTree)"
        throw "The produced commit tree '$committedTree' does not match the reviewed staged tree '$($State.stagedTree)'. A hook or concurrent process changed the commit; publication is refused."
    }
    $updated = @{}
    $State.psobject.Properties | ForEach-Object { $updated[$_.Name] = $_.Value }
    $updated.approvedTitle = $commitTitle
    $updated.commit = $commit
    $updated.branchHead = $commit
    $updated.completedPhase = 'Committed'
    Save-State $updated
    Write-PrepareLog "Commit completed. Commit=$commit Tree=$committedTree Title=$commitTitle"
    return [pscustomobject]$updated
}

function New-PullRequestBody([object]$State) {
    $riskText = if (@($State.highRiskPaths).Count) { (@($State.highRiskPaths) | ForEach-Object { "- ``$($_)``" }) -join "`n" } else { 'None flagged.' }
    $uiChanged = @($State.publicationPaths | Where-Object { $_ -like 'app/src/*/java/*/ui/*' -or $_ -like 'app/src/*/res/*' }).Count -gt 0
    $applicationChanged = @($State.publicationPaths | Where-Object { $_ -like 'app/*' }).Count -gt 0
    $screenshots = if ($uiChanged) { 'Not supplied by prepare-pr; add screenshots or explain why they are not applicable before merge.' } else { 'Not applicable; no UI path was detected.' }
    $scopeText = (@($State.publicationPaths) | ForEach-Object { "- ``$($_)``" }) -join "`n"
    $scopeCount = @($State.publicationPaths).Count
    $scopeLabel = if ($scopeCount -eq 1) { 'file' } else { 'files' }
    $plan = if ($script:validationPlan) { $script:validationPlan } else { Get-PrepareValidationPlan @($State.publicationPaths) }
    $script:validationPlan = $plan
    $separator = [char]0xB7
    $scopeSummary = "$scopeCount $scopeLabel $separator $($plan.releaseRelevance) $separator $($plan.validationRisk) risk"
    $hostedPath = Get-ExpectedHostedPath $plan
    $releaseText = if ($plan.releaseRequired) {
        'required after protected-main eligibility rechecks the merged range.'
    } else {
        'not required for the currently classified scope; protected main rechecks independently.'
    }
    $localChecksText = if ($State.committedOnly -and -not $State.localCheckLevel) {
        'Not rerun for the already-committed clean scope; authoritative PR validation is pending.'
    } else {
        "$($State.localCheckLevel) feedback passed for the committed snapshot."
    }
    return @"
## What changed

$($State.approvedTitle)

Scope: $scopeSummary

Application paths changed: $(if ($applicationChanged) { 'yes' } else { 'no' }).
UI paths changed: $(if ($uiChanged) { 'yes' } else { 'no' }).

## Review-sensitive areas

$riskText

<details>
<summary>Confirmed paths ($scopeCount)</summary>

$scopeText

</details>

## Validation and release

- Local checks: $localChecksText
- Expected hosted path: $hostedPath.
- Required `CI / Full validation`: pending.
- Development APK: $releaseText
- Android TV/manual runtime validation: not recorded by prepare-pr; update if applicable.

### Related issues

Not recorded by prepare-pr. Add references or state that none apply.

## Screenshots

$screenshots

## AI or LLM usage

Not recorded automatically. Disclose applicable assistance and human verification before merge.
"@
}

function Invoke-Publish([object]$Preflight, [object]$State) {
    Write-Section 'PUBLISH'
    if ($State.completedPhase -ne 'Committed') { throw 'A reviewed committed tree is required before publication.' }
    if ((Get-GitText @('rev-parse', 'HEAD')) -ne $State.commit) { throw 'HEAD changed after the approved commit.' }
    if (Get-GitText @('status', '--porcelain=v1', '--untracked-files=all')) { throw 'The working tree must be clean before publication.' }
    if ((Get-GitText @('rev-parse', 'HEAD^{tree}')) -ne $State.stagedTree) { throw 'HEAD tree changed after review; publication is refused.' }
    Assert-CommittedOnlyState $Preflight $State
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) { throw "GitHub CLI ('gh') is required before publication. Install it from https://cli.github.com/, run 'gh auth login', then resume with '.\scripts\prepare-pr.ps1 -Phase Publish'. No push occurred." }
    $authResult = Invoke-Gh -CommandPath $gh.Source -Arguments @('auth', 'status') -AllowFailure
    if ($authResult.ExitCode -ne 0) {
        Write-PrepareLog "GitHub CLI authentication failed: $($authResult.Output -join [Environment]::NewLine)"
        throw "GitHub CLI is not authenticated. Run 'gh auth login', then resume with '.\scripts\prepare-pr.ps1 -Phase Publish'. No push occurred."
    }
    $pullRequestBody = New-PullRequestBody $State

    $branch = $Preflight.Branch
    $originUrl = Get-GitText @('remote', 'get-url', $config.OriginRemote)
    $slug = Get-RepositorySlug $originUrl
    if ($preserveUpstreamCommit) {
        $beforeResult = Invoke-Gh -CommandPath $gh.Source -Arguments @('pr', 'list', '--repo', $slug, '--base', $config.BaseBranch, '--head', $branch, '--state', 'open', '--json', 'number,url,isDraft,headRefOid') -AllowFailure
        if ($beforeResult.ExitCode -ne 0) { throw "GitHub CLI could not authenticate the existing Draft PR before push:`n$($beforeResult.Output -join [Environment]::NewLine)" }
        $beforeJson = ($beforeResult.Output -join "`n").Trim()
        $beforePullRequests = if ($beforeJson) { @($beforeJson | ConvertFrom-Json) } else { @() }
        if ($beforePullRequests.Count -ne 1) { throw 'Expected exactly one existing Draft PR before preserved merge publication.' }
        if (-not $beforePullRequests[0].isDraft) { throw 'The existing upstream PR is no longer Draft; no push occurred.' }
        $expectedBeforeHead = if ($PreserveReconciledUpstreamMerge) { $ExpectedRemoteDraftHead } else { $ExpectedMergeFirstParent }
        if ($beforePullRequests[0].headRefOid -ne $expectedBeforeHead) { throw 'Existing Draft PR moved before publication; no push occurred.' }
    }
    $remoteRef = "refs/heads/$branch"
    $remoteQuery = Invoke-Git -Arguments @('ls-remote', '--heads', $config.OriginRemote, $remoteRef) -AllowFailure
    if ($remoteQuery.ExitCode -ne 0) { throw 'Could not inspect the remote branch safely.' }
    $remoteExists = [bool](($remoteQuery.Output -join '').Trim())
    if ($remoteExists) {
        $remoteCommit = (($remoteQuery.Output | Select-Object -First 1) -split '\s+')[0]
        if ($PreserveReconciledUpstreamMerge) {
            if ($remoteCommit -ne $ExpectedRemoteDraftHead) { throw 'Remote Draft head moved before reconciled publication.' }
            Invoke-Git -Arguments @('fetch', '--no-tags', $config.OriginRemote, $config.BaseBranch) | Out-Null
            if ((Get-GitText @('rev-parse', "$($config.OriginRemote)/$($config.BaseBranch)")) -ne $ExpectedCurrentMain) {
                throw 'Current protected main moved before reconciled publication.'
            }
        }
        Invoke-Git -Arguments @('fetch', '--no-tags', $config.OriginRemote, $remoteRef) | Out-Null
        $fastForward = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $remoteCommit, 'HEAD') -AllowFailure
        if ($fastForward.ExitCode -ne 0) { throw 'Remote branch is divergent or ahead; publication would require a force push. Refusing.' }
        $pushResult = Invoke-Git -Arguments @('push', $config.OriginRemote, $branch)
        if (-not $script:conciseMode) { $pushResult.Output | ForEach-Object { Write-Host $_ } }
    } else {
        $pushResult = Invoke-Git -Arguments @('push', '-u', $config.OriginRemote, $branch)
        if (-not $script:conciseMode) { $pushResult.Output | ForEach-Object { Write-Host $_ } }
    }

    $prResult = $null
    $existingResult = Invoke-Gh -CommandPath $gh.Source -Arguments @('pr', 'list', '--repo', $slug, '--base', $config.BaseBranch, '--head', $branch, '--state', 'open', '--json', 'number,url,isDraft,headRefOid') -AllowFailure
    if ($existingResult.ExitCode -ne 0) { throw "GitHub CLI could not inspect existing PRs:`n$($existingResult.Output -join [Environment]::NewLine)" }
    $existingJson = ($existingResult.Output -join "`n").Trim()
    $existingPullRequests = if ($existingJson) { @($existingJson | ConvertFrom-Json) } else { @() }
    if ($existingPullRequests.Count -gt 1) { throw 'Multiple open PRs match the published branch; refusing ambiguous PR identity.' }
    $existing = @($existingPullRequests | ForEach-Object { "#$($_.number) $($_.url)" })
    if ($preserveUpstreamCommit) {
        $maximumHeadObservations = 4
        for ($headObservation = 1; $headObservation -le $maximumHeadObservations; $headObservation++) {
            if ($existingPullRequests.Count -ne 1) { throw 'Expected exactly one existing Draft PR for the preserved upstream merge.' }
            if (-not $existingPullRequests[0].isDraft) { throw 'The existing upstream PR is no longer Draft; preserve the human readiness decision.' }
            $observedHead = [string]$existingPullRequests[0].headRefOid
            if ($observedHead -eq $State.commit) { break }
            if ($observedHead -ne $expectedBeforeHead) {
                throw 'Existing Draft PR head changed to an unexpected commit after publication.'
            }
            if ($headObservation -eq $maximumHeadObservations) {
                throw 'Existing Draft PR head did not expose the reviewed upstream merge commit within the bounded retry window.'
            }
            Write-PrepareLog "GitHub still reports authenticated pre-push Draft head $observedHead; retrying PR-head authentication ($headObservation/$maximumHeadObservations)."
            Start-Sleep -Seconds 1
            $retryResult = Invoke-Gh -CommandPath $gh.Source -Arguments @('pr', 'list', '--repo', $slug, '--base', $config.BaseBranch, '--head', $branch, '--state', 'open', '--json', 'number,url,isDraft,headRefOid') -AllowFailure
            if ($retryResult.ExitCode -ne 0) { throw "GitHub CLI could not reauthenticate the existing Draft PR after push:`n$($retryResult.Output -join [Environment]::NewLine)" }
            $retryJson = ($retryResult.Output -join "`n").Trim()
            $existingPullRequests = if ($retryJson) { @($retryJson | ConvertFrom-Json) } else { @() }
        }
    }
    if ($existing.Count) {
        $prResult = 'existing PR reported'
        $prDisposition = 'reused'
        Write-PrepareLog "Existing PR: $($existing -join ', ')"
    } else {
        $bodyFile = Join-Path ([IO.Path]::GetTempPath()) ("wholphin-pr-{0}.md" -f [guid]::NewGuid())
        try {
            $pullRequestBody | Set-Content -LiteralPath $bodyFile -Encoding UTF8
            $createResult = Invoke-Gh -CommandPath $gh.Source -Arguments @('pr', 'create', '--repo', $slug, '--base', $config.BaseBranch, '--head', $branch, '--title', $State.approvedTitle, '--body-file', $bodyFile) -AllowFailure
            if ($createResult.ExitCode -ne 0) { throw "GitHub CLI could not create the PR:`n$($createResult.Output -join [Environment]::NewLine)" }
            $prResult = 'PR created'
            $prDisposition = 'created'
            Write-PrepareLog "PR created: $($createResult.Output -join '')"
        } finally { Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue }
        $createdListResult = Invoke-Gh -CommandPath $gh.Source -Arguments @('pr', 'list', '--repo', $slug, '--base', $config.BaseBranch, '--head', $branch, '--state', 'open', '--json', 'number,url,isDraft,headRefOid') -AllowFailure
        if ($createdListResult.ExitCode -ne 0) { throw "GitHub CLI could not authenticate the newly created PR:`n$($createdListResult.Output -join [Environment]::NewLine)" }
        $createdListJson = ($createdListResult.Output -join "`n").Trim()
        $existingPullRequests = if ($createdListJson) { @($createdListJson | ConvertFrom-Json) } else { @() }
        if ($existingPullRequests.Count -ne 1) { throw 'Expected exactly one open PR after creation; refusing ambiguous PR identity.' }
    }
    $pullRequest = $existingPullRequests[0]
    $openLink = Format-MosaicTerminalLink '[open]' ([string]$pullRequest.url) ([string]$pullRequest.url)
    Write-Host "PR #$($pullRequest.number) $prDisposition  $openLink"
    if ($preserveUpstreamCommit) {
        Write-Host 'Auto-merge: EXCLUDED (upstream Draft requires human review).'
        Write-Host 'Review and resolve Draft readiness in GitHub.'
        $autoMergeResult = 'excluded upstream Draft'
    } else {
        $autoMergeResult = Enable-NativeAutoMerge $gh.Source $slug $pullRequest $branch $State.commit
        if ($script:conciseMode) { Write-Host 'Auto-merge: ENABLED' }
        if (-not $script:conciseMode) { Write-Host 'GitHub will merge only after required protection succeeds.' }
    }
    Write-Host 'Required CI / Full validation: PENDING'
    if (-not $script:validationPlan) { $script:validationPlan = Get-PrepareValidationPlan @($State.publicationPaths) }
    $expectedHostedPath = Get-ExpectedHostedPath $script:validationPlan
    Write-Host "Expected path: $expectedHostedPath"
    if (-not $script:conciseMode) { Write-Host 'Done - authoritative validation is running on GitHub.' }
    $script:publishedPullRequest = [pscustomobject]@{
        number = $pullRequest.number
        url = $pullRequest.url
        disposition = $prDisposition
        autoMerge = $autoMergeResult
        expectedPath = $expectedHostedPath
    }
    Write-PrepareLog "Publication completed. Branch=$branch Result=$prResult AutoMerge=$autoMergeResult ExpectedPath=$expectedHostedPath"
}

try {
    Set-Location -LiteralPath $repoRoot
    if ($NoFetch -and -not $NonInteractive) { throw '-NoFetch is reserved for isolated non-interactive testing.' }
    $refresh = $Phase -in @('Guided', 'Validate', 'Publish')
    $preflight = Assert-Preflight -RefreshBase:$refresh

    if ($Phase -eq 'Guided') {
        $state = Resolve-AndSaveScope $preflight
        $state = Invoke-LocalChecks $preflight $state $Level
        $state = Invoke-Stage $preflight $state
        $state = Invoke-Commit $preflight $state
        Invoke-Publish $preflight $state
        exit 0
    }

    switch ($Phase) {
        'Audit' {
            Resolve-AndSaveScope $preflight | Out-Null
        }
        'Validate' {
            $state = if ($Files.Count) { Resolve-AndSaveScope $preflight } else { Load-State $preflight }
            Invoke-LocalChecks $preflight $state $Level | Out-Null
        }
        'Stage' { Invoke-Stage $preflight (Load-State $preflight) | Out-Null }
        'Commit' { Invoke-Commit $preflight (Load-State $preflight) | Out-Null }
        'Publish' { Invoke-Publish $preflight (Load-State $preflight) }
    }
} catch {
    $script:prepareFailed = $true
    Write-PrepareLog "FAILED: $($_.Exception.Message)"
    Complete-PrepareStage -Status 'FAIL'
    Write-Error $_.Exception.Message
    $global:LASTEXITCODE = 1
    exit 1
} finally {
    if (-not $script:prepareFailed) { Complete-PrepareStage }
    Write-PrepareLog 'Invocation finished.'
    $logWriter.Dispose()
    $logStream.Dispose()
    Set-Location -LiteralPath $startingLocation
    $script:runTimer.Stop()
    if ($Phase -eq 'Guided' -and -not $script:prepareFailed -and $script:publishedPullRequest) {
        $duration = Format-MosaicDuration $script:runTimer.Elapsed
        $openLink = Format-MosaicTerminalLink '[open]' ([string]$script:publishedPullRequest.url) ([string]$script:publishedPullRequest.url)
        Write-Host "SUCCESS: prepare-pr completed in $duration"
        Write-Host "PR: #$($script:publishedPullRequest.number)  $openLink"
        Write-Host "Logs: $runRelativeDirectory"
    } else {
        Write-Host "Prepare-pr logs: $runDirectory"
    }
}
