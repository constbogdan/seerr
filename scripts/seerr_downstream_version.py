"""Deterministic downstream image versions derived from protected first-parent history."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

import seerr_change_classification as change_classification


EPOCH = "f74657aa501e1fc28bf314673a0cedde167d47e6"
REPOSITORY = "constbogdan/seerr"
REF = "refs/heads/downstream-main"
VERSION_TAG = re.compile(r"custom-v1\.0\.([1-9][0-9]*)")
UPSTREAM_TRAILER = re.compile(r"^Seerr-Upstream: ([0-9a-f]{40})$", re.MULTILINE)
DOWNSTREAM_TRAILER = re.compile(r"^Seerr-Downstream: ([0-9a-f]{40})$", re.MULTILINE)


def git(root, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        env=env,
        text=True,
        capture_output=True,
        encoding="utf-8",
        timeout=60,
    )
    if result.returncode:
        raise ValueError(
            "Seerr downstream version requires complete Git history: "
            f"git {args[0]} failed"
        )
    return result.stdout.strip()


def allocate(root, publication=False, epoch=EPOCH):
    if git(root, "rev-parse", "--is-shallow-repository") != "false":
        raise ValueError("Seerr downstream version requires full Git history; use fetch-depth: 0")

    source = git(root, "rev-parse", "HEAD")
    chain = git(root, "rev-list", "--first-parent", "HEAD").splitlines()
    if epoch not in chain:
        raise ValueError(
            "Seerr downstream version epoch is missing from the first-parent chain; "
            "do not reset the epoch"
        )

    number = chain.index(epoch)
    if number > 2_100_000_000:
        raise ValueError("Seerr downstream version exhausted")

    dirty = bool(git(root, "status", "--porcelain", "--untracked-files=normal"))
    if publication:
        expected = {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": REPOSITORY,
            "GITHUB_REF": REF,
            "GITHUB_EVENT_NAME": "push",
            "GITHUB_SHA": source,
        }
        if any(os.environ.get(key) != value for key, value in expected.items()):
            raise ValueError(
                "Publishable Seerr downstream version requires an exact protected "
                "downstream-main push in constbogdan/seerr"
            )
        if dirty or number < 1:
            raise ValueError(
                "Publishable Seerr downstream version requires a clean commit after the epoch"
            )

    version = f"1.0.{number}"
    return {
        "number": number,
        "version": version,
        "versionTag": f"custom-v{version}",
        "sourceSha": source,
        "sourceTree": git(root, "rev-parse", "HEAD^{tree}"),
        "sourceDateEpoch": int(git(root, "show", "-s", "--format=%ct", "HEAD")),
        "previousSha": chain[1] if len(chain) > 1 else "",
        "dirty": dirty,
        "publication": publication,
        "epoch": epoch,
    }


def _parents(root, commit):
    return git(root, "show", "-s", "--format=%P", commit).split()


def _is_ancestor(root, ancestor, descendant):
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("GIT_")
    }
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=root,
        env=env,
        capture_output=True,
        timeout=60,
    )
    return result.returncode == 0


def _managed_candidate(root, commit, protected_parent, protected_head):
    """Authenticate one durable managed-candidate marker from Git topology."""
    parents = _parents(root, commit)
    if len(parents) != 2:
        return None
    message = git(root, "show", "-s", "--format=%B", commit)
    upstream = UPSTREAM_TRAILER.findall(message)
    downstream = DOWNSTREAM_TRAILER.findall(message)
    if len(upstream) != 1 or len(downstream) != 1:
        return None
    if parents != [downstream[0], upstream[0]]:
        return None
    if not _is_ancestor(root, downstream[0], protected_parent):
        return None
    if not _is_ancestor(root, upstream[0], protected_head):
        return None
    base = git(root, "merge-base", downstream[0], upstream[0])
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        return None
    return {
        "candidateSha": commit,
        "upstreamBaseSha": base,
        "upstreamTipSha": upstream[0],
        "downstreamBaseSha": downstream[0],
    }


def authenticated_upstream_provenance(root, baseline, current):
    """Recover managed upstream provenance or return an intentionally empty claim."""
    claims = []
    protected_commits = git(root, "rev-list", "--first-parent", f"{baseline}..{current}").splitlines()
    for protected_head in reversed(protected_commits):
        protected_parents = _parents(root, protected_head)
        if len(protected_parents) != 2:
            continue
        protected_parent, merged_head = protected_parents
        candidates = []
        for commit in git(root, "rev-list", merged_head, f"^{protected_parent}").splitlines():
            claim = _managed_candidate(root, commit, protected_parent, merged_head)
            if claim:
                candidates.append(claim)
        if len(candidates) > 1:
            return {}
        if candidates:
            claims.append(candidates[0])
    if not claims:
        return {}
    for previous, current_claim in zip(claims, claims[1:]):
        if not _is_ancestor(root, previous["upstreamTipSha"], current_claim["upstreamTipSha"]):
            return {}
    return {
        "authenticated": True,
        "upstreamBaseSha": claims[0]["upstreamBaseSha"],
        "upstreamTipSha": claims[-1]["upstreamTipSha"],
        "managedCandidateSha": claims[-1]["candidateSha"],
    }


def publication_plan(
    root,
    previous_sha="",
    previous_version_tag="",
    publication=False,
    epoch=EPOCH,
):
    """Classify the exact unpublished range and allocate only a required image."""
    source = git(root, "rev-parse", "HEAD")
    dirty = bool(git(root, "status", "--porcelain", "--untracked-files=normal"))
    if publication:
        expected = {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": REPOSITORY,
            "GITHUB_REF": REF,
            "GITHUB_EVENT_NAME": "push",
            "GITHUB_SHA": source,
        }
        if any(os.environ.get(key) != value for key, value in expected.items()):
            raise ValueError(
                "Image eligibility requires an exact protected downstream-main push "
                "in constbogdan/seerr"
            )
        if dirty:
            raise ValueError("Image eligibility requires a clean protected-main checkout")

    if bool(previous_sha) != bool(previous_version_tag):
        raise ValueError("Previous image identity is incomplete")
    if previous_sha:
        if not re.fullmatch(r"[0-9a-f]{40}", previous_sha):
            raise ValueError("Previous image source is not a full lowercase Git SHA")
        match = VERSION_TAG.fullmatch(previous_version_tag)
        if not match:
            raise ValueError("Previous image version tag is malformed")
        baseline = previous_sha
        previous_number = int(match.group(1))
    else:
        baseline = epoch
        previous_number = 0
        previous_version_tag = ""

    classified = change_classification.classify_range(root, baseline, source)
    required = bool(classified["releaseRequired"])
    number = previous_number + 1 if required else previous_number
    version_tag = f"custom-v1.0.{number}" if required else previous_version_tag
    provenance = authenticated_upstream_provenance(root, baseline, source) if required else {}
    return {
        **classified,
        **provenance,
        "number": number,
        "version": f"1.0.{number}" if number else "",
        "versionTag": version_tag,
        "sourceSha": source,
        "sourceTree": git(root, "rev-parse", "HEAD^{tree}"),
        "sourceDateEpoch": int(git(root, "show", "-s", "--format=%ct", "HEAD")),
        "previousSha": baseline,
        "previousVersionTag": previous_version_tag,
        "dirty": dirty,
        "publication": publication,
        "epoch": epoch,
    }


def write_github_outputs(path, identity):
    values = {
        "number": identity["number"],
        "version": identity["version"],
        "version_tag": identity["versionTag"],
        "source_sha": identity["sourceSha"],
        "source_tree": identity["sourceTree"],
        "source_date_epoch": identity["sourceDateEpoch"],
        "previous_sha": identity["previousSha"],
        "previous_version_tag": identity.get("previousVersionTag", ""),
        "epoch": identity["epoch"],
        "release_required": str(identity.get("releaseRequired", True)).lower(),
        "release_relevance": identity.get("releaseRelevance", "product-relevant"),
        "validation_risk": identity.get("validationRisk", "high"),
        "upstream_authenticated": str(identity.get("authenticated", False)).lower(),
        "upstream_base_sha": identity.get("upstreamBaseSha", ""),
        "upstream_tip_sha": identity.get("upstreamTipSha", ""),
        "managed_candidate_sha": identity.get("managedCandidateSha", ""),
    }
    with Path(path).open("a", encoding="utf-8", newline="\n") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publication", action="store_true")
    parser.add_argument("--plan-publication", action="store_true")
    parser.add_argument("--previous-sha", default="")
    parser.add_argument("--previous-version-tag", default="")
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    try:
        root = Path(__file__).resolve().parent.parent
        identity = (
            publication_plan(
                root,
                args.previous_sha,
                args.previous_version_tag,
                args.publication,
            )
            if args.plan_publication
            else allocate(root, args.publication)
        )
        if args.github_output:
            write_github_outputs(args.github_output, identity)
        print(json.dumps(identity, sort_keys=True))
    except ValueError as error:
        parser.exit(1, str(error) + "\n")
