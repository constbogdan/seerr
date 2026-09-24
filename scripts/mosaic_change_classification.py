"""Deterministic Mosaic release-relevance and validation-risk classification."""

import argparse
from dataclasses import asdict, dataclass
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import subprocess


APK_RELEVANT = "apk-relevant"
ANDROID_VALIDATION_ONLY = "android-validation-only"
TOOLING_ONLY = "tooling-only"
DOCS_ONLY = "docs-only"
UNKNOWN = "unknown"

LOW = "low"
NORMAL = "normal"
HIGH = "high"


@dataclass(frozen=True)
class PathClassification:
    path: str
    releaseRelevance: str
    validationRisk: str
    reason: str


def _matches(path, patterns):
    return any(fnmatchcase(path, pattern) for pattern in patterns)


def _path(value):
    result = value.replace("\\", "/").removeprefix("./")
    if not result or result.startswith("/") or ".." in result.split("/"):
        raise ValueError(f"Invalid repository path: {value}")
    return result


def is_offline_tooling_test_support_path(value):
    """Return whether a path uses the supported flat tooling-test-support convention."""
    path = _path(value)
    return (
        path.startswith("scripts/")
        and path.count("/") == 1
        and path.endswith("_test_support.py")
    )


def classify_path(value):
    """Classify one Git path; unmatched paths fail into the conservative bucket."""
    path = _path(value)

    if path.startswith("docs/") or path in {
        "README.md", "CONTRIBUTING.md", "DEVELOPMENT.md", "Intents.md", "LICENSE"
    }:
        return PathClassification(path, DOCS_ONLY, LOW, "durable documentation")

    if path.startswith(".github/"):
        if _matches(path, (".github/workflows/*", ".github/actions/*")):
            return PathClassification(path, TOOLING_ONLY, HIGH, "CI/release automation")
        return PathClassification(path, TOOLING_ONLY, LOW, "repository metadata")

    if path == "scripts/mosaic_version.py":
        return PathClassification(path, APK_RELEVANT, HIGH, "Gradle-consumed version metadata")

    if path.startswith("scripts/"):
        name = path.removeprefix("scripts/")
        if name in {"resolve_upstream.py", "run_offline_tests.py", "upstream_ownership_policy.json"}:
            return PathClassification(path, TOOLING_ONLY, HIGH, "repository automation")
        if name.startswith("test_") and name.endswith(".py"):
            return PathClassification(path, TOOLING_ONLY, NORMAL, "offline tooling test")
        if is_offline_tooling_test_support_path(path):
            return PathClassification(path, TOOLING_ONLY, NORMAL, "offline tooling test support")
        if _matches(name, (
            "mosaic_*.py", "verify_mosaic_apk.py", "hosted_upstream.py",
            "*.ps1", "prepare-pr*.psd1", "mosaic-signing.json",
        )):
            risk = HIGH if _matches(name, (
                "mosaic_*.py", "verify_mosaic_apk.py", "hosted_upstream.py",
                "mosaic-signing.json", "sync-upstream.ps1", "prepare-pr*",
            )) else NORMAL
            return PathClassification(path, TOOLING_ONLY, risk, "repository automation")
        return PathClassification(path, UNKNOWN, HIGH, "unclassified script")

    if path.startswith("app/src/"):
        source_set = path.split("/", 3)[2]
        if source_set in {"test", "androidTest", "testDebug", "debug"}:
            risk = HIGH if path.startswith("app/src/androidTest/java/com/github/damontecres/wholphin/test/TestDbMigrations") else NORMAL
            return PathClassification(path, ANDROID_VALIDATION_ONLY, risk, f"{source_set} source set")
        high_risk = (
            path.endswith("AndroidManifest.xml")
            or "/proto/" in path
            or "/services/Update" in path
            or path.endswith("/ui/setup/InstallUpdatePage.kt")
            or path.endswith("/data/AppDatabase.kt")
            or path.endswith("/preferences/AppPreference.kt")
            or path.endswith("/preferences/AppPreferencesSerializer.kt")
        )
        return PathClassification(
            path, APK_RELEVANT, HIGH if high_risk else NORMAL, "production Android source/input"
        )

    if path.startswith("app/schemas/"):
        return PathClassification(path, ANDROID_VALIDATION_ONLY, HIGH, "database migration contract")

    if _matches(path, (
        "app/build.gradle.kts", "app/proguard-rules.pro", "app/config/*", "app/libs/*",
        "build.gradle.kts", "settings.gradle.kts", "gradle.properties", "gradlew",
        "gradlew.bat", "gradle/*", "wholphin-mpv-stub/*",
    )):
        return PathClassification(path, APK_RELEVANT, HIGH, "production build/package input")

    if path in {"lint.xml", "app/.gitignore"}:
        return PathClassification(path, ANDROID_VALIDATION_ONLY, NORMAL, "Android validation configuration")

    if path.startswith(".vscode/") or path in {".editorconfig", ".gitignore", ".pre-commit-config.yaml"}:
        return PathClassification(path, TOOLING_ONLY, LOW, "developer/repository tooling")

    if path == "renovate.json":
        return PathClassification(path, TOOLING_ONLY, HIGH, "dependency automation")

    return PathClassification(path, UNKNOWN, HIGH, "unclassified repository path")


def classify_paths(paths):
    entries = [classify_path(path) for path in sorted(set(paths))]
    relevance = DOCS_ONLY
    if any(item.releaseRelevance == UNKNOWN for item in entries):
        relevance = UNKNOWN
    elif any(item.releaseRelevance == APK_RELEVANT for item in entries):
        relevance = APK_RELEVANT
    elif any(item.releaseRelevance == ANDROID_VALIDATION_ONLY for item in entries):
        relevance = ANDROID_VALIDATION_ONLY
    elif any(item.releaseRelevance == TOOLING_ONLY for item in entries):
        relevance = TOOLING_ONLY

    risk = LOW
    if any(item.validationRisk == HIGH for item in entries):
        risk = HIGH
    elif any(item.validationRisk == NORMAL for item in entries):
        risk = NORMAL

    return {
        "releaseRelevance": relevance,
        "validationRisk": risk,
        "releaseRequired": relevance in {APK_RELEVANT, UNKNOWN},
        "paths": [asdict(item) for item in entries],
    }


def git(root, *args, check=True):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    try:
        result = subprocess.run(
            ["git", *args], cwd=root, env=env, capture_output=True, timeout=60
        )
    except subprocess.TimeoutExpired:
        raise ValueError("Change classification Git inspection timed out") from None
    if check and result.returncode:
        raise ValueError(f"Change classification requires complete Git history: git {args[0]} failed")
    return result


def classify_range(root, baseline, current):
    for value in (baseline, current):
        if len(value) != 40 or any(char not in "0123456789abcdef" for char in value):
            raise ValueError("Change classification requires full lowercase Git SHAs")
    if git(root, "merge-base", "--is-ancestor", baseline, current, check=False).returncode:
        raise ValueError("Published Development source is not an ancestor of current main")
    # Disabling rename detection exposes both the removed and added paths. A move
    # from an APK input into a non-APK directory must not hide the APK-relevant
    # side of the change behind a destination-only rename record.
    raw = git(root, "diff", "--no-renames", "--name-only", "-z", baseline, current).stdout
    paths = [part.decode("utf-8") for part in raw.split(b"\0") if part]
    result = classify_paths(paths)
    return {**result, "baselineSha": baseline, "currentSha": current}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", default="HEAD")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    try:
        head = git(root, "rev-parse", args.head).stdout.decode("ascii").strip()
        print(json.dumps(classify_range(root, args.base, head), sort_keys=True))
    except (OSError, UnicodeError, ValueError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
