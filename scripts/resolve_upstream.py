#!/usr/bin/env python3
"""Safely prepare a local I06 candidate branch for semantic resolution."""

from __future__ import annotations

import argparse
from fnmatch import fnmatchcase
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import mosaic_validation_policy
from mosaic_repository import (
    MOSAIC_DOWNSTREAM_REPOSITORY,
    UPSTREAM_REPOSITORY,
    authenticate_downstream_repository,
)


REPOSITORY = MOSAIC_DOWNSTREAM_REPOSITORY
UPSTREAM = UPSTREAM_REPOSITORY
BASE_BRANCH = "main"
UPSTREAM_WORKFLOW_PATH = ".github/workflows/upstream-sync.yml"
BRANCH_PREFIX = "chore/sync-upstream-"
EPISODE = re.compile(r"<!-- wholphin-upstream-episode:([0-9a-f]{64}) -->")
TECHNICAL = re.compile(
    r"<details>\s*<summary>"
    r"(?:Technical evidence|Technical provenance and upstream history)"
    r"</summary>.*?```json\s*(\{.*?\})\s*```.*?</details>",
    re.S,
)
RUN_ID = re.compile(r"/actions/runs/(\d+)")
BRANCH_IDENTITY = re.compile(
    re.escape(BRANCH_PREFIX) + r"([0-9a-f]{40})-([0-9a-f]{40})$"
)
RESOLUTION_HANDOFF = Path(".upstream-sync/resolution-handoff.json")


class Refusal(RuntimeError):
    """A safety condition could not be proven."""


@dataclass
class Result:
    stdout: str
    stderr: str
    returncode: int


@dataclass
class Candidate:
    pr: dict
    observation: dict
    ci: dict
    state: str = "Independent"
    predecessor: int | None = None
    overlaps: tuple[str, ...] = ()
    current_observation: dict | None = None
    current_main: str | None = None
    refusal: str | None = None


class Runner:
    def run(self, args: list[str], *, cwd: Path, check: bool = True) -> Result:
        completed = subprocess.run(
            args, cwd=cwd, text=True, encoding="utf-8", errors="replace",
            capture_output=True, check=False,
        )
        result = Result(completed.stdout, completed.stderr, completed.returncode)
        if check and result.returncode:
            detail = (result.stderr or result.stdout).strip()
            raise Refusal(f"Command failed ({result.returncode}): {' '.join(args)}\n{detail}")
        return result


def slug(remote: str) -> str | None:
    match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", remote.strip())
    return match.group(1) if match else None


def json_output(runner: Runner, args: list[str], root: Path):
    result = runner.run(args, cwd=root)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise Refusal(f"Expected JSON from {' '.join(args)}: {error}") from error


def marker(body: str) -> str | None:
    match = EPISODE.search(body or "")
    return match.group(1) if match else None


def technical_evidence(body: str) -> dict:
    match = TECHNICAL.search(body or "")
    if not match:
        return {}
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}


def flatten_pages(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    if value and all(isinstance(page, list) for page in value):
        return [item for page in value for item in page if isinstance(item, dict)]
    return [item for item in value if isinstance(item, dict)]


def validate_observation(observation: dict, pr: dict, episode: str, *, runner=None, root=None,
                         run_id=None, attempt=None, repository=REPOSITORY) -> None:
    repository = authenticate_downstream_repository(repository)
    if not isinstance(observation, dict):
        raise Refusal("Machine evidence must be a JSON object.")
    expected = {
        "episode_id": episode,
        "downstream_repo": repository,
        "branch": pr["head"]["ref"],
    }
    if run_id is not None:
        expected["run_id"] = str(run_id)
    if attempt is not None:
        expected["run_attempt"] = str(attempt)
    required = ("episode_id", "downstream_repo", "branch", "candidate_sha", "candidate_tree",
                "upstream_sha", "downstream_sha", "comparison_baseline",
                "ownership_policy_version", "classification_range_count", "review_paths",
                "conflict_paths")
    missing = [key for key in required if key not in observation or observation.get(key) is None]
    if missing:
        raise Refusal("Machine evidence is incomplete: " + ", ".join(missing))
    for key, wanted in expected.items():
        actual = observation.get(key)
        if str(actual) != str(wanted):
            raise Refusal(f"Machine evidence mismatch for {key}: expected {wanted}, found {actual}.")
    branch = BRANCH_IDENTITY.fullmatch(pr["head"]["ref"])
    if (not branch or observation.get("upstream_sha") != branch.group(1)
            or observation.get("downstream_sha") != branch.group(2)):
        raise Refusal("Machine evidence does not match the candidate branch SHA pair.")
    classification_count = observation.get("classification_range_count")
    automation_changes = observation.get("automation_changes")
    if automation_changes is not None:
        if (not isinstance(automation_changes, list)
                or classification_count != len(automation_changes)):
            raise Refusal("Machine evidence does not account for the complete classified upstream range.")
    else:
        ownership_counts = observation.get("ownership_counts")
        clean_path_count = observation.get("clean_path_count")
        valid_counts = (
            isinstance(ownership_counts, dict)
            and ownership_counts
            and all(isinstance(value, int) and not isinstance(value, bool) and value >= 0
                    for value in ownership_counts.values())
            and isinstance(classification_count, int)
            and not isinstance(classification_count, bool)
            and sum(ownership_counts.values()) == classification_count
            and isinstance(clean_path_count, int)
            and not isinstance(clean_path_count, bool)
            and 0 <= clean_path_count <= classification_count
        )
        if not valid_counts:
            raise Refusal("Machine evidence does not account for the complete classified upstream range.")
    anchor = observation.get("candidate_sha")
    head = pr["head"]["sha"]
    if anchor and anchor != head:
        if runner is None or root is None or not is_ancestor(runner, root, repository, anchor, head):
            raise Refusal("PR head is not a proven descendant of the machine-evidence candidate SHA.")


def load_observation(runner: Runner, root: Path, pr: dict, episode: str,
                     repository=REPOSITORY) -> tuple[dict, str | None]:
    repository = authenticate_downstream_repository(repository)
    fallback = technical_evidence(pr.get("body", ""))
    run_url = fallback.get("run_url")
    match = RUN_ID.search(run_url or "")
    if not match:
        validate_observation(fallback, pr, episode, runner=runner, root=root,
                             repository=repository)
        return fallback, run_url
    run_id = match.group(1)
    run = json_output(runner, ["gh", "api", f"repos/{repository}/actions/runs/{run_id}"], root)
    attempt = int(run.get("run_attempt") or 0)
    if not attempt:
        raise Refusal("Latest Upstream Sync run did not expose a valid attempt number.")
    with tempfile.TemporaryDirectory(prefix="wholphin-upstream-evidence-") as directory:
        destination = Path(directory)
        artifact_name = f"upstream-outcome-{attempt}"
        downloaded = runner.run([
            "gh", "run", "download", run_id, "--repo", repository,
            "--name", artifact_name, "--dir", str(destination),
        ], cwd=root, check=False)
        if downloaded.returncode:
            artifact_name = f"upstream-observation-{attempt}"
            downloaded = runner.run([
                "gh", "run", "download", run_id, "--repo", repository,
                "--name", artifact_name, "--dir", str(destination),
            ], cwd=root, check=False)
        evidence_file = next(destination.rglob("*.json"), None) if downloaded.returncode == 0 else None
        if not evidence_file:
            fallback["evidence_warning"] = "Machine observation artifact was unavailable or expired."
            validate_observation(fallback, pr, episode, runner=runner, root=root,
                                 repository=repository)
            return fallback, run_url
        observation = json.loads(evidence_file.read_text(encoding="utf-8"))
    validate_observation(observation, pr, episode, runner=runner, root=root,
                         run_id=run_id, attempt=attempt, repository=repository)
    return observation, run_url


def load_current_reuse_observation(runner: Runner, root: Path, pr: dict, original: dict,
                                   current_main: str, repository=REPOSITORY) -> dict:
    """Authenticate fresh hosted proof that one stale Draft remains the same episode."""
    repository = authenticate_downstream_repository(repository)
    original_run = RUN_ID.search(str(original.get("run_url") or ""))
    original_run_id = int(original_run.group(1)) if original_run else 0
    response = json_output(runner, [
        "gh", "api", f"repos/{repository}/actions/workflows/upstream-sync.yml/runs"
        f"?branch={BASE_BRANCH}&status=success&per_page=100",
    ], root)
    runs = response.get("workflow_runs") if isinstance(response, dict) else None
    if not isinstance(runs, list):
        raise Refusal("Could not enumerate authenticated Upstream Synchronization outcomes.")
    matches = []
    with tempfile.TemporaryDirectory(prefix="wholphin-upstream-current-") as directory:
        base = Path(directory)
        for run in runs:
            run_id = int(run.get("id") or 0)
            attempt = int(run.get("run_attempt") or 0)
            if (run_id <= original_run_id or attempt <= 0
                    or run.get("head_sha") != current_main
                    or run.get("head_branch") != BASE_BRANCH
                    or run.get("path") != UPSTREAM_WORKFLOW_PATH
                    or run.get("conclusion") != "success"
                    or run.get("event") not in {"schedule", "workflow_dispatch"}):
                continue
            destination = base / f"{run_id}-{attempt}"
            destination.mkdir()
            downloaded = runner.run([
                "gh", "run", "download", str(run_id), "--repo", repository,
                "--name", f"upstream-outcome-{attempt}", "--dir", str(destination),
            ], cwd=root, check=False)
            evidence_file = destination / "outcome.json"
            if downloaded.returncode or not evidence_file.is_file():
                continue
            try:
                evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise Refusal("A current-main upstream outcome artifact is unreadable.") from error
            expected = {
                "schema_version": 2,
                "downstream_repo": repository,
                "downstream_sha": current_main,
                "episode_id": marker(pr.get("body", "")),
                "ownership_policy_version": original.get("ownership_policy_version"),
                "outcome": "existing_draft_pr",
                "existing_pr_number": int(pr["number"]),
                "existing_pr_branch": pr["head"]["ref"],
                "existing_pr_head_sha": pr["head"]["sha"],
                "run_id": str(run_id),
                "run_attempt": str(attempt),
            }
            if all(str(evidence.get(key)) == str(value) for key, value in expected.items()):
                observed_candidate = {
                    "head": {
                        "ref": evidence.get("branch"),
                        "sha": evidence.get("candidate_sha"),
                    }
                }
                validate_observation(
                    evidence, observed_candidate, expected["episode_id"], runner=runner, root=root,
                    run_id=run_id, attempt=attempt, repository=repository,
                )
                original_anchor = original.get("candidate_sha")
                live_head = pr.get("head", {}).get("sha")
                if (not original_anchor or not live_head
                        or not is_ancestor(runner, root, repository, original_anchor, live_head)):
                    raise Refusal(
                        "The selected Draft head is not a proven descendant of its original candidate."
                    )
                matches.append(evidence)
    if not matches:
        raise Refusal(
            "No fresh authenticated same-episode Upstream Synchronization outcome exists for "
            "current origin/main. Run the normal Upstream Synchronization workflow and retry."
        )
    critical = {
        (item.get("episode_id"), item.get("downstream_sha"), item.get("upstream_sha"),
         item.get("ownership_policy_version"), item.get("existing_pr_number"),
         item.get("existing_pr_branch"), item.get("existing_pr_head_sha"),
         item.get("candidate_sha"), item.get("candidate_tree"),
         item.get("comparison_baseline"), item.get("classification_range_count"),
         tuple(item.get("review_paths") or ()), tuple(item.get("conflict_paths") or ()))
        for item in matches
    }
    if len(critical) != 1:
        raise Refusal("Current-main upstream outcomes disagree on resolver-critical identity.")
    return max(matches, key=lambda item: int(item.get("run_id") or 0))


def checks(runner: Runner, root: Path, number: int, repository=REPOSITORY) -> dict:
    repository = authenticate_downstream_repository(repository)
    result = runner.run([
        "gh", "pr", "checks", str(number), "--repo", repository,
        "--json", "name,state,link,bucket,workflow",
    ], cwd=root, check=False)
    if result.returncode and not result.stdout.strip():
        return {"status": "UNKNOWN", "name": None, "url": None}
    try:
        rows = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        return {"status": "UNKNOWN", "name": None, "url": None}
    preferred = next((row for row in rows if row.get("name") == "Full validation"), None)
    row = preferred or next((row for row in rows if row.get("bucket") in ("fail", "pending")), None)
    row = row or (rows[0] if rows else {})
    buckets = {item.get("bucket") for item in rows}
    status = ("FAILED" if buckets & {"fail", "cancel"} else
              "PENDING" if "pending" in buckets else "PASSED" if rows else "UNKNOWN")
    name = " / ".join(value for value in (row.get("workflow"), row.get("name")) if value)
    return {"status": status, "name": name or None, "url": row.get("link")}


def assert_preflight(runner: Runner, root: Path, *, allow_dirty=False,
                     allow_resolution_merge=False) -> tuple[str, str]:
    if not shutil.which("git"):
        raise Refusal("Git is required and was not found on PATH.")
    if not shutil.which("gh"):
        raise Refusal("GitHub CLI is required. Install gh, then run 'gh auth login'.")
    top = runner.run(["git", "rev-parse", "--show-toplevel"], cwd=root).stdout.strip()
    if Path(top).resolve() != root.resolve():
        raise Refusal(f"Expected repository root {root}, but Git reported {top}.")
    origin = runner.run(["git", "remote", "get-url", "origin"], cwd=root).stdout.strip()
    try:
        authenticate_downstream_repository(slug(origin))
    except ValueError as error:
        raise Refusal(
            "Expected origin constbogdan/Mosaic; "
            f"found {slug(origin) or origin}."
        ) from error
    upstream = runner.run(["git", "remote", "get-url", "upstream"], cwd=root).stdout.strip()
    if slug(upstream) != UPSTREAM:
        raise Refusal(f"Expected upstream {UPSTREAM}; found {slug(upstream) or upstream}.")
    branch = runner.run(["git", "branch", "--show-current"], cwd=root).stdout.strip()
    merge_head = runner.run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"],
                            cwd=root, check=False).stdout.strip()
    dirty = runner.run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=root).stdout.strip()
    if merge_head and not (allow_resolution_merge and branch.startswith(BRANCH_PREFIX)):
        raise Refusal("An active merge must be completed or aborted manually before resolution.")
    if dirty and not allow_dirty:
        raise Refusal("Working tree is not clean. Commit or preserve local work separately; nothing was stashed or discarded.")
    auth = runner.run(["gh", "auth", "status", "--hostname", "github.com"], cwd=root, check=False)
    if auth.returncode:
        raise Refusal("GitHub CLI is not authenticated. Run 'gh auth login' and retry.")
    return branch, dirty


def authenticated_origin(runner: Runner, root: Path) -> str:
    origin = runner.run(["git", "remote", "get-url", "origin"], cwd=root).stdout.strip()
    try:
        return authenticate_downstream_repository(slug(origin))
    except ValueError as error:
        raise Refusal(
            "Expected origin constbogdan/Mosaic; "
            f"found {slug(origin) or origin}."
        ) from error


def validate_pr(pr: dict, number: int, repository=REPOSITORY) -> str:
    repository = authenticate_downstream_repository(repository)
    if int(pr.get("number") or 0) != number:
        raise Refusal("GitHub returned metadata for a different PR.")
    if pr.get("base", {}).get("repo", {}).get("full_name") != repository:
        raise Refusal(f"PR #{number} does not belong to {repository}.")
    if pr.get("base", {}).get("ref") != BASE_BRANCH:
        raise Refusal(f"PR #{number} does not target {BASE_BRANCH}.")
    if pr.get("state") != "open":
        raise Refusal(f"PR #{number} is {pr.get('state', 'not open')}; closed decisions are not reopened.")
    branch = pr.get("head", {}).get("ref") or ""
    if pr.get("head", {}).get("repo", {}).get("full_name") != repository:
        raise Refusal("PR head is not the maintained downstream repository.")
    episode = marker(pr.get("body", ""))
    if not episode or not branch.startswith(BRANCH_PREFIX):
        raise Refusal(f"PR #{number} is not a durable I06 Upstream Sync candidate.")
    return episode


def open_candidates(runner: Runner, root: Path, repository=REPOSITORY) -> list[Candidate]:
    repository = authenticate_downstream_repository(repository)
    pulls = flatten_pages(json_output(runner, [
        "gh", "api", "--paginate", "--slurp",
        f"repos/{repository}/pulls?state=open&base={BASE_BRANCH}&per_page=100",
    ], root))
    candidates = []
    for pr in pulls:
        episode = marker(pr.get("body", ""))
        if (not episode or pr.get("head", {}).get("repo", {}).get("full_name") != repository
                or not str(pr.get("head", {}).get("ref") or "").startswith(BRANCH_PREFIX)):
            continue
        observation, _ = load_observation(runner, root, pr, episode, repository)
        candidates.append(Candidate(
            pr, observation, checks(runner, root, int(pr["number"]), repository)
        ))
    return sorted(candidates, key=lambda candidate: int(candidate.pr["number"]))


def semantic_paths(candidate: Candidate) -> set[str]:
    observation = candidate.observation
    paths = set(observation.get("review_paths") or []) | set(observation.get("conflict_paths") or [])
    for change in observation.get("automation_changes") or []:
        path = str(change.get("path") or "")
        production = (path.startswith("app/src/main/") or path.startswith(".github/")
                      or path.startswith("scripts/") or path.endswith((".gradle", ".gradle.kts")))
        ownership = change.get("ownership") in {"REVIEW", "DOWNSTREAM-OWNED"}
        if path and (production or ownership):
            paths.add(path)
    return {path for path in paths if not path.startswith("docs/") and not path.endswith(".md")}


def compare_status(runner: Runner, root: Path, repository: str, base: str, head: str) -> str:
    if base == head:
        return "identical"
    result = json_output(runner, ["gh", "api", f"repos/{repository}/compare/{base}...{head}"], root)
    return str(result.get("status") or "unknown")


def is_ancestor(runner: Runner, root: Path, repository: str, older: str, newer: str) -> bool:
    return compare_status(runner, root, repository, older, newer) in {"ahead", "identical"}


def classify_dependencies(runner: Runner, root: Path, candidates: list[Candidate],
                          repository=REPOSITORY) -> list[Candidate]:
    repository = authenticate_downstream_repository(repository)
    main = json_output(runner, ["gh", "api", f"repos/{repository}/git/ref/heads/{BASE_BRANCH}"], root)
    main_sha = main.get("object", {}).get("sha")
    if not main_sha:
        raise Refusal("Could not determine authoritative downstream main SHA.")
    active = [candidate for candidate in candidates if candidate.state != "Superseded"]
    for candidate in active:
        if is_ancestor(runner, root, repository, candidate.pr["head"]["sha"], main_sha):
            candidate.state = "Superseded"
            continue
        observed_main = candidate.observation.get("downstream_sha")
        if observed_main != main_sha:
            if not observed_main or not is_ancestor(
                    runner, root, repository, observed_main, main_sha):
                candidate.state = "Dependency ambiguous"
                continue
            try:
                current = load_current_reuse_observation(
                    runner, root, candidate.pr, candidate.observation, main_sha, repository
                )
            except Refusal as error:
                candidate.state = "Dependency ambiguous"
                candidate.refusal = str(error)
                continue
            original_upstream = candidate.observation.get("upstream_sha")
            current_upstream = current.get("upstream_sha")
            if (not original_upstream or not current_upstream
                    or not is_ancestor(runner, root, UPSTREAM, original_upstream, current_upstream)):
                candidate.state = "Dependency ambiguous"
                continue
            candidate.current_observation = current
            candidate.current_main = main_sha
            candidate.state = "Ready for current-main reconciliation"
    active = [candidate for candidate in active if candidate.state not in {"Superseded", "Dependency ambiguous"}]
    edges: dict[int, set[int]] = {int(candidate.pr["number"]): set() for candidate in active}
    for index, left in enumerate(active):
        for right in active[index + 1:]:
            overlap = sorted(semantic_paths(left) & semantic_paths(right))
            if not overlap:
                continue
            left_up = left.observation.get("upstream_sha")
            right_up = right.observation.get("upstream_sha")
            left_down = left.observation.get("downstream_sha")
            right_down = right.observation.get("downstream_sha")
            if not all((left_up, right_up, left_down, right_down)):
                left.state = right.state = "Dependency ambiguous"
                left.overlaps = right.overlaps = tuple(overlap)
                continue
            left_first = (is_ancestor(runner, root, UPSTREAM, left_up, right_up)
                          and is_ancestor(runner, root, repository, left_down, right_down))
            right_first = (is_ancestor(runner, root, UPSTREAM, right_up, left_up)
                           and is_ancestor(runner, root, repository, right_down, left_down))
            if left_first == right_first:
                left.state = right.state = "Dependency ambiguous"
                left.overlaps = right.overlaps = tuple(overlap)
            elif left_first:
                edges[int(right.pr["number"])].add(int(left.pr["number"]))
                right.overlaps = tuple(overlap)
            else:
                edges[int(left.pr["number"])].add(int(right.pr["number"]))
                left.overlaps = tuple(overlap)
    for candidate in active:
        number = int(candidate.pr["number"])
        if candidate.state == "Dependency ambiguous":
            continue
        predecessors = sorted(edges[number])
        if predecessors:
            candidate.state = f"Waiting on PR #{predecessors[0]}"
            candidate.predecessor = predecessors[0]
        elif candidate.state == "Ready for current-main reconciliation":
            continue
        elif len(active) == 1 or any(edges.values()):
            candidate.state = "Ready for resolution"
        else:
            candidate.state = "Independent"
    return candidates


def render_candidates(candidates: list[Candidate]) -> str:
    lines = ["Open upstream candidates", ""]
    for index, candidate in enumerate(candidates, 1):
        paths = sorted(set(candidate.observation.get("review_paths") or []) |
                       set(candidate.observation.get("conflict_paths") or []))
        lines += [f"[{index}] PR #{candidate.pr['number']}",
                  f"    {len(paths)} requiring attention", f"    CI: {candidate.ci['status']}",
                  f"    {candidate.state}"]
        if candidate.overlaps:
            lines.append("    Overlap: " + ", ".join(Path(path).name for path in candidate.overlaps))
        lines.append("")
    return "\n".join(lines).rstrip()


def checkout(runner: Runner, root: Path, branch: str, remote_sha: str) -> None:
    valid = runner.run(["git", "check-ref-format", "--branch", branch], cwd=root, check=False)
    if valid.returncode:
        raise Refusal("GitHub supplied an invalid candidate branch name.")
    runner.run(["git", "fetch", "--no-tags", "origin", f"refs/heads/{branch}:refs/remotes/origin/{branch}"], cwd=root)
    fetched = runner.run(["git", "rev-parse", f"refs/remotes/origin/{branch}"], cwd=root).stdout.strip()
    if fetched != remote_sha:
        raise Refusal("Fetched candidate branch does not match the current PR head SHA.")
    local = runner.run(["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=root, check=False)
    if local.returncode == 0:
        local_sha = runner.run(["git", "rev-parse", f"refs/heads/{branch}"], cwd=root).stdout.strip()
        if local_sha != fetched:
            raise Refusal(f"Local branch '{branch}' differs from the PR head; refusing to overwrite or reset it.")
        tracking = runner.run(["git", "for-each-ref", "--format=%(upstream:short)", f"refs/heads/{branch}"], cwd=root).stdout.strip()
        if tracking and tracking != f"origin/{branch}":
            raise Refusal(f"Local branch '{branch}' tracks unexpected ref '{tracking}'.")
        runner.run(["git", "switch", branch], cwd=root)
        if not tracking:
            runner.run(["git", "branch", "--set-upstream-to", f"origin/{branch}", branch], cwd=root)
    else:
        runner.run(["git", "switch", "--track", "-c", branch, f"origin/{branch}"], cwd=root)


def git_text(runner: Runner, root: Path, *args: str, check=True) -> str:
    return runner.run(["git", *args], cwd=root, check=check).stdout.strip()


def blocked_context(runner: Runner, root: Path, candidate: Candidate) -> dict:
    branch = candidate.pr["head"]["ref"]
    match = BRANCH_IDENTITY.fullmatch(branch)
    if not match:
        raise Refusal("Candidate branch does not encode an exact upstream/downstream SHA pair.")
    upstream, downstream = match.groups()
    observation = candidate.observation
    original_candidate = observation.get("candidate_sha")
    expected = {
        "upstream_sha": upstream,
        "downstream_sha": downstream,
    }
    for key, value in expected.items():
        if observation.get(key) != value:
            raise Refusal(f"Incomplete or mismatched conflict evidence for {key}.")
    if not original_candidate:
        raise Refusal("Original candidate evidence does not contain a candidate anchor.")
    parents = git_text(runner, root, "show", "-s", "--format=%P", original_candidate).split()
    if parents != [downstream]:
        raise Refusal("Blocked candidate is not the exact single-parent downstream workspace.")
    candidate_tree = git_text(runner, root, "rev-parse", original_candidate + "^{tree}")
    if observation.get("candidate_tree") and observation["candidate_tree"] != candidate_tree:
        raise Refusal("Blocked candidate tree differs from machine evidence.")
    raw = git_text(
        runner,
        root,
        "show",
        original_candidate + ":.upstream-sync/blocked-context.json",
    )
    try:
        context = json.loads(raw)
    except json.JSONDecodeError as error:
        raise Refusal("Blocked candidate context is unreadable.") from error
    if (context.get("schemaVersion") != 1
            or context.get("upstream") != upstream
            or context.get("downstream") != downstream
            or context.get("policyVersion") != observation.get("ownership_policy_version")
            or sorted(context.get("conflicts") or []) != sorted(observation.get("conflict_paths") or [])
            or not context.get("conflicts")):
        raise Refusal("Blocked candidate context does not match the authenticated episode evidence.")
    return context


def validate_draft_extension_scope(runner: Runner, root: Path, candidate: Candidate) -> list[str]:
    """Require every human commit between original A and live C to stay in reviewed scope."""
    anchor = candidate.observation.get("candidate_sha")
    live_head = candidate.pr["head"]["sha"]
    if not anchor or anchor == live_head:
        return []
    paths = sorted(set(git_text(
        runner, root, "diff", "--no-renames", "--name-only", anchor, live_head, "--",
    ).splitlines()))
    attention = set(candidate.observation.get("review_paths") or []) | set(
        candidate.observation.get("conflict_paths") or []
    )
    unexpected = sorted(set(paths) - attention)
    if unexpected:
        raise Refusal(
            "Draft descendant contains unexplained paths outside original review scope: "
            + ", ".join(unexpected)
        )
    return paths


def authenticate_upstream_history(runner: Runner, root: Path, upstream: str) -> None:
    runner.run([
        "git", "fetch", "--quiet", "--no-tags", "upstream",
        "refs/heads/main:refs/remotes/upstream/main",
    ], cwd=root)
    exists = runner.run(["git", "cat-file", "-e", upstream + "^{commit}"], cwd=root, check=False)
    ancestry = runner.run([
        "git", "merge-base", "--is-ancestor", upstream, "refs/remotes/upstream/main"
    ], cwd=root, check=False)
    if exists.returncode or ancestry.returncode:
        raise Refusal("Recorded upstream tip is missing or no longer belongs to current upstream history.")


def begin_native_resolution(runner: Runner, root: Path, candidate: Candidate,
                            first_parent: str | None = None) -> None:
    context = blocked_context(runner, root, candidate)
    upstream = context["upstream"]
    expected_head = first_parent or candidate.pr["head"]["sha"]
    if git_text(runner, root, "rev-parse", "HEAD") != expected_head:
        raise Refusal("Checked-out reconciliation head moved before native merge initialization.")
    authenticate_upstream_history(runner, root, upstream)
    merge = runner.run(["git", "merge", "--no-ff", "--no-commit", upstream], cwd=root, check=False)
    merge_head = git_text(runner, root, "rev-parse", "MERGE_HEAD", check=False)
    if merge.returncode not in (0, 1) or merge_head != upstream:
        raise Refusal("Git could not establish the exact native upstream merge state.")
    runner.run(["git", "rm", "-f", "--", ".upstream-sync/blocked-context.json"], cwd=root)


def assert_native_merge_identity(runner: Runner, root: Path, candidate: Candidate,
                                 first_parent: str | None = None) -> dict:
    context = blocked_context(runner, root, candidate)
    expected_first = first_parent or candidate.pr["head"]["sha"]
    expected_second = context["upstream"]
    if git_text(runner, root, "rev-parse", "HEAD") != expected_first:
        raise Refusal("Native resolution HEAD is not the exact remote Draft candidate.")
    if git_text(runner, root, "rev-parse", "MERGE_HEAD", check=False) != expected_second:
        raise Refusal("Native resolution MERGE_HEAD is not the exact recorded upstream tip.")
    return context


def assert_resolved_native_merge(runner: Runner, root: Path, candidate: Candidate,
                                 first_parent: str | None = None) -> str:
    assert_native_merge_identity(runner, root, candidate, first_parent)
    unmerged = git_text(runner, root, "diff", "--name-only", "--diff-filter=U")
    if unmerged:
        raise Refusal("Native merge still has unresolved paths: " + ", ".join(unmerged.splitlines()))
    context_tracked = runner.run([
        "git", "ls-files", "--error-unmatch", "--", ".upstream-sync/blocked-context.json"
    ], cwd=root, check=False)
    if context_tracked.returncode == 0:
        raise Refusal("Blocked-context metadata must not remain in the resolved merge tree.")
    markers = runner.run([
        "git", "grep", "--cached", "-n", "-I", "-E",
        "^(<<<<<<< |=======|>>>>>>> )", "--",
    ], cwd=root, check=False)
    if markers.returncode not in (0, 1):
        raise Refusal("Could not verify the resolved tree for conflict markers.")
    if markers.returncode == 0:
        raise Refusal("Resolved merge tree still contains conflict markers.")
    runner.run(["git", "diff", "--cached", "--check"], cwd=root)
    return git_text(runner, root, "write-tree")


def commit_native_resolution(runner: Runner, root: Path, candidate: Candidate, paths: list[str],
                             first_parent: str | None = None) -> tuple[str, str]:
    stageable = []
    for path in paths:
        tracked = runner.run(["git", "ls-files", "--error-unmatch", "--", path],
                             cwd=root, check=False)
        if (root / path).exists() or tracked.returncode == 0:
            stageable.append(path)
    if stageable:
        runner.run(["git", "add", "-A", "--", *stageable], cwd=root)
    tree = assert_resolved_native_merge(runner, root, candidate, first_parent)
    first = first_parent or candidate.pr["head"]["sha"]
    second = candidate.observation["upstream_sha"]
    runner.run([
        "git", "commit", "-m", f"Resolve official upstream {second} against Mosaic {first}"
    ], cwd=root)
    commit = git_text(runner, root, "rev-parse", "HEAD")
    parents = git_text(runner, root, "show", "-s", "--format=%P", commit).split()
    committed_tree = git_text(runner, root, "rev-parse", commit + "^{tree}")
    if parents != [first, second]:
        raise Refusal("Resolved commit does not have the exact expected native merge parents.")
    if committed_tree != tree:
        raise Refusal("Resolved merge commit tree differs from the reviewed index tree.")
    return commit, tree


def commit_clean_reconciled_resolution(runner: Runner, root: Path, candidate: Candidate,
                                       paths: list[str], first_parent: str) -> tuple[str, str]:
    """Create exact R=[B,U] when U is already contained and Git has no active merge."""
    if git_text(runner, root, "rev-parse", "HEAD") != first_parent:
        raise Refusal("Clean upstream review is not based on authenticated reconciliation B.")
    for path in paths:
        runner.run(["git", "add", "-A", "--", path], cwd=root)
    runner.run(["git", "diff", "--cached", "--check"], cwd=root)
    tree = git_text(runner, root, "write-tree")
    second = candidate.observation["upstream_sha"]
    commit = runner.run(
        ["git", "commit-tree", tree, "-p", first_parent, "-p", second, "-m",
         f"Resolve official upstream {second} against reconciled Mosaic {first_parent}"],
        cwd=root, check=True,
    )
    resolved = commit.stdout.strip()
    runner.run(["git", "update-ref", "HEAD", resolved, first_parent], cwd=root)
    parents = git_text(runner, root, "show", "-s", "--format=%P", resolved).split()
    if parents != [first_parent, second]:
        raise Refusal("Clean upstream resolution does not have exact parents [B,U].")
    if git_text(runner, root, "rev-parse", resolved + "^{tree}") != tree:
        raise Refusal("Clean upstream resolution tree differs from the reviewed index.")
    return resolved, tree


def reconciliation_commit(runner: Runner, root: Path, candidate: Candidate) -> str:
    """Finish the separately reviewed C+M merge and authenticate B=[C,M]."""
    remote_head = candidate.pr["head"]["sha"]
    current_main = candidate.current_main
    if not current_main:
        return remote_head
    merge_head = git_text(runner, root, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False)
    if merge_head != current_main:
        raise Refusal("Current-main reconciliation MERGE_HEAD does not match authenticated main.")
    unmerged = git_text(runner, root, "diff", "--name-only", "--diff-filter=U")
    if unmerged:
        raise Refusal(
            "Current-main reconciliation still has unresolved paths: "
            + ", ".join(unmerged.splitlines())
        )
    runner.run(["git", "diff", "--cached", "--check"], cwd=root)
    reviewed_tree = git_text(runner, root, "write-tree")
    runner.run([
        "git", "commit", "-m", f"Reconcile Mosaic main {current_main} into upstream Draft {remote_head}"
    ], cwd=root)
    commit = git_text(runner, root, "rev-parse", "HEAD")
    parents = git_text(runner, root, "show", "-s", "--format=%P", commit).split()
    if parents != [remote_head, current_main]:
        raise Refusal("Reconciliation commit does not have exact parents [Draft head, current main].")
    if git_text(runner, root, "rev-parse", commit + "^{tree}") != reviewed_tree:
        raise Refusal("Reconciliation commit tree differs from the reviewed reconciliation tree.")
    return commit


def begin_main_reconciliation(runner: Runner, root: Path, candidate: Candidate) -> str:
    """Start, but never silently complete, the authenticated C+M review stage."""
    remote_head = candidate.pr["head"]["sha"]
    current_main = candidate.current_main
    if not current_main:
        return remote_head
    runner.run([
        "git", "fetch", "--no-tags", "origin",
        f"refs/heads/{BASE_BRANCH}:refs/remotes/origin/{BASE_BRANCH}",
    ], cwd=root)
    fetched_main = git_text(runner, root, "rev-parse", f"refs/remotes/origin/{BASE_BRANCH}")
    if fetched_main != current_main:
        raise Refusal("Current Mosaic main moved after hosted reuse evidence; reobserve and retry.")
    head = git_text(runner, root, "rev-parse", "HEAD")
    if head != remote_head:
        raise Refusal("Local Draft head differs from the exact authenticated remote head.")
    contains_main = runner.run(
        ["git", "merge-base", "--is-ancestor", current_main, remote_head],
        cwd=root, check=False,
    )
    if contains_main.returncode == 0:
        return remote_head
    merge = runner.run(["git", "merge", "--no-ff", "--no-commit", current_main],
                       cwd=root, check=False)
    merge_head = git_text(runner, root, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False)
    if merge.returncode not in (0, 1) or merge_head != current_main:
        raise Refusal("Git could not establish the exact current-main reconciliation state.")
    return ""


def reconciliation_prompt(candidate: Candidate, runner: Runner, root: Path,
                          draft_extension_paths: list[str] | None = None) -> str:
    conflicts = git_text(runner, root, "diff", "--name-only", "--diff-filter=U").splitlines()
    lines = [
        f"# Reconcile Mosaic main for Upstream Sync PR #{candidate.pr['number']}", "",
        "This is the Mosaic-main reconciliation stage, not upstream semantic resolution.", "",
        f"- Remote Draft head C: `{candidate.pr['head']['sha']}`",
        f"- Authenticated current main M: `{candidate.current_main}`", "",
    ]
    if conflicts:
        lines += ["Resolve only these C + M reconciliation conflicts:", ""]
        lines += [f"- `{path}`" for path in conflicts]
    else:
        lines += ["The C + M merge is textually clean. Review the complete staged reconciliation tree."]
    if draft_extension_paths:
        lines += ["", "Authenticated human changes already present between original A and live C:", ""]
        lines += [f"- `{path}`" for path in draft_extension_paths]
    lines += ["", "Do not begin upstream resolution manually.",
              "After review and conflict resolution, rerun `resolve-upstream.ps1` for this PR."]
    return "\n".join(lines) + "\n"


def resolution_paths(runner: Runner, root: Path, remote_sha: str) -> list[str]:
    paths = set()
    commands = (
        ["git", "diff", "--no-renames", "--name-only", remote_sha, "HEAD", "--"],
        ["git", "diff", "--no-renames", "--name-only", "HEAD", "--"],
        ["git", "diff", "--cached", "--no-renames", "--name-only", "HEAD", "--"],
        ["git", "ls-files", "--others", "--exclude-standard"],
    )
    for command in commands:
        paths.update(line.strip().replace("\\", "/") for line in runner.run(command, cwd=root).stdout.splitlines()
                     if line.strip())
    return sorted(paths)


def validate_reconciliation_scope(runner: Runner, root: Path, candidate: Candidate,
                                  reconciliation: str) -> list[str]:
    if not candidate.current_main or reconciliation == candidate.pr["head"]["sha"]:
        return []
    remote = candidate.pr["head"]["sha"]
    recorded_downstream = candidate.observation["downstream_sha"]
    main_paths = set(git_text(
        runner, root, "diff", "--no-renames", "--name-only",
        recorded_downstream, candidate.current_main, "--",
    ).splitlines())
    reconciliation_paths = set(git_text(
        runner, root, "diff", "--no-renames", "--name-only", remote, reconciliation, "--",
    ).splitlines())
    unexpected = sorted(reconciliation_paths - main_paths)
    if unexpected:
        raise Refusal(
            "Current-main reconciliation contains paths outside the authenticated main delta: "
            + ", ".join(unexpected)
        )
    return sorted(reconciliation_paths)


def derive_filters(paths: list[str], attention: list[str]) -> list[str]:
    if not paths:
        raise Refusal("No semantic-resolution changes exist; publication is not needed.")
    production = sorted(set(path for path in paths + attention if path.startswith("app/src/main/")))
    changed_tests = sorted(set(path for path in paths
                               if path.startswith(("app/src/test/", "app/src/testDebug/"))))
    production_filters, fallback = mosaic_validation_policy.focused_tests(production)
    test_filters, _ = mosaic_validation_policy.focused_tests(changed_tests)
    if fallback and not test_filters:
        raise Refusal("Focused coverage is ambiguous and no supplemental changed test proves intent for: " +
                      ", ".join(fallback))
    filters = sorted((set(production_filters) - {mosaic_validation_policy.ALL_JVM_TESTS}) |
                     set(test_filters))
    if not filters:
        raise Refusal("No meaningful focused JVM filters can be derived from the resolution scope.")
    return filters


def validate_resolution_scope(paths: list[str], attention: list[str]) -> None:
    attention_set = set(attention)
    attention_filters, attention_fallback = mosaic_validation_policy.focused_tests(attention)
    changed_tests = [path for path in paths if path.startswith(("app/src/test/", "app/src/testDebug/"))]
    if attention_fallback and not changed_tests:
        raise Refusal("Attention scope has no deterministic focused-test mapping: " +
                      ", ".join(attention_fallback))
    unrelated = []
    for path in paths:
        if path in attention_set or path == ".upstream-sync/blocked-context.json":
            continue
        if path.startswith(("app/src/test/", "app/src/testDebug/")):
            continue
        if path.startswith("app/src/main/"):
            mapped, fallback = mosaic_validation_policy.focused_tests([path])
            if not fallback and set(mapped) & set(attention_filters):
                continue
        unrelated.append(path)
    if unrelated:
        raise Refusal("Resolution contains paths outside the deterministic attention/test scope: " +
                      ", ".join(unrelated))


def validate_filter_targets(root: Path, filters: list[str]) -> None:
    classes = set()
    for source_root in (root / "app" / "src").glob("test*"):
        if not source_root.is_dir():
            continue
        for source in list(source_root.rglob("*.kt")) + list(source_root.rglob("*.java")):
            text = source.read_text(encoding="utf-8", errors="replace")
            package = re.search(r"^\s*package\s+([\w.]+)", text, re.M)
            if not package:
                continue
            for name in re.findall(r"^\s*(?:public\s+)?(?:class|object)\s+(\w+)", text, re.M):
                classes.add(f"{package.group(1)}.{name}")
    unmatched = [test_filter for test_filter in filters
                 if not any(fnmatchcase(name, test_filter) or fnmatchcase(name.split(".")[-1], test_filter)
                            for name in classes)]
    if unmatched:
        raise Refusal("Focused JVM filters do not match source-controlled tests: " + ", ".join(unmatched))


def resolution_filters(root: Path, candidate: Candidate, derived: list[str]) -> tuple[list[str], str]:
    """Use exact semantic filters only when their candidate binding is authenticated."""
    path = root / RESOLUTION_HANDOFF
    if not path.is_file():
        return derived, "No semantic filter handoff found; using deterministic derived filters."
    try:
        handoff = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise Refusal(f"Semantic filter handoff is malformed: {error}") from error
    if not isinstance(handoff, dict) or handoff.get("schema_version") != 1:
        raise Refusal("Semantic filter handoff must be a schema-version 1 JSON object.")
    expected = {
        "pr_number": int(candidate.pr["number"]),
        "episode_id": marker(candidate.pr.get("body", "")),
        "branch": candidate.pr["head"]["ref"],
    }
    mismatched = [key for key, value in expected.items() if handoff.get(key) != value]
    if mismatched:
        raise Refusal("Semantic filter handoff binding mismatch: " + ", ".join(mismatched))
    filters = handoff.get("test_filters")
    if (not isinstance(filters, list) or not filters
            or any(not isinstance(value, str) or not value.strip() for value in filters)):
        raise Refusal("Semantic filter handoff test_filters must be a non-empty string array.")
    filters = list(dict.fromkeys(value.strip() for value in filters))
    missing = sorted(set(derived) - set(filters))
    if missing:
        raise Refusal(
            "Semantic filter handoff would weaken deterministic coverage; missing: "
            + ", ".join(missing)
        )
    validate_filter_targets(root, filters)
    return filters, f"Authenticated semantic filter handoff: {RESOLUTION_HANDOFF.as_posix()}"


def verify_local_descendant(runner: Runner, root: Path, candidate: Candidate) -> None:
    branch = candidate.pr["head"]["ref"]
    remote_sha = candidate.pr["head"]["sha"]
    current = runner.run(["git", "branch", "--show-current"], cwd=root).stdout.strip()
    if current != branch:
        raise Refusal(f"Expected candidate branch '{branch}', found '{current or 'detached HEAD'}'.")
    runner.run(["git", "fetch", "--no-tags", "origin",
                f"refs/heads/{branch}:refs/remotes/origin/{branch}"], cwd=root)
    fetched = runner.run(["git", "rev-parse", f"refs/remotes/origin/{branch}"], cwd=root).stdout.strip()
    if fetched != remote_sha:
        raise Refusal("Remote candidate head moved after evidence refresh; rerun without overwriting it.")
    ancestry = runner.run(["git", "merge-base", "--is-ancestor", remote_sha, "HEAD"], cwd=root, check=False)
    if ancestry.returncode:
        raise Refusal("Local candidate branch is not a normal descendant of the remote PR head.")


def prepare_command(root: Path, filters: list[str], first=None, second=None, tree=None, *,
                    remote_head=None, original_candidate=None, current_main=None,
                    reconciliation_commit=None) -> list[str]:
    def quote(value):
        return "'" + str(value).replace("'", "''") + "'"
    script = quote(root / "scripts" / "prepare-pr.ps1")
    filter_array = "@(" + ",".join(quote(value) for value in filters) + ")"
    command = f"& {script} -TestFilter {filter_array}"
    if all((first, second, tree)):
        if all((remote_head, original_candidate, current_main, reconciliation_commit)):
            command += (
                f" -PreserveReconciledUpstreamMerge -ExpectedRemoteDraftHead {quote(remote_head)} "
                f"-ExpectedOriginalCandidate {quote(original_candidate)} "
                f"-ExpectedCurrentMain {quote(current_main)} "
                f"-ExpectedReconciliationCommit {quote(reconciliation_commit)}"
            )
        else:
            command += " -PreserveMergeCommit"
        command += (
            f" -ExpectedMergeFirstParent {quote(first)} "
            f"-ExpectedMergeSecondParent {quote(second)} -ExpectedMergeTree {quote(tree)}"
        )
    return ["powershell", "-NoProfile", "-Command", command]


def select_candidate(candidates: list[Candidate], requested: int | None, input_fn=input) -> Candidate | None:
    if not candidates:
        print("No open Upstream Sync attention candidates.")
        return None
    print(render_candidates(candidates))
    selectable = [candidate for candidate in candidates
                  if candidate.state in {"Ready for resolution", "Independent",
                                         "Ready for current-main reconciliation"}]
    if requested is not None:
        matches = [candidate for candidate in candidates if int(candidate.pr["number"]) == requested]
        if len(matches) != 1:
            raise Refusal(f"Open I06 candidate PR #{requested} was not found.")
        chosen = matches[0]
    else:
        default_index = candidates.index(selectable[0]) + 1 if len(selectable) == 1 else None
        try:
            answer = input_fn("\nSelect candidate" + (f" [{default_index}]" if default_index else "") + ": ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nSelection cancelled; no branch was changed.")
            return None
        if not answer and default_index:
            chosen = selectable[0]
        elif answer.isdigit() and 1 <= int(answer) <= len(candidates):
            chosen = candidates[int(answer) - 1]
        else:
            print("Selection cancelled; no branch was changed.")
            return None
    if chosen.state.startswith("Waiting on"):
        raise Refusal(f"PR #{chosen.pr['number']} is {chosen.state}. Resolve its predecessor first.")
    if chosen.state in {"Superseded", "Dependency ambiguous"}:
        detail = f" {chosen.refusal}" if chosen.refusal else ""
        raise Refusal(
            f"PR #{chosen.pr['number']} is {chosen.state}; refusing to guess an integration order."
            f"{detail}"
        )
    return chosen


def publication_phase(root: Path, runner: Runner, candidate: Candidate, input_fn=input,
                      repository=REPOSITORY) -> None:
    repository = authenticate_downstream_repository(repository)
    if candidate.state.startswith("Waiting on") or candidate.state in {"Superseded", "Dependency ambiguous"}:
        raise Refusal(f"Candidate is {candidate.state}; semantic publication is not currently actionable.")
    resolution_first_parent = candidate.pr["head"]["sha"]
    native_conflict = bool(candidate.observation.get("conflict_paths"))
    if candidate.current_main:
        merge_head = git_text(
            runner, root, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False
        )
        head = git_text(runner, root, "rev-parse", "HEAD")
        if merge_head == candidate.current_main:
            resolution_first_parent = reconciliation_commit(runner, root, candidate)
            if native_conflict:
                begin_native_resolution(runner, root, candidate, resolution_first_parent)
                output = root / ".logs" / "upstream-resolution" / f"pr-{candidate.pr['number']}" / "codex-prompt.md"
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(
                    prompt(
                        int(candidate.pr["number"]), candidate.pr, candidate.observation,
                        candidate.ci, "Current main reconciled; upstream resolution active",
                    ),
                    encoding="utf-8", newline="\n",
                )
                print("Current-main reconciliation authenticated. Upstream semantic resolution is now active.")
                print(f"Review `{output.relative_to(root).as_posix()}`, resolve upstream semantics, then rerun.")
                return
        if merge_head == candidate.observation.get("upstream_sha"):
            parents = git_text(runner, root, "show", "-s", "--format=%P", head).split()
            if parents != [candidate.pr["head"]["sha"], candidate.current_main]:
                raise Refusal("Active upstream resolution is not based on exact reconciliation B=[C,M].")
            resolution_first_parent = head
        elif merge_head:
            raise Refusal("Active merge does not match current-main or recorded-upstream identity.")
        elif head == candidate.pr["head"]["sha"]:
            reconciled = begin_main_reconciliation(runner, root, candidate)
            if not reconciled:
                print("Current-main reconciliation started. Review it before upstream resolution.")
                return
            resolution_first_parent = reconciled
            if native_conflict:
                begin_native_resolution(runner, root, candidate, resolution_first_parent)
                print("Current main is already contained. Upstream semantic resolution is now active.")
                return
        else:
            parents = git_text(runner, root, "show", "-s", "--format=%P", head).split()
            if parents != [candidate.pr["head"]["sha"], candidate.current_main]:
                raise Refusal("Local reconciliation commit does not have exact parents [C,M].")
            resolution_first_parent = head
            if native_conflict:
                begin_native_resolution(runner, root, candidate, resolution_first_parent)
                print("Authenticated reconciliation found. Upstream semantic resolution is now active.")
                return
    verify_local_descendant(runner, root, candidate)
    if native_conflict:
        assert_native_merge_identity(runner, root, candidate, resolution_first_parent)
    paths = resolution_paths(runner, root, candidate.pr["head"]["sha"])
    attention = sorted(set(candidate.observation.get("review_paths") or []) |
                       set(candidate.observation.get("conflict_paths") or []))
    reconciliation_paths = validate_reconciliation_scope(
        runner, root, candidate, resolution_first_parent
    )
    upstream_paths = sorted(set(paths) - set(reconciliation_paths))
    validate_resolution_scope(upstream_paths, attention)
    derived_filters = derive_filters(paths, attention)
    validate_filter_targets(root, derived_filters)
    filters, filter_source = resolution_filters(root, candidate, derived_filters)
    print("\nPublication plan")
    print(f"PR: #{candidate.pr['number']} (same Draft)")
    print("Changes:")
    for path in paths:
        print(f"- {path}")
    print("Validation:\n  Focused tests:")
    for test_filter in filters:
        print(f"  - {test_filter}")
    print(f"  Source: {filter_source}")
    try:
        approved = input_fn("\nReady to PUSH? [y/N]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        approved = ""
    if approved != "y":
        print("Publication cancelled; nothing was committed or pushed.")
        return

    refreshed = classify_dependencies(
        runner, root, open_candidates(runner, root, repository), repository
    )
    matches = [item for item in refreshed if int(item.pr["number"]) == int(candidate.pr["number"])]
    if len(matches) != 1 or marker(matches[0].pr.get("body", "")) != marker(candidate.pr.get("body", "")):
        raise Refusal("Candidate PR/episode changed immediately before publication.")
    current = matches[0]
    if current.state.startswith("Waiting on") or current.state in {"Superseded", "Dependency ambiguous"}:
        raise Refusal(f"Candidate is now {current.state}; prepare-pr was not invoked.")
    if current.pr["head"]["sha"] != candidate.pr["head"]["sha"]:
        raise Refusal("Remote candidate head changed immediately before publication.")
    if candidate.current_main:
        keys = (
            "episode_id", "downstream_sha", "upstream_sha", "ownership_policy_version",
            "existing_pr_number", "existing_pr_branch", "existing_pr_head_sha",
            "candidate_sha", "candidate_tree", "comparison_baseline",
            "classification_range_count", "review_paths", "conflict_paths",
        )
        if (current.current_main != candidate.current_main
                or any(current.current_observation.get(key) != candidate.current_observation.get(key)
                       for key in keys)):
            raise Refusal("Fresh current-main reuse evidence changed after review began.")
    verify_local_descendant(runner, root, current)
    current_paths = resolution_paths(runner, root, current.pr["head"]["sha"])
    current_reconciliation_paths = validate_reconciliation_scope(
        runner, root, current, resolution_first_parent
    )
    validate_resolution_scope(
        sorted(set(current_paths) - set(current_reconciliation_paths)), attention
    )
    current_derived_filters = derive_filters(current_paths, attention)
    validate_filter_targets(root, current_derived_filters)
    current_filters, _ = resolution_filters(root, current, current_derived_filters)
    if current_paths != paths or current_filters != filters:
        raise Refusal("Resolution scope or focused-test plan changed after approval; rerun and review it.")
    if native_conflict:
        authenticate_upstream_history(runner, root, current.observation["upstream_sha"])
        _, tree = commit_native_resolution(
            runner, root, current, current_paths, resolution_first_parent
        )
        first = resolution_first_parent
        second = current.observation["upstream_sha"]
        command = prepare_command(
            root, filters, first, second, tree,
            remote_head=current.pr["head"]["sha"] if current.current_main else None,
            original_candidate=current.observation.get("candidate_sha") if current.current_main else None,
            current_main=current.current_main,
            reconciliation_commit=first if current.current_main else None,
        )
    elif current.current_main:
        _, tree = commit_clean_reconciled_resolution(
            runner, root, current, current_paths, resolution_first_parent
        )
        command = prepare_command(
            root, filters, resolution_first_parent, current.observation["upstream_sha"], tree,
            remote_head=current.pr["head"]["sha"],
            original_candidate=current.observation.get("candidate_sha"),
            current_main=current.current_main,
            reconciliation_commit=resolution_first_parent,
        )
    else:
        command = prepare_command(root, filters)
    runner.run(command, cwd=root)


def prompt(number: int, pr: dict, observation: dict, ci: dict,
           dependency="Ready for resolution") -> str:
    commits = observation.get("incoming_commits") or []
    paths = sorted(set(observation.get("review_paths") or []) | set(observation.get("conflict_paths") or []))
    commit_lines = []
    for commit in commits:
        sha = str(commit.get("sha") or "")
        subject = " ".join(str(commit.get("subject") or "Untitled upstream commit").split())
        url = commit.get("url")
        commit_lines.append(f"- {sha[:7]} - {subject}" + (f"\n  {url}" if url else ""))
    if not commit_lines:
        commit_lines = ["- Exact incoming commit details were unavailable; inspect the linked Actions run and Git history."]
    path_lines = [f"- {path}" for path in paths] or ["- No attention paths were recovered; inspect the linked run before editing."]
    ci_lines = [f"{ci['status']}" + (f" - {ci['name']}" if ci.get("name") else "")]
    if ci.get("url"):
        ci_lines.append(ci["url"])
    workspace = ("The resolver has authenticated its deterministic blocked workspace and started a real "
                 "merge of the exact recorded upstream tip. Resolve the active merge semantically; its "
                 "first parent will remain the exact remote Draft candidate, which is itself bound to the "
                 "recorded Mosaic baseline." if observation.get("conflict_paths") else
                 "This textually clean REVIEW candidate already has native upstream ancestry. Inspect and "
                 "adjust its semantics only where review proves that necessary.")
    return f"""# Resolve Upstream Sync PR #{number}

Resolve the currently checked-out Upstream Sync candidate for PR #{number}.

This branch was created by I06. {workspace}

Do not interpret the absence of Git conflict markers as proof that the semantic
integration is complete.

Candidate state: {'Draft - attention required' if pr.get('draft') else 'Normal PR - verify attention disposition'}
Dependency state: {dependency}
Episode ID: {marker(pr.get('body', ''))}
Upstream SHA: {observation.get('upstream_sha', 'unavailable')}
Downstream baseline SHA: {observation.get('downstream_sha', 'unavailable')}

## Incoming upstream changes

{chr(10).join(commit_lines)}

## Attention paths

{chr(10).join(path_lines)}

Cleanly integrated paths: {int(observation.get('clean_path_count') or 0)}

## Current CI

{chr(10).join(ci_lines)}

For every attention path:

1. Reconstruct the exact upstream intent from the recorded evidence and Git history.
2. Inspect current Mosaic behavior.
3. Preserve both where compatible.
4. Never blindly choose ours or theirs.
5. Preserve already-integrated clean upstream changes.
6. Preserve Enhanced Wholphin OFF behavior.
7. Preserve Mosaic acquisition, Series, and Downloads behavior where applicable.
8. Add or update tests where behavior changes.

Start with compile/runtime blockers exposed by CI, then resolve the remaining
attention paths semantically. Inspect the linked run when bounded failure evidence
is unavailable. Run focused validation as you work.

Write `{RESOLUTION_HANDOFF.as_posix()}` as schema-version 1 JSON containing the
current PR number, episode ID, branch, and exact meaningful JVM test filters:

```json
{{
  "schema_version": 1,
  "pr_number": {number},
  "episode_id": "{marker(pr.get('body', ''))}",
  "branch": "{pr.get('head', {}).get('ref', '')}",
  "test_filters": ["fully.qualified.TestClass"]
}}
```

Derive filters from behavior actually changed or preserved and prefer the
narrowest meaningful existing or newly added tests. The resolver authenticates
the binding and source-controlled targets, and refuses a handoff that omits its
deterministic coverage floor, before passing the exact filters to prepare-pr. If
no suitable focused JVM test exists, add the required test before publication.

Do not push, commit the active merge, mark the PR Ready, rewrite candidate history,
or force-update the branch. Resolve and stage the reviewed merge paths; the resolver
owns the authenticated merge commit only after explicit publication approval.

Report the semantic decisions made, tests changed, and validation needed before
this Draft can become Ready.
"""


def selected_output(number: int, root: Path, candidate: Candidate, runner: Runner) -> tuple[str, Path]:
    pr, observation = candidate.pr, candidate.observation
    run_url = observation.get("run_url")
    ci = candidate.ci
    checkout(runner, root, pr["head"]["ref"], pr["head"]["sha"])
    draft_extension_paths = validate_draft_extension_scope(runner, root, candidate)
    if candidate.state == "Ready for current-main reconciliation":
        reconciled = begin_main_reconciliation(runner, root, candidate)
        if not reconciled:
            content = reconciliation_prompt(candidate, runner, root, draft_extension_paths)
            output = root / ".logs" / "upstream-resolution" / f"pr-{number}" / "codex-prompt.md"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(content, encoding="utf-8", newline="\n")
            return ("\n".join([
                "Upstream resolution", "", f"PR:          #{number}",
                "Dependency:  Ready for current-main reconciliation", "",
                "Current-main reconciliation is active.",
                f"Read `{output.relative_to(root).as_posix()}` and review it exactly.",
                "Upstream semantic resolution has not begun.",
            ]), output)
    if observation.get("conflict_paths"):
        begin_native_resolution(runner, root, candidate, reconciled if candidate.current_main else None)
    content = prompt(number, pr, observation, ci, candidate.state)
    output = root / ".logs" / "upstream-resolution" / f"pr-{number}" / "codex-prompt.md"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(content, encoding="utf-8", newline="\n")
    paths = sorted(set(observation.get("review_paths") or []) | set(observation.get("conflict_paths") or []))
    clean = int(observation.get("clean_path_count") or 0)
    summary = [
        "Upstream resolution", "",
        f"PR:          #{number}",
        f"State:       {'Draft - attention required' if pr.get('draft') else 'Normal - verify attention disposition'}",
        f"Dependency:  {candidate.state}", "",
        "Branch:", pr["head"]["ref"], "",
        f"{len(paths)} requiring attention",
        *[f"- {path}" for path in paths], "",
        f"{clean} additional file{'s' if clean != 1 else ''} integrate cleanly.", "",
        f"CI: {ci['status']}",
    ]
    if ci.get("name"):
        summary.append(f"Check: {ci['name']}")
    if ci.get("url"):
        summary.append(f"Run: {ci['url']}")
    elif run_url:
        summary.append(f"Latest sync: {run_url}")
    relative_output = output.relative_to(root).as_posix()
    summary += ["", "Checked out candidate branch successfully.", "",
                f"Read `{relative_output}` and carry out the instructions exactly.", "",
                "Ready for semantic resolution."]
    return "\n".join(summary), output


def execute(number: int, root: Path, runner: Runner) -> tuple[str, Path]:
    assert_preflight(runner, root)
    repository = authenticated_origin(runner, root)
    pr = json_output(runner, ["gh", "api", f"repos/{repository}/pulls/{number}"], root)
    episode = validate_pr(pr, number, repository)
    observation, _ = load_observation(runner, root, pr, episode, repository)
    candidate = Candidate(
        pr, observation, checks(runner, root, number, repository), state="Ready for resolution"
    )
    return selected_output(number, root, candidate, runner)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pr", type=int)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    try:
        runner = Runner()
        branch, dirty = assert_preflight(
            runner, root, allow_dirty=True, allow_resolution_merge=True
        )
        repository = authenticated_origin(runner, root)
        candidates = classify_dependencies(
            runner, root, open_candidates(runner, root, repository), repository
        )
        current = [candidate for candidate in candidates if candidate.pr["head"]["ref"] == branch]
        if current:
            if args.pr is not None and int(current[0].pr["number"]) != args.pr:
                raise Refusal(f"Current candidate branch belongs to PR #{current[0].pr['number']}, not PR #{args.pr}.")
            publication_phase(root, runner, current[0], repository=repository)
            return 0
        if dirty:
            raise Refusal("Working tree is not clean. Preserve local work separately before selecting another candidate.")
        chosen = select_candidate(candidates, args.pr)
        if chosen is None:
            return 0
        summary, _ = selected_output(int(chosen.pr["number"]), root, chosen, runner)
        print(summary)
        return 0
    except Refusal as error:
        print(f"resolve-upstream: REFUSED\n{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
