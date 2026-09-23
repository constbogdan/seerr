"""Deterministic downstream image versions derived from protected first-parent history."""

import argparse
import json
import os
from pathlib import Path
import subprocess


EPOCH = "f74657aa501e1fc28bf314673a0cedde167d47e6"
REPOSITORY = "constbogdan/seerr"
REF = "refs/heads/downstream-main"


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


def write_github_outputs(path, identity):
    values = {
        "number": identity["number"],
        "version": identity["version"],
        "version_tag": identity["versionTag"],
        "source_sha": identity["sourceSha"],
        "source_tree": identity["sourceTree"],
        "source_date_epoch": identity["sourceDateEpoch"],
        "previous_sha": identity["previousSha"],
        "epoch": identity["epoch"],
    }
    with Path(path).open("a", encoding="utf-8", newline="\n") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publication", action="store_true")
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    try:
        identity = allocate(Path(__file__).resolve().parent.parent, args.publication)
        if args.github_output:
            write_github_outputs(args.github_output, identity)
        print(json.dumps(identity, sort_keys=True))
    except ValueError as error:
        parser.exit(1, str(error) + "\n")
