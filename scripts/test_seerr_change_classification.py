"""Offline boundary tests for Seerr change, risk, and ownership classification."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import seerr_change_classification as classification


class ClassificationTests(unittest.TestCase):
    def test_product_relevance_and_risk_are_independent(self):
        cases = {
            "docs/README.md": (classification.DOCS_ONLY, classification.LOW, False),
            "docs/downstream-workflow-inventory.txt": (
                classification.TOOLING_ONLY,
                classification.HIGH,
                False,
            ),
            ".github/workflows/ci.yml": (
                classification.TOOLING_ONLY,
                classification.HIGH,
                False,
            ),
            "scripts/prepare-pr.config.psd1": (
                classification.TOOLING_ONLY,
                classification.HIGH,
                False,
            ),
            "scripts/seerr_output.ps1": (
                classification.TOOLING_ONLY,
                classification.HIGH,
                False,
            ),
            "server/lib/watchlistsync.test.ts": (
                classification.VALIDATION_ONLY,
                classification.NORMAL,
                False,
            ),
            "cypress/e2e/discover.cy.ts": (
                classification.VALIDATION_ONLY,
                classification.NORMAL,
                False,
            ),
            "server/lib/watchlistsync.ts": (
                classification.PRODUCT_RELEVANT,
                classification.NORMAL,
                True,
            ),
            "server/middleware/auth.ts": (
                classification.PRODUCT_RELEVANT,
                classification.HIGH,
                True,
            ),
            "src/components/Discover/index.tsx": (
                classification.PRODUCT_RELEVANT,
                classification.NORMAL,
                True,
            ),
            "scripts/seerr_downstream_version.py": (
                classification.PRODUCT_RELEVANT,
                classification.HIGH,
                True,
            ),
            "config/.gitkeep": (
                classification.TOOLING_ONLY,
                classification.LOW,
                False,
            ),
            "scripts/upstream_ownership_policy.json": (
                classification.TOOLING_ONLY,
                classification.HIGH,
                False,
            ),
            "scripts/resolve_upstream.py": (
                classification.TOOLING_ONLY,
                classification.HIGH,
                False,
            ),
            "scripts/run_offline_tests.py": (
                classification.TOOLING_ONLY,
                classification.HIGH,
                False,
            ),
            "scripts/new_unclassified_tool.py": (
                classification.UNKNOWN,
                classification.HIGH,
                True,
            ),
            "new-top-level-input": (classification.UNKNOWN, classification.HIGH, True),
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                result = classification.classify_paths([path])
                self.assertEqual(
                    (
                        result["releaseRelevance"],
                        result["validationRisk"],
                        result["releaseRequired"],
                    ),
                    expected,
                )

    def test_mixed_unknown_never_becomes_a_skip(self):
        result = classification.classify_paths(
            ["docs/known.md", "server/lib/example.test.ts", "future/input.bin"]
        )
        self.assertEqual(result["releaseRelevance"], classification.UNKNOWN)
        self.assertEqual(result["validationRisk"], classification.HIGH)
        self.assertTrue(result["releaseRequired"])

    def test_flat_offline_tooling_test_support_is_known_without_broadening_scripts(self):
        for path in (
            "scripts/tooling_test_support.py",
            "scripts/example_test_support.py",
        ):
            with self.subTest(path=path):
                result = classification.classify_paths([path])
                self.assertEqual(result["releaseRelevance"], classification.TOOLING_ONLY)
                self.assertEqual(result["validationRisk"], classification.NORMAL)
                self.assertFalse(result["releaseRequired"])

        for path in (
            "scripts/new_unclassified_tool.py",
            "scripts/helpers/tooling_test_support.py",
        ):
            with self.subTest(path=path):
                result = classification.classify_paths([path])
                self.assertEqual(result["releaseRelevance"], classification.UNKNOWN)
                self.assertEqual(result["validationRisk"], classification.HIGH)
                self.assertTrue(result["releaseRequired"])

    def test_indirect_build_security_and_delivery_inputs_are_conservative(self):
        paths = [
            "pnpm-lock.yaml",
            "Dockerfile",
            "server/datasource.ts",
            "server/entity/User.ts",
            "server/migration/sqlite/1234-Example.ts",
            "seerr-api.yml",
        ]
        results = {entry.path: entry for entry in map(classification.classify_path, paths)}
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(
                    results[path].releaseRelevance, classification.PRODUCT_RELEVANT
                )
                self.assertEqual(results[path].validationRisk, classification.HIGH)

        for path in (
            ".github/workflows/downstream-image.yml",
            ".github/actions/setup/action.yml",
        ):
            with self.subTest(path=path):
                result = classification.classify_path(path)
                self.assertEqual(result.releaseRelevance, classification.TOOLING_ONLY)
                self.assertEqual(result.validationRisk, classification.HIGH)

    def test_seerr_ownership_policy_enforces_strategy_c_boundaries(self):
        policy = classification.load_ownership_policy()
        self.assertEqual(policy["schemaVersion"], 1)
        self.assertEqual(policy["defaultAutomationOwnership"], classification.REVIEW)

        for path in (
            ".github/workflows/downstream-validation.yml",
            ".github/workflows/downstream-image.yml",
            ".github/workflows/upstream-sync.yml",
            "docs/downstream-workflow-inventory.txt",
            "scripts/prepare-pr.config.psd1",
            "scripts/seerr_output.ps1",
            "scripts/hosted_upstream.py",
            "docs/UPSTREAM_SYNC.md",
        ):
            with self.subTest(path=path):
                self.assertEqual(
                    classification.ownership_for_path(path, policy),
                    classification.DOWNSTREAM_OWNED,
                )

        for path in (
            ".github/workflows/ci.yml",
            ".github/workflows/release.yml",
            ".github/workflows/future-automation.yml",
            ".github/actions/setup/action.yml",
        ):
            with self.subTest(path=path):
                self.assertNotIn(path, policy["paths"])
                self.assertEqual(
                    classification.ownership_for_path(path, policy),
                    classification.REVIEW,
                )

        for path in (
            "server/api/servarr/base.ts",
            "src/components/Discover/index.tsx",
        ):
            with self.subTest(path=path):
                self.assertNotIn(path, policy["paths"])
                self.assertEqual(
                    classification.ownership_for_path(path, policy),
                    classification.FOLLOW,
                )
                self.assertEqual(
                    classification.ownership_for_path(
                        path, policy, downstream_diverged=True
                    ),
                    classification.REVIEW,
                )

    def test_malformed_ownership_policy_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "policy.json"
            for policy in (
                {},
                {
                    "schemaVersion": 2,
                    "defaultAutomationOwnership": "REVIEW",
                    "paths": {},
                },
                {
                    "schemaVersion": 1,
                    "defaultAutomationOwnership": "FOLLOW",
                    "paths": {},
                },
                {
                    "schemaVersion": 1,
                    "defaultAutomationOwnership": "REVIEW",
                    "paths": {"scripts/example.py": "UNKNOWN"},
                },
            ):
                with self.subTest(policy=policy):
                    path.write_text(json.dumps(policy), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        classification.load_ownership_policy(path)

    def test_range_starts_at_complete_baseline_not_latest_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._git(root, "init", "-q")
            self._git(root, "config", "user.name", "Fixture")
            self._git(root, "config", "user.email", "fixture@example.invalid")
            baseline = self._commit(root, "docs/baseline.md", "baseline", "baseline")
            product_commit = self._commit(
                root, "server/lib/example.ts", "application", "application"
            )
            current = self._commit(root, "docs/follow-up.md", "follow-up", "docs")

            complete = classification.classify_range(root, baseline, current)
            latest_only = classification.classify_range(root, product_commit, current)

            self.assertEqual(
                complete["releaseRelevance"], classification.PRODUCT_RELEVANT
            )
            self.assertTrue(complete["releaseRequired"])
            self.assertEqual(latest_only["releaseRelevance"], classification.DOCS_ONLY)
            self.assertFalse(latest_only["releaseRequired"])
            self.assertEqual(complete["baselineSha"], baseline)
            self.assertEqual(complete["currentSha"], current)

    def test_mode_only_change_is_part_of_the_range(self):
        if os.name == "nt":
            self.skipTest("executable-bit fixture is not portable on Windows")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._git(root, "init", "-q")
            self._git(root, "config", "user.name", "Fixture")
            self._git(root, "config", "user.email", "fixture@example.invalid")
            baseline = self._commit(root, "scripts/validate-local.ps1", "fixture", "baseline")
            self._git(root, "update-index", "--chmod=+x", "scripts/validate-local.ps1")
            self._git(root, "commit", "-qm", "mode")
            current = self._git(root, "rev-parse", "HEAD")
            result = classification.classify_range(root, baseline, current)
            self.assertEqual(
                [item["path"] for item in result["paths"]],
                ["scripts/validate-local.ps1"],
            )

    def test_move_out_of_product_input_cannot_hide_removed_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._git(root, "init", "-q")
            self._git(root, "config", "user.name", "Fixture")
            self._git(root, "config", "user.email", "fixture@example.invalid")
            baseline = self._commit(
                root, "server/lib/example.ts", "application", "baseline"
            )
            destination = root / "docs" / "example.ts"
            destination.parent.mkdir(parents=True)
            self._git(root, "mv", "server/lib/example.ts", "docs/example.ts")
            self._git(root, "commit", "-qm", "move source")
            current = self._git(root, "rev-parse", "HEAD")

            result = classification.classify_range(root, baseline, current)

            self.assertEqual(
                result["releaseRelevance"], classification.PRODUCT_RELEVANT
            )
            self.assertTrue(result["releaseRequired"])
            self.assertEqual(
                [item["path"] for item in result["paths"]],
                ["docs/example.ts", "server/lib/example.ts"],
            )

    def test_additions_and_deletions_are_both_in_the_complete_range(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._git(root, "init", "-q")
            self._git(root, "config", "user.name", "Fixture")
            self._git(root, "config", "user.email", "fixture@example.invalid")
            baseline = self._commit(root, "server/lib/old.ts", "old", "baseline")
            (root / "server" / "lib" / "old.ts").unlink()
            added = root / "src" / "new.ts"
            added.parent.mkdir(parents=True)
            added.write_text("new", encoding="utf-8")
            self._git(root, "add", "--all")
            self._git(root, "commit", "-qm", "replace input")
            current = self._git(root, "rev-parse", "HEAD")

            result = classification.classify_range(root, baseline, current)

            self.assertEqual(
                [item["path"] for item in result["paths"]],
                ["server/lib/old.ts", "src/new.ts"],
            )
            self.assertEqual(
                result["releaseRelevance"], classification.PRODUCT_RELEVANT
            )

    def test_non_ancestor_baseline_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._git(root, "init", "-q")
            self._git(root, "config", "user.name", "Fixture")
            self._git(root, "config", "user.email", "fixture@example.invalid")
            current = self._commit(root, "docs/main.md", "main", "main")
            self._git(root, "switch", "--orphan", "other")
            other = self._commit(root, "docs/other.md", "other", "other")
            with self.assertRaisesRegex(ValueError, "not an ancestor"):
                classification.classify_range(root, other, current)

    @staticmethod
    def _git(root, *arguments):
        result = subprocess.run(
            ["git", *arguments], cwd=root, check=True, capture_output=True, text=True
        )
        return result.stdout.strip()

    @classmethod
    def _commit(cls, root, relative, content, message):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        cls._git(root, "add", relative)
        cls._git(root, "commit", "-qm", message)
        return cls._git(root, "rev-parse", "HEAD")


if __name__ == "__main__":
    unittest.main()
