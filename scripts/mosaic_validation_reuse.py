"""Reuse complete PR policy evidence only when GitHub and Git prove exact equality."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request

from mosaic_repository import (
    MOSAIC_DOWNSTREAM_REPOSITORY,
    authenticate_downstream_repository,
)

# Canonical downstream identity used by fixtures and live operations.
REPOSITORY = MOSAIC_DOWNSTREAM_REPOSITORY
WORKFLOW = ".github/workflows/ci.yml"
JOB = "Full validation"
CONTRACT = "pr-policy-v1"
NON_ANDROID = "NON_ANDROID"
ANDROID_FULL = "ANDROID_FULL"
VALIDATION_CLASSES = {NON_ANDROID, ANDROID_FULL}
CLASSIFY_STEP = "Choose PR validation path"
PRE_COMMIT_STEP = "Check changed files"
OFFLINE_STEP = "Run offline tooling checks"
FULL_STEP = "Run Full validation"
RECORD_STEP = "Record reusable PR validation evidence"
UPLOAD_STEP = "Upload PR validation evidence"
ARTIFACT_RE = re.compile(
    rf"wholphin-{CONTRACT}-(?P<class>non-android|android-full)-"
    r"pr-(?P<pr>[1-9][0-9]*)-(?P<head>[0-9a-f]{40})-"
    r"tested-(?P<tested>[0-9a-f]{40})-tree-(?P<tree>[0-9a-f]{40})-"
    r"run-(?P<run>[1-9][0-9]*)-attempt-(?P<attempt>[1-9][0-9]*)"
)


def git(root, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    result = subprocess.run(
        ["git", *args], cwd=root, env=env, capture_output=True, text=True, timeout=60
    )
    if result.returncode:
        raise ValueError(f"Git inspection failed: git {args[0]}")
    return result.stdout.strip()


class GitHub:
    """Minimal read-only GitHub client; response bodies and credentials stay out of errors."""

    def __init__(self, repository):
        self.repository = authenticate_downstream_repository(repository)

    def call(self, path):
        request = urllib.request.Request(
            f"https://api.github.com/repos/{self.repository}/{path}",
            headers={
                "Authorization": "Bearer " + os.environ["GH_TOKEN"],
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "mosaic-validation-reuse",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read())
        except (OSError, urllib.error.HTTPError, json.JSONDecodeError):
            raise ValueError("GitHub validation-evidence lookup failed") from None

    def pages(self, path, key=None):
        result = []
        for page in range(1, 11):
            separator = "&" if "?" in path else "?"
            data = self.call(f"{path}{separator}per_page=100&page={page}")
            entries = data[key] if key else data
            result.extend(entries)
            if len(entries) < 100:
                return result
        raise ValueError("GitHub validation-evidence pagination was incomplete")


def artifact_name(validation_class, pr, head, tested, tree, run, attempt):
    if validation_class not in VALIDATION_CLASSES:
        raise ValueError("PR validation evidence requires a known validation class")
    values = (head, tested, tree)
    if any(not re.fullmatch(r"[0-9a-f]{40}", value) for value in values):
        raise ValueError("PR validation evidence requires exact Git identities")
    if any(not re.fullmatch(r"[1-9][0-9]*", str(value)) for value in (pr, run, attempt)):
        raise ValueError("PR validation evidence requires numeric PR/run identity")
    class_name = validation_class.lower().replace("_", "-")
    return (
        f"wholphin-{CONTRACT}-{class_name}-pr-{pr}-{head}-"
        f"tested-{tested}-tree-{tree}-"
        f"run-{run}-attempt-{attempt}"
    )


def record(root, env):
    repository = authenticate_downstream_repository(env.get("GITHUB_REPOSITORY"))
    expected = {
        "GITHUB_ACTIONS": "true",
        "GITHUB_EVENT_NAME": "pull_request",
    }
    if any(env.get(key) != value for key, value in expected.items()):
        raise ValueError("PR evidence requires the repository pull_request workflow")
    pr = env.get("PR_NUMBER", "")
    base = env.get("PR_BASE_SHA", "")
    head = env.get("PR_HEAD_SHA", "")
    tested = env.get("GITHUB_SHA", "")
    run = env.get("GITHUB_RUN_ID", "")
    attempt = env.get("GITHUB_RUN_ATTEMPT", "")
    validation_class = env.get("VALIDATION_CLASS", "")
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        raise ValueError("PR validation evidence requires the exact base SHA")
    if env.get("GITHUB_REF") != f"refs/pull/{pr}/merge" or git(root, "rev-parse", "HEAD") != tested:
        raise ValueError("PR evidence checkout is not the exact synthetic merge ref")
    if git(root, "show", "-s", "--format=%P", "HEAD").split() != [base, head]:
        raise ValueError("PR evidence merge parents differ from the event base/head")
    tree = git(root, "rev-parse", "HEAD^{tree}")
    name = artifact_name(validation_class, pr, head, tested, tree, run, attempt)
    evidence = {
        "contract": CONTRACT,
        "repository": repository,
        "workflow": WORKFLOW,
        "job": JOB,
        "validationClass": validation_class,
        "prNumber": int(pr),
        "baseSha": base,
        "headSha": head,
        "testedSha": tested,
        "testedTree": tree,
        "runId": int(run),
        "runAttempt": int(attempt),
    }
    evidence_path = Path(env["RUNNER_TEMP"]) / "mosaic-pr-validation-evidence"
    evidence_path.mkdir(parents=True, exist_ok=False)
    (evidence_path / "validation-evidence.json").write_text(
        json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    apk_path = env.get("PR_APK_PATH", "")
    if validation_class == ANDROID_FULL:
        apk = Path(apk_path)
        if not apk.is_file() or not re.fullmatch(
            r"Mosaic-default-debug-[A-Za-z0-9.-]+\.apk", apk.name
        ):
            raise ValueError("ANDROID_FULL evidence requires the validated universal Debug APK")
        shutil.copy2(apk, evidence_path / apk.name)
    elif apk_path:
        raise ValueError("NON_ANDROID evidence must not include an Android APK")
    with Path(env["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        output.write(f"artifact_name={name}\n")
        output.write(f"evidence_path={evidence_path}\n")
        output.write(f"validation_class={validation_class}\n")
        output.write(f"validation_contract={CONTRACT}\n")
        output.write(f"tested_sha={tested}\n")
        output.write(f"tested_tree={tree}\n")
    return evidence | {"artifactName": name, "evidencePath": str(evidence_path)}


def _single(items, reason):
    if len(items) != 1:
        raise ValueError(reason)
    return items[0]


def reuse_decision(root, api, env):
    repository = authenticate_downstream_repository(env.get("GITHUB_REPOSITORY"))
    expected = {
        "GITHUB_ACTIONS": "true",
        "GITHUB_EVENT_NAME": "push",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_REF_PROTECTED": "true",
    }
    if any(env.get(key) != value for key, value in expected.items()):
        raise ValueError("not an exact protected-main push")
    main_sha = git(root, "rev-parse", "HEAD")
    if env.get("GITHUB_SHA") != main_sha:
        raise ValueError("protected-main checkout differs from the event SHA")
    main_tree = git(root, "rev-parse", "HEAD^{tree}")
    parents = git(root, "show", "-s", "--format=%P", "HEAD").split()
    if len(parents) != 2:
        raise ValueError("main update is not an unambiguous two-parent PR merge")

    pulls = api.pages(f"commits/{main_sha}/pulls")
    pull = _single(
        [
            item
            for item in pulls
            if item.get("merged_at")
            and item.get("merge_commit_sha") == main_sha
            and item.get("base", {}).get("repo", {}).get("full_name") == repository
            and item.get("base", {}).get("ref") == "main"
            and item.get("head", {}).get("repo", {}).get("full_name") == repository
        ],
        "no unique same-repository merged PR owns the main commit",
    )
    if parents != [pull["base"]["sha"], pull["head"]["sha"]]:
        raise ValueError("main merge parents differ from the associated PR")

    workflow_endpoint = f"actions/workflows/{Path(WORKFLOW).name}"
    workflow = api.call(workflow_endpoint)
    encoded_head = urllib.parse.quote(pull["head"]["sha"])
    runs = api.pages(
        f"{workflow_endpoint}/runs?event=pull_request&head_sha={encoded_head}",
        "workflow_runs",
    )
    candidates = [
        run
        for run in runs
        if run.get("workflow_id") == workflow.get("id")
        and run.get("path") == WORKFLOW
        and run.get("event") == "pull_request"
        and run.get("head_sha") == pull["head"]["sha"]
        and run.get("head_branch") == pull["head"]["ref"]
        and run.get("head_repository", {}).get("full_name") == repository
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
    ]

    accepted = []
    for run in candidates:
        attempt = run.get("run_attempt")
        if type(run.get("id")) is not int or type(attempt) is not int:
            continue
        jobs = api.pages(f"actions/runs/{run['id']}/attempts/{attempt}/jobs", "jobs")
        jobs = [
            job
            for job in jobs
            if job.get("name") == JOB
            and job.get("status") == "completed"
            and job.get("conclusion") == "success"
            and job.get("head_sha") == pull["head"]["sha"]
        ]
        if len(jobs) != 1:
            continue
        artifacts = api.pages(f"actions/runs/{run['id']}/artifacts", "artifacts")
        matches = []
        for artifact in artifacts:
            match = ARTIFACT_RE.fullmatch(str(artifact.get("name", "")))
            owner = artifact.get("workflow_run", {})
            if (
                match
                and match["pr"] == str(pull["number"])
                and match["head"] == pull["head"]["sha"]
                and match["run"] == str(run["id"])
                and match["attempt"] == str(attempt)
                and artifact.get("expired") is False
                and re.fullmatch(r"sha256:[0-9a-f]{64}", str(artifact.get("digest", "")))
                and owner.get("id") == run["id"]
                and owner.get("head_sha") == pull["head"]["sha"]
                and owner.get("head_branch") == pull["head"]["ref"]
                and owner.get("repository_id") == owner.get("head_repository_id")
            ):
                matches.append((artifact, match))
        if len(matches) == 1:
            artifact, match = matches[0]
            validation_class = match["class"].upper().replace("-", "_")
            step_entries = jobs[0].get("steps", [])

            def conclusion(name):
                values = [step.get("conclusion") for step in step_entries if step.get("name") == name]
                return values[0] if len(values) == 1 else None

            if any(
                conclusion(name) != "success"
                for name in (CLASSIFY_STEP, PRE_COMMIT_STEP, OFFLINE_STEP, RECORD_STEP, UPLOAD_STEP)
            ):
                continue
            full_result = conclusion(FULL_STEP)
            if (
                validation_class == ANDROID_FULL and full_result != "success"
            ) or (
                validation_class == NON_ANDROID and full_result != "skipped"
            ):
                continue
            accepted.append((run, artifact, match, validation_class))

    run, artifact, match, validation_class = _single(
        accepted, "required PR validation evidence is missing or ambiguous"
    )
    tested_commit = api.call(f"git/commits/{match['tested']}")
    tested_parents = [item.get("sha") for item in tested_commit.get("parents", [])]
    if tested_parents != [pull["base"]["sha"], pull["head"]["sha"]]:
        raise ValueError("tested PR merge parents differ from the merged PR")
    if tested_commit.get("tree", {}).get("sha") != match["tree"]:
        raise ValueError("tested PR tree evidence differs from GitHub Git data")
    if match["tree"] != main_tree:
        raise ValueError("final main tree differs from the tested PR tree")
    return {
        "reuseValidation": True,
        "reason": (
            f"authenticated successful PR {validation_class} policy tested the exact final main tree"
        ),
        "validationClass": validation_class,
        "validationContract": CONTRACT,
        "mainTree": main_tree,
        "testedTree": match["tree"],
        "testedSha": match["tested"],
        "prNumber": str(pull["number"]),
        "runId": str(run["id"]),
        "runAttempt": str(run["run_attempt"]),
        "artifactId": str(artifact["id"]),
        "artifactDigest": artifact["digest"],
    }


def decide(root, api, env):
    try:
        return reuse_decision(root, api, env)
    except (KeyError, OSError, TypeError, UnicodeError, ValueError) as error:
        return {
            "reuseValidation": False,
            "reason": str(error),
            "mainTree": git(root, "rev-parse", "HEAD^{tree}"),
        }


def write_decision(result, env):
    with Path(env["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        output.write(f"reuse_validation={str(result['reuseValidation']).lower()}\n")
        output.write(f"reason={result['reason']}\n")
        for source, target in (("mainTree", "main_tree"), ("testedTree", "tested_tree"),
                               ("testedSha", "tested_sha"), ("prNumber", "pr_number"),
                               ("runId", "run_id"), ("runAttempt", "run_attempt"),
                               ("validationClass", "validation_class"),
                               ("validationContract", "validation_contract"),
                               ("artifactId", "artifact_id"),
                               ("artifactDigest", "artifact_digest")):
            if result.get(source):
                output.write(f"{target}={result[source]}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("record", "reuse"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    try:
        if args.mode == "record":
            print(json.dumps(record(root, os.environ), sort_keys=True))
        else:
            repository = authenticate_downstream_repository(os.environ.get("GITHUB_REPOSITORY"))
            result = decide(root, GitHub(repository), os.environ)
            write_decision(result, os.environ)
            print(json.dumps(result, sort_keys=True))
    except (KeyError, OSError, ValueError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
