import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import seerr_validation_policy as policy


ROOT = Path(__file__).resolve().parent.parent

class ValidationPolicyTest(unittest.TestCase):
    def test_low_risk_documentation_uses_scoped_checks(self):
        plan = policy.plan_paths(["docs/PREPARE_PR.md"])
        self.assertEqual("docs-only", plan["releaseRelevance"])
        self.assertEqual("low", plan["validationRisk"])
        self.assertEqual(policy.SCOPED, plan["validationMode"])
        self.assertEqual("", plan["offlineTestPattern"])

    def test_sensitive_tooling_requires_full(self):
        for path, expected_pattern in (
            ("scripts/prepare-pr.ps1", "test_*.py"),
            ("scripts/seerr_output.ps1", "test_prepare_pr.py"),
        ):
            with self.subTest(path=path):
                plan = policy.plan_paths([path])
                self.assertEqual("tooling-only", plan["releaseRelevance"])
                self.assertEqual("high", plan["validationRisk"])
                self.assertEqual(policy.FULL, plan["validationMode"])
                self.assertEqual(expected_pattern, plan["offlineTestPattern"])

        config = (ROOT / "scripts/prepare-pr.config.psd1").read_text()
        self.assertIn("'scripts/seerr_output.ps1'", config)

    def test_shared_offline_tooling_support_uses_scoped_with_complete_fixtures(self):
        for path in (
            "scripts/tooling_test_support.py",
            "scripts/example_test_support.py",
        ):
            with self.subTest(path=path):
                plan = policy.plan_paths([path])
                self.assertEqual("tooling-only", plan["releaseRelevance"])
                self.assertEqual("normal", plan["validationRisk"])
                self.assertFalse(plan["releaseRequired"])
                self.assertEqual(policy.SCOPED, plan["validationMode"])
                self.assertEqual("test_*.py", plan["offlineTestPattern"])

    def test_fast_offline_feedback_runs_only_explicitly_bounded_modules(self):
        cases = (
            ("scripts/test_seerr_change_classification.py", ["test_seerr_change_classification.py"]),
            ("scripts/seerr_validation_policy.py", ["test_seerr_validation_policy.py"]),
            ("scripts/seerr_repository.py", ["test_seerr_repository.py"]),
            ("scripts/resolve_upstream.py", ["test_resolve_upstream.py"]),
            ("scripts/test_prepare_pr.py", []),
            ("scripts/hosted_upstream.py", []),
            ("scripts/test_hosted_upstream.py", []),
            ("scripts/tooling_test_support.py", []),
        )
        for path, expected in cases:
            with self.subTest(path=path):
                self.assertEqual(
                    expected,
                    policy.plan_paths([path])["localFastOfflinePatterns"],
                )

        mixed = policy.plan_paths([
            "scripts/seerr_validation_policy.py",
            "scripts/test_prepare_pr.py",
        ])
        self.assertEqual("test_*.py", mixed["offlineTestPattern"])
        self.assertEqual(
            ["test_seerr_validation_policy.py"],
            mixed["localFastOfflinePatterns"],
        )

    def test_repository_authentication_helper_requires_full_hosted_validation(self):
        plan = policy.plan_paths(["scripts/seerr_repository.py"])
        self.assertEqual("tooling-only", plan["releaseRelevance"])
        self.assertEqual("high", plan["validationRisk"])
        self.assertFalse(plan["releaseRequired"])
        self.assertEqual(policy.FULL, plan["validationMode"])
        self.assertEqual("test_seerr_repository.py", plan["offlineTestPattern"])

    def test_image_planner_is_high_risk_tooling_not_product_output(self):
        plan = policy.plan_paths(["scripts/seerr_downstream_version.py"])
        self.assertEqual("tooling-only", plan["releaseRelevance"])
        self.assertFalse(plan["releaseRequired"])
        self.assertEqual("high", plan["validationRisk"])
        self.assertEqual(policy.FULL, plan["validationMode"])

    def test_upstream_automation_uses_explicit_release_and_offline_boundaries(self):
        ownership = policy.plan_paths(["scripts/upstream_ownership_policy.json"])
        self.assertEqual("tooling-only", ownership["releaseRelevance"])
        self.assertEqual("high", ownership["validationRisk"])
        self.assertFalse(ownership["releaseRequired"])
        self.assertEqual(policy.FULL, ownership["validationMode"])
        self.assertEqual("test_hosted_upstream.py", ownership["offlineTestPattern"])

        resolver = policy.plan_paths(["scripts/resolve_upstream.py"])
        self.assertEqual("tooling-only", resolver["releaseRelevance"])
        self.assertEqual("high", resolver["validationRisk"])
        self.assertFalse(resolver["releaseRequired"])
        self.assertEqual(policy.FULL, resolver["validationMode"])
        self.assertEqual("test_resolve_upstream.py", resolver["offlineTestPattern"])

        runner = policy.plan_paths(["scripts/run_offline_tests.py"])
        self.assertEqual("tooling-only", runner["releaseRelevance"])
        self.assertEqual("high", runner["validationRisk"])
        self.assertFalse(runner["releaseRequired"])
        self.assertEqual("test_run_offline_tests.py", runner["offlineTestPattern"])

        validation_reuse = policy.plan_paths(["scripts/seerr_validation_reuse.py"])
        self.assertEqual("tooling-only", validation_reuse["releaseRelevance"])
        self.assertEqual("high", validation_reuse["validationRisk"])
        self.assertFalse(validation_reuse["releaseRequired"])
        self.assertEqual(policy.FULL, validation_reuse["validationMode"])
        self.assertEqual(
            "test_seerr_validation_reuse.py", validation_reuse["offlineTestPattern"]
        )

    def test_unexpected_generated_files_are_not_treated_as_safe_scope(self):
        for path in (
            "scripts/__pycache__/seerr_change_classification.cpython-314.pyc",
            "scripts/generated.pyc",
        ):
            with self.subTest(path=path):
                plan = policy.plan_paths([path], root=ROOT)
                self.assertEqual("unknown", plan["releaseRelevance"])
                self.assertEqual(policy.FULL, plan["validationMode"])

    def test_normal_application_change_gets_authenticated_focused_test(self):
        plan = policy.plan_paths(["src/utils/refreshIntervalHelper.ts"])
        self.assertEqual("product-relevant", plan["releaseRelevance"])
        self.assertEqual("normal", plan["validationRisk"])
        self.assertEqual(policy.FOCUSED, plan["validationMode"])
        self.assertEqual(
            ["src/utils/refreshIntervalHelper.test.ts"], plan["focusedTests"]
        )

    def test_release_build_and_sensitive_application_inputs_require_full(self):
        for path in (
            ".github/workflows/downstream-validation.yml",
            "Dockerfile",
            "package.json",
            "pnpm-lock.yaml",
            "server/datasource.ts",
            "server/entity/User.ts",
            "server/test/index.mts",
        ):
            with self.subTest(path=path):
                plan = policy.plan_paths([path])
                self.assertEqual(policy.FULL, plan["validationMode"])

    def test_unknown_path_uses_conservative_full(self):
        for path in ("unexpected/new-boundary.file", "scripts/new_unclassified_tool.py"):
            with self.subTest(path=path):
                plan = policy.plan_paths([path])
                self.assertEqual("unknown", plan["releaseRelevance"])
                self.assertEqual("high", plan["validationRisk"])
                self.assertTrue(plan["releaseRequired"])
                self.assertEqual(policy.FULL, plan["validationMode"])

    def test_unmapped_production_path_escalates_to_full(self):
        path = "src/utils/urlHelper.ts"
        plan = policy.plan_paths([path])
        self.assertEqual(policy.FULL, plan["validationMode"])
        self.assertEqual([], plan["focusedTests"])
        self.assertEqual([path], plan["focusedFallbackPaths"])

        additive = policy.plan_paths(
            [path], ["server/utils/userAgent.test.ts"], root=ROOT
        )
        self.assertEqual(policy.FULL, additive["validationMode"])
        self.assertEqual(
            ["server/utils/userAgent.test.ts"], additive["focusedTests"]
        )

    def test_direct_test_file_is_authenticated(self):
        path = "server/utils/userAgent.test.ts"
        plan = policy.plan_paths([path])
        self.assertEqual(policy.FOCUSED, plan["validationMode"])
        self.assertEqual([path], plan["focusedTests"])

    def test_explicit_filter_remains_supported(self):
        test_path = "server/utils/userAgent.test.ts"
        plan = policy.plan_paths(["docs/PREPARE_PR.md"], [test_path])
        self.assertEqual(policy.FOCUSED, plan["validationMode"])
        self.assertEqual([test_path], plan["focusedTests"])

    def test_invalid_focused_filters_fail_closed(self):
        for value in (
            "server/utils/userAgent.spec.ts",
            "server/utils/missing.test.ts",
            "../server/utils/userAgent.test.ts",
            str((ROOT / "server/utils/userAgent.test.ts").resolve()),
            "cypress/e2e/settings.cy.ts",
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    policy.plan_paths(["docs/PREPARE_PR.md"], [value], root=ROOT)

    def test_reviewed_untracked_test_is_allowed_but_ignored_test_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
            (root / "server/lib").mkdir(parents=True)
            test_path = "server/lib/newFeature.test.ts"
            (root / test_path).write_text("export {};\n", encoding="utf-8")
            plan = policy.plan_paths([test_path], root=root)
            self.assertEqual(policy.FOCUSED, plan["validationMode"])
            self.assertEqual([test_path], plan["focusedTests"])
            (root / ".gitignore").write_text("*.test.ts\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "ignored"):
                policy.plan_paths([test_path], root=root)

    def test_upstream_or_other_caller_can_force_full(self):
        plan = policy.plan_paths(["docs/PREPARE_PR.md"], force_full=True)
        self.assertEqual(policy.FULL, plan["validationMode"])
        self.assertEqual("caller policy requires Full", plan["reason"])

    def test_github_outputs_are_machine_readable(self):
        plan = policy.plan_paths(["docs/PREPARE_PR.md"])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "github-output"
            policy.write_github_outputs(plan, output)
            values = dict(line.split("=", 1) for line in output.read_text().splitlines())
        self.assertEqual("scoped", values["validation_mode"])
        self.assertEqual("docs-only", values["release_relevance"])
        self.assertEqual("false", values["release_required"])

    def test_reviewed_untracked_candidates_are_reported_separately(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
            (root / "reviewed.json").write_text("{}\n")
            (root / "ignored.log").write_text("ignored\n")
            (root / ".gitignore").write_text("*.log\n")
            self.assertEqual(
                ["reviewed.json"],
                policy.reviewed_untracked_paths(root, ["reviewed.json", "ignored.log"]),
            )
            result = subprocess.run(
                [sys.executable, "-B", str(ROOT / "scripts/seerr_validation_policy.py"),
                 "--repo-root", str(root), "--path", "reviewed.json"],
                capture_output=True, text=True, check=True,
            )
            self.assertEqual(["reviewed.json"], json.loads(result.stdout)["reviewedUntrackedPaths"])


class ValidationIntegrationContractTest(unittest.TestCase):
    def test_ci_exposes_each_validation_path_before_expensive_execution(self):
        workflow = (
            ROOT / ".github/workflows/downstream-validation.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("pull_request:", workflow)
        self.assertIn("- downstream-main", workflow)
        self.assertIn("name: Downstream validation", workflow)
        self.assertIn("github.repository == 'constbogdan/seerr'", workflow)
        self.assertIn("permissions:\n  contents: read", workflow)

    def test_ci_retains_machine_contracts_and_current_merge_guidance(self):
        workflow = (
            ROOT / ".github/workflows/downstream-validation.yml"
        ).read_text(encoding="utf-8")
        for command in (
            "pnpm install --frozen-lockfile",
            "node bin/check-i18n.js",
            "pnpm format:check",
            "pnpm lint",
            "pnpm typecheck",
            "pnpm test",
            "pnpm build",
        ):
            self.assertIn(command, workflow)
        self.assertIn("Verify workflow inventory", workflow)
        self.assertNotIn("packages: write", workflow)

    def test_fast_standard_full_and_prepare_pr_contracts(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        self.assertIn("ValidateSet('Fast', 'Standard', 'Full')", validator)
        self.assertIn("seerr_validation_policy.py", validator)
        self.assertIn("Fast provides local feedback only", validator)
        self.assertIn("Fast deferred heavyweight or complete offline tooling", validator)
        self.assertIn("@($plan.localFastOfflinePatterns", validator)
        self.assertIn("'test_*.py'", validator)
        for command in (
            "@('install', '--frozen-lockfile')",
            "@('bin/check-i18n.js')",
            "@('format:check')",
            "@('lint')",
            "@('typecheck')",
            "@('test')",
            "@('build')",
            "Assert-WorkflowInventory",
            "@('diff', '--check')",
        ):
            self.assertIn(command, validator)
        self.assertIn("[StringComparer]::Ordinal", validator)
        self.assertIn("Assert-WorkflowInventory", validator)

    def test_local_validation_uses_repository_local_pnpm_commands(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        self.assertIn("function Find-Pnpm", validator)
        self.assertIn("'pnpm.cmd'", validator)
        self.assertIn("File = $pnpm", validator)
        self.assertIn("$env:CONFIG_DIRECTORY = $validationConfig", validator)
        self.assertIn("Args = @('test') + $selectedTests", validator)
        self.assertNotIn("Get-Command pre-commit", validator)
        self.assertNotIn("pre-commit.exe", validator)

    def test_local_validation_strips_publication_credentials(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        for name in (
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "SYNC_APP_ID",
            "SYNC_APP_PRIVATE_KEY",
            "SYNC_BOT_CLIENT_ID",
            "SYNC_BOT_PRIVATE_KEY",
            "SYNC_PUBLISH_TOKEN",
        ):
            self.assertIn(name, validator)
        self.assertIn('Remove-Item -LiteralPath "Env:$name"', validator)

    def test_validation_does_not_contain_publication_operations(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text().lower()
        for forbidden in (
            "git push",
            "gh pr create",
            "gh pr merge",
            "docker push",
            "build-push-action",
        ):
            self.assertNotIn(forbidden, validator)

    def test_ci_has_authoritative_seerr_validation_policy(self):
        workflow = (
            ROOT / ".github/workflows/downstream-validation.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("name: Downstream Validation", workflow)
        self.assertIn("name: Downstream validation", workflow)
        self.assertIn("branches:\n      - downstream-main", workflow)
        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertNotIn("packages: write", workflow)
        self.assertNotIn("pull-requests: write", workflow)

    def test_validator_records_stage_failures_and_logs(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        for helper in ("Start-MaintenanceStage", "Complete-MaintenanceStage", "Fail-MaintenanceStage"):
            self.assertIn(helper, validator)
        self.assertIn("failed with exit code", validator)
        self.assertIn("Write-Error $_.Exception.Message", validator)

    def test_validator_failure_is_nonzero(self):
        shell = shutil.which("powershell.exe") or shutil.which("pwsh")
        if not shell:
            self.skipTest("PowerShell is unavailable")
        result = subprocess.run(
            [
                shell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(ROOT / "scripts/validate-local.ps1"),
                "-Level",
                "Fast",
                "-ChangedPath",
                "docs/PREPARE_PR.md",
                "-TestFilter",
                "server/missing.test.ts",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("does not exist", result.stdout + result.stderr)

    def test_validator_uses_isolated_run_logs(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        self.assertIn("seerr-validation-", validator)
        self.assertIn("Logs: $runDirectory", validator)
        self.assertIn("seerr-validation-", validator)

    def test_snapshot_detects_worktree_index_untracked_and_head_drift(self):
        shell = shutil.which("powershell.exe") or shutil.which("pwsh")
        if not shell:
            self.skipTest("PowerShell is unavailable")
        validator = str(ROOT / "scripts/validate-local.ps1").replace("'", "''")
        cases = {
            "Working": "Set-Content tracked.txt changed",
            "Index": "Set-Content tracked.txt changed; git add tracked.txt",
            "Untracked": "Set-Content new.txt new",
            "Head": (
                "Set-Content tracked.txt changed; git add tracked.txt; "
                "git -c user.name=Fixture -c user.email=fixture@example.com commit -qm changed"
            ),
        }
        for expected, mutation in cases.items():
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
                (root / "tracked.txt").write_text("initial\n", encoding="utf-8")
                subprocess.run(["git", "add", "tracked.txt"], cwd=root, check=True)
                subprocess.run(
                    [
                        "git",
                        "-c",
                        "user.name=Fixture",
                        "-c",
                        "user.email=fixture@example.com",
                        "commit",
                        "-qm",
                        "initial",
                    ],
                    cwd=root,
                    check=True,
                )
                escaped_root = directory.replace("'", "''")
                probe = (
                    "$tokens=$null; $errors=$null; "
                    f"$ast=[Management.Automation.Language.Parser]::ParseFile('{validator}',"
                    "[ref]$tokens,[ref]$errors); "
                    "$names=@('Get-TextHash','Get-GitText','Get-RepositorySnapshot',"
                    "'Assert-RepositorySnapshot'); "
                    "$ast.FindAll({param($n) $n -is "
                    "[Management.Automation.Language.FunctionDefinitionAst]},$true) | "
                    "Where-Object Name -in $names | ForEach-Object { "
                    "Invoke-Expression $_.Extent.Text }; "
                    f"$global:runDirectory=Join-Path '{escaped_root}' 'logs'; "
                    "New-Item -ItemType Directory -Path $runDirectory | Out-Null; "
                    f"Set-Location '{escaped_root}'; $snapshot=Get-RepositorySnapshot; "
                    f"{mutation}; "
                    "try { Assert-RepositorySnapshot $snapshot probe; exit 9 } "
                    f"catch {{ if ($_.Exception.Message -notmatch '{expected}') {{ exit 8 }} }}; "
                    "exit 0"
                )
                result = subprocess.run(
                    [shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", probe],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_snapshot_hashes_multiple_untracked_paths_individually(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        self.assertIn("$untrackedText = Get-GitText", validator)
        self.assertIn("($untrackedText -split", validator)
        self.assertNotIn("@(Get-GitText @('ls-files'", validator)

    def test_stage_output_is_captured_once(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        stage = validator.split("function Invoke-ValidationStage", 1)[1].split(
            "\ntry {", 1
        )[0]
        self.assertIn("Invoke-MaintenanceLoggedCommand", validator)
        self.assertIn("-EchoOutput", validator)
        self.assertNotIn("$lines = @(&", stage)
        self.assertIn("Assert-RepositorySnapshot $Snapshot $Stage.Name", validator)

    def test_validation_logs_are_outside_the_repository_and_linked_live(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        output = (ROOT / "scripts/seerr_output.ps1").read_text()
        self.assertIn("[IO.Path]::GetTempPath()", validator)
        self.assertIn("-RunDirectoryRoot $validationLogRoot", validator)
        self.assertIn("[string]$RunDirectoryRoot", output)
        self.assertIn("$link", output)
        self.assertIn("if ($EchoOutput) { Write-Host $line }", output)

    def test_snapshot_check_precedes_exit_status_acceptance(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        stage = validator.split("function Invoke-ValidationStage", 1)[1].split(
            "\ntry {", 1
        )[0]
        self.assertIn("Assert-RepositorySnapshot $Snapshot $Stage.Name", stage)
        self.assertLess(
            stage.index("Assert-RepositorySnapshot $Snapshot $Stage.Name"),
            stage.index("if ($exitCode -ne 0)"),
        )


if __name__ == "__main__":
    unittest.main()
