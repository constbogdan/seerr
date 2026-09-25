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

    def commit_path(self, path, content, message):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        self.git("add", path)
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def plan(self, previous_sha="", previous_version_tag=""):
        return version.publication_plan(
            self.root,
            previous_sha,
            previous_version_tag,
            epoch=self.epoch,
        )

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

    def test_publication_plan_publishes_product_but_skips_docs_and_tooling(self):
        previous = self.git("rev-parse", "HEAD")
        self.commit_path("docs/note.md", "docs\n", "docs")
        skipped = self.plan(previous, "custom-v1.0.7")
        self.assertFalse(skipped["releaseRequired"])
        self.assertEqual("custom-v1.0.7", skipped["versionTag"])
        self.assertEqual(7, skipped["number"])

        self.commit_path("scripts/seerr_downstream_version.py", "tooling\n", "tooling")
        skipped = self.plan(previous, "custom-v1.0.7")
        self.assertFalse(skipped["releaseRequired"])
        self.assertEqual(7, skipped["number"])

        self.commit_path("src/feature.ts", "product\n", "product")
        required = self.plan(previous, "custom-v1.0.7")
        self.assertTrue(required["releaseRequired"])
        self.assertEqual("custom-v1.0.8", required["versionTag"])

    def test_unknown_change_requires_publication(self):
        previous = self.git("rev-parse", "HEAD")
        self.commit_path("unclassified.boundary", "unknown\n", "unknown")
        plan = self.plan(previous, "custom-v1.0.2")
        self.assertTrue(plan["releaseRequired"])
        self.assertEqual("unknown", plan["releaseRelevance"])

    def test_validation_only_change_does_not_publish_or_advance(self):
        previous = self.git("rev-parse", "HEAD")
        self.commit_path("cypress/e2e/check.cy.ts", "validation\n", "validation")
        plan = self.plan(previous, "custom-v1.0.4")
        self.assertFalse(plan["releaseRequired"])
        self.assertEqual("validation-only", plan["releaseRelevance"])
        self.assertEqual("custom-v1.0.4", plan["versionTag"])

    def test_skipped_merges_do_not_advance_baseline_or_version(self):
        previous = self.git("rev-parse", "HEAD")
        self.commit_path("docs/one.md", "one\n", "docs one")
        self.commit_path("docs/two.md", "two\n", "docs two")
        skipped = self.plan(previous, "custom-v1.0.11")
        self.assertFalse(skipped["releaseRequired"])
        self.assertEqual(previous, skipped["previousSha"])
        self.assertEqual("custom-v1.0.11", skipped["versionTag"])
        self.commit_path("server/feature.ts", "product\n", "product")
        required = self.plan(previous, "custom-v1.0.11")
        self.assertTrue(required["releaseRequired"])
        self.assertEqual("custom-v1.0.12", required["versionTag"])

    def test_managed_candidate_provenance_is_authenticated_from_topology(self):
        downstream = self.git("rev-parse", "HEAD")
        self.git("checkout", "-b", "upstream")
        self.commit_path("server/upstream.ts", "upstream\n", "upstream")
        upstream = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        tree = self.git("rev-parse", f"{upstream}^{{tree}}")
        message = (
            "Managed upstream candidate\n\n"
            f"Seerr-Upstream: {upstream}\n"
            f"Seerr-Downstream: {downstream}\n"
        )
        candidate = subprocess.run(
            ["git", "commit-tree", tree, "-p", downstream, "-p", upstream],
            cwd=self.root,
            input=message,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        self.git("merge", "--no-ff", candidate, "-m", "Merge managed candidate")
        head = self.git("rev-parse", "HEAD")
        claim = version.authenticated_upstream_provenance(self.root, downstream, head)
        self.assertTrue(claim["authenticated"])
        self.assertEqual(upstream, claim["upstreamTipSha"])
        self.assertEqual(candidate, claim["managedCandidateSha"])

    def test_ordinary_or_malformed_merge_does_not_claim_upstream_provenance(self):
        baseline = self.git("rev-parse", "HEAD")
        self.git("checkout", "-b", "topic")
        self.commit_path("src/topic.ts", "topic\n", "topic")
        self.git("checkout", "main")
        self.git("merge", "--no-ff", "topic", "-m", "ordinary merge")
        head = self.git("rev-parse", "HEAD")
        self.assertEqual(
            {}, version.authenticated_upstream_provenance(self.root, baseline, head)
        )

        self.git("checkout", "-b", "malformed", baseline)
        self.commit_path("server/malformed.ts", "malformed\n", "malformed")
        malformed_tip = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        self.git(
            "merge", "--no-ff", malformed_tip, "-m",
            f"Fake marker\n\nSeerr-Upstream: {'0' * 40}\nSeerr-Downstream: {baseline}",
        )
        malformed_head = self.git("rev-parse", "HEAD")
        self.assertEqual(
            {}, version.authenticated_upstream_provenance(self.root, head, malformed_head)
        )

    def test_workflow_gates_write_permission_behind_exact_range_eligibility(self):
        workflow = (Path(__file__).parent.parent / ".github/workflows/downstream-image.yml").read_text()
        self.assertIn("eligibility:", workflow)
        self.assertIn("packages: read", workflow)
        self.assertIn("needs: eligibility", workflow)
        self.assertIn("if: needs.eligibility.outputs.release_required == 'true'", workflow)
        self.assertIn("packages: write", workflow)
        self.assertIn("--plan-publication", workflow)
        self.assertIn("org.opencontainers.image.revision", workflow)
        self.assertNotIn("paths:", workflow)


if __name__ == "__main__":
    unittest.main()
