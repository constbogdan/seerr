[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$startingLocation = Get-Location

function Invoke-Git {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [switch]$Capture
    )

    if ($Capture) {
        $output = & git @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "git $($Arguments -join ' ') failed:`n$($output -join [Environment]::NewLine)"
        }
        return $output
    }

    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Test-GitRef {
    param([Parameter(Mandatory)][string]$Ref)

    & git show-ref --verify --quiet $Ref
    return $LASTEXITCODE -eq 0
}

try {
    Set-Location -LiteralPath $repoRoot

    $topLevel = (Invoke-Git -Arguments @('rev-parse', '--show-toplevel') -Capture | Select-Object -First 1).Trim()
    if ([IO.Path]::GetFullPath($topLevel) -ne [IO.Path]::GetFullPath($repoRoot)) {
        throw "Expected repository root '$repoRoot', but Git reported '$topLevel'."
    }

    $workingTree = Invoke-Git -Arguments @('status', '--porcelain=v1', '--untracked-files=all') -Capture
    if ($workingTree) {
        throw "The working tree is not clean. Commit, stash, or otherwise resolve the listed work before syncing upstream:`n$($workingTree -join [Environment]::NewLine)"
    }

    $branch = (Invoke-Git -Arguments @('branch', '--show-current') -Capture | Select-Object -First 1).Trim()
    if ($branch -ne 'main') {
        throw "Run this helper from local 'main'; current branch is '$branch'."
    }

    foreach ($remote in @('origin', 'upstream')) {
        $url = (Invoke-Git -Arguments @('remote', 'get-url', $remote) -Capture | Select-Object -First 1).Trim()
        Write-Host "$remote -> $url"
    }

    Write-Host 'Fetching origin/main...'
    Invoke-Git -Arguments @('fetch', 'origin', 'main')
    Write-Host 'Fetching upstream/main...'
    Invoke-Git -Arguments @('fetch', 'upstream', 'main')

    if (-not (Test-GitRef 'refs/heads/main')) {
        throw "Local branch 'main' does not exist."
    }
    if (-not (Test-GitRef 'refs/remotes/origin/main')) {
        throw "Remote-tracking ref 'origin/main' does not exist after fetch."
    }
    if (-not (Test-GitRef 'refs/remotes/upstream/main')) {
        throw "Remote-tracking ref 'upstream/main' does not exist after fetch."
    }

    $counts = ((Invoke-Git -Arguments @('rev-list', '--left-right', '--count', 'main...origin/main') -Capture) -join ' ').Trim() -split '\s+'
    if ($counts.Count -ne 2) {
        throw "Could not determine divergence between main and origin/main."
    }
    $ahead = [int]$counts[0]
    $behind = [int]$counts[1]
    if ($ahead -gt 0) {
        throw "Local main has $ahead commit(s) not present on origin/main. Refusing to discard or publish them automatically."
    }
    if ($behind -gt 0) {
        Write-Host "Fast-forwarding local main by $behind commit(s)..."
        Invoke-Git -Arguments @('merge', '--ff-only', 'origin/main')
    } else {
        Write-Host 'Local main already matches origin/main.'
    }

    $date = Get-Date -Format 'yyyy-MM-dd'
    $syncBranch = "chore/sync-upstream-$date"
    if (Test-GitRef "refs/heads/$syncBranch") {
        throw "Local branch '$syncBranch' already exists. Refusing to overwrite it."
    }
    if (Test-GitRef "refs/remotes/origin/$syncBranch") {
        throw "Remote branch 'origin/$syncBranch' already exists. Refusing to create a conflicting local branch."
    }

    Invoke-Git -Arguments @('switch', '-c', $syncBranch, 'main')
    Write-Host "Merging upstream/main into $syncBranch..."
    & git merge --no-edit upstream/main
    $mergeExitCode = $LASTEXITCODE

    if ($mergeExitCode -ne 0) {
        $conflicts = & git diff --name-only --diff-filter=U
        if ($LASTEXITCODE -eq 0 -and $conflicts) {
            Write-Host ''
            Write-Host 'Merge conflicts require deliberate semantic resolution:' -ForegroundColor Yellow
            $conflicts | ForEach-Object { Write-Host "  $_" }
            Write-Host ''
            Write-Host 'Inspect ours, upstream, the common base, callers, and tests. Never choose ours/theirs mechanically.'
            Write-Host 'After resolving: git add the files, run Standard validation, then Full validation, commit, push, and open a PR into main.'
            exit 2
        }
        throw "git merge upstream/main failed with exit code $mergeExitCode."
    }

    Write-Host ''
    Write-Host "Upstream merge completed on '$syncBranch'."
    Write-Host 'Review the merge and high-risk auto-merged integration files. Git may have fast-forwarded or created the normal merge commit.'
    Write-Host 'Run Standard validation, then Full validation. Do not push or open the sync PR if validation fails.'
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    Set-Location -LiteralPath $startingLocation
}
