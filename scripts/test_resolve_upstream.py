import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tooling_test_support import normalized_native_output


MODULE_PATH = Path(__file__).with_name("resolve_upstream.py")
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("resolve_upstream", MODULE_PATH)
resolve = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = resolve
SPEC.loader.exec_module(resolve)


EPISODE = "e" * 64
UPSTREAM = "a" * 40
DOWNSTREAM = "b" * 40
CANDIDATE = "c" * 40
BRANCH = f"chore/sync-upstream-{UPSTREAM}-{DOWNSTREAM}"


class FakeRunner:
    def __init__(self, *, dirty=False, origin="https://github.com/constbogdan/seerr.git",
                 state="open", candidate=True, local=False, local_sha=CANDIDATE,
                 tracking=None, artifact=True, ci_bucket="fail", current_branch="chore/test",
                 upstream_rewritten=False, artifact_payload=None):
        self.dirty = dirty
        self.origin = origin
        self.state = state
        self.candidate = candidate
        self.local = local
        self.local_sha = local_sha
        self.tracking = tracking
        self.artifact = artifact
        self.ci_bucket = ci_bucket
        self.current_branch = current_branch
        self.upstream_rewritten = upstream_rewritten
        self.artifact_payload = artifact_payload
        self.main_sha = DOWNSTREAM
        self.compare_map = {}
        self.calls = []
        self.root = None

    @property
    def repository(self):
        return resolve.slug(self.origin)

    def pr(self):
        body = ("<details><summary>Technical provenance and upstream history</summary>\n\n"
                "58 incoming\n\n- Upstream history remains human-readable here.\n\n"
                "```json\n" + json.dumps(self.durable_evidence()) + "\n```\n</details>\n" +
                f"<!-- seerr-upstream-episode:{EPISODE} -->") if self.candidate else "ordinary"
        return {"number": 33, "state": self.state, "draft": True, "body": body,
                "html_url": "https://github.com/constbogdan/seerr/pull/33",
                "head": {"ref": BRANCH if self.candidate else "feature/ordinary", "sha": CANDIDATE,
                         "repo": {"full_name": self.repository}},
                "base": {"ref": resolve.BASE_BRANCH, "repo": {"full_name": self.repository}}}

    def observation(self):
        return {"schema_version": 2, "episode_id": EPISODE,
                "downstream_repo": self.repository, "branch": BRANCH,
                "run_id": "456", "run_attempt": "1", "candidate_sha": CANDIDATE,
                "upstream_sha": UPSTREAM, "downstream_sha": DOWNSTREAM,
                "candidate_tree": "f" * 40, "ownership_policy_version": 1,
                "comparison_baseline": "9" * 40, "classification_range_count": 1,
                "run_url": "https://github.com/constbogdan/seerr/actions/runs/456",
                "automation_changes": [{"path": "server/lib/downloadtracker.ts", "ownership": "REVIEW"}],
                "review_paths": ["server/lib/downloadtracker.ts", "src/components/Discover/index.tsx"],
                "conflict_paths": ["server/lib/downloadtracker.ts"], "clean_path_count": 10,
                "priority": {"risk": "medium", "debt": "high", "age": "1h",
                             "escalation": "Attention"},
                "incoming_commits": [{"sha": "d" * 40,
                                      "subject": "Fix duplicates (#1946)",
                                      "url": "https://github.com/seerr-team/seerr/commit/" + "d" * 40}]}

    def durable_evidence(self):
        value = self.observation()
        value.pop("automation_changes")
        value["ownership_counts"] = {"REVIEW": 1}
        value["clean_path_count"] = 1
        return value

    def run(self, args, *, cwd, check=True):
        self.calls.append(list(args))
        self.root = Path(cwd)
        result = self._result(args)
        if check and result.returncode:
            raise resolve.Refusal(result.stderr or "fixture failure")
        return result

    def _result(self, args):
        joined = " ".join(args)
        if args[:3] == ["git", "rev-parse", "--show-toplevel"]:
            return resolve.Result(str(self.root), "", 0)
        if args[:4] == ["git", "remote", "get-url", "origin"]:
            return resolve.Result(self.origin + "\n", "", 0)
        if args[:4] == ["git", "remote", "get-url", "upstream"]:
            return resolve.Result("https://github.com/seerr-team/seerr.git\n", "", 0)
        if args[:3] == ["git", "status", "--porcelain=v1"]:
            return resolve.Result("?? local.txt\n" if self.dirty else "", "", 0)
        if args[:3] == ["git", "branch", "--show-current"]:
            return resolve.Result(self.current_branch + "\n", "", 0)
        if args[:5] == ["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"]:
            return resolve.Result("", "", 1)
        if args[:3] == ["gh", "auth", "status"]:
            return resolve.Result("authenticated", "", 0)
        if args[:3] == ["gh", "api", f"repos/{self.repository}/pulls/33"]:
            return resolve.Result(json.dumps(self.pr()), "", 0)
        if args[:3] == ["gh", "api", "--paginate"]:
            return resolve.Result(json.dumps([[self.pr()]]), "", 0)
        if args[:3] == ["gh", "api", f"repos/{self.repository}/git/ref/heads/{resolve.BASE_BRANCH}"]:
            return resolve.Result(json.dumps({"object": {"sha": self.main_sha}}), "", 0)
        if args[:2] == ["gh", "api"] and "/compare/" in args[2]:
            comparison = args[2].split("/compare/", 1)[1]
            return resolve.Result(json.dumps({"status": self.compare_map.get(comparison, "diverged")}), "", 0)
        if args[:3] == ["gh", "api", f"repos/{self.repository}/actions/runs/456"]:
            return resolve.Result(json.dumps({"run_attempt": 1}), "", 0)
        if args[:3] == ["gh", "run", "download"]:
            if not self.artifact:
                return resolve.Result("", "expired", 1)
            artifact_name = args[args.index("--name") + 1]
            if self.artifact == "observation" and artifact_name.startswith("upstream-outcome-"):
                return resolve.Result("", "outcome unavailable", 1)
            destination = Path(args[args.index("--dir") + 1])
            filename = "outcome.json" if artifact_name.startswith("upstream-outcome-") else "observation.json"
            payload = self.artifact_payload if self.artifact_payload is not None else self.observation()
            (destination / filename).write_text(json.dumps(payload), encoding="utf-8")
            return resolve.Result("", "", 0)
        if args[:3] == ["gh", "pr", "checks"]:
            row = {"name": "Downstream validation", "workflow": "Downstream validation", "bucket": self.ci_bucket,
                   "state": "FAILURE" if self.ci_bucket == "fail" else "SUCCESS",
                   "link": "https://github.com/constbogdan/seerr/actions/runs/789"}
            return resolve.Result(json.dumps([row]), "", 1 if self.ci_bucket == "fail" else 0)
        if args[:3] == ["git", "check-ref-format", "--branch"]:
            return resolve.Result(BRANCH, "", 0)
        if args[:2] == ["git", "fetch"]:
            return resolve.Result("", "", 0)
        if args[:3] == ["git", "rev-parse", f"refs/remotes/origin/{BRANCH}"]:
            return resolve.Result(CANDIDATE + "\n", "", 0)
        if args[:4] == ["git", "show-ref", "--verify", "--quiet"]:
            return resolve.Result("", "", 0 if self.local else 1)
        if args[:3] == ["git", "rev-parse", f"refs/heads/{BRANCH}"]:
            return resolve.Result(self.local_sha + "\n", "", 0)
        if args[:2] == ["git", "for-each-ref"]:
            return resolve.Result((self.tracking or "") + "\n", "", 0)
        if args[:2] in (["git", "switch"], ["git", "branch"]):
            return resolve.Result("", "", 0)
        if args[:5] == ["git", "show", "-s", "--format=%P", CANDIDATE]:
            return resolve.Result(DOWNSTREAM + "\n", "", 0)
        if args[:3] == ["git", "rev-parse", CANDIDATE + "^{tree}"]:
            return resolve.Result("f" * 40 + "\n", "", 0)
        if args[:3] == ["git", "show", CANDIDATE + ":.upstream-sync/blocked-context.json"]:
            context = {"schemaVersion": 1, "upstream": UPSTREAM, "downstream": DOWNSTREAM,
                       "policyVersion": 1, "conflicts": ["server/lib/downloadtracker.ts"]}
            return resolve.Result(json.dumps(context), "", 0)
        if args[:3] == ["git", "rev-parse", "HEAD"]:
            return resolve.Result(CANDIDATE + "\n", "", 0)
        if args[:2] == ["git", "cat-file"]:
            return resolve.Result("", "", 0)
        if args[:3] == ["git", "merge-base", "--is-ancestor"]:
            return resolve.Result("", "rewritten" if self.upstream_rewritten else "",
                                  1 if self.upstream_rewritten else 0)
        if args[:2] == ["git", "merge"]:
            return resolve.Result("", "fixture conflict", 1)
        if args[:3] == ["git", "rev-parse", "MERGE_HEAD"]:
            return resolve.Result(UPSTREAM + "\n", "", 0)
        if args[:2] == ["git", "rm"]:
            return resolve.Result("", "", 0)
        raise AssertionError(f"Unexpected fixture command: {joined}")


class ResolveUpstreamTests(unittest.TestCase):
    def root(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / ".gitignore").write_text(".logs/\n", encoding="utf-8")
        return root

    def tracked_root(self, files):
        root = self.root()
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "resolver@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "Resolver Test"], cwd=root, check=True)
        for path, content in files.items():
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "fixture"], cwd=root, check=True)
        return root

    def execute(self, runner):
        root = self.root()
        with patch.object(resolve.shutil, "which", return_value="fixture"):
            summary, output = resolve.execute(33, root, runner)
        return root, summary, output

    def candidate(self, number, path, upstream, downstream=DOWNSTREAM, head=None):
        episode = f"{number:064x}"
        branch = f"chore/sync-upstream-{upstream}-{downstream}"
        head = head or f"{number:040x}"
        pr = {"number": number, "state": "open", "draft": True,
              "body": f"<!-- seerr-upstream-episode:{episode} -->",
              "head": {"ref": branch, "sha": head, "repo": {"full_name": resolve.REPOSITORY}},
              "base": {"ref": resolve.BASE_BRANCH, "repo": {"full_name": resolve.REPOSITORY}}}
        observation = {"episode_id": episode, "upstream_sha": upstream,
                       "downstream_sha": downstream, "candidate_sha": head,
                       "review_paths": [path], "conflict_paths": [path], "clean_path_count": 1}
        return resolve.Candidate(pr, observation,
                                 {"status": "FAILED", "name": "Downstream validation", "url": "run"})

    def test_native_conflict_resolution_produces_exact_two_parent_reviewed_tree(self):
        root = self.root()
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")

        def git(*args, check=True):
            result = subprocess.run(
                ["git", "-c", "core.autocrlf=false", *args], cwd=root, env=env,
                capture_output=True, text=True, encoding="utf-8",
            )
            if check:
                self.assertEqual(0, result.returncode, result.stderr)
            return result

        git("init", "-b", "main")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        (root / "source.kt").write_text("base\n", encoding="utf-8", newline="\n")
        git("add", "source.kt")
        git("commit", "-m", "Base")
        downstream = git("rev-parse", "HEAD").stdout.strip()
        (root / "source.kt").write_text("upstream\n", encoding="utf-8", newline="\n")
        git("commit", "-am", "Upstream")
        upstream = git("rev-parse", "HEAD").stdout.strip()
        upstream_bare = root.parent / (root.name + "-upstream.git")
        self.addCleanup(lambda: shutil.rmtree(upstream_bare, ignore_errors=True))
        subprocess.run(["git", "init", "--bare", str(upstream_bare)], check=True,
                       capture_output=True, text=True)
        git("push", str(upstream_bare), f"{upstream}:refs/heads/{resolve.UPSTREAM_BRANCH}")
        git("checkout", "--detach", downstream)
        context = {"schemaVersion": 1, "upstream": upstream, "downstream": downstream,
                   "policyVersion": 1, "conflicts": ["source.kt"]}
        context_path = root / ".upstream-sync" / "blocked-context.json"
        context_path.parent.mkdir()
        context_path.write_text(json.dumps(context), encoding="utf-8", newline="\n")
        git("add", ".upstream-sync/blocked-context.json")
        git("commit", "-m", "Blocked workspace")
        candidate_sha = git("rev-parse", "HEAD").stdout.strip()
        branch = f"chore/sync-upstream-{upstream}-{downstream}"
        git("switch", "-c", branch)
        git("remote", "add", "upstream", str(upstream_bare))
        observation = {"candidate_sha": candidate_sha, "candidate_tree": git(
            "rev-parse", "HEAD^{tree}").stdout.strip(), "upstream_sha": upstream,
            "downstream_sha": downstream, "ownership_policy_version": 1,
            "conflict_paths": ["source.kt"]}
        pr = {"number": 33, "head": {"ref": branch, "sha": candidate_sha}}
        candidate = resolve.Candidate(pr, observation, {})
        runner = resolve.Runner()

        resolve.begin_native_resolution(runner, root, candidate)
        self.assertEqual(upstream, git("rev-parse", "MERGE_HEAD").stdout.strip())
        (root / "source.kt").write_text(
            "<<<<<<< downstream\nleft\n=======\nright\n>>>>>>> upstream\n",
            encoding="utf-8", newline="\n",
        )
        git("add", "source.kt")
        with self.assertRaisesRegex(resolve.Refusal, "conflict markers"):
            resolve.assert_resolved_native_merge(runner, root, candidate)
        (root / "source.kt").write_text(
            "resolved downstream + upstream\n", encoding="utf-8", newline="\n"
        )
        commit, reviewed_tree = resolve.commit_native_resolution(
            runner, root, candidate, ["source.kt", ".upstream-sync/blocked-context.json"]
        )
        self.assertEqual(
            [candidate_sha, upstream],
            git("show", "-s", "--format=%P", commit).stdout.split(),
        )
        self.assertEqual(reviewed_tree, git("rev-parse", commit + "^{tree}").stdout.strip())
        self.assertEqual(0, git("merge-base", "--is-ancestor", upstream, commit, check=False).returncode)
        self.assertNotEqual(0, git("cat-file", "-e", commit + ":.upstream-sync/blocked-context.json",
                                  check=False).returncode)
        self.assertEqual("resolved downstream + upstream", git("show", commit + ":source.kt").stdout.strip())

    def test_reused_draft_reconciliation_produces_exact_b_and_r_topology(self):
        root = self.root()
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")

        def git(*args, check=True):
            return subprocess.run(["git", *args], cwd=root, env=env, text=True,
                                  capture_output=True, check=check)

        git("init", "-q", "-b", "main")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        (root / "source.kt").write_text("base\n", encoding="utf-8", newline="\n")
        git("add", "source.kt")
        git("commit", "-q", "-m", "D")
        downstream = git("rev-parse", "HEAD").stdout.strip()

        git("switch", "-q", "-c", "upstream")
        (root / "source.kt").write_text("upstream\n", encoding="utf-8", newline="\n")
        git("commit", "-qam", "U")
        upstream = git("rev-parse", "HEAD").stdout.strip()
        upstream_bare = root / "upstream.git"
        subprocess.run(["git", "init", "-q", "--bare", str(upstream_bare)], env=env, check=True)
        git("remote", "add", "upstream", str(upstream_bare))
        git("push", "-q", "upstream", f"{upstream}:refs/heads/{resolve.UPSTREAM_BRANCH}")

        git("switch", "-q", "--detach", downstream)
        context_path = root / ".upstream-sync" / "blocked-context.json"
        context_path.parent.mkdir()
        context_path.write_text(json.dumps({
            "schemaVersion": 1, "upstream": upstream, "downstream": downstream,
            "policyVersion": 1, "conflicts": ["source.kt"],
        }), encoding="utf-8")
        git("add", ".upstream-sync/blocked-context.json")
        git("commit", "-q", "-m", "A")
        candidate_sha = git("rev-parse", "HEAD").stdout.strip()
        branch = f"chore/sync-upstream-{upstream}-{downstream}"
        git("switch", "-q", "-c", branch)

        bare = root / "origin.git"
        subprocess.run(["git", "init", "-q", "--bare", str(bare)], env=env, check=True)
        git("remote", "add", "origin", str(bare))
        git("push", "-q", "origin", f"{candidate_sha}:refs/heads/{branch}")
        git("switch", "-q", "--detach", downstream)
        (root / "main.txt").write_text("current main\n", encoding="utf-8", newline="\n")
        git("add", "main.txt")
        git("commit", "-q", "-m", "M")
        current_main = git("rev-parse", "HEAD").stdout.strip()
        git("push", "-q", "origin", f"{current_main}:refs/heads/{resolve.BASE_BRANCH}")
        git("switch", "-q", branch)

        observation = {
            "candidate_sha": candidate_sha,
            "candidate_tree": git("rev-parse", candidate_sha + "^{tree}").stdout.strip(),
            "upstream_sha": upstream, "downstream_sha": downstream,
            "ownership_policy_version": 1, "conflict_paths": ["source.kt"],
            "review_paths": ["source.kt"],
        }
        candidate = resolve.Candidate(
            {"number": 33, "head": {"ref": branch, "sha": candidate_sha}},
            observation, {}, current_main=current_main,
        )
        runner = resolve.Runner()
        self.assertEqual("", resolve.begin_main_reconciliation(runner, root, candidate))
        self.assertEqual(current_main, git("rev-parse", "MERGE_HEAD").stdout.strip())
        b_commit = resolve.reconciliation_commit(runner, root, candidate)
        self.assertEqual(
            [candidate_sha, current_main],
            git("show", "-s", "--format=%P", b_commit).stdout.split(),
        )
        resolve.begin_native_resolution(runner, root, candidate, b_commit)
        (root / "source.kt").write_text(
            "resolved downstream + upstream\n", encoding="utf-8", newline="\n"
        )
        git("add", "source.kt")
        r_commit, reviewed_tree = resolve.commit_native_resolution(
            runner, root, candidate, ["source.kt", ".upstream-sync/blocked-context.json"], b_commit
        )
        self.assertEqual([b_commit, upstream], git("show", "-s", "--format=%P", r_commit).stdout.split())
        self.assertEqual(reviewed_tree, git("rev-parse", r_commit + "^{tree}").stdout.strip())
        for ancestor in (candidate_sha, current_main, upstream):
            self.assertEqual(0, git("merge-base", "--is-ancestor", ancestor, r_commit,
                                    check=False).returncode)

    def test_reconciliation_skips_redundant_b_when_protected_head_is_in_draft(self):
        current = "6" * 40

        class Contained(FakeRunner):
            def _result(self, args):
                if args[:3] == ["git", "rev-parse", f"refs/remotes/origin/{resolve.BASE_BRANCH}"]:
                    return resolve.Result(current + "\n", "", 0)
                if args[:3] == ["git", "merge-base", "--is-ancestor"]:
                    return resolve.Result("", "", 0)
                return super()._result(args)

        candidate = resolve.Candidate(
            Contained().pr(), Contained().observation(), {}, current_main=current
        )
        runner = Contained()
        self.assertEqual(CANDIDATE, resolve.begin_main_reconciliation(runner, self.root(), candidate))
        self.assertFalse(any(call[:2] == ["git", "merge"] for call in runner.calls))

    def test_upstream_rewrite_and_incomplete_context_fail_before_merge(self):
        with self.assertRaisesRegex(resolve.Refusal, "no longer belongs"):
            self.execute(FakeRunner(upstream_rewritten=True))

        class MismatchedPolicy(FakeRunner):
            def observation(self):
                value = super().observation()
                value["ownership_policy_version"] = 2
                return value

        with self.assertRaisesRegex(resolve.Refusal, "context does not match"):
            self.execute(MismatchedPolicy())

    def run_wrapper(self, arguments, input_text=""):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        scripts = root / "scripts"
        scripts.mkdir()
        wrapper = MODULE_PATH.with_name("resolve-upstream.ps1")
        (scripts / wrapper.name).write_text(wrapper.read_text(encoding="utf-8"), encoding="utf-8")
        capture = root / "python-args.txt"
        (scripts / "resolve_upstream.py").write_text(
            "import os, pathlib, sys\n"
            "pathlib.Path(os.environ['RESOLVE_CAPTURE']).write_text(' '.join(sys.argv[1:]))\n",
            encoding="utf-8",
        )
        environment = os.environ.copy()
        environment["RESOLVE_CAPTURE"] = str(capture)
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if not shell:
            self.skipTest("PowerShell is unavailable")
        completed = subprocess.run(
            [shell, "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(scripts / wrapper.name), *arguments],
            cwd=root, input=input_text, text=True, capture_output=True, env=environment, check=False)
        return completed, capture.read_text(encoding="utf-8").strip() if capture.exists() else ""

    def test_explicit_pr_is_the_only_direct_operator_input(self):
        wrapper = MODULE_PATH.with_name("resolve-upstream.ps1").read_text(encoding="utf-8")
        self.assertRegex(wrapper, r"\[string\]\$Pr")
        self.assertNotIn("$Branch", wrapper)
        completed, captured = self.run_wrapper(["-Pr", "33"])
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertRegex(captured, r"--pr 33$")

    def test_interactive_invocation_reprompts_until_positive_integer(self):
        completed, captured = self.run_wrapper([])
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertNotIn("--pr", captured)

    def test_invalid_explicit_pr_fails_clearly(self):
        completed, captured = self.run_wrapper(["-Pr", "0"])
        self.assertNotEqual(0, completed.returncode)
        self.assertIn("-Pr must be a positive integer", normalized_native_output(completed))
        self.assertEqual("", captured)

    def test_wrong_repository_refuses_before_checkout(self):
        runner = FakeRunner(origin="https://github.com/example/wrong.git")
        with self.assertRaisesRegex(resolve.Refusal, "Expected origin"):
            self.execute(runner)
        self.assertFalse(any(call[:2] == ["git", "switch"] for call in runner.calls))

    def test_seerr_repository_is_authenticated_and_targets_matching_api(self):
        runner = FakeRunner(origin="https://github.com/constbogdan/seerr.git")
        self.execute(runner)
        commands = [" ".join(call) for call in runner.calls]
        self.assertTrue(any("repos/constbogdan/seerr/pulls/33" in call for call in commands))
        self.assertTrue(any("--repo constbogdan/seerr" in call for call in commands))
        self.assertFalse(any("repos/seerr-team/seerr/" in call for call in commands))

    def test_dirty_tree_including_untracked_refuses_before_github_query(self):
        runner = FakeRunner(dirty=True)
        with self.assertRaisesRegex(resolve.Refusal, "not clean"):
            self.execute(runner)
        self.assertFalse(any("pulls/33" in " ".join(call) for call in runner.calls))

    def test_pr_not_found_surfaces_github_error(self):
        class Missing(FakeRunner):
            def _result(self, args):
                if args[:3] == ["gh", "api", f"repos/{resolve.REPOSITORY}/pulls/33"]:
                    return resolve.Result("", "HTTP 404: Not Found", 1)
                return super()._result(args)
        with self.assertRaisesRegex(resolve.Refusal, "HTTP 404"):
            self.execute(Missing())

    def test_non_candidate_and_closed_pr_refuse(self):
        for runner, message in ((FakeRunner(candidate=False), "not a durable managed Upstream Sync"),
                                (FakeRunner(state="closed"), "closed")):
            with self.subTest(message=message), self.assertRaisesRegex(resolve.Refusal, message):
                self.execute(runner)

    def test_fresh_checkout_uses_exact_pr_branch_and_creates_prompt(self):
        runner = FakeRunner()
        root, summary, output = self.execute(runner)
        self.assertIn(["git", "fetch", "--no-tags", "origin",
                       f"refs/heads/{BRANCH}:refs/remotes/origin/{BRANCH}"], runner.calls)
        self.assertIn(["git", "switch", "--track", "-c", BRANCH, f"origin/{BRANCH}"], runner.calls)
        self.assertTrue(output.is_file())
        self.assertEqual(output, root / ".logs/upstream-resolution/pr-33/codex-prompt.md")
        self.assertIn("PR:          #33", summary)
        self.assertIn("State:       Draft - attention required", summary)
        self.assertIn("CI: FAILED", summary)
        self.assertIn(
            "Read `.logs/upstream-resolution/pr-33/codex-prompt.md` and carry out the instructions exactly.",
            summary,
        )
        self.assertNotIn("# Resolve Upstream Sync PR #33", summary)

    def test_existing_exact_tracking_branch_is_safe(self):
        runner = FakeRunner(local=True, tracking=f"origin/{BRANCH}")
        self.execute(runner)
        self.assertIn(["git", "switch", BRANCH], runner.calls)
        self.assertFalse(any("--track" in call for call in runner.calls))

    def test_existing_local_divergence_refuses_without_switch(self):
        runner = FakeRunner(local=True, local_sha="f" * 40)
        with self.assertRaisesRegex(resolve.Refusal, "differs from the PR head"):
            self.execute(runner)
        self.assertFalse(any(call[:2] == ["git", "switch"] for call in runner.calls))

    def test_pr_evidence_attention_ci_and_actual_values_reach_prompt(self):
        runner = FakeRunner()
        _, _, output = self.execute(runner)
        text = output.read_text(encoding="utf-8")
        self.assertIn("Candidate state: Draft - attention required", text)
        self.assertIn("server/lib/downloadtracker.ts", text)
        self.assertIn("Fix duplicates (#1946)", text)
        self.assertIn("FAILED - Downstream validation", text)
        self.assertIn("actions/runs/789", text)
        self.assertIn(UPSTREAM, text)
        self.assertIn(DOWNSTREAM, text)
        self.assertIn(".upstream-sync/resolution-handoff.json", text)
        self.assertIn('"pr_number": 33', text)
        self.assertIn(f'"episode_id": "{EPISODE}"', text)
        self.assertIn(f'"branch": "{BRANCH}"', text)
        self.assertIn("add the required test before publication", text)

    def test_mismatched_machine_evidence_refuses(self):
        class Mismatched(FakeRunner):
            def observation(self):
                value = super().observation()
                value["candidate_sha"] = "9" * 40
                return value
        with self.assertRaisesRegex(resolve.Refusal, "machine-evidence candidate SHA"):
            self.execute(Mismatched())

    def test_current_seerr_candidate_uses_complete_outcome_artifact(self):
        runner = FakeRunner()
        _, summary, _ = self.execute(runner)
        self.assertIn("Ready for semantic resolution", summary)
        downloads = [call for call in runner.calls if call[:3] == ["gh", "run", "download"]]
        self.assertEqual(1, len(downloads))
        self.assertIn("upstream-outcome-1", downloads[0])

    def test_complete_observation_artifact_is_used_when_outcome_is_unavailable(self):
        runner = FakeRunner(artifact="observation")
        _, summary, _ = self.execute(runner)
        self.assertIn("Ready for semantic resolution", summary)
        downloads = [call for call in runner.calls if call[:3] == ["gh", "run", "download"]]
        self.assertEqual(2, len(downloads))
        self.assertIn("upstream-outcome-1", downloads[0])
        self.assertIn("upstream-observation-1", downloads[1])

    def test_incomplete_downloaded_artifact_refuses_without_weaker_fallback(self):
        runner = FakeRunner(artifact_payload={"schema_version": 2})
        with self.assertRaisesRegex(resolve.Refusal, "Machine evidence is incomplete"):
            self.execute(runner)

    def test_wrong_downstream_repository_in_artifact_refuses(self):
        runner = FakeRunner()
        payload = runner.observation()
        payload["downstream_repo"] = "other/seerr"
        runner.artifact_payload = payload
        with self.assertRaisesRegex(resolve.Refusal, "mismatch for downstream_repo"):
            self.execute(runner)

    def test_mismatched_episode_and_branch_refuse(self):
        runner = FakeRunner()
        payload = runner.observation()
        payload["episode_id"] = "1" * 64
        runner.artifact_payload = payload
        with self.assertRaisesRegex(resolve.Refusal, "mismatch for episode_id"):
            self.execute(runner)

        runner = FakeRunner()
        payload = runner.observation()
        payload["branch"] = "chore/sync-upstream-foreign"
        runner.artifact_payload = payload
        with self.assertRaisesRegex(resolve.Refusal, "mismatch for branch"):
            self.execute(runner)

    def test_human_edited_draft_head_is_accepted_only_as_proven_descendant(self):
        runner = FakeRunner()
        pr = runner.pr()
        pr["head"]["sha"] = "8" * 40
        observation = runner.observation()
        runner.compare_map[f"{CANDIDATE}...{'8' * 40}"] = "ahead"
        resolve.validate_observation(observation, pr, EPISODE, runner=runner, root=self.root())

    def test_descendant_draft_scope_must_remain_explainable(self):
        class Descendant(FakeRunner):
            def __init__(self, path):
                super().__init__()
                self.path = path

            def pr(self):
                value = super().pr()
                value["head"]["sha"] = "8" * 40
                return value

            def _result(self, args):
                if args[:5] == ["git", "diff", "--no-renames", "--name-only", CANDIDATE]:
                    return resolve.Result(self.path + "\n", "", 0)
                return super()._result(args)

        allowed = Descendant("server/lib/downloadtracker.ts")
        candidate = resolve.Candidate(allowed.pr(), allowed.observation(), {})
        self.assertEqual(
            ["server/lib/downloadtracker.ts"],
            resolve.validate_draft_extension_scope(allowed, self.root(), candidate),
        )
        refused = Descendant("unrelated.txt")
        with self.assertRaisesRegex(resolve.Refusal, "unexplained paths"):
            resolve.validate_draft_extension_scope(
                refused, self.root(),
                resolve.Candidate(refused.pr(), refused.observation(), {}),
            )

    def current_reuse_runner(self, *, artifacts=None, runs=None):
        current_main = "6" * 40
        current_upstream = "7" * 40
        deterministic = "8" * 40
        base = FakeRunner()
        evidence = base.observation()
        evidence.update(
            schema_version=2,
            branch=f"chore/sync-upstream-{current_upstream}-{current_main}",
            candidate_sha=deterministic,
            candidate_tree="5" * 40,
            upstream_sha=current_upstream,
            downstream_sha=current_main,
            run_id="900",
            run_attempt="1",
            outcome="existing_draft_pr",
            existing_pr_number=33,
            existing_pr_branch=BRANCH,
            existing_pr_head_sha=CANDIDATE,
        )
        artifacts = {900: evidence} if artifacts is None else artifacts
        runs = ([{
            "id": run_id, "run_attempt": 1, "head_sha": current_main,
            "head_branch": resolve.BASE_BRANCH, "path": resolve.UPSTREAM_WORKFLOW_PATH,
            "conclusion": "success", "event": "schedule",
        } for run_id in artifacts] if runs is None else runs)

        class CurrentReuse(FakeRunner):
            def _result(self, args):
                if args[:3] == [
                        "gh", "api",
                        f"repos/{resolve.REPOSITORY}/actions/workflows/upstream-sync.yml/runs?branch={resolve.BASE_BRANCH}&status=success&per_page=100"]:
                    return resolve.Result(json.dumps({"workflow_runs": runs}), "", 0)
                if args[:3] == ["gh", "run", "download"] and int(args[3]) in artifacts:
                    destination = Path(args[args.index("--dir") + 1])
                    (destination / "outcome.json").write_text(
                        json.dumps(artifacts[int(args[3])]), encoding="utf-8"
                    )
                    return resolve.Result("", "", 0)
                return super()._result(args)

        return CurrentReuse(), current_main, evidence

    def test_fresh_exact_protected_branch_same_episode_reuse_is_fully_authenticated(self):
        runner, current_main, expected = self.current_reuse_runner()
        actual = resolve.load_current_reuse_observation(
            runner, self.root(), runner.pr(), runner.observation(), current_main
        )
        self.assertEqual(expected, actual)
        self.assertTrue(any("actions/workflows/upstream-sync.yml/runs" in " ".join(call)
                            for call in runner.calls))

    def test_missing_or_expired_fresh_reuse_evidence_refuses(self):
        runner, current_main, _ = self.current_reuse_runner(artifacts={}, runs=[])
        with self.assertRaisesRegex(resolve.Refusal, "Run the normal Upstream Synchronization"):
            resolve.load_current_reuse_observation(
                runner, self.root(), runner.pr(), runner.observation(), current_main
            )

    def test_fresh_reuse_binding_mismatch_and_ambiguity_refuse(self):
        runner, current_main, evidence = self.current_reuse_runner()
        wrong = dict(evidence, existing_pr_head_sha="9" * 40)
        wrong_runner, _, _ = self.current_reuse_runner(artifacts={900: wrong})
        with self.assertRaisesRegex(resolve.Refusal, "No fresh authenticated"):
            resolve.load_current_reuse_observation(
                wrong_runner, self.root(), wrong_runner.pr(), wrong_runner.observation(), current_main
            )

        disagreeing = dict(evidence, run_id="901", upstream_sha="4" * 40,
                           branch=f"chore/sync-upstream-{'4' * 40}-{current_main}")
        ambiguous, _, _ = self.current_reuse_runner(artifacts={900: evidence, 901: disagreeing})
        with self.assertRaisesRegex(resolve.Refusal, "disagree"):
            resolve.load_current_reuse_observation(
                ambiguous, self.root(), ambiguous.pr(), ambiguous.observation(), current_main
            )

    def test_ci_success_renders(self):
        _, summary, _ = self.execute(FakeRunner(ci_bucket="pass"))
        self.assertIn("CI: PASSED", summary)

    def test_expired_artifact_uses_current_durable_pr_provenance(self):
        runner = FakeRunner(artifact=False)
        _, summary, _ = self.execute(runner)
        self.assertIn("Ready for semantic resolution", summary)
        self.assertIn("Technical provenance and upstream history", runner.pr()["body"])

    def test_legacy_technical_evidence_heading_remains_supported(self):
        evidence = FakeRunner().durable_evidence()
        body = ("<details><summary>Technical evidence</summary>\n\n```json\n"
                + json.dumps(evidence) + "\n```\n</details>")
        self.assertEqual(evidence, resolve.technical_evidence(body))

    def test_incomplete_durable_pr_provenance_still_refuses(self):
        class IncompleteProvenance(FakeRunner):
            def durable_evidence(self):
                value = super().durable_evidence()
                value.pop("ownership_counts")
                return value

        with self.assertRaisesRegex(resolve.Refusal, "complete classified upstream range"):
            self.execute(IncompleteProvenance(artifact=False))

    def test_logs_are_ignored_and_no_mutating_github_or_destructive_git_commands_exist(self):
        root, _, _ = self.execute(FakeRunner())
        self.assertIn(".logs/", (root / ".gitignore").read_text(encoding="utf-8"))
        source = MODULE_PATH.read_text(encoding="utf-8")
        for forbidden in ("gh pr comment", "gh issue", "git reset", "git stash", "git clean",
                          "--force", "git push", "git pull"):
            self.assertNotIn(forbidden, source)

    def test_selector_handles_zero_one_multiple_and_cancellation(self):
        with patch("builtins.print") as output:
            self.assertIsNone(resolve.select_candidate([], None, lambda _: ""))
            self.assertIn("No open", output.call_args.args[0])
        one = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40)
        one.state = "Ready for resolution"
        self.assertIs(one, resolve.select_candidate([one], None, lambda _: ""))
        two = self.candidate(37, "server/lib/watchlistsync.ts", "2" * 40)
        two.state = "Independent"
        self.assertIsNone(resolve.select_candidate([one, two], None, lambda _: "q"))
        self.assertIs(two, resolve.select_candidate([one, two], None, lambda _: "2"))

    def test_independent_candidates_remain_parallel(self):
        runner = FakeRunner()
        first = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40)
        second = self.candidate(37, "server/lib/watchlistsync.ts", "2" * 40)
        result = resolve.classify_dependencies(runner, self.root(), [first, second])
        self.assertEqual(["Independent", "Independent"], [candidate.state for candidate in result])

    def test_exact_attention_overlap_uses_upstream_ancestry_order(self):
        runner = FakeRunner()
        older, newer = "1" * 40, "2" * 40
        runner.compare_map[f"{older}...{newer}"] = "ahead"
        first = self.candidate(33, "server/lib/downloadtracker.ts", older)
        second = self.candidate(37, "server/lib/downloadtracker.ts", newer)
        result = resolve.classify_dependencies(runner, self.root(), [first, second])
        self.assertEqual("Ready for resolution", result[0].state)
        self.assertEqual("Waiting on PR #33", result[1].state)
        self.assertEqual(("server/lib/downloadtracker.ts",), result[1].overlaps)

    def test_ambiguous_overlap_refuses_selection(self):
        runner = FakeRunner()
        first = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40)
        second = self.candidate(37, "server/lib/downloadtracker.ts", "2" * 40)
        result = resolve.classify_dependencies(runner, self.root(), [first, second])
        self.assertEqual("Dependency ambiguous", result[0].state)
        with self.assertRaisesRegex(resolve.Refusal, "refusing to guess"):
            resolve.select_candidate(result, 33)

    def test_predecessor_merge_supersedes_it_and_requires_fresh_successor_observation(self):
        runner = FakeRunner()
        merged_head, current = "3" * 40, "4" * 40
        runner.main_sha = current
        runner.compare_map[f"{merged_head}...{current}"] = "ahead"
        first = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40,
                               downstream=DOWNSTREAM, head=merged_head)
        second = self.candidate(37, "server/lib/downloadtracker.ts", "2" * 40,
                                downstream=current)
        result = resolve.classify_dependencies(runner, self.root(), [first, second])
        self.assertEqual("Superseded", result[0].state)
        self.assertEqual("Ready for resolution", result[1].state)

    def test_stale_downstream_baseline_is_ambiguous_until_reobserved(self):
        runner = FakeRunner()
        runner.main_sha = "4" * 40
        candidate = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40)
        self.assertEqual("Dependency ambiguous",
                         resolve.classify_dependencies(runner, self.root(), [candidate])[0].state)

    def test_filter_derivation_uses_exact_tracked_seerr_tests(self):
        source = "server/lib/downloadtracker.ts"
        test = "server/lib/downloadtracker.test.ts"
        root = self.tracked_root({source: "export {};\n", test: "test('queue', () => {});\n"})
        filters = resolve.derive_filters(root, [source, test], [source])
        self.assertEqual([test], filters)

    def write_filter_handoff(self, root, candidate, **overrides):
        payload = {
            "schema_version": 1,
            "pr_number": int(candidate.pr["number"]),
            "episode_id": resolve.marker(candidate.pr["body"]),
            "branch": candidate.pr["head"]["ref"],
            "head_sha": candidate.pr["head"]["sha"],
            "reviewed_source_sha": CANDIDATE,
            "test_filters": ["server/lib/downloadtracker.test.ts"],
        }
        payload.update(overrides)
        path = root / resolve.RESOLUTION_HANDOFF
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_absent_filter_handoff_uses_derived_fallback(self):
        candidate = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40)
        filters, reason = resolve.resolution_filters(
            self.root(), FakeRunner(), candidate, ["server/lib/downloadtracker.test.ts"]
        )
        self.assertEqual(["server/lib/downloadtracker.test.ts"], filters)
        self.assertIn("using deterministic derived filters", reason)

    def test_valid_filter_handoff_is_bound_and_validated(self):
        root = self.tracked_root({
            "server/lib/downloadtracker.ts": "export {};\n",
            "server/lib/downloadtracker.test.ts": "test('queue', () => {});\n",
            "server/lib/semantic.test.tsx": "test('semantic', () => {});\n",
        })
        candidate = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40)
        self.write_filter_handoff(
            root, candidate,
            test_filters=[
                "server/lib/downloadtracker.test.ts",
                "server/lib/semantic.test.tsx",
            ],
        )
        filters, reason = resolve.resolution_filters(
            root, FakeRunner(), candidate, ["server/lib/downloadtracker.test.ts"]
        )
        self.assertEqual(
            ["server/lib/downloadtracker.test.ts", "server/lib/semantic.test.tsx"], filters
        )
        self.assertIn("Authenticated semantic filter handoff", reason)

    def test_stale_or_mismatched_filter_handoff_refuses(self):
        candidate = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40)
        cases = {
            "pr_number": 34,
            "episode_id": "f" * 64,
            "branch": "chore/sync-upstream-wrong",
            "head_sha": "f" * 40,
            "reviewed_source_sha": "f" * 40,
        }
        for field, value in cases.items():
            with self.subTest(field=field):
                root = self.root()
                self.write_filter_handoff(root, candidate, **{field: value})
                with self.assertRaisesRegex(resolve.Refusal, field):
                    resolve.resolution_filters(
                        root, FakeRunner(), candidate, ["server/lib/downloadtracker.test.ts"]
                    )

    def test_malformed_filter_handoff_refuses(self):
        candidate = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40)
        root = self.root()
        path = root / resolve.RESOLUTION_HANDOFF
        path.parent.mkdir(parents=True)
        path.write_text("{not-json", encoding="utf-8")
        with self.assertRaisesRegex(resolve.Refusal, "malformed"):
            resolve.resolution_filters(
                root, FakeRunner(), candidate, ["server/lib/downloadtracker.test.ts"]
            )

    def test_filter_handoff_cannot_remove_derived_coverage(self):
        root = self.root()
        candidate = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40)
        self.write_filter_handoff(root, candidate, test_filters=["src/pages/semantic.test.tsx"])
        with self.assertRaisesRegex(resolve.Refusal, "would weaken deterministic coverage"):
            resolve.resolution_filters(
                root, FakeRunner(), candidate, ["server/lib/downloadtracker.test.ts"]
            )

    def test_missing_or_unmapped_filters_refuse(self):
        with self.assertRaisesRegex(resolve.Refusal, "No semantic-resolution changes"):
            resolve.derive_filters(self.root(), [], [])
        root = self.tracked_root({"server/unknown.ts": "export {};\n"})
        self.assertEqual([], resolve.derive_filters(root, ["server/unknown.ts"], []))
        candidate = self.candidate(33, "server/unknown.ts", "1" * 40)
        with self.assertRaisesRegex(resolve.Refusal, "No authenticated semantic test handoff"):
            resolve.resolution_filters(root, FakeRunner(), candidate, [])

    def test_handoff_rejects_non_test_and_nonexistent_targets(self):
        root = self.tracked_root({"server/lib/downloadtracker.ts": "export {};\n"})
        candidate = self.candidate(33, "server/lib/downloadtracker.ts", "1" * 40)
        for value, message in (
            ("server/lib/downloadtracker.ts", "Unsupported focused Seerr test path"),
            ("server/lib/missing.test.ts", "does not exist"),
        ):
            with self.subTest(value=value):
                self.write_filter_handoff(root, candidate, test_filters=[value])
                with self.assertRaisesRegex(resolve.Refusal, message):
                    resolve.resolution_filters(root, FakeRunner(), candidate, [], [value])

    def test_supplemental_scope_allows_related_tests_and_refuses_unrelated_behavior(self):
        source = "server/lib/downloadtracker.ts"
        test = "server/lib/downloadtracker.test.ts"
        root = self.tracked_root({
            source: "export {};\n",
            test: "test('queue', () => {});\n",
            "server/lib/watchlistsync.ts": "export {};\n",
        })
        attention = [source]
        resolve.validate_resolution_scope(root, [
            attention[0],
            test,
            ".upstream-sync/blocked-context.json",
        ], attention)
        with self.assertRaisesRegex(resolve.Refusal, "outside"):
            resolve.validate_resolution_scope(root, [
                attention[0],
                "server/lib/watchlistsync.ts",
            ], attention)

    def test_changed_test_supplies_supplemental_filter_for_unmapped_resource_attention(self):
        test = "src/components/Discover/index.test.tsx"
        root = self.tracked_root({test: "test('discover', () => {});\n"})
        filters = resolve.derive_filters(root, ["seerr-api.yml", test], ["seerr-api.yml"])
        self.assertEqual([test], filters)

    def test_default_no_publication_never_invokes_prepare_pr(self):
        candidate = self.candidate(
            33, "server/lib/downloadtracker.ts",
            "1" * 40)
        runner = FakeRunner()
        root = self.tracked_root({
            "server/lib/downloadtracker.ts": "export {};\n",
            "server/lib/downloadtracker.test.ts": "test('queue', () => {});\n",
        })
        with (patch.object(resolve, "verify_local_descendant"),
              patch.object(resolve, "assert_native_merge_identity"),
              patch.object(resolve, "resolution_paths", return_value=[
                  "server/lib/downloadtracker.ts"]),
              patch.object(resolve, "validate_reconciliation_scope", return_value=[])):
            resolve.publication_phase(root, runner, candidate, lambda _: "")
        self.assertFalse(any(call and call[0] == "powershell" for call in runner.calls))

    def test_explicit_yes_rechecks_and_delegates_exact_filters_to_prepare_pr(self):
        candidate = self.candidate(
            33, "server/lib/downloadtracker.ts",
            "1" * 40)
        candidate.state = "Ready for resolution"

        class PublishRunner(FakeRunner):
            def _result(self, args):
                if args and args[0] == "powershell":
                    return resolve.Result("prepared", "", 0)
                return super()._result(args)

        runner = PublishRunner()
        root = self.tracked_root({
            "server/lib/downloadtracker.ts": "export {};\n",
            "server/lib/downloadtracker.test.ts": "test('queue', () => {});\n",
            "server/lib/semantic.test.tsx": "test('semantic', () => {});\n",
        })
        self.write_filter_handoff(
            root, candidate,
            test_filters=[
                "server/lib/downloadtracker.test.ts",
                "server/lib/semantic.test.tsx",
            ],
        )
        paths = ["server/lib/downloadtracker.ts"]
        with (patch.object(resolve, "verify_local_descendant"),
              patch.object(resolve, "assert_native_merge_identity"),
              patch.object(resolve, "resolution_paths", return_value=paths),
              patch.object(resolve, "validate_reconciliation_scope", return_value=[]),
              patch.object(resolve, "open_candidates", return_value=[candidate]),
              patch.object(resolve, "classify_dependencies", return_value=[candidate]),
              patch.object(resolve, "commit_native_resolution", return_value=("d" * 40, "f" * 40))):
            resolve.publication_phase(root, runner, candidate, lambda _: "y")
        command = next(call for call in runner.calls if call and call[0] == "powershell")
        self.assertEqual("-Command", command[-2])
        self.assertIn("prepare-pr.ps1", command[-1])
        self.assertIn(
            "-TestFilter @('server/lib/downloadtracker.test.ts','server/lib/semantic.test.tsx')",
            command[-1],
        )
        self.assertNotIn("-Level", command[-1])
        self.assertIn("-PreserveMergeCommit", command[-1])
        self.assertIn(f"-ExpectedMergeFirstParent '{candidate.pr['head']['sha']}'", command[-1])
        self.assertIn(f"-ExpectedMergeSecondParent '{candidate.observation['upstream_sha']}'", command[-1])

    def test_clean_review_candidate_keeps_existing_non_conflict_publication_path(self):
        candidate = self.candidate(
            33, "server/lib/downloadtracker.ts",
            "1" * 40,
        )
        candidate.observation["conflict_paths"] = []
        candidate.state = "Ready for resolution"

        class PublishRunner(FakeRunner):
            def _result(self, args):
                if args and args[0] == "powershell":
                    return resolve.Result("prepared", "", 0)
                return super()._result(args)

        runner = PublishRunner()
        root = self.tracked_root({
            "server/lib/downloadtracker.ts": "export {};\n",
            "server/lib/downloadtracker.test.ts": "test('queue', () => {});\n",
        })
        paths = ["server/lib/downloadtracker.ts"]
        with (patch.object(resolve, "verify_local_descendant"),
              patch.object(resolve, "assert_native_merge_identity") as native,
              patch.object(resolve, "resolution_paths", return_value=paths),
              patch.object(resolve, "validate_reconciliation_scope", return_value=[]),
              patch.object(resolve, "open_candidates", return_value=[candidate]),
              patch.object(resolve, "classify_dependencies", return_value=[candidate])):
            resolve.publication_phase(root, runner, candidate, lambda _: "y")
        native.assert_not_called()
        command = next(call for call in runner.calls if call and call[0] == "powershell")
        self.assertNotIn("-PreserveMergeCommit", command[-1])

    def test_waiting_candidate_refuses_direct_selection(self):
        candidate = self.candidate(37, "server/lib/downloadtracker.ts", "2" * 40)
        candidate.state = "Waiting on PR #33"
        with self.assertRaisesRegex(resolve.Refusal, "Resolve its predecessor"):
            resolve.select_candidate([candidate], 37)

if __name__ == "__main__":
    unittest.main()
