import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "scripts/run_offline_tests.py"


class OfflineTestRunnerTests(unittest.TestCase):
    def run_fixture(self, source, pattern="test_fixture.py"):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            if source is not None:
                (root / "test_fixture.py").write_text(
                    textwrap.dedent(source), encoding="utf-8"
                )
            summary = root / "real-summary.md"
            output = root / "real-output.txt"
            env = dict(
                os.environ,
                GITHUB_STEP_SUMMARY=str(summary),
                GITHUB_OUTPUT=str(output),
                GH_TOKEN="fixture-gh-token",
                GITHUB_TOKEN="fixture-github-token",
                SYNC_APP_ID="12345",
                SYNC_APP_PRIVATE_KEY="fixture-private-key",
                SYNC_PUBLISH_TOKEN="fixture-publish-token",
            )
            result = subprocess.run(
                [sys.executable, "-B", str(RUNNER), "--start", str(root),
                 "--pattern", pattern],
                cwd=ROOT, env=env, capture_output=True, text=True, check=False,
            )
            return result, summary.exists(), output.exists()

    def test_success_buffers_transcript_and_isolates_hosted_output_channels(self):
        result, summary_exists, output_exists = self.run_fixture("""
            import os
            import unittest

            class Fixture(unittest.TestCase):
                def test_output(self):
                    print('Recovered · downstream-build-5')
                    self.assertNotIn('GITHUB_STEP_SUMMARY', os.environ)
                    self.assertNotIn('GITHUB_OUTPUT', os.environ)
                    self.assertNotIn('GH_TOKEN', os.environ)
                    self.assertNotIn('GITHUB_TOKEN', os.environ)
                    self.assertNotIn('SYNC_APP_ID', os.environ)
                    self.assertNotIn('SYNC_APP_PRIVATE_KEY', os.environ)
                    self.assertNotIn('SYNC_PUBLISH_TOKEN', os.environ)
        """)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("Recovered", result.stdout + result.stderr)
        self.assertFalse(summary_exists)
        self.assertFalse(output_exists)

    def test_pattern_cannot_escape_or_select_non_test_files(self):
        for pattern in ("../test_fixture.py", "*.py", "fixture.py", "test_*/x.py"):
            with self.subTest(pattern=pattern):
                result, summary_exists, output_exists = self.run_fixture(
                    "import unittest\n", pattern=pattern
                )
                self.assertNotEqual(0, result.returncode)
                self.assertIn("offline test pattern must be", result.stderr)
                self.assertFalse(summary_exists)
                self.assertFalse(output_exists)

    def test_failure_retains_fixture_diagnostics(self):
        result, _, _ = self.run_fixture("""
            import unittest

            class Fixture(unittest.TestCase):
                def test_failure(self):
                    print('useful fixture diagnostic')
                    self.fail('intentional failure')
        """)
        self.assertEqual(1, result.returncode)
        self.assertIn("useful fixture diagnostic", result.stdout + result.stderr)
        self.assertIn("intentional failure", result.stdout + result.stderr)

    def test_missing_requested_pattern_fails_with_actionable_diagnostic(self):
        result, summary_exists, output_exists = self.run_fixture(
            None, pattern="test_missing_fixture.py"
        )
        self.assertEqual(1, result.returncode)
        self.assertIn(
            "No offline tooling tests matched pattern 'test_missing_fixture.py'",
            result.stderr,
        )
        self.assertFalse(summary_exists)
        self.assertFalse(output_exists)


if __name__ == "__main__":
    unittest.main()
