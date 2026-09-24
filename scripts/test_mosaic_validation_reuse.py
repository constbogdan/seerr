import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import mosaic_validation_reuse as reuse


MAIN = "c" * 40
BASE = "a" * 40
HEAD = "b" * 40
TESTED = "d" * 40
TREE = "e" * 40


class FakeGitHub:
    def __init__(
        self,
        *,
        validation_class=reuse.FULL,
        required_step=None,
        required_result="success",
        runs=1,
        artifacts=1,
        artifact_expired=False,
        artifact_class=None,
        run_attempt=1,
        artifact_attempt=None,
        run_path=None,
        run_repository=None,
        tested_tree=TREE,
        tested_parents=None,
        repository=reuse.REPOSITORY,
    ):
        self.validation_class = validation_class
        self.required_step = required_step
        self.required_result = required_result
        self.run_count = runs
        self.artifact_count = artifacts
        self.artifact_expired = artifact_expired
        self.artifact_class = artifact_class or validation_class
        self.run_attempt = run_attempt
        self.artifact_attempt = artifact_attempt or run_attempt
        self.run_path = run_path or reuse.WORKFLOW
        self.repository = repository
        self.run_repository = run_repository or repository
        self.tested_tree = tested_tree
        self.tested_parents = tested_parents or [BASE, HEAD]

    def call(self, path):
        if path == f"actions/workflows/{Path(reuse.WORKFLOW).name}":
            return {"id": 42}
        if path == f"git/commits/{TESTED}":
            return {
                "tree": {"sha": self.tested_tree},
                "parents": [{"sha": value} for value in self.tested_parents],
            }
        raise AssertionError(path)

    def pages(self, path, key=None):
        if path == f"commits/{MAIN}/pulls":
            return [
                {
                    "number": 7,
                    "merged_at": "2026-09-13T00:00:00Z",
                    "merge_commit_sha": MAIN,
                    "base": {
                        "sha": BASE,
                        "ref": "downstream-main",
                        "repo": {"full_name": self.repository},
                    },
                    "head": {
                        "sha": HEAD,
                        "ref": "feature",
                        "repo": {"full_name": self.repository},
                    },
                }
            ]
        if path.startswith(f"actions/workflows/{Path(reuse.WORKFLOW).name}/runs?"):
            return [
                {
                    "id": 100 + index,
                    "run_attempt": self.run_attempt,
                    "workflow_id": 42,
                    "path": self.run_path,
                    "event": "pull_request",
                    "head_sha": HEAD,
                    "head_branch": "feature",
                    "head_repository": {"full_name": self.run_repository},
                    "status": "completed",
                    "conclusion": "success",
                }
                for index in range(self.run_count)
            ]
        job_match = reuse.re.fullmatch(
            rf"actions/runs/([0-9]+)/attempts/{self.run_attempt}/jobs", path
        )
        if job_match:
            steps = [
                *[
                    {"name": name, "conclusion": "success"}
                    for name in reuse.VALIDATION_STEPS
                ],
                {"name": reuse.RECORD_STEP, "conclusion": "success"},
                {"name": reuse.UPLOAD_STEP, "conclusion": "success"},
            ]
            if self.required_step:
                next(step for step in steps if step["name"] == self.required_step)[
                    "conclusion"
                ] = self.required_result
            return [
                {
                    "name": reuse.JOB,
                    "status": "completed",
                    "conclusion": "success",
                    "head_sha": HEAD,
                    "steps": steps,
                }
            ]
        artifact_match = reuse.re.fullmatch(r"actions/runs/([0-9]+)/artifacts", path)
        if artifact_match:
            run = int(artifact_match[1])
            name = reuse.artifact_name(
                self.artifact_class,
                7,
                HEAD,
                TESTED,
                self.tested_tree,
                run,
                self.artifact_attempt,
            )
            return [
                {
                    "id": 500 + index,
                    "name": name,
                    "expired": self.artifact_expired,
                    "digest": "sha256:" + "f" * 64,
                    "workflow_run": {
                        "id": run,
                        "head_sha": HEAD,
                        "head_branch": "feature",
                        "repository_id": 1,
                        "head_repository_id": 1,
                    },
                }
                for index in range(self.artifact_count)
            ]
        raise AssertionError(path)


def environment(repository=reuse.REPOSITORY):
    return {
        "GITHUB_ACTIONS": "true",
        "GITHUB_REPOSITORY": repository,
        "GITHUB_EVENT_NAME": "push",
        "GITHUB_REF": "refs/heads/downstream-main",
        "GITHUB_REF_PROTECTED": "true",
        "GITHUB_SHA": MAIN,
    }


def git_values(_root, *args):
    if args == ("rev-parse", "HEAD"):
        return MAIN
    if args == ("rev-parse", "HEAD^{tree}"):
        return TREE
    if args == ("show", "-s", "--format=%P", "HEAD"):
        return f"{BASE} {HEAD}"
    raise AssertionError(args)


class ValidationReuseTests(unittest.TestCase):
    def decide(self, api=None, env=None, git_side_effect=git_values):
        with mock.patch.object(reuse, "git", side_effect=git_side_effect):
            return reuse.decide(ROOT, api or FakeGitHub(), env or environment())

    def test_full_evidence_reuses_exact_tree(self):
        result = self.decide()
        self.assertTrue(result["reuseValidation"])
        self.assertEqual(reuse.FULL, result["validationClass"])
        self.assertEqual(TREE, result["testedTree"])
        self.assertEqual(TREE, result["mainTree"])

    def test_repository_reuses_only_matching_seerr_evidence(self):
        repository = "constbogdan/seerr"
        result = self.decide(FakeGitHub(repository=repository), environment(repository))
        self.assertTrue(result["reuseValidation"])
        self.assertFalse(
            self.decide(
                FakeGitHub(repository="other/seerr"),
                environment(repository),
            )["reuseValidation"]
        )

    def test_actual_ci_workflow_matches_reuse_consumer_contract(self):
        workflow = (ROOT / reuse.WORKFLOW).read_text(encoding="utf-8")
        lines = workflow.splitlines()
        job_start = lines.index("  validation:")
        job_end = next(
            (
                index
                for index in range(job_start + 1, len(lines))
                if lines[index].startswith("  ")
                and not lines[index].startswith("    ")
                and lines[index].endswith(":")
            ),
            len(lines),
        )
        job_lines = lines[job_start:job_end]
        job_name = next(
            line.removeprefix("    name: ")
            for line in job_lines
            if line.startswith("    name: ")
        )
        step_names = [
            line.removeprefix("      - name: ")
            for line in job_lines
            if line.startswith("      - name: ")
        ]
        self.assertEqual(reuse.JOB, job_name)
        for name in reuse.VALIDATION_STEPS:
            self.assertEqual(1, step_names.count(name), name)
        self.assertIn("github.repository == 'constbogdan/seerr'", workflow)
        self.assertNotIn("packages: write", workflow)
        # Reuse remains a fail-closed primitive until a later authorized workflow
        # pass wires record/upload steps into the hosted job.
        self.assertNotIn(reuse.RECORD_STEP, workflow)
        self.assertNotIn(reuse.UPLOAD_STEP, workflow)

    def test_validation_class_requires_matching_full_step_outcome(self):
        self.assertFalse(
            self.decide(FakeGitHub(validation_class="SCOPED"))[
                "reuseValidation"
            ]
        )

    def test_failed_or_cancelled_required_step_falls_back(self):
        for step in reuse.VALIDATION_STEPS + (reuse.RECORD_STEP, reuse.UPLOAD_STEP):
            for result in ("failure", "cancelled"):
                with self.subTest(step=step, result=result):
                    self.assertFalse(
                        self.decide(
                            FakeGitHub(required_step=step, required_result=result)
                        )["reuseValidation"]
                    )

    def test_tree_or_tested_parent_mismatch_falls_back(self):
        different_tree = self.decide(FakeGitHub(tested_tree="1" * 40))
        self.assertFalse(different_tree["reuseValidation"])
        self.assertIn("differs", different_tree["reason"])
        different_parents = self.decide(FakeGitHub(tested_parents=[BASE, "2" * 40]))
        self.assertFalse(different_parents["reuseValidation"])
        self.assertIn("parents differ", different_parents["reason"])

    def test_main_parent_mismatch_falls_back(self):
        def wrong_parent(root, *args):
            if args == ("show", "-s", "--format=%P", "HEAD"):
                return f"{BASE} {'3' * 40}"
            return git_values(root, *args)

        result = self.decide(git_side_effect=wrong_parent)
        self.assertFalse(result["reuseValidation"])
        self.assertIn("parents differ", result["reason"])

    def test_missing_expired_or_ambiguous_evidence_falls_back(self):
        for api in (
            FakeGitHub(runs=0),
            FakeGitHub(artifacts=0),
            FakeGitHub(artifact_expired=True),
            FakeGitHub(runs=2),
            FakeGitHub(artifacts=2),
        ):
            self.assertFalse(self.decide(api)["reuseValidation"])

    def test_foreign_repository_or_workflow_falls_back(self):
        self.assertFalse(
            self.decide(FakeGitHub(run_path=".github/workflows/foreign.yml"))[
                "reuseValidation"
            ]
        )
        self.assertFalse(
            self.decide(FakeGitHub(run_repository="foreign/seerr"))[
                "reuseValidation"
            ]
        )

    def test_contract_class_or_attempt_mismatch_falls_back(self):
        legacy = FakeGitHub()
        with mock.patch.object(
            reuse,
            "artifact_name",
            return_value=(
                f"legacy-pr-7-{HEAD}-tested-{TESTED}-tree-{TREE}-run-100-attempt-1"
            ),
        ):
            self.assertFalse(self.decide(legacy)["reuseValidation"])
        self.assertFalse(
            self.decide(
                FakeGitHub(
                    validation_class=reuse.FULL,
                    artifact_class="SCOPED",
                )
            )["reuseValidation"]
        )
        self.assertFalse(
            self.decide(FakeGitHub(run_attempt=2, artifact_attempt=1))["reuseValidation"]
        )

    def test_direct_main_or_non_pr_merge_falls_back(self):
        def one_parent(root, *args):
            if args == ("show", "-s", "--format=%P", "HEAD"):
                return BASE
            return git_values(root, *args)

        result = self.decide(git_side_effect=one_parent)
        self.assertFalse(result["reuseValidation"])
        self.assertIn("two-parent", result["reason"])

    def test_api_uncertainty_falls_back_without_failing_delivery(self):
        api = mock.Mock()
        api.pages.side_effect = ValueError("transport unavailable")
        result = self.decide(api)
        self.assertFalse(result["reuseValidation"])
        self.assertEqual(TREE, result["mainTree"])

    def test_record_binds_full_synthetic_merge_and_writes_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            env = self.record_environment(temporary, output, reuse.FULL)
            with mock.patch.object(reuse, "git", side_effect=self.pr_git):
                result = reuse.record(ROOT, env)
            record = json.loads(
                (Path(result["evidencePath"]) / "validation-evidence.json").read_text()
            )
            self.assertEqual(reuse.FULL, record["validationClass"])
            self.assertEqual(BASE, record["baseSha"])
            self.assertEqual(TESTED, record["testedSha"])
            self.assertEqual("constbogdan/seerr", record["repository"])
            self.assertTrue(result["artifactName"].startswith("seerr-pr-policy-v1-full-"))

    def test_record_rejects_foreign_repository(self):
        with tempfile.TemporaryDirectory() as temporary:
            env = self.record_environment(
                temporary, Path(temporary) / "output", reuse.FULL
            )
            env["GITHUB_REPOSITORY"] = "other/seerr"
            with mock.patch.object(reuse, "git", side_effect=self.pr_git):
                with self.assertRaises(ValueError):
                    reuse.record(ROOT, env)

    def test_record_contains_only_generic_validation_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            env = self.record_environment(temporary, output, reuse.FULL)
            with mock.patch.object(reuse, "git", side_effect=self.pr_git):
                result = reuse.record(ROOT, env)
            files = sorted(
                path.name for path in Path(result["evidencePath"]).iterdir()
            )
            self.assertEqual(["validation-evidence.json"], files)
            self.assertNotIn("apk", json.dumps(result).lower())

    def test_record_rejects_unknown_class_or_parent_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            for validation_class in ("SCOPED", "FOCUSED"):
                with self.subTest(validation_class=validation_class):
                    env = self.record_environment(
                        temporary, Path(temporary) / "output", validation_class
                    )
                    with mock.patch.object(reuse, "git", side_effect=self.pr_git):
                        with self.assertRaises(ValueError):
                            reuse.record(ROOT, env)
            env = self.record_environment(
                temporary, Path(temporary) / "output", reuse.FULL
            )

            def wrong_pr_parents(_root, *args):
                if args == ("show", "-s", "--format=%P", "HEAD"):
                    return f"{BASE} {'9' * 40}"
                return self.pr_git(_root, *args)

            with mock.patch.object(reuse, "git", side_effect=wrong_pr_parents):
                with self.assertRaisesRegex(ValueError, "parents differ"):
                    reuse.record(ROOT, env)

    @staticmethod
    def record_environment(temporary, output, validation_class):
        return {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": reuse.REPOSITORY,
            "GITHUB_EVENT_NAME": "pull_request",
            "GITHUB_REF": "refs/pull/7/merge",
            "GITHUB_SHA": TESTED,
            "GITHUB_RUN_ID": "100",
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_OUTPUT": str(output),
            "RUNNER_TEMP": temporary,
            "PR_NUMBER": "7",
            "PR_BASE_SHA": BASE,
            "PR_HEAD_SHA": HEAD,
            "VALIDATION_CLASS": validation_class,
        }

    @staticmethod
    def pr_git(_root, *args):
        if args == ("rev-parse", "HEAD"):
            return TESTED
        if args == ("rev-parse", "HEAD^{tree}"):
            return TREE
        if args == ("show", "-s", "--format=%P", "HEAD"):
            return f"{BASE} {HEAD}"
        raise AssertionError(args)

    def test_reuse_contract_contains_no_android_or_image_publication_evidence(self):
        source = (ROOT / "scripts/mosaic_validation_reuse.py").read_text(encoding="utf-8")
        workflow = (ROOT / reuse.WORKFLOW).read_text(encoding="utf-8")
        self.assertNotIn("APK", source)
        self.assertNotIn("android", source.lower())
        self.assertNotIn("packages: write", workflow)
        self.assertNotIn("docker", workflow.lower())


if __name__ == "__main__":
    unittest.main()
