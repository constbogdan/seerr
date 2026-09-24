"""Offline boundary tests for Mosaic change and risk classification."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import mosaic_change_classification as classification


class ClassificationTests(unittest.TestCase):
    def test_release_relevance_and_risk_are_independent(self):
        cases = {
            "docs/README.md": (classification.DOCS_ONLY, classification.LOW, False),
            ".github/workflows/ci.yml": (
                classification.TOOLING_ONLY, classification.HIGH, False
            ),
            "scripts/prepare-pr.config.psd1": (
                classification.TOOLING_ONLY, classification.HIGH, False
            ),
            "app/src/test/java/FixtureTest.kt": (
                classification.ANDROID_VALIDATION_ONLY, classification.NORMAL, False
            ),
            "app/src/main/java/example/Screen.kt": (
                classification.APK_RELEVANT, classification.NORMAL, True
            ),
            "app/src/main/AndroidManifest.xml": (
                classification.APK_RELEVANT, classification.HIGH, True
            ),
            "scripts/mosaic_version.py": (
                classification.APK_RELEVANT, classification.HIGH, True
            ),
            "scripts/upstream_ownership_policy.json": (
                classification.TOOLING_ONLY, classification.HIGH, False
            ),
            "scripts/resolve_upstream.py": (
                classification.TOOLING_ONLY, classification.HIGH, False
            ),
            "scripts/run_offline_tests.py": (
                classification.TOOLING_ONLY, classification.HIGH, False
            ),
            "scripts/new_unclassified_tool.py": (
                classification.UNKNOWN, classification.HIGH, True
            ),
            "new-top-level-input": (classification.UNKNOWN, classification.HIGH, True),
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                result = classification.classify_paths([path])
                self.assertEqual(
                    (result["releaseRelevance"], result["validationRisk"], result["releaseRequired"]),
                    expected,
                )

    def test_mixed_unknown_never_becomes_a_skip(self):
        result = classification.classify_paths([
            "docs/known.md", "app/src/test/java/FixtureTest.kt", "future/input.bin"
        ])
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

    def test_indirect_build_and_security_inputs_are_conservative(self):
        paths = [
            "gradle/libs.versions.toml",
            "app/build.gradle.kts",
            "scripts/mosaic_version.py",
            "app/src/main/proto/WholphinDataStore.proto",
            ".github/actions/mosaic-sign-apk/action.yml",
            "scripts/mosaic-signing.json",
        ]
        results = {entry.path: entry for entry in map(classification.classify_path, paths)}
        for path in paths[:4]:
            with self.subTest(path=path):
                self.assertEqual(results[path].releaseRelevance, classification.APK_RELEVANT)
                self.assertEqual(results[path].validationRisk, classification.HIGH)
        for path in paths[4:]:
            with self.subTest(path=path):
                self.assertEqual(results[path].releaseRelevance, classification.TOOLING_ONLY)
                self.assertEqual(results[path].validationRisk, classification.HIGH)

    def test_range_starts_at_last_published_source_not_latest_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._git(root, "init", "-q")
            self._git(root, "config", "user.name", "Fixture")
            self._git(root, "config", "user.email", "fixture@example.invalid")
            baseline = self._commit(root, "docs/baseline.md", "baseline", "baseline")
            app_commit = self._commit(
                root, "app/src/main/java/example/Screen.kt", "application", "application"
            )
            current = self._commit(root, "docs/follow-up.md", "tooling follow-up", "docs")

            complete = classification.classify_range(root, baseline, current)
            latest_only = classification.classify_range(root, app_commit, current)

            self.assertEqual(complete["releaseRelevance"], classification.APK_RELEVANT)
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
            self.assertEqual([item["path"] for item in result["paths"]], ["scripts/validate-local.ps1"])

    def test_move_out_of_apk_input_cannot_hide_removed_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._git(root, "init", "-q")
            self._git(root, "config", "user.name", "Fixture")
            self._git(root, "config", "user.email", "fixture@example.invalid")
            baseline = self._commit(
                root, "app/src/main/java/example/Screen.kt", "application", "baseline"
            )
            destination = root / "docs" / "Screen.kt"
            destination.parent.mkdir(parents=True)
            self._git(root, "mv", "app/src/main/java/example/Screen.kt", "docs/Screen.kt")
            self._git(root, "commit", "-qm", "move source")
            current = self._git(root, "rev-parse", "HEAD")

            result = classification.classify_range(root, baseline, current)

            self.assertEqual(result["releaseRelevance"], classification.APK_RELEVANT)
            self.assertTrue(result["releaseRequired"])
            self.assertEqual(
                [item["path"] for item in result["paths"]],
                ["app/src/main/java/example/Screen.kt", "docs/Screen.kt"],
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
