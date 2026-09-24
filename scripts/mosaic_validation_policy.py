"""Deterministic local/PR validation selection built on Seerr change classification."""

import argparse
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import subprocess

import mosaic_change_classification as classification


SCOPED = "scoped"
FOCUSED = "focused"
FULL = "full"

# These paths control validation, publication, packaging, authentication, or
# persistence. They require Full even when product relevance is tooling-only.
FULL_VALIDATION_PATTERNS = (
    ".github/workflows/*",
    ".github/actions/*",
    "scripts/mosaic_change_classification.py",
    "scripts/mosaic_validation_policy.py",
    "scripts/upstream_ownership_policy.json",
    "scripts/mosaic_repository.py",
    "scripts/mosaic_validation_reuse.py",
    "scripts/seerr_downstream_version.py",
    "scripts/prepare-pr.ps1",
    "scripts/prepare-pr.config.psd1",
    "scripts/validate-local.ps1",
    "scripts/hosted_upstream.py",
    "scripts/resolve_upstream.py",
    "scripts/resolve-upstream.ps1",
    "scripts/sync-upstream.ps1",
    "docs/downstream-workflow-inventory.txt",
    "Dockerfile",
    "Dockerfile.local",
    "package.json",
    "pnpm-lock.yaml",
    "next.config.ts",
    "tsconfig.json",
    "seerr-api.yml",
    "server/datasource.ts",
    "server/entity/*",
    "server/lib/settings/*",
    "server/middleware/*",
    "server/migration/*",
    "server/test/index.mts",
)

TEST_ROOTS = ("server/", "src/")
TEST_SUFFIXES = (".test.ts", ".test.tsx")


OFFLINE_TEST_MAP = {
    "scripts/hosted_upstream.py": "test_hosted_upstream.py",
    "scripts/upstream_ownership_policy.json": "test_hosted_upstream.py",
    "scripts/resolve_upstream.py": "test_resolve_upstream.py",
    "scripts/run_offline_tests.py": "test_run_offline_tests.py",
    "scripts/mosaic_change_classification.py": "test_mosaic_change_classification.py",
    "scripts/mosaic_repository.py": "test_mosaic_repository.py",
    "scripts/mosaic_validation_reuse.py": "test_mosaic_validation_reuse.py",
    "scripts/seerr_downstream_version.py": "test_seerr_downstream_version.py",
}


BOUNDED_LOCAL_FAST_OFFLINE_PATTERNS = frozenset({
    "test_mosaic_change_classification.py",
    "test_mosaic_repository.py",
    "test_mosaic_validation_policy.py",
    "test_mosaic_validation_reuse.py",
    "test_resolve_upstream.py",
    "test_run_offline_tests.py",
    "test_seerr_downstream_version.py",
})


def offline_test_patterns(paths):
    """Return every offline fixture pattern associated with the changed paths."""
    tests = set()
    for path in paths:
        if path in {
            ".vscode/tasks.json",
            "scripts/mosaic_validation_policy.py",
            "scripts/validate-local.ps1",
        }:
            tests.add("test_mosaic_validation_policy.py")
        elif path == "scripts/prepare-pr.ps1":
            tests.update(("test_mosaic_validation_policy.py", "test_prepare_pr.py"))
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


def _git_path(root, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    return subprocess.run(
        ["git", "-c", f"safe.directory={root}", *args],
        cwd=root,
        env=env,
        capture_output=True,
        timeout=60,
    )


def authenticated_test_filter(root, value, candidate_paths=()):
    """Return one exact repository test path or fail closed."""
    path = value.replace("\\", "/").removeprefix("./")
    if (
        not path
        or path.startswith("/")
        or ".." in path.split("/")
        or not path.startswith(TEST_ROOTS)
        or not path.endswith(TEST_SUFFIXES)
    ):
        raise ValueError(f"Unsupported focused Seerr test path: {value}")
    target = (Path(root) / path).resolve()
    try:
        target.relative_to(Path(root).resolve())
    except ValueError:
        raise ValueError(f"Focused Seerr test escapes the repository: {value}") from None
    if not target.is_file():
        raise ValueError(f"Focused Seerr test does not exist: {path}")
    tracked = _git_path(root, "ls-files", "--error-unmatch", "--", path).returncode == 0
    ignored = (
        _git_path(root, "check-ignore", "--no-index", "--quiet", "--", path).returncode
        == 0
    )
    reviewed_paths = {
        value.replace("\\", "/").removeprefix("./") for value in candidate_paths
    }
    reviewed_untracked = path in reviewed_paths and not ignored
    if ignored:
        raise ValueError(f"Focused Seerr test is ignored: {path}")
    if not tracked and not reviewed_untracked:
        raise ValueError(f"Focused Seerr test is not a reviewed source path: {path}")
    return path


def focused_tests(paths, root):
    """Return authenticated sibling/direct tests and unmapped product inputs."""
    selected = set()
    fallback_paths = []
    candidates = set(paths)
    for path in sorted(candidates):
        if path.startswith(TEST_ROOTS) and path.endswith(TEST_SUFFIXES):
            selected.add(authenticated_test_filter(root, path, candidates))
            continue
        if not path.startswith(TEST_ROOTS) or not path.endswith((".ts", ".tsx")):
            continue
        suffix = ".test.tsx" if path.endswith(".tsx") else ".test.ts"
        candidate = path.rsplit(".", 1)[0] + suffix
        try:
            selected.add(authenticated_test_filter(root, candidate, candidates))
        except ValueError:
            fallback_paths.append(path)
    return sorted(selected), fallback_paths


def plan_paths(paths, explicit_filters=(), force_full=False, root=None):
    paths = sorted(set(paths))
    root = Path(root).resolve() if root else Path(__file__).resolve().parent.parent
    result = classification.classify_paths(paths)
    full_paths = [entry["path"] for entry in result["paths"]
                  if _matches(entry["path"], FULL_VALIDATION_PATTERNS)]
    explicit = sorted({
        authenticated_test_filter(root, value, paths) for value in explicit_filters
    })
    mapped, fallback = focused_tests(paths, root)

    if force_full or result["releaseRelevance"] == classification.UNKNOWN or full_paths:
        mode = FULL
        reason = (
            "caller policy requires Full"
            if force_full
            else "unknown or security/build/persistence-sensitive input requires Full"
        )
        # Exact operator-requested tests remain useful additive local feedback even
        # when the changed scope still requires authoritative Full validation.
        tests = explicit
    elif explicit and not fallback:
        mode = FOCUSED
        tests = explicit
        reason = (
            "operator-supplied exact Seerr test coverage"
        )
    elif result["releaseRelevance"] in {
        classification.PRODUCT_RELEVANT,
        classification.VALIDATION_ONLY,
    }:
        if mapped and not fallback:
            mode = FOCUSED
            tests = mapped
            reason = "changed Seerr source has authenticated sibling/direct tests"
        else:
            mode = FULL
            tests = explicit
            reason = "product or test scope lacks a complete authenticated focused-test binding"
    else:
        mode = SCOPED
        tests, fallback = [], []
        reason = "proven documentation/tooling scope uses bounded repository checks"

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
    result = subprocess.run(
        ["git", "-c", f"safe.directory={root}", *args],
        cwd=root,
        env=env,
        capture_output=True,
        timeout=60,
    )
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
        plan = plan_paths(paths, args.test_filter, args.force_full, root)
        plan["reviewedUntrackedPaths"] = reviewed_untracked_paths(root, paths)
        if args.github_output:
            write_github_outputs(plan, args.github_output)
        print(json.dumps(plan, sort_keys=True))
    except (OSError, UnicodeError, ValueError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
