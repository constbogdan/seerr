"""Deterministic Seerr product-relevance and validation-risk classification."""

import argparse
from dataclasses import asdict, dataclass
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import subprocess


PRODUCT_RELEVANT = "product-relevant"
VALIDATION_ONLY = "validation-only"
TOOLING_ONLY = "tooling-only"
DOCS_ONLY = "docs-only"
UNKNOWN = "unknown"

LOW = "low"
NORMAL = "normal"
HIGH = "high"

FOLLOW = "FOLLOW"
REVIEW = "REVIEW"
DOWNSTREAM_OWNED = "DOWNSTREAM-OWNED"
OWNERSHIP = frozenset({FOLLOW, REVIEW, DOWNSTREAM_OWNED})
POLICY_PATH = Path(__file__).with_name("upstream_ownership_policy.json")


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


def load_ownership_policy(path=POLICY_PATH):
    """Load the exact versioned ownership policy or fail closed."""
    policy = json.loads(Path(path).read_text(encoding="utf-8"))
    if (
        policy.get("schemaVersion") != 1
        or policy.get("defaultAutomationOwnership") != REVIEW
        or not isinstance(policy.get("paths"), dict)
        or not set(policy["paths"].values()) <= OWNERSHIP
    ):
        raise ValueError("Unsupported upstream ownership policy")
    for value in policy["paths"]:
        _path(value)
    return policy


def ownership_for_path(value, policy, downstream_diverged=False):
    """Classify one path, promoting downstream-diverged FOLLOW paths to REVIEW."""
    path = _path(value)
    ownership = policy["paths"].get(
        path,
        policy["defaultAutomationOwnership"] if path.startswith(".github/") else FOLLOW,
    )
    if ownership not in OWNERSHIP:
        raise ValueError("Unknown upstream ownership classification")
    return REVIEW if downstream_diverged and ownership == FOLLOW else ownership


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

    if path == "docs/downstream-workflow-inventory.txt":
        return PathClassification(path, TOOLING_ONLY, HIGH, "workflow inventory authority")

    if path.startswith("docs/") or path in {
        "README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "LICENSE", "SECURITY.md"
    }:
        return PathClassification(path, DOCS_ONLY, LOW, "durable documentation")

    if path.startswith("gen-docs/"):
        return PathClassification(path, DOCS_ONLY, LOW, "documentation site source")

    if path.startswith(".github/"):
        if _matches(path, (".github/workflows/*", ".github/actions/*")):
            return PathClassification(path, TOOLING_ONLY, HIGH, "CI/release automation")
        return PathClassification(path, TOOLING_ONLY, LOW, "repository metadata")

    if path == "scripts/seerr_downstream_version.py":
        return PathClassification(path, TOOLING_ONLY, HIGH, "image publication metadata")

    if path.startswith("scripts/"):
        name = path.removeprefix("scripts/")
        if name in {"resolve_upstream.py", "run_offline_tests.py", "upstream_ownership_policy.json"}:
            return PathClassification(path, TOOLING_ONLY, HIGH, "repository automation")
        if name.startswith("test_") and name.endswith(".py"):
            return PathClassification(path, TOOLING_ONLY, NORMAL, "offline tooling test")
        if is_offline_tooling_test_support_path(path):
            return PathClassification(path, TOOLING_ONLY, NORMAL, "offline tooling test support")
        if _matches(name, (
            "seerr_*.py", "hosted_upstream.py",
            "*.ps1", "prepare-pr*.psd1",
        )):
            risk = HIGH if _matches(name, (
                "seerr_*.py", "hosted_upstream.py",
                "seerr_output.ps1", "sync-upstream.ps1",
                "resolve-upstream.ps1", "prepare-pr*",
            )) else NORMAL
            return PathClassification(path, TOOLING_ONLY, risk, "repository automation")
        return PathClassification(path, UNKNOWN, HIGH, "unclassified script")

    if path.startswith("cypress/") or path.startswith("server/test/"):
        return PathClassification(path, VALIDATION_ONLY, NORMAL, "test source or fixture")

    if (
        path.startswith(("server/", "src/"))
        and path.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"))
    ):
        return PathClassification(path, VALIDATION_ONLY, NORMAL, "unit test source")

    if path.startswith("server/"):
        high_risk = _matches(path, (
            "server/datasource.ts", "server/entity/*", "server/lib/settings/*",
            "server/middleware/*", "server/migration/*", "server/routes/*",
        ))
        return PathClassification(
            path, PRODUCT_RELEVANT, HIGH if high_risk else NORMAL,
            "production server source/input",
        )

    if path.startswith(("src/", "public/")):
        return PathClassification(path, PRODUCT_RELEVANT, NORMAL, "production web source/input")

    if path.startswith("config/"):
        return PathClassification(path, TOOLING_ONLY, LOW, "runtime-directory placeholder")

    if _matches(path, (
        ".dockerignore", "Dockerfile", "Dockerfile.local", "compose*.yaml",
        "package.json", "pnpm-lock.yaml", ".npmrc", "next.config.ts",
        "postcss.config.js", "tailwind.config.js", "tsconfig.json",
        "seerr-api.yml", "charts/*",
    )):
        return PathClassification(path, PRODUCT_RELEVANT, HIGH, "production build/package input")

    if path.startswith("bin/"):
        return PathClassification(path, TOOLING_ONLY, HIGH, "repository automation")

    if path in {
        ".prettierignore", ".prettierrc.js", "eslint.config.mts",
        "stylelint.config.js", "cypress.config.ts",
    }:
        return PathClassification(path, VALIDATION_ONLY, NORMAL, "validation configuration")

    if path.startswith(".vscode/") or path in {".editorconfig", ".gitignore", ".pre-commit-config.yaml"}:
        return PathClassification(path, TOOLING_ONLY, LOW, "developer/repository tooling")

    if path.startswith(".husky/"):
        return PathClassification(path, TOOLING_ONLY, NORMAL, "developer repository hook")

    if path.startswith(".github/renovate"):
        return PathClassification(path, TOOLING_ONLY, HIGH, "dependency automation")

    return PathClassification(path, UNKNOWN, HIGH, "unclassified repository path")


def classify_paths(paths):
    entries = [classify_path(path) for path in sorted(set(paths))]
    relevance = DOCS_ONLY
    if any(item.releaseRelevance == UNKNOWN for item in entries):
        relevance = UNKNOWN
    elif any(item.releaseRelevance == PRODUCT_RELEVANT for item in entries):
        relevance = PRODUCT_RELEVANT
    elif any(item.releaseRelevance == VALIDATION_ONLY for item in entries):
        relevance = VALIDATION_ONLY
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
        "releaseRequired": relevance in {PRODUCT_RELEVANT, UNKNOWN},
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
        raise ValueError("Change-classification baseline is not an ancestor of current head")
    # Disabling rename detection exposes both the removed and added paths. A move
    # from a product input into a non-product directory must not hide the product-relevant
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
