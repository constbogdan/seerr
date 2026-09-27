"""Verify published downstream images and reconcile immutable GitHub Releases."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

import seerr_change_classification as change_classification
import seerr_downstream_version as downstream_version


REPOSITORY = "constbogdan/seerr"
REF = "refs/heads/downstream-main"
IMAGE = "ghcr.io/constbogdan/seerr"
SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
VERSION_TAG = re.compile(r"custom-v1\.0\.([1-9][0-9]*)")
MERGE_PR = re.compile(r"^Merge pull request #([1-9][0-9]*)\b")
API_VERSION = "2022-11-28"


class ReleaseError(RuntimeError):
    """Fail-closed downstream release error."""


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
        raise ReleaseError(f"Release preparation requires complete Git history: git {args[0]} failed")
    return result.stdout.strip()


def validate_identity(source_sha, version_tag):
    if not SHA.fullmatch(source_sha):
        raise ReleaseError("Release source is not a full lowercase Git SHA")
    if not VERSION_TAG.fullmatch(version_tag):
        raise ReleaseError("Downstream release version is malformed")


def validate_publication_context(source_sha):
    expected = {
        "GITHUB_ACTIONS": "true",
        "GITHUB_REPOSITORY": REPOSITORY,
        "GITHUB_REF": REF,
        "GITHUB_EVENT_NAME": "push",
        "GITHUB_SHA": source_sha,
    }
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise ReleaseError(
            "GitHub Release publication requires the exact protected downstream-main push"
        )


def _manifest(metadata):
    value = metadata.get("manifest", metadata.get("Manifest"))
    if not isinstance(value, dict):
        raise ReleaseError("Published image metadata has no manifest")
    return value


def published_image(metadata_path, expected_reference, source_sha, version_tag):
    try:
        metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise ReleaseError("Published image metadata is unreadable") from error
    name = metadata.get("name", metadata.get("Name"))
    if name != expected_reference:
        raise ReleaseError("Published image reference does not match the authenticated tag")
    digest = _manifest(metadata).get("digest", _manifest(metadata).get("Digest"))
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise ReleaseError("Published image digest is missing or malformed")
    try:
        identity = downstream_version.previous_image_identity(metadata)
    except ValueError as error:
        raise ReleaseError(str(error)) from error
    if identity != {"previousSha": source_sha, "previousVersionTag": version_tag}:
        raise ReleaseError("Published image OCI identity does not match the release identity")
    return digest


def verify_published_images(
    source_sha,
    version_tag,
    version_metadata,
    source_metadata,
    rolling_metadata,
    expected_digest="",
    image_already_published=False,
):
    validate_identity(source_sha, version_tag)
    if not expected_digest and not image_already_published:
        raise ReleaseError("Fresh image publication did not report its build digest")
    if expected_digest and not DIGEST.fullmatch(expected_digest):
        raise ReleaseError("Build publication digest is malformed")
    references = (
        (version_metadata, f"{IMAGE}:{version_tag}"),
        (source_metadata, f"{IMAGE}:{source_sha}"),
        (rolling_metadata, f"{IMAGE}:custom"),
    )
    digests = {
        published_image(path, reference, source_sha, version_tag)
        for path, reference in references
    }
    if len(digests) != 1:
        raise ReleaseError("Published downstream tags do not resolve to one image digest")
    digest = digests.pop()
    if expected_digest and digest != expected_digest:
        raise ReleaseError("Published image digest differs from the build publication digest")
    return digest


def _markdown_text(value):
    value = unicodedata.normalize("NFKC", value)
    value = " ".join(value.replace("\x00", "").split())
    if not value:
        return "Downstream product change"
    for character in "\\`*_{}[]<>()#+-.!|":
        value = value.replace(character, "\\" + character)
    return value[:300]


def _change_title(root, commit):
    message = git(root, "show", "-s", "--format=%B", commit)
    lines = [line.strip() for line in message.splitlines() if line.strip()]
    if not lines:
        return "Downstream product change", ""
    match = MERGE_PR.match(lines[0])
    if match:
        title = lines[1] if len(lines) > 1 else f"Downstream pull request #{match.group(1)}"
        return title, f"#{match.group(1)}"
    return lines[0], commit[:12]


def release_changes(root, baseline_sha, source_sha):
    for value in (baseline_sha, source_sha):
        if not SHA.fullmatch(value):
            raise ReleaseError("Release-note range requires full lowercase Git SHAs")
    if git(root, "merge-base", "--is-ancestor", baseline_sha, source_sha) not in ("",):
        raise ReleaseError("Release-note baseline is not an ancestor of the source")
    commits = git(root, "rev-list", "--first-parent", "--reverse", f"{baseline_sha}..{source_sha}")
    rows = []
    for commit in commits.splitlines():
        parents = git(root, "show", "-s", "--format=%P", commit).split()
        if not parents:
            raise ReleaseError("Release-note commit has no first parent")
        classification = change_classification.classify_range(root, parents[0], commit)
        if not classification["releaseRequired"]:
            continue
        title, identity = _change_title(root, commit)
        suffix = f" ({identity})" if identity else ""
        rows.append(f"- {_markdown_text(title)}{suffix}")
    if not rows:
        raise ReleaseError("Published product range contains no releasable change summary")
    return rows


def release_notes(root, baseline_sha, source_sha, version_tag, image_digest):
    validate_identity(source_sha, version_tag)
    if not DIGEST.fullmatch(image_digest):
        raise ReleaseError("Release-note image digest is malformed")
    changes = "\n".join(release_changes(root, baseline_sha, source_sha))
    return (
        f"# {version_tag}\n\n"
        "This release publishes reviewed downstream Seerr product changes.\n\n"
        "## Changes\n\n"
        f"{changes}\n\n"
        "## Container\n\n"
        f"`{IMAGE}:{version_tag}`\n\n"
        "Source revision:\n"
        f"`{source_sha}`\n\n"
        "Image digest:\n"
        f"`{image_digest}`\n"
    )


class GitHub:
    def __init__(self, repository=REPOSITORY, token=None, opener=urlopen):
        if repository != REPOSITORY:
            raise ReleaseError("GitHub Release repository identity is not trusted")
        self.repository = repository
        self.token = token or os.environ.get("GITHUB_TOKEN", "")
        if not self.token:
            raise ReleaseError("GitHub Release publication token is unavailable")
        self.opener = opener

    def request(self, method, resource, payload=None, missing_ok=False):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            f"https://api.github.com/repos/{self.repository}/{resource}",
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "User-Agent": "seerr-downstream-release",
                "X-GitHub-Api-Version": API_VERSION,
            },
        )
        try:
            with self.opener(request, timeout=30) as response:
                body = response.read()
        except HTTPError as error:
            if missing_ok and error.code == 404:
                return None
            raise ReleaseError(f"GitHub API {method} {resource} failed with HTTP {error.code}") from None
        except (OSError, URLError) as error:
            raise ReleaseError(f"GitHub API {method} {resource} failed") from error
        if not body:
            return {}
        try:
            return json.loads(body)
        except (UnicodeError, ValueError) as error:
            raise ReleaseError("GitHub API returned malformed JSON") from error

    def tag(self, version_tag):
        return self.request("GET", f"git/ref/tags/{quote(version_tag, safe='')}", missing_ok=True)

    def annotated_tag(self, sha):
        return self.request("GET", f"git/tags/{sha}")

    def create_tag(self, version_tag, source_sha):
        return self.request("POST", "git/refs", {"ref": f"refs/tags/{version_tag}", "sha": source_sha})

    def release(self, version_tag):
        return self.request("GET", f"releases/tags/{quote(version_tag, safe='')}", missing_ok=True)

    def create_release(self, version_tag, source_sha, title, body):
        return self.request(
            "POST",
            "releases",
            {
                "tag_name": version_tag,
                "target_commitish": source_sha,
                "name": title,
                "body": body,
                "draft": False,
                "prerelease": False,
                "make_latest": "true",
            },
        )


def tag_commit(github, tag, maximum_depth=4):
    if tag is None:
        return None
    target = tag.get("object", {})
    for _ in range(maximum_depth):
        kind = target.get("type")
        sha = target.get("sha")
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise ReleaseError("Existing release tag has malformed identity")
        if kind == "commit":
            return sha
        if kind != "tag":
            raise ReleaseError("Existing release tag does not resolve to a commit")
        target = github.annotated_tag(sha).get("object", {})
    raise ReleaseError("Existing release tag indirection is too deep")


def validate_existing_release(release, version_tag, source_sha, title, body):
    if release.get("tag_name") != version_tag:
        raise ReleaseError("Existing GitHub Release tag identity conflicts")
    if release.get("target_commitish") != source_sha:
        raise ReleaseError("Existing GitHub Release source identity conflicts")
    if release.get("name") != title or release.get("body") != body:
        raise ReleaseError("Existing GitHub Release presentation conflicts")
    if release.get("draft") is not False or release.get("prerelease") is not False:
        raise ReleaseError("Existing GitHub Release state conflicts")
    if release.get("assets") not in (None, []):
        raise ReleaseError("Existing GitHub Release contains unexpected attached assets")
    expected_url = f"https://github.com/{REPOSITORY}/releases/tag/{version_tag}"
    if release.get("html_url") != expected_url:
        raise ReleaseError("Existing GitHub Release URL identity conflicts")


def reconcile_release(github, version_tag, source_sha, title, body):
    validate_identity(source_sha, version_tag)
    tag = github.tag(version_tag)
    release = github.release(version_tag)
    existing_target = tag_commit(github, tag)
    if existing_target is not None and existing_target != source_sha:
        raise ReleaseError("Existing release tag points to a different source SHA")
    if release is not None:
        if existing_target is None:
            raise ReleaseError("Existing GitHub Release has no authenticated Git tag")
        validate_existing_release(release, version_tag, source_sha, title, body)
        return {"outcome": "existing", "url": release.get("html_url", "")}
    if tag is None:
        github.create_tag(version_tag, source_sha)
        created = github.tag(version_tag)
        if tag_commit(github, created) != source_sha:
            raise ReleaseError("Created release tag cannot be authenticated")
    created_release = github.create_release(version_tag, source_sha, title, body)
    validate_existing_release(created_release, version_tag, source_sha, title, body)
    return {"outcome": "created", "url": created_release.get("html_url", "")}


def write_output(path, values):
    with Path(path).open("a", encoding="utf-8", newline="\n") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify = subparsers.add_parser("verify-image")
    verify.add_argument("--source-sha", required=True)
    verify.add_argument("--version-tag", required=True)
    verify.add_argument("--version-metadata", type=Path, required=True)
    verify.add_argument("--source-metadata", type=Path, required=True)
    verify.add_argument("--rolling-metadata", type=Path, required=True)
    verify.add_argument("--expected-digest", default="")
    verify.add_argument(
        "--image-already-published", choices=("true", "false"), required=True
    )
    verify.add_argument("--github-output", type=Path, required=True)

    publish = subparsers.add_parser("publish-release")
    publish.add_argument("--source-sha", required=True)
    publish.add_argument("--baseline-sha", required=True)
    publish.add_argument("--version-tag", required=True)
    publish.add_argument("--image-digest", required=True)
    publish.add_argument("--notes", type=Path, required=True)
    publish.add_argument("--github-output", type=Path, required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "verify-image":
            digest = verify_published_images(
                args.source_sha,
                args.version_tag,
                args.version_metadata,
                args.source_metadata,
                args.rolling_metadata,
                args.expected_digest,
                args.image_already_published == "true",
            )
            write_output(args.github_output, {"image_digest": digest})
            print(json.dumps({"imageDigest": digest}, sort_keys=True))
            return 0

        validate_publication_context(args.source_sha)
        root = Path(__file__).resolve().parent.parent
        if git(root, "rev-parse", "HEAD") != args.source_sha:
            raise ReleaseError("Release checkout does not match the authenticated source SHA")
        body = release_notes(
            root,
            args.baseline_sha,
            args.source_sha,
            args.version_tag,
            args.image_digest,
        )
        args.notes.write_text(body, encoding="utf-8", newline="\n")
        result = reconcile_release(
            GitHub(), args.version_tag, args.source_sha, args.version_tag, body
        )
        write_output(args.github_output, result)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ReleaseError, ValueError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    sys.exit(main())
