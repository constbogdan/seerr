import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import mosaic_change_classification as classification
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
        validation_class=reuse.ANDROID_FULL,
        full=None,
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
        self.full = full or (
            "success" if validation_class == reuse.ANDROID_FULL else "skipped"
        )
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
                        "ref": "main",
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
                {"name": reuse.CLASSIFY_STEP, "conclusion": "success"},
                {"name": reuse.PRE_COMMIT_STEP, "conclusion": "success"},
                {"name": reuse.OFFLINE_STEP, "conclusion": "success"},
                {"name": reuse.FULL_STEP, "conclusion": self.full},
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
        "GITHUB_REF": "refs/heads/main",
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

    def test_android_full_evidence_reuses_exact_tree(self):
        result = self.decide()
        self.assertTrue(result["reuseValidation"])
        self.assertEqual(reuse.ANDROID_FULL, result["validationClass"])
        self.assertEqual(TREE, result["testedTree"])
        self.assertEqual(TREE, result["mainTree"])

    def test_non_android_evidence_reuses_exact_tree(self):
        result = self.decide(FakeGitHub(validation_class=reuse.NON_ANDROID))
        self.assertTrue(result["reuseValidation"])
        self.assertEqual(reuse.NON_ANDROID, result["validationClass"])

    def test_mosaic_repository_reuses_only_matching_mosaic_evidence(self):
        repository = "constbogdan/Mosaic"
        result = self.decide(
            FakeGitHub(repository=repository), environment(repository)
        )
        self.assertTrue(result["reuseValidation"])
        self.assertFalse(
            self.decide(
                FakeGitHub(repository="constbogdan/Wholphin"),
                environment(repository),
            )["reuseValidation"]
        )

    def test_actual_ci_workflow_matches_reuse_consumer_contract(self):
        workflow = (ROOT / reuse.WORKFLOW).read_text(encoding="utf-8")
        lines = workflow.splitlines()
        job_start = lines.index("  full-validation:")
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
        for name in (
            reuse.CLASSIFY_STEP,
            reuse.PRE_COMMIT_STEP,
            reuse.OFFLINE_STEP,
            reuse.FULL_STEP,
            reuse.RECORD_STEP,
            reuse.UPLOAD_STEP,
        ):
            self.assertEqual(1, step_names.count(name), name)
        self.assertIn("github.repository == 'constbogdan/Mosaic'", workflow)
        self.assertNotIn("github.repository == 'constbogdan/Wholphin'", workflow)
        self.assertIn("python -B scripts/run_offline_tests.py --pattern 'test_*.py'", workflow)
        self.assertIn("github.event_name == 'pull_request' || steps.main-validation-reuse.outputs.reuse_validation != 'true'", workflow)
        self.assertIn("steps.pr-validation.outputs.validation_mode != 'non-android'", workflow)
        self.assertIn("'NON_ANDROID' || 'ANDROID_FULL'", workflow)
        self.assertIn("python -B scripts/mosaic_validation_reuse.py record", workflow)
        self.assertIn("name: ${{ steps.pr-validation-evidence.outputs.artifact_name }}", workflow)
        self.assertLess(
            workflow.index("- name: Check for reusable PR validation"),
            workflow.index("- name: Check repository formatting"),
        )
        for skipped_on_reuse in (
            "Check repository formatting",
            "Run offline tooling checks",
            "Set up Android validation",
            "Run Full validation",
        ):
            section = workflow.split(f"- name: {skipped_on_reuse}", 1)[1].split("\n      - ", 1)[0]
            self.assertIn("reuse_validation != 'true'", section)

    def test_validation_class_requires_matching_full_step_outcome(self):
        self.assertFalse(
            self.decide(FakeGitHub(validation_class=reuse.ANDROID_FULL, full="skipped"))[
                "reuseValidation"
            ]
        )
        self.assertFalse(
            self.decide(FakeGitHub(validation_class=reuse.NON_ANDROID, full="success"))[
                "reuseValidation"
            ]
        )

    def test_failed_or_cancelled_required_step_falls_back(self):
        for step in (
            reuse.CLASSIFY_STEP,
            reuse.PRE_COMMIT_STEP,
            reuse.OFFLINE_STEP,
            reuse.FULL_STEP,
            reuse.RECORD_STEP,
            reuse.UPLOAD_STEP,
        ):
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
            self.decide(FakeGitHub(run_repository="foreign/Wholphin"))[
                "reuseValidation"
            ]
        )

    def test_contract_class_or_attempt_mismatch_falls_back(self):
        legacy = FakeGitHub()
        with mock.patch.object(
            reuse,
            "artifact_name",
            return_value=(
                f"wholphin-pr-7-{HEAD}-tested-{TESTED}-tree-{TREE}-run-100-attempt-1"
            ),
        ):
            self.assertFalse(self.decide(legacy)["reuseValidation"])
        self.assertFalse(
            self.decide(
                FakeGitHub(
                    validation_class=reuse.NON_ANDROID,
                    artifact_class=reuse.ANDROID_FULL,
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

    def test_record_binds_non_android_synthetic_merge_and_writes_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            env = self.record_environment(temporary, output, reuse.NON_ANDROID)
            with mock.patch.object(reuse, "git", side_effect=self.pr_git):
                result = reuse.record(ROOT, env)
            record = json.loads(
                (Path(result["evidencePath"]) / "validation-evidence.json").read_text()
            )
            self.assertEqual(reuse.NON_ANDROID, record["validationClass"])
            self.assertEqual(BASE, record["baseSha"])
            self.assertEqual(TESTED, record["testedSha"])

    def test_record_binds_current_mosaic_repository_without_protocol_rename(self):
        with tempfile.TemporaryDirectory() as temporary:
            env = self.record_environment(
                temporary, Path(temporary) / "output", reuse.NON_ANDROID
            )
            env["GITHUB_REPOSITORY"] = "constbogdan/Mosaic"
            with mock.patch.object(reuse, "git", side_effect=self.pr_git):
                result = reuse.record(ROOT, env)
            record = json.loads(
                (Path(result["evidencePath"]) / "validation-evidence.json").read_text()
            )
            self.assertEqual("constbogdan/Mosaic", record["repository"])
            self.assertTrue(result["artifactName"].startswith("wholphin-pr-policy-v1-"))

    def test_record_binds_android_full_and_carries_validated_apk(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            apk = Path(temporary) / "Mosaic-default-debug-1.0.apk"
            apk.write_bytes(b"debug apk")
            env = self.record_environment(temporary, output, reuse.ANDROID_FULL)
            env["PR_APK_PATH"] = str(apk)
            with mock.patch.object(reuse, "git", side_effect=self.pr_git):
                result = reuse.record(ROOT, env)
            self.assertEqual(
                b"debug apk",
                (Path(result["evidencePath"]) / apk.name).read_bytes(),
            )
            self.assertEqual(reuse.ANDROID_FULL, result["validationClass"])

    def test_record_rejects_unknown_class_parent_mismatch_or_missing_apk(self):
        with tempfile.TemporaryDirectory() as temporary:
            for validation_class in ("TARGETED", reuse.ANDROID_FULL):
                with self.subTest(validation_class=validation_class):
                    env = self.record_environment(
                        temporary, Path(temporary) / "output", validation_class
                    )
                    with mock.patch.object(reuse, "git", side_effect=self.pr_git):
                        with self.assertRaises(ValueError):
                            reuse.record(ROOT, env)
            env = self.record_environment(
                temporary, Path(temporary) / "output", reuse.NON_ANDROID
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
            "PR_APK_PATH": "",
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

    def test_release_assembly_and_non_apk_classification_are_unchanged(self):
        workflow = (ROOT / reuse.WORKFLOW).read_text(encoding="utf-8")
        self.assertIn("if: steps.eligibility.outputs.release_required == 'true'", workflow)
        self.assertIn(":app:assembleDefaultRelease -PmosaicPublication=true", workflow)
        self.assertEqual(
            classification.classify_paths(["docs/AGENTS.md"])["releaseRequired"], False
        )


if __name__ == "__main__":
    unittest.main()
