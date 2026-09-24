"""Hosted-only normal Git integration; no application code or build is executed.

The observe job has read permission. The publish job repeats the observation in
a fresh disposable repository and checks the first job's exact SHA pair.
"""

import argparse
import datetime
import hashlib
import html
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unicodedata
from urllib.parse import quote

from mosaic_repository import (
    MOSAIC_DOWNSTREAM_REPOSITORY,
    UPSTREAM_REPOSITORY,
    authenticate_downstream_repository,
)


ORIGIN = MOSAIC_DOWNSTREAM_REPOSITORY
UPSTREAM = UPSTREAM_REPOSITORY
URLS = {"origin": f"https://github.com/{ORIGIN}.git",
        "upstream": f"https://github.com/{UPSTREAM}.git"}
# Reviewed, already integrated official upstream commit at implementation time.
INITIAL_ANCHOR = "1778bdb34caa699c0590232a7de709a889839765"
PREFIX = "chore/sync-upstream-"
BRANCH = re.compile(re.escape(PREFIX) + r"([0-9a-f]{40})-([0-9a-f]{40})$")
POLICY_PATH = Path(__file__).with_name("upstream_ownership_policy.json")
OWNERSHIP = {"FOLLOW", "REVIEW", "DOWNSTREAM-OWNED"}
EPISODE_MARKER = re.compile(r"<!-- wholphin-upstream-episode:([0-9a-f]{64}) -->")
ANSI_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ANSI_OSC = re.compile(r"\x1b\].*?(?:\x07|\x1b\\)", re.DOTALL)
CREDENTIAL_URL = re.compile(r"(?i)\b(https?://)[^\s/@]+@")
AUTHORIZATION_VALUE = re.compile(
    r"(?i)\b(authorization\s*[:=]\s*)(?:(?:basic|bearer|token)\s+)?[^\s|]+"
)
GITHUB_TOKEN = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_.-]+|github_pat_[A-Za-z0-9_]+)\b")
WORKFLOW_COMMAND = re.compile(r"^\s*::")
DIAGNOSTIC_MAX_LINES = 8
DIAGNOSTIC_MAX_CHARS = 1200
DIAGNOSTIC_TRUNCATION = "... diagnostic truncated ..."
OPERATION_CREDENTIAL_KEYS = {"GH_TOKEN", "GITHUB_TOKEN", "SYNC_PUBLISH_TOKEN"}


class Blocked(RuntimeError):
    pass


class IdentityError(Blocked):
    pass


def load_policy(path=POLICY_PATH):
    policy = json.loads(Path(path).read_text(encoding="utf-8"))
    if policy.get("schemaVersion") != 1 or policy.get("defaultAutomationOwnership") != "REVIEW":
        raise IdentityError("Unsupported upstream ownership policy.")
    if not set(policy.get("paths", {}).values()) <= OWNERSHIP:
        raise IdentityError("Unknown upstream ownership classification.")
    return policy


def ownership(path, policy):
    if path in policy["paths"]:
        return policy["paths"][path]
    return "REVIEW" if path.startswith(".github/") else "FOLLOW"


def classify_changes(git, base, up, policy, downstream=None):
    raw = git.run("diff", "--name-status", "-z", "--find-renames", base, up, "--").stdout
    fields = raw.rstrip("\0").split("\0") if raw else []
    result, index = [], 0
    while index < len(fields):
        status = fields[index]
        index += 1
        old = fields[index]
        index += 1
        new = old
        if status.startswith(("R", "C")):
            new = fields[index]
            index += 1
        old_owner, new_owner = ownership(old, policy), ownership(new, policy)
        classification = "REVIEW" if old != new and old_owner != new_owner else new_owner
        if old != new and old_owner != new_owner:
            reason = "rename crosses ownership boundary"
        elif classification == "DOWNSTREAM-OWNED":
            reason = "trusted downstream policy preserves this exact path"
        elif classification == "REVIEW":
            reason = ("trusted downstream policy requires semantic review" if new in policy["paths"]
                      else "unmapped automation path defaults to REVIEW")
        elif new in policy["paths"]:
            reason = "trusted downstream policy follows upstream"
        else:
            reason = "non-automation path follows upstream by default"
        def blob(commit, path):
            value = git.run("rev-parse", f"{commit}:{path}", check=False)
            return value.stdout.strip() if value.returncode == 0 else None
        result.append({"status": status, "old_path": old, "path": new,
                       "old_blob": blob(base, old), "new_blob": blob(up, new),
                       "downstream_blob": blob(downstream or base, new),
                       "downstream_old_blob": blob(downstream or base, old),
                       "old_ownership": old_owner, "new_ownership": new_owner,
                       "ownership": classification,
                       "counterpart": old if old != new else None,
                       "reason": reason,
                       "affects_candidate": classification != "DOWNSTREAM-OWNED"})
    return result


def verify_complete_classification(git, base, upstream, changes):
    """Prove that classification accounts for the complete native upstream range."""
    expected = git.run(
        "diff", "--name-status", "-z", "--find-renames", base, upstream, "--"
    ).stdout
    fields = expected.rstrip("\0").split("\0") if expected else []
    range_rows, index = [], 0
    while index < len(fields):
        status = fields[index]
        index += 1
        old_path = fields[index]
        index += 1
        path = old_path
        if status.startswith(("R", "C")):
            path = fields[index]
            index += 1
        range_rows.append((status, old_path, path))
    classified_rows = [
        (row.get("status"), row.get("old_path"), row.get("path")) for row in changes
    ]
    if classified_rows != range_rows:
        raise Blocked("Complete upstream range classification does not match the Git diff.")
    if any(row.get("ownership") not in OWNERSHIP for row in changes):
        raise Blocked("Complete upstream range contains an unknown ownership classification.")
    return range_rows


def verify_native_merge_candidate(git, candidate, downstream, upstream, tree=None):
    """Authenticate exact native merge parents and, when supplied, its reviewed tree."""
    parents = git.text("show", "-s", "--format=%P", candidate).split()
    candidate_tree = git.text("rev-parse", candidate + "^{tree}")
    if parents != [downstream, upstream]:
        raise Blocked("Native merge candidate does not have the exact trusted parent order.")
    if tree is not None and candidate_tree != tree:
        raise Blocked("Native merge candidate tree differs from the reviewed merge tree.")
    return candidate_tree


def native_merge_candidate(git, downstream, upstream, tree, message):
    """Create and authenticate a deterministic native two-parent merge commit."""
    if git.text("rev-parse", "HEAD") != downstream:
        raise Blocked("Native merge first-parent checkout moved during candidate construction.")
    merge_heads = git.text("rev-parse", "MERGE_HEAD").splitlines()
    if merge_heads != [upstream]:
        raise Blocked("Native merge second parent does not match the trusted upstream tip.")
    if git.text("write-tree") != tree:
        raise Blocked("Native merge index tree changed before candidate construction.")
    candidate = git.run(
        "commit-tree", tree, "-p", downstream, "-p", upstream, input=message
    ).stdout.strip()
    verify_native_merge_candidate(git, candidate, downstream, upstream, tree)
    return candidate


def preserve_downstream_owned(git, downstream, changes):
    for change in changes:
        if change["ownership"] != "DOWNSTREAM-OWNED":
            continue
        # A same-owner rename changes two path states. Restore both the old and
        # new path exactly as downstream records them rather than accepting half
        # of the upstream rename while excluding the other half.
        for path in sorted({change["old_path"], change["path"]}):
            exists = git.run("cat-file", "-e", f"{downstream}:{path}", check=False).returncode == 0
            if exists:
                git.run("checkout", downstream, "--", path)
                git.run("add", "--", path)
            else:
                git.run("rm", "-f", "--ignore-unmatch", "--", path)


def display_text(value):
    return html.escape(str(value)).replace("\r", "\\r").replace("\n", "\\n").replace("@", "&#64;")


def display_markdown_text(value):
    return display_text(value).translate(str.maketrans({
        "[": "&#91;", "]": "&#93;", "(": "&#40;", ")": "&#41;", "`": "&#96;"}))


def attention_paths(observation):
    return sorted(set(observation.get("review_paths", [])) | set(observation.get("conflict_paths", [])))


def attention_episode(observation):
    paths = set(attention_paths(observation))
    rows = []
    for change in observation.get("automation_changes", []):
        if change.get("path") in paths:
            rows.append({"path": change.get("path"),
                         "counterpart": change.get("counterpart"),
                         "status": change.get("status"),
                         "ownership": change.get("ownership"),
                         "downstream_blob": change.get("downstream_blob"),
                         "downstream_old_blob": change.get("downstream_old_blob"),
                         "textual_conflict": change.get("path") in observation.get("conflict_paths", [])})
    payload = {"schemaVersion": 1,
               "policyVersion": observation.get("ownership_policy_version"),
               "attention": sorted(rows, key=lambda row: (row["path"] or "", row["ownership"] or ""))}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def finalize_attention(git, observation, base, upstream):
    paths = attention_paths(observation)
    observation["clean_path_count"] = sum(
        change.get("affects_candidate") and change.get("path") not in paths
        for change in observation.get("automation_changes", []))
    if paths:
        observation["episode_id"] = attention_episode(observation)


def episode_marker(observation):
    episode = observation.get("episode_id")
    return f"<!-- wholphin-upstream-episode:{episode} -->" if episode else ""


def pull_episode(pull):
    match = EPISODE_MARKER.search(pull.get("body") or "")
    return match.group(1) if match else None


def blob_url(repository, sha, path):
    if not sha or not path:
        return None
    return f"https://github.com/{repository}/blob/{sha}/{quote(path, safe='/')}"


def downstream_repository(observation):
    """Return the exact authenticated downstream identity recorded by this run."""
    return authenticate_downstream_repository(observation.get("downstream_repo"))


def candidate_pr_navigation(observation):
    """Return one canonical downstream PR link, never an upstream-controlled URL."""
    waiting = observation.get("outcome") == "waiting_on_existing_pr"
    number = str(observation.get("blocking_pr_number" if waiting else "pr_number") or "")
    supplied_url = str(observation.get("blocking_pr_url" if waiting else "pr_url") or "").rstrip("/")
    if not number and supplied_url:
        repository = downstream_repository(observation)
        match = re.fullmatch(rf"https://github\.com/{re.escape(repository)}/pull/(\d+)", supplied_url)
        number = match.group(1) if match else ""
    if not number.isdigit() or int(number) <= 0:
        return ""
    canonical = f"https://github.com/{downstream_repository(observation)}/pull/{number}"
    if supplied_url and supplied_url != canonical:
        return ""
    return f"PR #{number}  [open]({canonical})"


def candidate_branch_navigation(observation):
    branch = str(observation.get("branch") or "")
    if not BRANCH.fullmatch(branch):
        return ""
    repository = downstream_repository(observation)
    return f"Candidate branch  [inspect](https://github.com/{repository}/tree/{quote(branch, safe='/')})"


def ownership_rows(observation, category):
    return [change for change in observation.get("automation_changes", [])
            if change.get("ownership") == category]


def attention_evidence(observation, *, rich_upstream=False):
    """Render the human decision before bulk history, with optional trusted blob links."""
    paths = attention_paths(observation)
    changes = {change.get("path"): change for change in observation.get("automation_changes", [])}
    conflict_paths = set(observation.get("conflict_paths", []))
    lines = []
    for path in paths:
        change = changes.get(path, {})
        rendered_path = f"<code>{display_text(path)}</code>"
        if rich_upstream:
            upstream_side = (f"[Incoming upstream]({blob_url(UPSTREAM, observation.get('upstream_sha'), path)})"
                             if change.get("new_blob") else "incoming upstream absent")
            if change.get("downstream_blob"):
                downstream_side = f"[Current Mosaic]({blob_url(downstream_repository(observation), observation.get('downstream_sha'), path)})"
            elif change.get("downstream_old_blob") and change.get("counterpart"):
                counterpart = change["counterpart"]
                downstream_side = (f"[Current Mosaic prior path]({blob_url(downstream_repository(observation), observation.get('downstream_sha'), counterpart)}) "
                                   f"<code>{display_text(counterpart)}</code>")
            else:
                downstream_side = "current Mosaic absent"
            rendered_path += f" · {downstream_side} | {upstream_side}"
        lines.append(f"- {rendered_path}")
        if path in conflict_paths:
            lines.append("  - Git textual conflict: human semantic resolution is required.")
        if change.get("ownership") == "REVIEW" or path in observation.get("review_paths", []):
            reason = display_text(change.get("reason") or observation.get("cross_file_review")
                                  or "downstream policy requires semantic review")
            textual_note = "" if path in conflict_paths else " Git merged textually, but that does not resolve the semantic review."
            lines.append(f"  - Semantic REVIEW: {reason}.{textual_note}".replace("..", "."))
    return lines


def pull_reference_numbers(subject):
    patterns = (
        rf"https?://github\.com/{re.escape(UPSTREAM)}/(?:pull|issues)/(\d+)",
        rf"(?<![\w/]){re.escape(UPSTREAM)}#(\d+)",
        r"(?<![\w/])#(\d+)",
    )
    return list(dict.fromkeys(number for pattern in patterns
                              for number in re.findall(pattern, subject, flags=re.IGNORECASE)))


def quiet_subject(value):
    """Render upstream-controlled text without live URLs, mentions, or issue references."""
    text = str(value or "Untitled upstream commit")
    text = re.sub(r"https?://[^\s<>()]+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"(?<![\w/])[\w.-]+/[\w.-]+#\d+", "", text)
    text = re.sub(r"\(?\s*#\d+\s*\)?", "", text)
    text = " ".join(text.split()).strip(" -\N{EM DASH}\N{MIDDLE DOT}()")
    return display_markdown_text(text or "Untitled upstream commit")


def commit_presentation(commit, *, rich_upstream=False):
    sha = commit.get("sha") or ""
    raw_subject = commit.get("subject") or "Untitled upstream commit"
    numbers = commit.get("pull_request_numbers") or pull_reference_numbers(raw_subject)
    short = display_text(sha[:7] or "unknown")
    if rich_upstream:
        subject = display_markdown_text(re.sub(r"\s*\(#\d+\)\s*$", "", raw_subject))
        commit_url = commit.get("url") or (f"https://github.com/{UPSTREAM}/commit/{sha}" if sha else None)
        commit_text = f"[`{short}`]({commit_url})" if commit_url else f"`{short}`"
        references = [f"[PR {number}](https://github.com/{UPSTREAM}/pull/{number})" for number in numbers]
    else:
        subject = quiet_subject(raw_subject)
        commit_text = f"<code>{short}</code>"
        references = [f"PR {display_text(number)}" for number in numbers]
    reference_text = (" ".join(references) + " \N{EM DASH} ") if references else ""
    return f"{reference_text}{subject} \N{MIDDLE DOT} {commit_text}"


def technical_evidence(observation):
    return json.dumps({
        key: observation.get(key) for key in (
            "schema_version", "ownership_policy_version", "episode_id", "upstream_repo",
            "upstream_base_sha", "upstream_sha", "downstream_repo", "downstream_sha",
            "comparison_baseline", "candidate_sha", "candidate_tree", "branch", "outcome",
            "candidate_parents", "classification_range_count", "ownership_counts", "review_paths",
            "conflict_paths", "clean_path_count", "blocking_pr_number", "blocking_pr_url",
            "blocking_pr_head_sha", "blocking_pr_branch", "blocking_upstream_sha",
            "blocking_downstream_sha", "existing_pr_number", "existing_pr_branch",
            "existing_pr_head_sha",
            "configured_schedule_utc", "observed_at", "run_url")
        if observation.get(key) is not None
    }, indent=2, ensure_ascii=True)


def human_evidence(observation, *, rich_upstream=False, include_technical=True,
                   include_attention=True):
    lines = []
    paths = attention_paths(observation)
    if include_attention:
        lines += [f"{len(paths)} requiring attention", ""]
        lines += attention_evidence(observation, rich_upstream=rich_upstream) or ["- None"]
    commits = observation.get("incoming_commits", [])
    lines += ["", f"{len(commits)} incoming", ""]
    lines += [f"- {commit_presentation(commit, rich_upstream=rich_upstream)}"
              for commit in commits[:10]] or ["- None"]
    if len(commits) > 10:
        lines.append(f"- {len(commits) - 10} additional incoming commits are retained in the observation artifact.")
    clean = int(observation.get("clean_path_count") or 0)
    if clean:
        verb = "integrates" if clean == 1 else "integrate"
        lines += ["", f"{clean} additional file{'s' if clean != 1 else ''} {verb} cleanly."]
    if observation.get("run_url"):
        lines += ["", f"Latest observation: [{display_text(observation['run_url'])}]({observation['run_url']})"]
    if include_technical:
        lines += ["", "<details>", "<summary>Technical evidence</summary>", "", "```json",
                  technical_evidence(observation), "```", "", "</details>"]
        marker = episode_marker(observation)
        if marker:
            lines += ["", marker]
        if observation.get("upstream_sha") and observation.get("ancestry_validated"):
            lines += ["", f"<!-- wholphin-upstream-observed:{observation['upstream_sha']} -->"]
    return "\n".join(lines) + "\n"


def candidate_title(observation, draft):
    if draft:
        names = [quiet_subject(Path(path).name) for path in attention_paths(observation)]
        scope = ", ".join(names[:2])
        if len(names) > 2:
            scope += f" and {len(names) - 2} more"
        return "chore: review upstream changes" + (f" to {scope}" if scope else "")
    return "chore: synchronize official upstream"


def observation_handoff_summary(observation):
    """Keep Observe technical; Publish owns the final non-no-delta operator outcome."""
    return (
        "## Upstream observation recorded\n\n"
        "The Publish candidate job will reauthenticate these exact inputs and report the final "
        "operator action.\n\n"
        "<details>\n<summary>Observation evidence</summary>\n\n<pre>" +
        html.escape(json.dumps(observation, indent=2, ensure_ascii=True)) +
        "</pre>\n\n</details>\n"
    )


def upstream_summary(observation, *, publication=False, operation_error=False):
    outcome = observation['outcome']
    handed_off = {'observed_excluded', 'ready', 'review_required', 'semantic_conflict',
                  'existing_pr', 'existing_draft_pr', 'waiting_on_existing_pr'}
    if not publication and not operation_error and outcome in handed_off:
        return observation_handoff_summary(observation)
    changes = observation.get('automation_changes', [])
    change_count = len(changes)
    change_word = 'change' if change_count == 1 else 'changes'
    attention_count = len(attention_paths(observation))
    attention_verb = 'requires' if attention_count == 1 else 'require'
    pr_navigation = candidate_pr_navigation(observation)
    branch_navigation = candidate_branch_navigation(observation)
    if operation_error:
        heading = 'Upstream publication failed' if publication else 'Upstream observation failed'
        if publication and not pr_navigation:
            action = ('No candidate PR was confirmed. The deterministic branch may already exist if '
                      'publication stopped after its push; inspect the outcome artifact and branch before rerunning.')
        else:
            action = 'Inspect the refusal below before retrying.'
    elif outcome in {'blocked', 'semantic_conflict'}:
        heading = f'{change_count} upstream {change_word} · review required'
        action = (f'{attention_count} path{"s" if attention_count != 1 else ""} {attention_verb} semantic resolution. '
                  'No automatic merge is performed.')
    else:
        blocking_number = display_text(observation.get('blocking_pr_number') or '')
        heading = {
            'no_delta': 'No upstream changes',
            'observed_excluded': f'{change_count} upstream {change_word} · observed but excluded',
            'ready': f'{change_count} upstream {change_word} · none require attention',
            'review_required': f'{change_count} upstream {change_word} · review required',
            'existing_pr': f'{change_count} upstream {change_word} · candidate already open',
            'existing_draft_pr': f'{change_count} upstream {change_word} · review candidate already open',
            'waiting_on_existing_pr': (f'Waiting on PR #{blocking_number}' if blocking_number
                                       else 'Waiting on existing upstream PR'),
            'pr_created': f'{change_count} upstream {change_word} · candidate created',
            'review_pr_created': f'{change_count} upstream {change_word} · review candidate created',
        }.get(outcome, 'Upstream check complete')
        action = {
            'no_delta': 'No action is required. The existing UTC schedule will check again automatically.',
            'observed_excluded': ('Downstream-owned changes were observed but excluded; Mosaic state was preserved. '
                                  'No candidate is required.'),
            'ready': 'No paths require attention. Candidate publication will run next.',
            'review_required': (f'{attention_count} path{"s" if attention_count != 1 else ""} {attention_verb} review. '
                                'A Draft candidate will be prepared next.'),
            'existing_pr': 'Continue review in the existing candidate PR; no duplicate was created.',
            'existing_draft_pr': 'Continue semantic resolution in the existing Draft PR; no duplicate was created.',
            'waiting_on_existing_pr': ('The current newer upstream observation is retained. '
                                       'No duplicate candidate branch or PR was created.'),
            'pr_created': 'Review the candidate PR. Merge or reject remains a human decision.',
            'review_pr_created': 'Resolve the identified paths in the Draft PR. No automatic merge is performed.',
        }.get(outcome, 'Inspect the technical details before taking action.')
    failure_reason = ''
    if operation_error or outcome in {'blocked', 'semantic_conflict'}:
        failure_reason = '\n\nReason: ' + display_text(
            observation.get('reason') or 'Semantic review is required.')
    # Retain full evidence and escape remote/user-controlled strings. Keep this in
    # the existing protected sync helper rather than adding an executable dependency.
    counts = observation.get('ownership_counts') or {}
    count_text = []
    if counts:
        count_text = [f'Upstream changes: {change_count}', '',
                      f"- FOLLOW: {counts.get('FOLLOW', 0)} — normal candidate integration",
                      f"- REVIEW: {counts.get('REVIEW', 0)} — semantic/manual review required",
                      f"- DOWNSTREAM-OWNED: {counts.get('DOWNSTREAM-OWNED', 0)} — observed but excluded"]
        for category in ("FOLLOW", "REVIEW", "DOWNSTREAM-OWNED"):
            rows = [change for change in changes
                    if change.get("ownership") == category]
            if rows:
                count_text += ['', f'### {category}', '']
                for change in rows:
                    path = display_text(change.get("path", "unknown"))
                    change_reason = display_text(change.get("reason", ""))
                    count_text.append(f'- <code>{path}</code> — {change_reason}')
        count_text += ['', 'Configured schedule: <code>' +
                       display_text(observation.get('configured_schedule_utc', 'unknown')) +
                       '</code>; observed start: <code>' +
                       display_text(observation.get('observed_at', 'unknown')) + '</code>.']
    primary = []
    if outcome == 'waiting_on_existing_pr':
        primary += ['### Existing review blocker', '']
        if pr_navigation:
            primary += [pr_navigation, '']
        primary += ['Resolve the authenticated existing candidate before publishing this distinct newer episode.']
    elif attention_count:
        primary += ['### Review required', '']
        if pr_navigation:
            primary += [pr_navigation, '']
        elif operation_error and publication and branch_navigation:
            primary += [branch_navigation, '']
        primary += [f'{attention_count} path{"s" if attention_count != 1 else ""} '
                    f'{attention_verb} semantic review:', '']
        primary += attention_evidence(observation, rich_upstream=True)
        if pr_navigation:
            primary += ['', 'Next: run `.\\scripts\\resolve-upstream.ps1`, enter this Draft PR number, '
                        'and follow its authenticated semantic-resolution handoff.']
    elif pr_navigation:
        primary += ['### Candidate ready', '', pr_navigation]
    elif operation_error and publication and branch_navigation:
        primary += ['### Publication state', '', branch_navigation]
    if counts:
        primary += ['', f"- {attention_count} requiring attention",
                    f"- {counts.get('FOLLOW', 0)} follow upstream",
                    f"- {counts.get('DOWNSTREAM-OWNED', 0)} preserved downstream"]
    primary_text = ('\n'.join(primary) + '\n\n') if primary else ''
    navigation = human_evidence(observation, rich_upstream=True, include_technical=False,
                                include_attention=False)
    return (f'## {heading}\n\n{primary_text}{action}{failure_reason}\n\n'
            '<details>\n<summary>Operator navigation</summary>\n\n' + navigation + '\n</details>\n\n'
            '<details>\n<summary>Technical details</summary>\n\n' + '\n'.join(count_text) +
            '\n\n### Complete machine evidence\n\n<pre>' +
            html.escape(json.dumps(observation, indent=2, ensure_ascii=True)) +
            '</pre>\n\n</details>\n')


class OperationError(Blocked):
    """Operational failure reported separately from expected blocked states."""


def operation_credentials(env):
    """Return operation-scoped credential values for exact-match redaction only."""
    values = set()
    for source in (os.environ, env or {}):
        for key in OPERATION_CREDENTIAL_KEYS:
            value = source.get(key)
            if value:
                values.add(str(value))
    return sorted(values, key=len, reverse=True)


def sanitize_command_diagnostic(stdout, stderr, *, credentials=()):
    """Return bounded native command detail that is safe for logs and evidence."""
    # Git porcelain rejection detail may be on stdout while remote diagnostics
    # commonly use stderr. Preserve both, but never preserve their raw framing.
    text = "\n".join(value for value in (stderr, stdout) if isinstance(value, str) and value)
    text = ANSI_OSC.sub("", text)
    text = ANSI_CSI.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(
        character if character in "\n\t" or unicodedata.category(character) not in {"Cc", "Cf"}
        else " "
        for character in text
    )
    text = CREDENTIAL_URL.sub(r"\1[credentials-redacted]@", text)
    text = AUTHORIZATION_VALUE.sub(r"\1[credential redacted]", text)
    for credential in credentials:
        if credential:
            text = text.replace(credential, "[credential redacted]")
    text = GITHUB_TOKEN.sub("[credential redacted]", text)

    lines = []
    source_lines = text.splitlines()
    for raw_line in source_lines:
        line = " ".join(raw_line.split())
        if not line:
            continue
        if WORKFLOW_COMMAND.match(line):
            line = ": :" + line.lstrip()[2:]
        lines.append(line)

    truncated = len(lines) > DIAGNOSTIC_MAX_LINES
    diagnostic = " | ".join(lines[:DIAGNOSTIC_MAX_LINES])
    if len(diagnostic) > DIAGNOSTIC_MAX_CHARS:
        truncated = True
    if truncated:
        available = DIAGNOSTIC_MAX_CHARS - len(DIAGNOSTIC_TRUNCATION) - 1
        diagnostic = diagnostic[:max(0, available)].rstrip() + " " + DIAGNOSTIC_TRUNCATION
    return diagnostic


def command(args, *, cwd=None, env=None, check=True, input=None):
    result = subprocess.run(args, cwd=cwd, env=env, input=input,
                            capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=180)
    if check and result.returncode:
        operation = args[1:]
        while operation and operation[0] == "-c":
            operation = operation[2:]
        raw_diagnostic = "\n".join(value for value in (result.stderr, result.stdout)
                                   if isinstance(value, str)).lower()
        category = ("permission_denied" if "403" in raw_diagnostic or "permission" in raw_diagnostic
                    else "rate_limited" if "rate limit" in raw_diagnostic or "429" in raw_diagnostic
                    else "not_found" if "404" in raw_diagnostic or "not found" in raw_diagnostic
                    else "transient_network" if any(value in raw_diagnostic for value in ("timeout", "timed out", "502", "503", "504"))
                    else "operation_failed")
        diagnostic = sanitize_command_diagnostic(
            result.stdout, result.stderr, credentials=operation_credentials(env)
        )
        reason = diagnostic or "inspect permissions/connectivity and rerun."
        raise OperationError(
            f"{category}: {args[0]} {operation[0] if operation else 'operation'} "
            f"failed (exit {result.returncode}); {reason}"
        )
    return result


class Git:
    def __init__(self, path, repository=ORIGIN):
        self.path = Path(path)
        self.repository = authenticate_downstream_repository(repository)
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith("GIT_") and k not in {"GH_TOKEN", "GITHUB_TOKEN", "SYNC_PUBLISH_TOKEN"}}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_TERMINAL_PROMPT="0", GIT_LFS_SKIP_SMUDGE="1")
        self.options = ["git", "-c", "core.hooksPath=" + os.devnull,
                        "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false",
                        "-c", "maintenance.auto=false", "-c", "gc.auto=0",
                        "-c", "protocol.file.allow=never"]
        self.run("init", "--quiet")
        urls = {"origin": f"https://github.com/{self.repository}.git",
                "upstream": f"https://github.com/{UPSTREAM}.git"}
        for name, url in urls.items():
            self.run("remote", "add", name, url)

    def run(self, *args, check=True, input=None):
        return command(self.options + list(args), cwd=self.path, env=self.env,
                       check=check, input=input)

    def text(self, *args):
        return self.run(*args).stdout.strip()

    def identities(self):
        urls = {"origin": f"https://github.com/{self.repository}.git",
                "upstream": f"https://github.com/{UPSTREAM}.git"}
        for name, expected in urls.items():
            for option in ([], ["--push"]):
                actual = self.text("remote", "get-url", *option, "--all", name)
                if actual != expected:
                    raise IdentityError(f"Unexpected {name} identity; expected exactly {expected}.")

    def fetch(self, remote, source, destination):
        self.run("fetch", "--quiet", "--no-tags", remote, f"{source}:{destination}")

    def ancestor(self, older, newer):
        result = self.run("merge-base", "--is-ancestor", older, newer, check=False)
        if result.returncode not in (0, 1):
            raise Blocked("Cannot prove upstream ancestry; history is missing or rewritten.")
        return result.returncode == 0

    def push(self, branch, candidate):
        self.identities()
        env = dict(self.env, GH_TOKEN=os.environ["SYNC_PUBLISH_TOKEN"])
        # A fixed, trusted credential helper; never persisted in Git config.
        command(self.options + ["-c", "credential.helper=",
                "-c", "credential.helper=!gh auth git-credential", "push", "--porcelain",
                "origin", f"{candidate}:refs/heads/{branch}"], cwd=self.path, env=env)


class GitHub:
    def __init__(self, repository=ORIGIN):
        self.repository = authenticate_downstream_repository(repository)

    def environment(self, publish=False):
        env = {k: v for k, v in os.environ.items() if k != "SYNC_PUBLISH_TOKEN"}
        if publish:
            env["GH_TOKEN"] = os.environ["SYNC_PUBLISH_TOKEN"]
        return env

    def api(self, endpoint, payload=None, publish=False, method="POST"):
        args = ["gh", "api", "--hostname", "github.com", endpoint]
        if payload is not None:
            args += ["--method", method, "--input", "-"]
        env = self.environment(publish)
        return json.loads(command(args, env=env, input=json.dumps(payload) if payload else None).stdout)

    def pages(self, resource):
        output = command(["gh", "api", "--hostname", "github.com", "--paginate", "--slurp",
                          f"repos/{self.repository}/{resource}"], env=self.environment()).stdout
        return [item for page in json.loads(output) for item in page]

    def pulls(self):
        return self.pages("pulls?state=all&base=main&per_page=100")

    def create_pr(self, branch, body, *, draft=False, title=None):
        return self.api(f"repos/{self.repository}/pulls", {
            "head": branch, "base": "main", "title": title or "chore: synchronize official upstream",
            "body": body, "maintainer_can_modify": False, "draft": draft}, publish=True)["html_url"]

def sync_pulls(pulls, repository=ORIGIN):
    repository = authenticate_downstream_repository(repository)
    return [p for p in pulls if p["base"]["ref"] == "main"
            and p["base"]["repo"]["full_name"] == repository
            and p["head"].get("repo")
            and p["head"]["repo"]["full_name"] == repository
            and p["head"]["ref"].startswith(PREFIX)]


def branch_name(upstream, downstream):
    if not all(re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (upstream, downstream)):
        raise Blocked("Invalid SHA identity.")
    return f"{PREFIX}{upstream}-{downstream}"


def blocked_workspace_matches(git, candidate, upstream, downstream, policy_version):
    parents = git.text("show", "-s", "--format=%P", candidate).split()
    context = git.run("show", candidate + ":.upstream-sync/blocked-context.json", check=False)
    if parents != [downstream] or context.returncode:
        return False
    try:
        record = json.loads(context.stdout)
    except (TypeError, ValueError):
        return False
    return (record.get("schemaVersion") == 1
            and record.get("upstream") == upstream
            and record.get("downstream") == downstream
            and record.get("policyVersion") == policy_version
            and isinstance(record.get("conflicts"), list)
            and bool(record["conflicts"]))


def authenticate_open_managed_candidate(git, pull, policy_version):
    """Authenticate one open managed PR as a native merge or blocked review workspace."""
    if pull.get("state") != "open":
        raise Blocked("The managed sync PR is not open; preserve the human PR decision.")
    match = BRANCH.fullmatch(str(pull.get("head", {}).get("ref") or ""))
    head_sha = str(pull.get("head", {}).get("sha") or "")
    try:
        number = int(pull.get("number"))
    except (TypeError, ValueError):
        number = 0
    if not match or number <= 0 or not re.fullmatch(r"[0-9a-f]{40}", head_sha):
        raise Blocked("Open managed sync PR identity cannot be authenticated.")
    review_ref = f"refs/review/{number}"
    actual_head = git.text("rev-parse", review_ref)
    if actual_head != head_sha:
        raise Blocked("Open managed sync PR head changed during authentication.")
    upstream, downstream = match.groups()
    try:
        verify_native_merge_candidate(git, review_ref, downstream, upstream)
        native = True
    except OperationError:
        raise
    except Blocked:
        native = False
    blocked = blocked_workspace_matches(
        git, review_ref, upstream, downstream, policy_version
    )
    if not native and not blocked:
        raise Blocked("Open managed sync PR does not contain its named authenticated input pair.")
    if (blocked or pull_episode(pull)) and not pull.get("draft"):
        raise Blocked("Attention-required managed sync PR is no longer Draft; preserve the human PR decision.")
    return {
        "blocking_pr_number": number,
        "blocking_pr_url": pull.get("html_url"),
        "blocking_pr_head_sha": head_sha,
        "blocking_pr_branch": pull["head"]["ref"],
        "blocking_upstream_sha": upstream,
        "blocking_downstream_sha": downstream,
    }


def existing_candidate(git, pulls, observation, candidate, policy_version):
    same = [pull for pull in pulls if pull["head"]["ref"] == observation["branch"]]
    if len(same) > 1 or (same and same[0]["state"] != "open"):
        raise Blocked("This exact SHA pair has a closed or ambiguous PR decision; do not automatically reopen or recreate it.")
    if same:
        if same[0]["head"]["sha"] != candidate:
            raise Blocked("Existing PR head differs from the deterministic candidate; preserve human changes.")
        if observation.get("episode_id") and not same[0].get("draft"):
            raise Blocked("Attention-required candidate is no longer Draft; preserve the human PR decision.")
        observation.update(outcome="existing_draft_pr" if same[0].get("draft") else "existing_pr",
                           pr_url=same[0]["html_url"], pr_number=same[0]["number"],
                           existing_pr_number=same[0]["number"],
                           existing_pr_branch=same[0]["head"]["ref"],
                           existing_pr_head_sha=same[0]["head"]["sha"])
        return True
    if observation.get("episode_id"):
        episode = [pull for pull in pulls if pull_episode(pull) == observation["episode_id"]]
        open_episode = [pull for pull in episode if pull["state"] == "open"]
        if len(open_episode) > 1:
            raise Blocked("Multiple Draft PRs represent one unresolved upstream episode; inspect without mutation.")
        if open_episode:
            pull = open_episode[0]
            if not pull.get("draft"):
                raise Blocked("The unresolved episode PR is no longer Draft; preserve the human PR decision.")
            observation.update(outcome="existing_draft_pr", pr_url=pull["html_url"],
                               pr_number=pull["number"], existing_branch=pull["head"]["ref"],
                               existing_pr_number=pull["number"],
                               existing_pr_branch=pull["head"]["ref"],
                               existing_pr_head_sha=pull["head"]["sha"])
            return True
        if episode:
            raise Blocked("The unresolved episode has a closed PR decision; do not automatically reopen or recreate it.")
    others = [pull for pull in pulls if pull["state"] == "open"]
    if len(others) > 1:
        raise Blocked("Multiple managed sync PRs could block this episode; inspect without mutation.")
    if others:
        blocker = authenticate_open_managed_candidate(git, others[0], policy_version)
        observation.update(outcome="waiting_on_existing_pr", **blocker)
        return True
    return False


def inspect(git, github, observation, anchor=INITIAL_ANCHOR):
    git.identities()
    git.fetch("origin", "refs/heads/main", "refs/remotes/origin/main")
    git.fetch("upstream", "refs/heads/main", "refs/remotes/upstream/main")
    down = git.text("rev-parse", "refs/remotes/origin/main")
    up = git.text("rev-parse", "refs/remotes/upstream/main")
    policy = load_policy()
    observation.update(upstream_sha=up, downstream_sha=down, branch=branch_name(up, down),
                       ownership_policy_version=policy["schemaVersion"])
    if not git.ancestor(anchor, down):
        raise Blocked("Downstream no longer contains the reviewed initial upstream anchor; inspect main history.")
    # Native ancestry is the canonical accepted-range fact. Historical candidate
    # Historical candidate branches are irrelevant once current upstream is
    # already contained by current downstream main.
    if git.ancestor(up, down):
        observation.update(outcome="no_delta", comparison_baseline=up, upstream_base_sha=up,
                           incoming_count=0, incoming_commits=[], changed_paths=[], conflict_paths=[])
        observation["ancestry_validated"] = True
        return
    pulls = sync_pulls(github.pulls(), github.repository)
    anchors = {anchor}
    # Also retain an attempted branch if a runner died after push but before PR.
    refs = git.text("ls-remote", "--refs", "origin", "refs/heads/" + PREFIX + "*")
    for row in refs.splitlines():
        _, ref = row.split()
        ref_branch = ref.removeprefix("refs/heads/")
        match = BRANCH.fullmatch(ref_branch)
        if match:
            destination = "refs/attempts/" + match[1] + "-" + match[2]
            git.fetch("origin", ref, destination)
            try:
                verify_native_merge_candidate(git, destination, match[2], match[1])
                normal = True
            except Blocked:
                normal = False
            blocked = blocked_workspace_matches(git, destination, match[1], match[2], policy["schemaVersion"])
            if not normal and not blocked:
                # Only the exact current SHA-pair branch can be an interrupted
                # push-before-PR retry for this observation. Preserve an
                # unrelated malformed historical orphan without letting it
                # override the current native PR/Git lifecycle.
                if ref_branch == observation["branch"]:
                    raise Blocked("Current sync branch does not contain its named input pair; inspect different work without overwriting it.")
                continue
            anchors.add(match[1])
    # PR head refs survive branch deletion. Closed PRs remain decision records.
    for pr in pulls:
        match = BRANCH.fullmatch(pr["head"]["ref"])
        if match:
            git.fetch("origin", f"refs/pull/{int(pr['number'])}/head", f"refs/review/{int(pr['number'])}")
            anchors.add(match[1])
    for previous in sorted(anchors):
        if git.run("cat-file", "-e", previous + "^{commit}", check=False).returncode:
            git.fetch("upstream", previous, "refs/observations/" + previous)
        if not git.ancestor(previous, up):
            raise Blocked(f"Upstream is not a descendant of recorded observation {previous}; human rewrite review required.")
    observation["ancestry_validated"] = True
    bases = git.text("merge-base", "--all", down, up).splitlines()
    if len(bases) != 1:
        raise Blocked("Expected one common comparison baseline; inspect unrelated/criss-cross history.")
    base = bases[0]
    observation.update(comparison_baseline=base, upstream_base_sha=base)
    commits = git.text("rev-list", "--reverse", f"{down}..{up}").splitlines()
    observation["incoming_commits"] = []
    for sha in commits:
        subject = git.text("show", "-s", "--format=%s", sha)
        numbers = pull_reference_numbers(subject)
        observation["incoming_commits"].append({
            "sha": sha,
            "subject": subject,
            "url": f"https://github.com/{UPSTREAM}/commit/{sha}",
            "pull_request_numbers": numbers,
            "pull_request_urls": [f"https://github.com/{UPSTREAM}/pull/{number}" for number in numbers],
        })
    observation["automation_changes"] = classify_changes(git, base, up, policy, down)
    classified_range = verify_complete_classification(
        git, base, up, observation["automation_changes"]
    )
    observation["classification_range_count"] = len(classified_range)
    for change in observation["automation_changes"]:
        path = change["path"]
        counterpart = change.get("counterpart")
        change["upstream_url"] = blob_url(UPSTREAM, up, path) if change.get("new_blob") else None
        change["downstream_url"] = (blob_url(downstream_repository(observation), down, path)
                                    if change.get("downstream_blob") else None)
        change["downstream_old_url"] = (blob_url(downstream_repository(observation), down, counterpart)
                                         if counterpart and change.get("downstream_old_blob") else None)
    observation["changed_paths"] = [row["path"] for row in observation["automation_changes"]]
    observation["incoming_count"] = len(commits)
    counts = {name: sum(row["ownership"] == name for row in observation["automation_changes"])
              for name in sorted(OWNERSHIP)}
    observation["ownership_counts"] = counts
    if observation["automation_changes"] and all(not row["affects_candidate"] for row in observation["automation_changes"]):
        observation.update(outcome="observed_excluded", conflict_paths=[], textual_conflicts=False,
                           reason="All changed paths were observed and explicitly preserved as downstream-owned.")
        return
    # Merge occurs only in this process-owned temporary checkout. No hooks,
    # filters, application scripts, local actions, or builds are invoked.
    git.run("checkout", "--quiet", "--detach", down)
    git.env.update(GIT_AUTHOR_NAME="github-actions[bot]", GIT_COMMITTER_NAME="github-actions[bot]",
                   GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com",
                   GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com")
    merge = git.run("merge", "--no-ff", "--no-commit", up, check=False)
    preserve_downstream_owned(git, down, observation["automation_changes"])
    conflicts = git.run("diff", "--name-only", "--diff-filter=U", "-z").stdout.rstrip("\0")
    observation["conflict_paths"] = conflicts.split("\0") if conflicts else []
    observation["textual_conflicts"] = bool(conflicts)
    if conflicts:
        # Produce a reviewable, single-parent workspace: retain downstream bytes for
        # every unresolved path and add deterministic context. Never claim upstream ancestry.
        for path in observation["conflict_paths"]:
            if git.run("cat-file", "-e", f"{down}:{path}", check=False).returncode == 0:
                git.run("checkout", down, "--", path)
                git.run("add", "--", path)
            else:
                git.run("rm", "-f", "--ignore-unmatch", "--", path)
        context_path = git.path / ".upstream-sync" / "blocked-context.json"
        context_path.parent.mkdir(parents=True, exist_ok=True)
        context_path.write_text(json.dumps({"schemaVersion": 1, "upstream": up,
            "downstream": down, "mergeBase": base, "conflicts": observation["conflict_paths"],
            "policyVersion": policy["schemaVersion"]}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        git.run("add", "--", ".upstream-sync/blocked-context.json")
        tree = git.text("write-tree")
        timestamp = max(int(git.text("show", "-s", "--format=%ct", s)) for s in (up, down))
        git.env.update(GIT_AUTHOR_DATE=f"{timestamp} +0000", GIT_COMMITTER_DATE=f"{timestamp} +0000")
        message = f"Prepare semantic upstream review {up} against {down}\n\nNo upstream ancestry accepted.\n"
        candidate = git.run("commit-tree", tree, "-p", down, input=message).stdout.strip()
        observation.update(candidate_sha=candidate, candidate_tree=tree,
                           outcome="semantic_conflict",
                           status="Blocked — semantic integration required",
                           reason="Textual conflicts require human semantic resolution; upstream ancestry was not accepted.")
        observation["review_paths"] = sorted(set(observation["conflict_paths"]) | {
            row["path"] for row in observation["automation_changes"] if row["ownership"] == "REVIEW"})
        finalize_attention(git, observation, base, up)
        description(observation)
        existing_candidate(git, pulls, observation, candidate, policy["schemaVersion"])
        return
    if merge.returncode:
        raise Blocked("Normal integration failed before publication.")
    git.run("diff", "--cached", "--check")
    tree = git.text("write-tree")
    review = [row["path"] for row in observation["automation_changes"] if row["ownership"] == "REVIEW"]
    owned = [row["path"] for row in observation["automation_changes"] if row["ownership"] == "DOWNSTREAM-OWNED"]
    followed_automation = [row["path"] for row in observation["automation_changes"]
                           if row["ownership"] == "FOLLOW" and row["path"].startswith(".github/")]
    if owned and followed_automation:
        review += followed_automation
        observation["cross_file_review"] = "FOLLOW automation changed beside preserved downstream-owned automation; inspect dependencies."
    review = sorted(set(review))
    observation["review_paths"] = review
    timestamp = max(int(git.text("show", "-s", "--format=%ct", s)) for s in (up, down))
    git.env.update(GIT_AUTHOR_DATE=f"{timestamp} +0000", GIT_COMMITTER_DATE=f"{timestamp} +0000")
    message = f"Merge official upstream {up} into downstream {down}\n\nWholphin-Upstream: {up}\nWholphin-Downstream: {down}\n"
    candidate = native_merge_candidate(git, down, up, tree, message)
    observation.update(candidate_sha=candidate, candidate_tree=tree,
                       candidate_parents=[down, up],
                       outcome="review_required" if review else "ready",
                       status="Review required" if review else "Candidate ready")
    finalize_attention(git, observation, base, up)
    description(observation)  # Check durable PR metadata fits before any push.
    existing_candidate(git, pulls, observation, candidate, policy["schemaVersion"])


def publish(git, github, observation, expected_up, expected_down,
            expected_blocking_pr="", expected_blocking_head="", expected_existing_pr="",
            expected_existing_branch="", expected_existing_head=""):
    if (observation.get("upstream_sha"), observation.get("downstream_sha")) != (expected_up, expected_down):
        raise Blocked("Refs changed between read and publish jobs; rerun to observe current inputs.")
    expected_wait = bool(str(expected_blocking_pr).strip() or str(expected_blocking_head).strip())
    if expected_wait and not (str(expected_blocking_pr).strip() and str(expected_blocking_head).strip()):
        raise Blocked("Observe handoff contains an incomplete blocking PR identity.")
    if observation["outcome"] == "waiting_on_existing_pr":
        actual = (str(observation.get("blocking_pr_number") or ""),
                  str(observation.get("blocking_pr_head_sha") or ""))
        expected = (str(expected_blocking_pr).strip(), str(expected_blocking_head).strip())
        if not expected_wait or actual != expected:
            raise Blocked("Blocking PR state changed between read and publish jobs; rerun safely.")
        return
    if expected_wait:
        raise Blocked("Blocking PR state changed between read and publish jobs; rerun safely.")
    expected_existing = tuple(str(value).strip() for value in (
        expected_existing_pr, expected_existing_branch, expected_existing_head
    ))
    has_expected_existing = any(expected_existing)
    if has_expected_existing and not all(expected_existing):
        raise Blocked("Observe handoff contains an incomplete existing Draft identity.")
    if observation["outcome"] in {"no_delta", "observed_excluded"}:
        if has_expected_existing:
            raise Blocked("Existing Draft state changed between read and publish jobs; rerun safely.")
        return
    if observation["outcome"] in {"existing_pr", "existing_draft_pr"}:
        actual_existing = tuple(str(observation.get(key) or "") for key in (
            "existing_pr_number", "existing_pr_branch", "existing_pr_head_sha"
        ))
        if not has_expected_existing or actual_existing != expected_existing:
            raise Blocked("Existing Draft state changed between read and publish jobs; rerun safely.")
        return
    if has_expected_existing:
        raise Blocked("Existing Draft state changed between read and publish jobs; rerun safely.")
    if observation["outcome"] not in {"ready", "review_required", "semantic_conflict"}:
        raise Blocked("Observation is not a publishable candidate.")
    token_present = bool(os.environ.get("SYNC_PUBLISH_TOKEN", "").strip())
    print("SYNC_PUBLISH_TOKEN: " + ("present" if token_present else "missing"))
    if not token_present:
        raise OperationError("Publication App token unavailable. Check SYNC_BOT_CLIENT_ID and SYNC_BOT_PRIVATE_KEY for the approved repository-scoped App and rerun; no branch was pushed.")
    git.identities()
    for remote, expected in (("origin", expected_down), ("upstream", expected_up)):
        actual = git.text("ls-remote", "--refs", remote, "refs/heads/main").split()
        if not actual or actual[0] != expected:
            raise Blocked("Main ref moved immediately before publication; rerun without overwriting history.")
    branch, candidate = observation["branch"], observation["candidate_sha"]
    current = git.text("ls-remote", "--refs", "origin", "refs/heads/" + branch).split()
    if current and current[0] != candidate:
        raise Blocked("Sync branch already contains different work; no force push is permitted.")
    # Recheck PR decisions just before publication, including partially completed retries.
    pulls = sync_pulls(github.pulls(), github.repository)
    matching = [p for p in pulls if p["head"]["ref"] == branch]
    if matching:
        if len(matching) == 1 and matching[0]["state"] == "open" and matching[0]["head"]["sha"] == candidate:
            observation.update(outcome="existing_draft_pr" if matching[0].get("draft") else "existing_pr",
                               pr_url=matching[0]["html_url"])
            return
        raise Blocked("PR decision changed before publication; human review required.")
    episode_matching = [p for p in pulls if p["state"] == "open"
                        and observation.get("episode_id")
                        and pull_episode(p) == observation["episode_id"]]
    if episode_matching:
        if len(episode_matching) == 1 and episode_matching[0].get("draft"):
            observation.update(outcome="existing_draft_pr", pr_url=episode_matching[0]["html_url"],
                               pr_number=episode_matching[0]["number"])
            return
        raise Blocked("The unresolved episode PR changed before publication; human review required.")
    if any(p["state"] == "open" for p in pulls):
        raise Blocked("Another sync PR appeared before publication; rerun after review.")
    if not current:
        git.push(branch, candidate)
    published = git.text("ls-remote", "--refs", "origin", "refs/heads/" + branch).split()
    if not published or published[0] != candidate:
        raise Blocked("Published branch identity could not be verified; preserve it and inspect the remote.")
    prior_outcome = observation["outcome"]
    draft = prior_outcome in {"review_required", "semantic_conflict"}
    observation["pr_url"] = github.create_pr(
        branch, description(observation), draft=draft,
        title=candidate_title(observation, draft))
    observation["pr_number"] = str(observation["pr_url"]).rstrip("/").split("/")[-1]
    observation["outcome"] = ("blocked" if prior_outcome == "semantic_conflict"
                              else "review_pr_created" if draft else "pr_created")


def description(o):
    attention = attention_paths(o)
    follow = ownership_rows(o, "FOLLOW")
    preserved = ownership_rows(o, "DOWNSTREAM-OWNED")
    lines = ["## What requires attention?", ""]
    if attention:
        lines += [f"{len(attention)} path{'s' if len(attention) != 1 else ''} "
                  f"{'requires' if len(attention) == 1 else 'require'} semantic review:", ""]
        lines += attention_evidence(o)
    else:
        lines += ["No REVIEW paths or Git textual conflicts were identified."]

    lines += ["", "## Why?", ""]
    if o.get("textual_conflicts") or o.get("conflict_paths"):
        lines += ["Git found textual conflicts. Their downstream-preserved workspace is not a resolved merge; human semantic resolution is required."]
    elif attention:
        lines += ["Git produced a textually clean candidate, but downstream ownership policy still requires semantic REVIEW for the paths above."]
    else:
        lines += ["The complete upstream range is classified for normal integration and still requires ordinary PR review and required CI."]

    lines += ["", "## What integrates automatically?", "",
              f"{len(follow)} FOLLOW path{'s' if len(follow) != 1 else ''} "
              f"{'is' if len(follow) == 1 else 'are'} included by the native candidate."
              if follow else "No FOLLOW paths are present in this episode."]
    clean = int(o.get("clean_path_count") or 0)
    if clean:
        lines += [f"{clean} candidate path{'s' if clean != 1 else ''} "
                  f"{'requires' if clean == 1 else 'require'} no semantic decision."]

    lines += ["", "## What is intentionally preserved downstream?", ""]
    if preserved:
        lines += [f"{len(preserved)} DOWNSTREAM-OWNED path{'s' if len(preserved) != 1 else ''} retain Mosaic semantics:", ""]
        lines += [f"- <code>{display_text(change.get('path', 'unknown'))}</code>"
                  for change in preserved]
    else:
        lines += ["No DOWNSTREAM-OWNED paths are present in this episode."]

    lines += ["", "## What should the operator do next?", ""]
    if attention:
        lines += ["Run `.\\scripts\\resolve-upstream.ps1`, enter this Draft PR number, and follow the generated authenticated Codex handoff."]
    else:
        lines += ["Review the candidate tree and required CI. Merge or reject remains a human decision."]
    lines += ["Human review and merge/reject remain required.",
              "No automatic semantic resolution or merge is performed."]

    lines += ["", "<details>", "<summary>Technical provenance and upstream history</summary>", "",
              f"{len(o.get('incoming_commits', []))} incoming", ""]
    lines += [f"- {commit_presentation(commit)}" for commit in o.get("incoming_commits", [])[:10]] or ["- None"]
    if len(o.get("incoming_commits", [])) > 10:
        lines += [f"- {len(o['incoming_commits']) - 10} additional incoming commits are retained in the observation artifact."]
    if o.get("run_url"):
        run_url = display_text(o["run_url"])
        lines += ["", f"Latest observation: [{run_url}]({o['run_url']})"]
    lines += ["", "```json", technical_evidence(o), "```", "", "</details>"]
    marker = episode_marker(o)
    if marker:
        lines += ["", marker]
    if o.get("upstream_sha") and o.get("ancestry_validated"):
        lines += ["", f"<!-- wholphin-upstream-observed:{o['upstream_sha']} -->"]
    body = "\n".join(lines)
    # Full structured evidence remains in the retained observation artifact. The
    # bounded technical section keeps durable identity without making it the
    # primary human view; oversized proposals still fail closed.
    if len(body.encode("utf-8")) > 55000:
        raise Blocked("Evidence exceeds one durable GitHub body; split/review this integration manually.")
    return body + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--expected-upstream", default="")
    parser.add_argument("--expected-downstream", default="")
    parser.add_argument("--expected-blocking-pr", default="")
    parser.add_argument("--expected-blocking-head", default="")
    parser.add_argument("--expected-existing-pr", default="")
    parser.add_argument("--expected-existing-branch", default="")
    parser.add_argument("--expected-existing-head", default="")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    raw_repository = os.environ.get("GITHUB_REPOSITORY", "")
    o = {"schema_version": 2, "upstream_repo": UPSTREAM, "upstream_ref": "refs/heads/main",
         "downstream_repo": raw_repository, "downstream_ref": "refs/heads/main",
         "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
         "configured_schedule_utc": os.environ.get("CONFIGURED_SCHEDULE") or "manual",
         "workflow": os.environ.get("GITHUB_WORKFLOW"), "run_id": os.environ.get("GITHUB_RUN_ID"),
         "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
         "run_url": "",
         "outcome": "blocked", "textual_conflicts": None}
    operation_error = False
    failed = False
    try:
        try:
            repository = authenticate_downstream_repository(raw_repository)
        except ValueError as error:
            raise IdentityError(
                "Hosted execution requires the canonical downstream repository identity."
            ) from error
        o["downstream_repo"] = repository
        o["run_url"] = f"https://github.com/{repository}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
        if (os.environ.get("GITHUB_ACTIONS") != "true"
                or os.environ.get("GITHUB_REF") != "refs/heads/main"
                or os.environ.get("GITHUB_EVENT_NAME") not in {"schedule", "workflow_dispatch"}):
            raise IdentityError("Hosted execution requires the canonical downstream, main, and schedule/workflow_dispatch.")
        github = GitHub(repository)
        with tempfile.TemporaryDirectory(prefix="wholphin-sync-", dir=os.environ["RUNNER_TEMP"]) as work:
            git = Git(work, repository)
            git.identities()
            inspect(git, github, o)
            if args.publish:
                publish(git, github, o, args.expected_upstream, args.expected_downstream,
                        args.expected_blocking_pr, args.expected_blocking_head,
                        args.expected_existing_pr, args.expected_existing_branch,
                        args.expected_existing_head)
    except (Blocked, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        failed = True
        operation_error = isinstance(exc, OperationError) or not isinstance(exc, Blocked)
        outcome = ("publication_error" if args.publish else "infrastructure_error") if operation_error else "blocked"
        o.update(outcome=outcome, reason=str(exc) if isinstance(exc, Blocked) else f"{type(exc).__name__}: hosted operation failed; inspect permissions/input and rerun.")
    finally:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(o, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                for key in ("outcome", "upstream_sha", "downstream_sha",
                            "blocking_pr_number", "blocking_pr_head_sha",
                            "existing_pr_number", "existing_pr_branch",
                            "existing_pr_head_sha"):
                    stream.write(f"{key}={o.get(key, '')}\n")
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
                stream.write(upstream_summary(o, publication=args.publish, operation_error=operation_error))
        if failed:
            detail = o.get("reason") or "Unknown hosted refusal"
            print(f"hosted-upstream: {o.get('outcome', 'blocked')}: {detail}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
