"""Deterministic local/PR validation selection built on Mosaic change classification."""

import argparse
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import subprocess

import mosaic_change_classification as classification


NON_ANDROID = "non-android"
TARGETED_ANDROID = "targeted-android"
FULL = "full"

ALL_JVM_TESTS = "com.github.damontecres.wholphin.*"

# These paths control trusted builds, publication, updater identity, packaging, or
# persistence. They require Full even when their release relevance is tooling-only.
FULL_VALIDATION_PATTERNS = (
    ".github/workflows/*",
    ".github/actions/*",
    "scripts/mosaic_change_classification.py",
    "scripts/mosaic_validation_policy.py",
    "scripts/upstream_ownership_policy.json",
    "scripts/mosaic_development_release.py",
    "scripts/mosaic_hold_release.py",
    "scripts/mosaic_repository.py",
    "scripts/mosaic_signing_exercise.py",
    "scripts/mosaic_stable.py",
    "scripts/mosaic_validation_reuse.py",
    "scripts/mosaic_version.py",
    "scripts/verify_mosaic_apk.py",
    "scripts/mosaic-signing.json",
    "app/build.gradle.kts",
    "app/proguard-rules.pro",
    "build.gradle.kts",
    "settings.gradle.kts",
    "gradle.properties",
    "gradlew",
    "gradlew.bat",
    "gradle/*",
    "app/src/*/AndroidManifest.xml",
    "app/src/androidTest/*",
    "app/src/release/*",
    "app/src/main/proto/*",
    "app/src/main/java/*/data/AppDatabase.kt",
    "app/src/main/java/*/preferences/AppPreference.kt",
    "app/src/main/java/*/preferences/AppPreferencesSerializer.kt",
    "app/src/main/java/*/services/Update*",
    "app/src/main/java/*/ui/setup/InstallUpdatePage.kt",
    "app/schemas/*",
    "renovate.json",
)

# Package-level filters deliberately trade some extra test work for an auditable,
# conservative mapping. A production Android path that misses this map gets the
# broad all-JVM fallback rather than silently selecting no tests.
FOCUSED_TEST_PATTERNS = (
    ("app/src/main/java/*/data/model/*", ("com.github.damontecres.wholphin.data.model.*",)),
    ("app/src/main/java/*/services/*", ("com.github.damontecres.wholphin.services.*",)),
    ("app/src/main/java/*/ui/cards/*", ("com.github.damontecres.wholphin.ui.cards.*",)),
    ("app/src/main/java/*/ui/components/*", ("com.github.damontecres.wholphin.ui.components.*",)),
    ("app/src/main/java/*/ui/detail/series/*", ("com.github.damontecres.wholphin.ui.detail.series.*",)),
    ("app/src/main/java/*/ui/downloads/*", ("com.github.damontecres.wholphin.ui.downloads.*",)),
    ("app/src/main/java/*/ui/main/*", (
        "com.github.damontecres.wholphin.ui.main.*",
        "com.github.damontecres.wholphin.test.TestHomeRowSamples",
        "com.github.damontecres.wholphin.test.TestMainActivityViewModel",
    )),
    ("app/src/main/java/*/ui/playback/*", ("com.github.damontecres.wholphin.ui.playback.*",)),
    ("app/src/main/java/*/ui/detail/discover/*", (
        "com.github.damontecres.wholphin.test.TestSeerr*",
        "com.github.damontecres.wholphin.services.SeerrRequestPaginationTest",
    )),
    ("app/src/main/java/*/util/*", ("com.github.damontecres.wholphin.util.*",)),
)


OFFLINE_TEST_MAP = {
    "scripts/mosaic_delivery_output.py": "test_mosaic_delivery_output.py",
    "scripts/hosted_upstream.py": "test_hosted_upstream.py",
    "scripts/upstream_ownership_policy.json": "test_hosted_upstream.py",
    "scripts/resolve_upstream.py": "test_resolve_upstream.py",
    "scripts/run_offline_tests.py": "test_run_offline_tests.py",
    "scripts/mosaic_change_classification.py": "test_mosaic_change_classification.py",
    "scripts/mosaic_development_release.py": "test_mosaic_development_release.py",
    "scripts/mosaic_hold_release.py": "test_mosaic_hold_release.py",
    "scripts/mosaic_repository.py": "test_mosaic_repository.py",
    "scripts/mosaic_signing_exercise.py": "test_mosaic_signing_exercise.py",
    "scripts/mosaic_stable.py": "test_mosaic_stable.py",
    "scripts/mosaic_validation_reuse.py": "test_mosaic_validation_reuse.py",
    "scripts/mosaic_version.py": "test_mosaic_version.py",
    "scripts/verify_mosaic_apk.py": "test_verify_mosaic_apk.py",
}


BOUNDED_LOCAL_FAST_OFFLINE_PATTERNS = frozenset({
    "test_mosaic_change_classification.py",
    "test_mosaic_delivery_output.py",
    "test_mosaic_development_release.py",
    "test_mosaic_hold_release.py",
    "test_mosaic_repository.py",
    "test_mosaic_signing_exercise.py",
    "test_mosaic_stable.py",
    "test_mosaic_validation_policy.py",
    "test_mosaic_validation_reuse.py",
    "test_mosaic_version.py",
    "test_resolve_upstream.py",
    "test_run_offline_tests.py",
    "test_verify_mosaic_apk.py",
})


def offline_test_patterns(paths):
    """Return every offline fixture pattern associated with the changed paths."""
    tests = set()
    for path in paths:
        if path in {
            ".vscode/tasks.json",
            "scripts/mosaic_output.ps1",
            "scripts/mosaic_validation_policy.py",
            "scripts/prepare-pr.ps1",
            "scripts/validate-local.ps1",
        }:
            tests.add("test_mosaic_validation_policy.py")
        elif path.startswith("scripts/test_") and path.endswith(".py"):
            tests.add(Path(path).name)
        elif classification.is_offline_tooling_test_support_path(path):
            tests.add("test_*.py")
        elif path in OFFLINE_TEST_MAP:
            tests.add(OFFLINE_TEST_MAP[path])
    return tests


def offline_test_pattern(paths):
    """Choose the narrowest comprehensive offline pattern for explicit validation."""
    tests = offline_test_patterns(paths)
    if not tests:
        return ""
    return next(iter(tests)) if len(tests) == 1 else "test_*.py"


def local_fast_offline_patterns(paths):
    """Return explicitly bounded modules suitable for automatic local Fast feedback."""
    return sorted(
        offline_test_patterns(paths) & BOUNDED_LOCAL_FAST_OFFLINE_PATTERNS
    )


def _matches(path, patterns):
    return any(fnmatchcase(path, pattern) for pattern in patterns)


def focused_tests(paths):
    """Return mapped tests and whether broad fallback was required."""
    selected = set()
    fallback_paths = []
    for path in sorted(set(paths)):
        if path.startswith("app/src/test/") or path.startswith("app/src/testDebug/"):
            if path.endswith((".kt", ".java")):
                selected.add("*" + Path(path).stem)
            continue
        if not path.startswith("app/src/main/"):
            continue
        matches = set()
        for pattern, filters in FOCUSED_TEST_PATTERNS:
            if fnmatchcase(path, pattern):
                matches.update(filters)
        if matches:
            selected.update(matches)
        else:
            fallback_paths.append(path)
    if fallback_paths:
        selected.add(ALL_JVM_TESTS)
    return sorted(selected), fallback_paths


def plan_paths(paths, explicit_filters=(), force_full=False):
    paths = sorted(set(paths))
    result = classification.classify_paths(paths)
    full_paths = [entry["path"] for entry in result["paths"]
                  if _matches(entry["path"], FULL_VALIDATION_PATTERNS)]

    if force_full or result["releaseRelevance"] == classification.UNKNOWN or full_paths:
        mode = FULL
        reason = (
            "caller policy requires Full"
            if force_full
            else "unknown or security/build/persistence-sensitive input requires Full"
        )
        tests, fallback = [], []
    elif explicit_filters or result["releaseRelevance"] in {
        classification.APK_RELEVANT,
        classification.ANDROID_VALIDATION_ONLY,
    }:
        mode = TARGETED_ANDROID
        mapped, fallback = focused_tests(paths)
        tests = sorted(set(explicit_filters or mapped or (ALL_JVM_TESTS,)))
        reason = (
            "operator-supplied focused JVM coverage"
            if explicit_filters
            else "Android input uses deterministic focused JVM coverage"
        )
    else:
        mode = NON_ANDROID
        tests, fallback = [], []
        reason = "proven non-Android scope uses repository tooling checks only"

    return {
        **result,
        "validationMode": mode,
        "focusedTests": tests,
        "focusedFallbackPaths": fallback,
        "fullTriggerPaths": full_paths,
        "offlineTestPattern": offline_test_pattern(paths),
        "localFastOfflinePatterns": local_fast_offline_patterns(paths),
        "reason": reason,
    }


def _git(root, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    result = subprocess.run(["git", *args], cwd=root, env=env, capture_output=True, timeout=60)
    if result.returncode:
        raise ValueError(f"Validation policy Git inspection failed: git {args[0]}")
    return result.stdout


def changed_paths(root, base, head="HEAD", include_working_tree=False):
    """Collect committed and optional staged/unstaged/untracked paths without rename hiding."""
    paths = set()
    committed = _git(root, "diff", "--no-renames", "--name-only", "-z", base, head)
    paths.update(part.decode("utf-8") for part in committed.split(b"\0") if part)
    if include_working_tree:
        for args in (
            ("diff", "--no-renames", "--name-only", "-z", head),
            ("diff", "--cached", "--no-renames", "--name-only", "-z", head),
            ("ls-files", "--others", "--exclude-standard", "-z"),
        ):
            raw = _git(root, *args)
            paths.update(part.decode("utf-8") for part in raw.split(b"\0") if part)
    return sorted(paths)


def reviewed_untracked_paths(root, paths):
    """Return only non-ignored untracked paths from the already reviewed candidate set."""
    raw = _git(root, "ls-files", "--others", "--exclude-standard", "-z")
    untracked = {part.decode("utf-8") for part in raw.split(b"\0") if part}
    return sorted(set(paths) & untracked)


def write_github_outputs(plan, path):
    values = {
        "release_relevance": plan["releaseRelevance"],
        "release_required": str(plan["releaseRequired"]).lower(),
        "validation_risk": plan["validationRisk"],
        "validation_mode": plan["validationMode"],
        "focused_tests": ",".join(plan["focusedTests"]),
        "offline_test_pattern": plan["offlineTestPattern"],
        "changed_path_count": str(len(plan["paths"])),
        "reason": plan["reason"],
    }
    with Path(path).open("a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--include-working-tree", action="store_true")
    parser.add_argument("--path", action="append", default=[])
    parser.add_argument("--test-filter", action="append", default=[])
    parser.add_argument("--force-full", action="store_true")
    parser.add_argument("--github-output")
    parser.add_argument("--repo-root")
    args = parser.parse_args()
    root = Path(args.repo_root).resolve() if args.repo_root else Path(__file__).resolve().parent.parent
    try:
        if args.path:
            paths = args.path
        elif args.base:
            paths = changed_paths(root, args.base, args.head, args.include_working_tree)
        else:
            raise ValueError("Supply --path or --base")
        plan = plan_paths(paths, args.test_filter, args.force_full)
        plan["reviewedUntrackedPaths"] = reviewed_untracked_paths(root, paths)
        if args.github_output:
            write_github_outputs(plan, args.github_output)
        print(json.dumps(plan, sort_keys=True))
    except (OSError, UnicodeError, ValueError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
