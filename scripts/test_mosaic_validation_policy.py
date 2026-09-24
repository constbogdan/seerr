import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

import mosaic_validation_policy as policy


ROOT = Path(__file__).resolve().parent.parent


def run_embedded_validation_plan(mode, relevance, release_required):
    """Execute the actual early-plan Python embedded in ci.yml."""
    workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    step = workflow.split("      - name: Validation path ·", 1)[1]
    source = step.split("          python - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
    source = textwrap.dedent(source)
    with tempfile.TemporaryDirectory() as directory:
        summary = Path(directory) / "summary.md"
        env = {
            **os.environ,
            "RELEASE_RELEVANCE": relevance,
            "RELEASE_REQUIRED": release_required,
            "VALIDATION_RISK": "high" if relevance == "unknown" else "normal",
            "VALIDATION_MODE": mode,
            "CHANGED_PATH_COUNT": "3",
            "REASON": "fixture policy reason",
            "GITHUB_STEP_SUMMARY": str(summary),
        }
        result = subprocess.run(
            [sys.executable, "-B", "-c", source],
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout, summary.read_text()


class ValidationPolicyTest(unittest.TestCase):
    def test_low_risk_documentation_uses_non_android_checks(self):
        plan = policy.plan_paths(["docs/PREPARE_PR.md"])
        self.assertEqual("docs-only", plan["releaseRelevance"])
        self.assertEqual("low", plan["validationRisk"])
        self.assertEqual(policy.NON_ANDROID, plan["validationMode"])
        self.assertEqual("", plan["offlineTestPattern"])

    def test_isolated_tooling_can_be_high_risk_without_android(self):
        plan = policy.plan_paths(["scripts/prepare-pr.ps1"])
        self.assertEqual("tooling-only", plan["releaseRelevance"])
        self.assertEqual("high", plan["validationRisk"])
        self.assertEqual(policy.NON_ANDROID, plan["validationMode"])
        self.assertEqual("test_mosaic_validation_policy.py", plan["offlineTestPattern"])

    def test_shared_offline_tooling_support_uses_non_android_with_complete_fixtures(self):
        for path in (
            "scripts/tooling_test_support.py",
            "scripts/example_test_support.py",
        ):
            with self.subTest(path=path):
                plan = policy.plan_paths([path])
                self.assertEqual("tooling-only", plan["releaseRelevance"])
                self.assertEqual("normal", plan["validationRisk"])
                self.assertFalse(plan["releaseRequired"])
                self.assertEqual(policy.NON_ANDROID, plan["validationMode"])
                self.assertEqual("test_*.py", plan["offlineTestPattern"])

    def test_fast_offline_feedback_runs_only_explicitly_bounded_modules(self):
        cases = (
            ("scripts/test_mosaic_change_classification.py", ["test_mosaic_change_classification.py"]),
            ("scripts/mosaic_validation_policy.py", ["test_mosaic_validation_policy.py"]),
            ("scripts/mosaic_repository.py", ["test_mosaic_repository.py"]),
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
            "scripts/mosaic_validation_policy.py",
            "scripts/test_prepare_pr.py",
        ])
        self.assertEqual("test_*.py", mixed["offlineTestPattern"])
        self.assertEqual(
            ["test_mosaic_validation_policy.py"],
            mixed["localFastOfflinePatterns"],
        )

    def test_repository_authentication_helper_requires_full_hosted_validation(self):
        plan = policy.plan_paths(["scripts/mosaic_repository.py"])
        self.assertEqual("tooling-only", plan["releaseRelevance"])
        self.assertEqual("high", plan["validationRisk"])
        self.assertFalse(plan["releaseRequired"])
        self.assertEqual(policy.FULL, plan["validationMode"])
        self.assertEqual("test_mosaic_repository.py", plan["offlineTestPattern"])

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
        self.assertEqual(policy.NON_ANDROID, resolver["validationMode"])
        self.assertEqual("test_resolve_upstream.py", resolver["offlineTestPattern"])

        runner = policy.plan_paths(["scripts/run_offline_tests.py"])
        self.assertEqual("tooling-only", runner["releaseRelevance"])
        self.assertEqual("high", runner["validationRisk"])
        self.assertFalse(runner["releaseRequired"])
        self.assertEqual("test_run_offline_tests.py", runner["offlineTestPattern"])

        validation_reuse = policy.plan_paths(["scripts/mosaic_validation_reuse.py"])
        self.assertEqual("tooling-only", validation_reuse["releaseRelevance"])
        self.assertEqual("high", validation_reuse["validationRisk"])
        self.assertFalse(validation_reuse["releaseRequired"])
        self.assertEqual(policy.FULL, validation_reuse["validationMode"])
        self.assertEqual(
            "test_mosaic_validation_reuse.py", validation_reuse["offlineTestPattern"]
        )

        hold_release = policy.plan_paths(["scripts/mosaic_hold_release.py"])
        self.assertEqual("tooling-only", hold_release["releaseRelevance"])
        self.assertEqual("high", hold_release["validationRisk"])
        self.assertFalse(hold_release["releaseRequired"])
        self.assertEqual(policy.FULL, hold_release["validationMode"])
        self.assertEqual(
            "test_mosaic_hold_release.py", hold_release["offlineTestPattern"]
        )

    def test_python_generated_files_are_ignored_not_classified(self):
        for path in (
            "scripts/__pycache__/mosaic_change_classification.cpython-314.pyc",
            "scripts/generated.pyc",
        ):
            with self.subTest(path=path):
                result = subprocess.run(
                    ["git", "check-ignore", "--quiet", path], cwd=ROOT, check=False
                )
                self.assertEqual(0, result.returncode)

    def test_normal_application_change_gets_focused_android_tests(self):
        plan = policy.plan_paths([
            "app/src/main/java/com/github/damontecres/wholphin/ui/downloads/DownloadsPage.kt"
        ])
        self.assertEqual("apk-relevant", plan["releaseRelevance"])
        self.assertEqual("normal", plan["validationRisk"])
        self.assertEqual(policy.TARGETED_ANDROID, plan["validationMode"])
        self.assertIn("com.github.damontecres.wholphin.ui.downloads.*", plan["focusedTests"])

    def test_release_build_and_sensitive_application_inputs_require_full(self):
        for path in (
            ".github/workflows/ci.yml",
            "app/build.gradle.kts",
            "app/src/main/proto/WholphinDataStore.proto",
            "app/src/main/java/com/github/damontecres/wholphin/data/AppDatabase.kt",
            "app/src/androidTest/java/com/github/damontecres/wholphin/test/TestDbMigrations.kt",
            "app/src/release/java/com/github/damontecres/wholphin/services/RealProvider.kt",
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

    def test_unmapped_production_path_gets_broad_fallback(self):
        path = "app/src/main/java/com/github/damontecres/wholphin/newarea/NewThing.kt"
        plan = policy.plan_paths([path])
        self.assertEqual(policy.TARGETED_ANDROID, plan["validationMode"])
        self.assertEqual([policy.ALL_JVM_TESTS], plan["focusedTests"])
        self.assertEqual([path], plan["focusedFallbackPaths"])

    def test_new_or_moved_test_files_cannot_disappear(self):
        plan = policy.plan_paths([
            "app/src/test/java/com/github/example/OldNameTest.kt",
            "app/src/test/java/com/github/example/NewNameTest.kt",
        ])
        self.assertEqual(["*NewNameTest", "*OldNameTest"], plan["focusedTests"])

    def test_explicit_filter_remains_supported(self):
        plan = policy.plan_paths(["docs/PREPARE_PR.md"], ["*IntentionalTest"])
        self.assertEqual(policy.TARGETED_ANDROID, plan["validationMode"])
        self.assertEqual(["*IntentionalTest"], plan["focusedTests"])

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
        self.assertEqual("non-android", values["validation_mode"])
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
                [sys.executable, "-B", str(ROOT / "scripts/mosaic_validation_policy.py"),
                 "--repo-root", str(root), "--path", "reviewed.json"],
                capture_output=True, text=True, check=True,
            )
            self.assertEqual(["reviewed.json"], json.loads(result.stdout)["reviewedUntrackedPaths"])


class ValidationIntegrationContractTest(unittest.TestCase):
    def test_ci_exposes_each_validation_path_before_expensive_execution(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        dynamic_name = (
            "Validation path · ${{ steps.pr-validation.outputs.release_relevance == 'unknown' "
            "&& 'Conservative Android Full' || steps.pr-validation.outputs.validation_mode == "
            "'non-android' && 'Non-Android' || 'Android Full' }}"
        )
        self.assertIn(dynamic_name, workflow)

        cases = (
            (
                "non-android",
                "tooling-only",
                "false",
                "Application validation not required.",
                "Next: check changed files and run all offline tooling tests.",
            ),
            (
                "full",
                "apk-relevant",
                "true",
                "Android Full required.",
                "Next: check changed files, run all offline tooling tests, then run Full validation.",
            ),
            (
                "full",
                "unknown",
                "true",
                "Conservative Android Full required because classification is uncertain.",
                "Running changed-range pre-commit, all offline tooling tests, then Full defaultDebug validation.",
            ),
        )
        for mode, relevance, required, headline, next_step in cases:
            with self.subTest(mode=mode, relevance=relevance):
                output, summary = run_embedded_validation_plan(mode, relevance, required)
                self.assertIn(headline, output)
                self.assertIn(next_step, output)
                self.assertIn(headline, summary)
                self.assertIn(next_step, summary)

    def test_ci_retains_machine_contracts_and_current_merge_guidance(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        for contract in (
            "  full-validation:",
            "    name: Full validation",
            "id: pr-validation",
            "- name: Run Full validation",
            "id: full-validation",
            "Record reusable PR validation evidence",
            "Upload PR validation evidence",
        ):
            self.assertIn(contract, workflow)
        self.assertNotIn("Confirm this required job is green", workflow)
        self.assertIn("Eligible ordinary PRs merge through native auto-merge", workflow)
        self.assertIn("Draft and upstream-review PRs remain human-controlled", workflow)

    def test_fast_standard_full_and_prepare_pr_contracts(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        core = validator
        prepare = (ROOT / "scripts/prepare-pr.ps1").read_text()
        prepare_config = (ROOT / "scripts/prepare-pr.config.psd1").read_text()
        self.assertIn("ValidateSet('Fast', 'Standard', 'Full')", validator)
        self.assertIn("mosaic_validation_policy.py", core)
        self.assertIn("$effectiveMode = if ($Level -eq 'Full')", core)
        self.assertIn("$isFullPath = $effectiveMode -eq 'full'", core)
        self.assertIn("Fast provides local feedback only", core)
        self.assertIn("$selectedTests = if ($Level -eq 'Fast' -and $TestFilter.Count)", core)
        self.assertIn("elseif ($Level -eq 'Fast' -and $plan.validationMode -eq 'full')", core)
        self.assertIn("@($plan.localFastOfflinePatterns", core)
        self.assertIn("$deferredOfflineToPr", core)
        self.assertIn("Fast deferred heavyweight or complete offline tooling", core)
        self.assertIn("Reviewed untracked pre-commit", core)
        self.assertIn("$plan.reviewedUntrackedPaths", core)
        self.assertIn("@('run', '--all-files')", core)
        self.assertIn("'test_*.py'", core)
        self.assertIn("ValidateSet('Fast', 'Full')", prepare)
        self.assertIn("[string]$Level = 'Fast'", prepare)
        self.assertIn("-ChangedPath @($State.publicationPaths)", prepare)
        self.assertIn("Invoke-LocalChecks", prepare)
        self.assertNotIn("FocusedBeforeFull", validator + prepare)
        self.assertNotIn("$levels = if ($isUpstreamSync)", prepare)
        self.assertNotIn("if ($policy.validationMode -eq 'full')", prepare)
        self.assertNotIn("validationResults", prepare)
        self.assertIn("Upstream-sync preparation requires meaningful focused JVM test patterns", prepare)
        self.assertIn("authoritative validation is running on GitHub.", prepare)
        self.assertIn("Join-Path $runDirectory 'prepare-pr.log'", prepare)
        self.assertNotIn("Join-Path $repoRoot 'prepare-pr.log'", prepare)
        for safety_boundary in (
            "Get-WorkingSnapshotHash",
            "Get-StagedSnapshotHash",
            "HEAD^{tree}",
            "publication would require a force push",
            "Expected exactly one existing Draft PR for the preserved upstream merge",
        ):
            self.assertIn(safety_boundary, prepare)
        self.assertIn("'.vscode/*'", prepare_config)
        for canonical_doc in (
            "'docs/MOSAIC_ROADMAP.md'",
            "'docs/ARCHITECTURE.md'",
            "'docs/MOSAIC_IDENTITY.md'",
        ):
            self.assertIn(canonical_doc, prepare_config)
        self.assertNotIn("'docs/Wholphin_ROADMAP.md'", prepare_config)
        self.assertIn("$path -ne '.vscode/tasks.json'", prepare)
        self.assertIn("[credentials-redacted]", prepare)

    def test_local_validation_uses_resolved_python_module_for_pre_commit(self):
        validator = (ROOT / "scripts/validate-local.ps1").read_text()
        resolver = validator.split("function Find-PreCommit", 1)[1].split(
            "function Invoke-StageCommand", 1
        )[0]
        self.assertNotIn("Get-Command pre-commit", resolver)
        self.assertNotIn("pre-commit.exe", resolver)
        self.assertIn("& $Python -m pre_commit --version", resolver)
        self.assertIn("File = $Python; Prefix = @('-m', 'pre_commit')", resolver)

    def test_python_autofix_hooks_use_modules_not_generated_console_launchers(self):
        config = (ROOT / ".pre-commit-config.yaml").read_text(encoding="utf-8")
        self.assertIn("rev: v6.0.0", config)
        expected = {
            "end-of-file-fixer": "python -m pre_commit_hooks.end_of_file_fixer",
            "trailing-whitespace": "python -m pre_commit_hooks.trailing_whitespace_fixer",
        }
        for hook_id, entry in expected.items():
            with self.subTest(hook=hook_id):
                block = config.split(f"- id: {hook_id}", 1)[1].split("- id:", 1)[0]
                self.assertIn(f"entry: {entry}", block)
                self.assertNotIn(".exe", block.lower())
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.assertIn("uses: pre-commit/action@2c7b3805fd2a0fd8c1884dcaebf91fc102a13ecd", workflow)

    def test_vscode_tasks_are_native_safe_entry_points(self):
        tasks = json.loads((ROOT / ".vscode/tasks.json").read_text())
        labels = {task["label"]: task["command"] for task in tasks["tasks"]}
        self.assertEqual(
            {
                "Mosaic: Prepare PR",
                "Mosaic: Resolve Upstream",
                "Mosaic: Classify Changes",
                "Mosaic: Validate Fast",
                "Mosaic: Validate Standard",
                "Mosaic: Validate Full",
            },
            set(labels),
        )
        self.assertEqual(".\\scripts\\prepare-pr.ps1", labels["Mosaic: Prepare PR"])
        self.assertEqual(".\\scripts\\resolve-upstream.ps1", labels["Mosaic: Resolve Upstream"])
        classify = labels["Mosaic: Classify Changes"]
        self.assertIn("mosaic_validation_policy.py", classify)
        self.assertIn("--base origin/main --head HEAD --include-working-tree", classify)
        self.assertIn("ConvertFrom-Json", classify)
        self.assertIn("Where-Object releaseRelevance -eq 'unknown'", classify)
        combined = "\n".join(labels.values()).lower()
        for forbidden in ("stable", "publish", "rollback", "force"):
            self.assertNotIn(forbidden, combined)
        ignore = (ROOT / ".gitignore").read_text()
        self.assertEqual(1, sum(line == ".logs/" for line in ignore.splitlines()))
        self.assertIn("!.vscode/tasks.json", ignore)

    def test_ci_has_authoritative_pr_policy_and_keeps_main_i02_boundary(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.assertIn("Choose PR validation path", workflow)
        self.assertIn("Validation path ·", workflow)
        self.assertIn("Android Full required", workflow)
        self.assertIn("No Development release is expected from this PR alone.", workflow)
        self.assertIn("Selected PR checks passed", workflow)
        self.assertIn("Required CI is green", workflow)
        self.assertIn("<summary>Technical details</summary>", workflow)
        self.assertIn('git show "$BASE_SHA:scripts/mosaic_validation_policy.py"', workflow)
        self.assertIn("First rollout cannot trust a policy absent from base; require Full.", workflow)
        self.assertNotIn("Run targeted Android validation", workflow)
        self.assertIn(
            "python -B scripts/run_offline_tests.py --pattern 'test_*.py'", workflow
        )
        offline_step = workflow.split("      - name: Run offline tooling checks", 1)[1]
        offline_step = offline_step.split("      - name:", 1)[0]
        self.assertIn("if: github.event_name == 'pull_request'", offline_step)
        self.assertIn("--pattern 'test_*.py'", offline_step)
        self.assertIn(
            "steps.pr-validation.outputs.validation_mode != 'non-android'", workflow
        )
        self.assertIn("Record reusable PR validation evidence", workflow)
        self.assertIn("Upload PR validation evidence", workflow)
        self.assertIn("GITHUB_STEP_SUMMARY", workflow)
        self.assertIn(
            "steps.main-validation-reuse.outputs.reuse_validation != 'true'", workflow
        )
        self.assertIn("Build unsigned Development Release APK", workflow)
        self.assertIn("needs.release-build.outputs.release_required == 'true'", workflow)
        self.assertFalse((ROOT / ".github/workflows/mosaic-development-release.yml").exists())
        self.assertFalse((ROOT / ".github/workflows/mosaic-development-resume.yml").exists())

    def test_output_helper_is_color_independent_and_retains_error_locations(self):
        helper = (ROOT / "scripts/mosaic_output.ps1").read_text()
        for marker in ("[RUN]", "[PASS]", "[FAIL]"):
            self.assertIn(marker, helper)
        self.assertIn("CurrentStageLog", helper)
        self.assertIn("CurrentStageWriter", helper)
        self.assertIn("[IO.StreamWriter]::new", helper)
        self.assertNotIn("Add-Content -LiteralPath $Context.CurrentStageLog", helper)
        self.assertIn("MaximumLines = 16", helper)
        self.assertIn("Full log:", helper)
        self.assertIn("\\d+(?::\\d+)?", helper)

    def test_stage_helper_success_and_failure_outputs(self):
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if not shell:
            self.skipTest("PowerShell is unavailable")
        helper = str(ROOT / "scripts/mosaic_output.ps1").replace("'", "''")
        with tempfile.TemporaryDirectory() as directory:
            escaped = directory.replace("'", "''")
            script = (
                f". '{helper}'; $root='{escaped}'; $legacy=Join-Path $root 'legacy.log'; "
                "Set-Content $legacy ''; $c=New-MosaicRunOutput $root validation $legacy; "
                "Start-MosaicStage $c 1 2 'Pre-commit' 'pre-commit.log'; Complete-MosaicStage $c; "
                "Start-MosaicStage $c 2 2 'Compile' 'compile.log'; "
                "Write-MosaicStageLog $c 'e: Sample.kt:12:3: failure'; "
                "Fail-MosaicStage $c 'exit 1'"
            )
            shell_arguments = [shell, "-NoProfile"]
            if os.name == "nt":
                shell_arguments += ["-ExecutionPolicy", "Bypass"]
            result = subprocess.run(
                shell_arguments + ["-Command", script], capture_output=True, text=True, timeout=30
            )
            stage_logs = list(Path(directory).glob(".logs/validation/*/*.log"))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("[1/2] Pre-commit [PASS]", result.stdout)
        self.assertIn("[2/2] Compile [RUN]", result.stdout)
        self.assertIn("[2/2] Compile [FAIL]", result.stdout)
        self.assertIn("Sample.kt:12:3", result.stdout)
        self.assertIn("Full log:", result.stdout)
        self.assertEqual(2, len(stage_logs))

    def test_compact_stage_log_link_appears_once_on_run(self):
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if not shell:
            self.skipTest("PowerShell is unavailable")
        helper = str(ROOT / "scripts/mosaic_output.ps1").replace("'", "''")
        with tempfile.TemporaryDirectory() as directory:
            escaped = directory.replace("'", "''")
            script = (
                f". '{helper}'; $root='{escaped}'; $legacy=Join-Path $root 'legacy.log'; "
                "$env:MOSAIC_OUTPUT_COMPACT='1'; $env:MOSAIC_TERMINAL_HYPERLINKS='never'; "
                "$c=New-MosaicRunOutput $root validation $legacy; "
                "Start-MosaicStage $c 1 2 'Pre-commit' 'pre-commit.log'; Complete-MosaicStage $c; "
                "Start-MosaicStage $c 2 2 'Compile' 'compile.log'; Fail-MosaicStage $c 'exit 1'"
            )
            shell_arguments = [shell, "-NoProfile"]
            if os.name == "nt":
                shell_arguments += ["-ExecutionPolicy", "Bypass"]
            result = subprocess.run(
                shell_arguments + ["-Command", script], capture_output=True, text=True, timeout=30
            )
        self.assertEqual(0, result.returncode, result.stderr)
        lines = result.stdout.splitlines()
        run_lines = [line for line in lines if "[RUN]" in line]
        result_lines = [line for line in lines if "[PASS]" in line or "[FAIL]" in line]
        self.assertEqual(2, len(run_lines))
        self.assertTrue(all("[log:" in line for line in run_lines))
        self.assertTrue(all("[log" not in line for line in result_lines))
        self.assertEqual(2, result.stdout.count("[log:"))
        self.assertIn("FAILED: Compile", result.stdout)
        self.assertIn("exit 1", result.stdout)

    def test_legacy_log_is_only_published_after_live_logging(self):
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if not shell:
            self.skipTest("PowerShell is unavailable")
        helper = str(ROOT / "scripts/mosaic_output.ps1").replace("'", "''")
        with tempfile.TemporaryDirectory() as directory:
            escaped = directory.replace("'", "''")
            script = (
                f". '{helper}'; $root='{escaped}'; $legacy=Join-Path $root 'legacy.log'; "
                "[IO.File]::WriteAllText($legacy, 'previous'); "
                "$lock=[IO.File]::Open($legacy, 'Open', 'ReadWrite', 'None'); "
                "$c=New-MosaicRunOutput $root validation $legacy; "
                "Start-MosaicStage $c 1 1 'Compile' 'compile.log'; "
                "Write-MosaicRunLog $c 'live output remains available'; Complete-MosaicStage $c; "
                "$first=Publish-MosaicLegacyLog $c; $lock.Dispose(); "
                "$second=Publish-MosaicLegacyLog $c; "
                "$content=Get-Content $legacy -Raw; "
                "if ($first -or -not $second -or $content -notmatch 'live output remains available') { exit 9 }"
            )
            shell_arguments = [shell, "-NoProfile"]
            if os.name == "nt":
                shell_arguments += ["-ExecutionPolicy", "Bypass"]
            result = subprocess.run(
                shell_arguments + ["-Command", script], capture_output=True, text=True, timeout=30
            )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(1, result.stdout.count("Compatibility log could not be refreshed"))
        helper_source = (ROOT / "scripts/mosaic_output.ps1").read_text()
        self.assertNotIn("Add-Content -LiteralPath $Context.LegacyLogPath", helper_source)

    def test_stage_command_uses_one_writer_for_complete_output(self):
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if not shell:
            self.skipTest("PowerShell is unavailable")
        helper = str(ROOT / "scripts/mosaic_output.ps1").replace("'", "''")
        with tempfile.TemporaryDirectory() as directory:
            escaped = directory.replace("'", "''")
            script = (
                f". '{helper}'; $root='{escaped}'; $legacy=Join-Path $root 'legacy.log'; "
                "$c=New-MosaicRunOutput $root validation $legacy; "
                "Start-MosaicStage $c 1 1 'Output' 'output.log'; "
                # Reuse the current host, even when no shell can be found on PATH.
                "$shell=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName; $env:PATH=''; "
                "$code=Invoke-MosaicLoggedCommand $c $shell @('-NoProfile','-Command','1..200') 'fixture'; "
                "$path=$c.CurrentStageLog; Complete-MosaicStage $c; "
                "$lines=@(Get-Content $path); if ($code -ne 0 -or $lines.Count -lt 204) { exit 8 }"
            )
            shell_arguments = [shell, "-NoProfile"]
            if os.name == "nt":
                shell_arguments += ["-ExecutionPolicy", "Bypass"]
            result = subprocess.run(
                shell_arguments + ["-Command", script], capture_output=True, text=True, timeout=30
            )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("Stream was not readable", result.stdout + result.stderr)
        self.assertNotIn("being used by another process", result.stdout + result.stderr)

    def test_stage_command_preserves_empty_output_lines(self):
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if not shell:
            self.skipTest("PowerShell is unavailable")
        helper = str(ROOT / "scripts/mosaic_output.ps1").replace("'", "''")
        with tempfile.TemporaryDirectory() as directory:
            escaped = directory.replace("'", "''")
            script = (
                f". '{helper}'; $root='{escaped}'; $legacy=Join-Path $root 'legacy.log'; "
                "$c=New-MosaicRunOutput $root validation $legacy; "
                "Start-MosaicStage $c 1 1 'Output' 'output.log'; "
                "$command=\"[Console]::WriteLine('before'); [Console]::WriteLine(''); "
                "[Console]::WriteLine('after')\"; "
                # Reuse the current host, even when no shell can be found on PATH.
                "$shell=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName; $env:PATH=''; "
                "$code=Invoke-MosaicLoggedCommand $c $shell @('-NoProfile','-Command',$command) 'fixture'; "
                "$path=$c.CurrentStageLog; Complete-MosaicStage $c; "
                "$content=Get-Content $path -Raw; "
                "if ($code -ne 0 -or $content -notmatch 'before\\r?\\n\\r?\\nafter') { exit 8 }"
            )
            shell_arguments = [shell, "-NoProfile"]
            if os.name == "nt":
                shell_arguments += ["-ExecutionPolicy", "Bypass"]
            result = subprocess.run(
                shell_arguments + ["-Command", script], capture_output=True, text=True, timeout=30
            )
        self.assertEqual(0, result.returncode, result.stderr)


if __name__ == "__main__":
    unittest.main()
