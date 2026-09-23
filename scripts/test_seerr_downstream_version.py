import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import seerr_downstream_version as version


class VersionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.git("init", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.commit("epoch")
        self.epoch = self.git("rev-parse", "HEAD")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(
            ["git", *args],
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout.strip()

    def commit(self, message):
        marker = self.root / "history.txt"
        history = marker.read_text() if marker.exists() else ""
        marker.write_text(history + message + "\n")
        self.git("add", "history.txt")
        self.git("commit", "-m", message)

    def allocate(self, publication=False):
        return version.allocate(self.root, publication, self.epoch)

    def publication_environment(self):
        return patch.dict(
            os.environ,
            GITHUB_ACTIONS="true",
            GITHUB_REPOSITORY=version.REPOSITORY,
            GITHUB_REF=version.REF,
            GITHUB_EVENT_NAME="push",
            GITHUB_SHA=self.git("rev-parse", "HEAD"),
        )

    def test_epoch_is_not_publishable(self):
        self.assertEqual(self.allocate()["versionTag"], "custom-v1.0.0")
        with self.publication_environment(), self.assertRaises(ValueError):
            self.allocate(True)

    def test_first_parent_versions_are_monotonic_and_repeatable(self):
        for number in range(1, 4):
            self.commit(str(number))
            with self.publication_environment():
                first = self.allocate(True)
                self.assertEqual(first, self.allocate(True))
            self.assertEqual(first["number"], number)
            self.assertEqual(first["version"], f"1.0.{number}")
            self.assertEqual(first["versionTag"], f"custom-v1.0.{number}")

    def test_side_history_does_not_allocate_extra_versions(self):
        self.git("checkout", "-b", "upstream")
        self.commit("upstream one")
        self.commit("upstream two")
        self.git("checkout", "main")
        self.git("merge", "--no-ff", "upstream", "-m", "sync")
        self.assertEqual(self.allocate()["number"], 1)

    def test_publication_context_and_clean_tree_are_required(self):
        self.commit("one")
        with self.publication_environment(), patch.dict(
            os.environ, GITHUB_REPOSITORY="seerr-team/seerr"
        ), self.assertRaises(ValueError):
            self.allocate(True)

        (self.root / "untracked.txt").write_text("dirty\n")
        with self.publication_environment(), self.assertRaises(ValueError):
            self.allocate(True)

    def test_missing_epoch_refuses(self):
        with self.assertRaises(ValueError):
            version.allocate(self.root, epoch="0" * 40)

    def test_github_outputs_preserve_distinct_identities(self):
        self.commit("one")
        identity = self.allocate()
        output = self.root / "output.txt"
        version.write_github_outputs(output, identity)
        fields = dict(line.split("=", 1) for line in output.read_text().splitlines())
        self.assertEqual(fields["version_tag"], "custom-v1.0.1")
        self.assertEqual(fields["source_sha"], identity["sourceSha"])
        self.assertEqual(fields["source_tree"], identity["sourceTree"])
        self.assertNotEqual(fields["version_tag"], fields["source_sha"])


if __name__ == "__main__":
    unittest.main()
