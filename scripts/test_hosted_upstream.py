"""Offline integration tests: disposable Git repositories and an in-memory GitHub.

Run: python -B -m unittest discover -s scripts -p 'test_hosted_upstream.py' -v
No test contacts GitHub or mutates the application checkout.
"""

import json
import io
from contextlib import redirect_stderr, redirect_stdout
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import hosted_upstream as sync


class GitHubFake:
    def __init__(self):
        self.repository = sync.ORIGIN
        self.records = []
        self.created = []
        self.fail_pr = False

    def pulls(self):
        return self.records

    def create_pr(self, branch, body, *, draft=False, title=None):
        if self.fail_pr:
            raise sync.Blocked("PR creation failed")
        self.created.append((branch, body, draft, title))
        return f"https://github.com/{self.repository}/pull/123"


class LocalGit(sync.Git):
    def __init__(self, path, remotes):
        self.remotes = remotes
        self.pushes = []
        super().__init__(path)
        # Explicit fixture-only local transport. Production forbids file URLs.
        self.options += ["-c", "protocol.file.allow=always"]

    def fetch(self, remote, source, destination):
        self.run("fetch", "--quiet", "--no-tags", str(self.remotes[remote]), f"{source}:{destination}")

    def text(self, *args):
        if args[0] == "ls-remote":
            args = tuple(str(self.remotes.get(a, a)) for a in args)
        return super().text(*args)

    def push(self, branch, candidate):
        self.identities()
        args = ("push", "--porcelain", str(self.remotes["origin"]), f"{candidate}:refs/heads/{branch}")
        self.pushes.append(args)
        self.run(*args)


class HostedSyncTests(unittest.TestCase):
    def setUp(self):
        token = patch.dict(os.environ, {"SYNC_PUBLISH_TOKEN": "fixture-only-never-sent"})
        token.start()
        self.addCleanup(token.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="wholphin-sync-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.seed = self.root / "seed"
        self.seed.mkdir()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="Fixture", GIT_COMMITTER_NAME="Fixture",
                        GIT_AUTHOR_EMAIL="fixture@example.invalid", GIT_COMMITTER_EMAIL="fixture@example.invalid")
        self.g("init", "-b", "main")
        self.commit("base.txt", "base\n")
        self.anchor = self.g("rev-parse", "HEAD")
        self.remotes = {name: self.root / (name + ".git") for name in ("origin", "upstream")}
        for remote in self.remotes.values():
            self.g("clone", "--bare", str(self.seed), str(remote))
        self.github = GitHubFake()

    def g(self, *args):
        result = subprocess.run(["git", "-c", "core.autocrlf=false", "-c", "core.hooksPath=" + os.devnull,
                                 *args], cwd=self.seed, env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def commit(self, name, content):
        path = self.seed / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        self.g("add", "--", name)
        self.g("commit", "-m", "Update " + name)
        return self.g("rev-parse", "HEAD")

    def upstream(self, name="upstream.txt", content="incoming\n"):
        sha = self.commit(name, content)
        self.g("push", str(self.remotes["upstream"]), "HEAD:refs/heads/main")
        return sha

    def instance(self):
        path = self.root / ("work-" + str(len(list(self.root.glob("work-*")))))
        path.mkdir()
        return LocalGit(path, self.remotes)

    def observe(self, git=None, **values):
        git = git or self.instance()
        o = {"upstream_repo": sync.UPSTREAM, "downstream_repo": sync.ORIGIN}
        o.update(values)
        sync.inspect(git, self.github, o, self.anchor)
        return git, o

    def pr(self, o, state="open", head=None, draft=False, body=None):
        return {"number": 123, "state": state, "html_url": "https://github.com/constbogdan/Mosaic/pull/123",
                "draft": draft, "body": body if body is not None else sync.description(o),
                "base": {"ref": "main", "repo": {"full_name": sync.ORIGIN}},
                "head": {"ref": o["branch"], "sha": head or o["candidate_sha"], "repo": {"full_name": sync.ORIGIN}}}

    def retain_pr(self, git, o, state="open", head=None, draft=False, body=None):
        git.run("push", str(self.remotes["origin"]), f"{o['candidate_sha']}:refs/pull/123/head")
        self.github.records = [self.pr(o, state, head, draft=draft, body=body)]

    def test_no_delta_and_no_remote_mutation(self):
        git, o = self.observe()
        self.assertEqual(o["outcome"], "no_delta")
        summary = sync.upstream_summary(o)
        self.assertTrue(summary.startswith("## No upstream changes"))
        self.assertIn("No action is required.", summary)
        self.assertIn("existing UTC schedule will check again automatically", summary)
        self.assertIn("<summary>Technical details</summary>", summary)
        sync.publish(git, self.github, o, o["upstream_sha"], o["downstream_sha"])
        self.assertFalse(git.pushes or self.github.created)

    def test_upstream_ahead_normal_merge_exact_parents_and_metadata(self):
        up = self.upstream()
        git, o = self.observe()
        self.assertEqual(o["outcome"], "ready")
        self.assertEqual(git.text("show", "-s", "--format=%P", o["candidate_sha"]), self.anchor + " " + up)
        self.assertEqual(o["candidate_parents"], [self.anchor, up])
        self.assertEqual(git.text("rev-parse", o["candidate_sha"] + "^{tree}"), o["candidate_tree"])
        self.assertEqual(o["incoming_count"], 1)
        self.assertEqual(o["changed_paths"], ["upstream.txt"])
        self.assertEqual(o["classification_range_count"], 1)
        body = sync.description(o)
        for text in (up, self.anchor, "Human review", "upstream.txt",
                     "1 FOLLOW path is included by the native candidate"):
            self.assertIn(text, body)
        evidence = sync.technical_evidence(o)
        self.assertIn('"candidate_parents"', evidence)
        self.assertIn('"classification_range_count": 1', evidence)

    def test_native_merge_primitive_rejects_parent_and_tree_mismatch(self):
        up = self.upstream()
        git, observation = self.observe()
        candidate = observation["candidate_sha"]
        tree = observation["candidate_tree"]
        self.assertEqual(
            tree,
            sync.verify_native_merge_candidate(git, candidate, self.anchor, up, tree),
        )
        with self.assertRaisesRegex(sync.Blocked, "parent order"):
            sync.verify_native_merge_candidate(git, candidate, up, self.anchor, tree)
        with self.assertRaisesRegex(sync.Blocked, "reviewed merge tree"):
            sync.verify_native_merge_candidate(git, candidate, self.anchor, up, self.anchor)

    def test_complete_range_classification_rejects_missing_or_unknown_rows(self):
        self.upstream("one.txt", "one\n")
        self.upstream("two.txt", "two\n")
        git, observation = self.observe()
        changes = observation["automation_changes"]
        self.assertEqual(2, len(sync.verify_complete_classification(
            git, observation["comparison_baseline"], observation["upstream_sha"], changes
        )))
        with self.assertRaisesRegex(sync.Blocked, "does not match"):
            sync.verify_complete_classification(
                git, observation["comparison_baseline"], observation["upstream_sha"], changes[:-1]
            )
        unknown = [dict(row) for row in changes]
        unknown[0]["ownership"] = "UNKNOWN"
        with self.assertRaisesRegex(sync.Blocked, "unknown ownership"):
            sync.verify_complete_classification(
                git, observation["comparison_baseline"], observation["upstream_sha"], unknown
            )

    def test_divergent_downstream_preserved(self):
        up = self.upstream()
        self.g("checkout", "--detach", self.anchor)
        down = self.commit("custom.txt", "downstream\n")
        self.g("push", str(self.remotes["origin"]), "HEAD:refs/heads/main")
        git, o = self.observe()
        self.assertEqual(o["downstream_sha"], down)
        self.assertTrue(git.ancestor(up, o["candidate_sha"]))
        self.assertEqual(git.text("show", o["candidate_sha"] + ":custom.txt"), "downstream")

    def test_textual_conflict_creates_deterministic_blocked_workspace(self):
        self.upstream("base.txt", "upstream\n")
        self.g("checkout", "--detach", self.anchor)
        self.commit("base.txt", "downstream\n")
        self.g("push", str(self.remotes["origin"]), "HEAD:refs/heads/main")
        git, o = self.instance(), {"downstream_repo": sync.ORIGIN}
        sync.inspect(git, self.github, o, self.anchor)
        self.assertEqual(o["outcome"], "semantic_conflict")
        self.assertEqual(o["conflict_paths"], ["base.txt"])
        self.assertTrue(o["textual_conflicts"])
        self.assertFalse(git.ancestor(o["upstream_sha"], o["candidate_sha"]))
        sync.publish(git, self.github, o, o["upstream_sha"], o["downstream_sha"])
        self.assertEqual(o["outcome"], "blocked")
        self.assertTrue(self.github.created[0][2])
        self.assertEqual(1, len(git.pushes))
        self.assertNotIn("--force", git.pushes[0])

        git.run("push", str(self.remotes["origin"]),
                f"{o['candidate_sha']}:refs/pull/123/head")
        self.github.records = [self.pr(o, draft=True)]
        retry, existing = self.observe()
        self.assertEqual("existing_draft_pr", existing["outcome"])
        self.assertEqual(123, existing["existing_pr_number"])
        self.assertEqual(existing["branch"], existing["existing_pr_branch"])
        self.assertEqual(existing["candidate_sha"], existing["existing_pr_head_sha"])
        sync.publish(
            retry, self.github, existing, existing["upstream_sha"], existing["downstream_sha"],
            expected_existing_pr=existing["existing_pr_number"],
            expected_existing_branch=existing["existing_pr_branch"],
            expected_existing_head=existing["existing_pr_head_sha"],
        )
        self.assertFalse(retry.pushes)

    def test_invalid_fetch_or_push_identity(self):
        for push in (False, True):
            git = self.instance()
            git.run("remote", "set-url", *(["--push"] if push else []), "origin", "https://github.com/other/repo.git")
            with self.assertRaisesRegex(sync.Blocked, "Unexpected origin"):
                self.observe(git)
            self.assertFalse(git.pushes)

    def test_initial_anchor_rewrite_refused(self):
        self.upstream()
        git = self.instance()
        with self.assertRaises(sync.Blocked):
            sync.inspect(git, self.github, {}, "f" * 40)

    def test_recorded_upstream_rewrite_refused(self):
        first = self.upstream()
        git, old = self.observe()
        self.retain_pr(git, old, "closed")
        self.g("checkout", "--detach", self.anchor)
        self.commit("replacement.txt", "rewritten\n")
        # Fixture-only rewrite simulates an upstream event; executor never does this.
        self.g("push", "--force", str(self.remotes["upstream"]), "HEAD:refs/heads/main")
        with self.assertRaisesRegex(sync.Blocked, "not a descendant.*" + first):
            self.observe()

    def test_orphan_published_branch_is_rewrite_anchor(self):
        self.upstream()
        git, o = self.observe()
        git.push(o["branch"], o["candidate_sha"])
        self.g("checkout", "--detach", self.anchor)
        self.commit("replacement.txt", "rewrite after interrupted publication\n")
        self.g("push", "--force", str(self.remotes["upstream"]), "HEAD:refs/heads/main")
        with self.assertRaisesRegex(sync.Blocked, "not a descendant"):
            self.observe()

    def test_orphan_branch_with_noncanonical_parent_shape_fails_closed(self):
        self.upstream()
        git, observation = self.observe()
        noncanonical = git.run(
            "commit-tree",
            observation["candidate_tree"],
            "-p",
            observation["candidate_sha"],
            input="Noncanonical descendant\n",
        ).stdout.strip()
        git.run(
            "push",
            str(self.remotes["origin"]),
            f"{noncanonical}:refs/heads/{observation['branch']}",
        )
        with self.assertRaisesRegex(sync.Blocked, "does not contain its named input pair"):
            self.observe()

    def malformed_orphan(self, git, observation):
        malformed = git.run(
            "commit-tree",
            observation["candidate_tree"],
            "-p",
            observation["candidate_sha"],
            input="Historical malformed orphan\n",
        ).stdout.strip()
        git.run(
            "push",
            str(self.remotes["origin"]),
            f"{malformed}:refs/heads/{observation['branch']}",
        )
        return malformed

    def advance_divergent_refs(self, old_upstream):
        self.g("checkout", "--detach", self.anchor)
        downstream = self.commit("downstream.txt", "current downstream\n")
        self.g("push", str(self.remotes["origin"]), "HEAD:refs/heads/main")
        self.g("checkout", "--detach", old_upstream)
        upstream = self.upstream("current-upstream.txt", "current upstream\n")
        return downstream, upstream

    def test_unrelated_malformed_orphan_is_preserved_and_ignored(self):
        old_upstream = self.upstream("old-upstream.txt", "old upstream\n")
        old_git, old = self.observe()
        malformed = self.malformed_orphan(old_git, old)
        downstream, upstream = self.advance_divergent_refs(old_upstream)

        git, observation = self.observe()
        self.assertEqual("ready", observation["outcome"])
        self.assertEqual([downstream, upstream], observation["candidate_parents"])
        self.assertNotEqual(old["branch"], observation["branch"])
        self.assertEqual(
            malformed,
            git.text("ls-remote", "--refs", "origin", "refs/heads/" + old["branch"]).split()[0],
        )

    def test_current_native_pr_remains_authoritative_over_unrelated_malformed_orphan(self):
        old_upstream = self.upstream("old-upstream.txt", "old upstream\n")
        old_git, old = self.observe()
        malformed = self.malformed_orphan(old_git, old)
        self.advance_divergent_refs(old_upstream)
        current_git, current = self.observe()
        self.retain_pr(current_git, current)

        retry_git, retry = self.observe()
        self.assertEqual("existing_pr", retry["outcome"])
        self.assertEqual(current["candidate_sha"], retry["candidate_sha"])
        self.assertEqual(
            malformed,
            retry_git.text("ls-remote", "--refs", "origin", "refs/heads/" + old["branch"]).split()[0],
        )

    def test_multiple_current_pair_pr_records_remain_ambiguous(self):
        self.upstream()
        git, observation = self.observe()
        first = self.pr(observation)
        second = {**first, "number": 124,
                  "html_url": "https://github.com/constbogdan/Mosaic/pull/124"}
        git.run(
            "push",
            str(self.remotes["origin"]),
            f"{observation['candidate_sha']}:refs/pull/123/head",
        )
        git.run(
            "push",
            str(self.remotes["origin"]),
            f"{observation['candidate_sha']}:refs/pull/124/head",
        )
        self.github.records = [first, second]
        with self.assertRaisesRegex(sync.Blocked, "closed or ambiguous PR decision"):
            self.observe(git=self.instance())

    def test_deterministic_branch_and_commit_across_retries(self):
        self.upstream()
        _, a = self.observe()
        _, b = self.observe()
        self.assertEqual(a["branch"], b["branch"])
        self.assertEqual(a["candidate_sha"], b["candidate_sha"])
        self.assertEqual(sync.BRANCH.fullmatch(a["branch"]).groups(), (a["upstream_sha"], a["downstream_sha"]))
        self.assertNotEqual(a["branch"], sync.branch_name(a["upstream_sha"], "a" * 40))
        with self.assertRaises(sync.Blocked):
            sync.branch_name("--unsafe", a["downstream_sha"])

    def test_existing_open_pr_reused_without_writes(self):
        self.upstream()
        git, o = self.observe()
        self.retain_pr(git, o)
        retry, result = self.observe()
        self.assertEqual(result["outcome"], "existing_pr")
        sync.publish(
            retry, self.github, result, result["upstream_sha"], result["downstream_sha"],
            expected_existing_pr=result["existing_pr_number"],
            expected_existing_branch=result["existing_pr_branch"],
            expected_existing_head=result["existing_pr_head_sha"],
        )
        self.assertFalse(retry.pushes or self.github.created)
        summary = sync.upstream_summary(result, publication=True)
        self.assertIn("### Candidate ready", summary)
        self.assertIn("PR #123  [open](https://github.com/constbogdan/Mosaic/pull/123)", summary)
        self.assertIn("no duplicate was created", summary)

    def test_draft_pr_appearing_during_publish_remains_blocked_and_open(self):
        self.upstream(".github/workflows/ci.yml", "review\n")
        git, observation = self.observe()
        self.assertEqual("review_required", observation["outcome"])
        self.github.records = [self.pr(observation, draft=True)]
        sync.publish(git, self.github, observation, observation["upstream_sha"], observation["downstream_sha"])
        self.assertEqual("existing_draft_pr", observation["outcome"])
        self.assertFalse(git.pushes or self.github.created)

    def test_closed_pr_not_reopened(self):
        self.upstream()
        git, o = self.observe()
        self.retain_pr(git, o, "closed")
        with self.assertRaisesRegex(sync.Blocked, "closed or ambiguous"):
            self.observe()

    def test_new_upstream_preserves_older_open_pr(self):
        self.upstream(".github/workflows/first.yml", "review first\n")
        old_git, old = self.observe()
        sync.publish(old_git, self.github, old, old["upstream_sha"], old["downstream_sha"])
        self.retain_pr(old_git, old, draft=True, body=self.github.created[0][1])
        published_count = len(self.github.created)

        self.upstream(".github/workflows/second.yml", "review second\n")
        waiting_git, waiting = self.observe()

        self.assertEqual("waiting_on_existing_pr", waiting["outcome"])
        self.assertEqual(2, waiting["incoming_count"])
        self.assertEqual(2, waiting["classification_range_count"])
        self.assertEqual(
            {".github/workflows/first.yml", ".github/workflows/second.yml"},
            set(waiting["changed_paths"]),
        )
        self.assertEqual(123, waiting["blocking_pr_number"])
        self.assertEqual(old["candidate_sha"], waiting["blocking_pr_head_sha"])
        self.assertEqual(old["branch"], waiting["blocking_pr_branch"])
        self.assertEqual(old["upstream_sha"], waiting["blocking_upstream_sha"])
        self.assertEqual(old["downstream_sha"], waiting["blocking_downstream_sha"])
        self.assertEqual(old["pr_url"], waiting["blocking_pr_url"])
        self.assertIn('"blocking_pr_head_sha"', sync.technical_evidence(waiting))

        observe_summary = sync.upstream_summary(waiting)
        self.assertTrue(observe_summary.startswith("## Upstream observation recorded"))
        self.assertNotIn("## Waiting on PR #123", observe_summary)
        with patch.dict(os.environ, {}, clear=True):
            sync.publish(
                waiting_git,
                self.github,
                waiting,
                waiting["upstream_sha"],
                waiting["downstream_sha"],
                waiting["blocking_pr_number"],
                waiting["blocking_pr_head_sha"],
            )
        self.assertFalse(waiting_git.pushes)
        self.assertEqual(published_count, len(self.github.created))
        summary = sync.upstream_summary(waiting, publication=True)
        self.assertTrue(summary.startswith("## Waiting on PR #123"))
        self.assertIn("PR #123  [open](https://github.com/constbogdan/Mosaic/pull/123)", summary)
        self.assertIn("current newer upstream observation is retained", summary)
        self.assertIn("No duplicate candidate branch or PR was created", summary)

        retry_git, retry = self.observe()
        self.assertEqual("waiting_on_existing_pr", retry["outcome"])
        self.assertEqual(waiting["candidate_sha"], retry["candidate_sha"])
        sync.publish(
            retry_git,
            self.github,
            retry,
            retry["upstream_sha"],
            retry["downstream_sha"],
            waiting["blocking_pr_number"],
            waiting["blocking_pr_head_sha"],
        )
        self.assertFalse(retry_git.pushes)
        self.assertEqual(published_count, len(self.github.created))

    def test_waiting_blocker_head_change_between_jobs_refuses(self):
        self.upstream(".github/workflows/first.yml", "review first\n")
        old_git, old = self.observe()
        self.retain_pr(old_git, old, draft=True)
        self.upstream(".github/workflows/second.yml", "review second\n")
        _, first = self.observe()

        changed_head = old_git.run(
            "commit-tree",
            old["candidate_tree"],
            "-p", old["downstream_sha"],
            "-p", old["upstream_sha"],
            input="Authenticated but changed blocker head\n",
        ).stdout.strip()
        old_git.run(
            "push", "--force", str(self.remotes["origin"]),
            f"{changed_head}:refs/pull/123/head",
        )
        self.github.records[0]["head"]["sha"] = changed_head
        publish_git, current = self.observe()
        self.assertEqual("waiting_on_existing_pr", current["outcome"])
        with self.assertRaisesRegex(sync.Blocked, "Blocking PR state changed"):
            sync.publish(
                publish_git,
                self.github,
                current,
                first["upstream_sha"],
                first["downstream_sha"],
                first["blocking_pr_number"],
                first["blocking_pr_head_sha"],
            )
        self.assertFalse(publish_git.pushes or self.github.created)

    def test_multiple_older_open_managed_candidates_remain_ambiguous(self):
        self.upstream(".github/workflows/first.yml", "review first\n")
        old_git, old = self.observe()
        self.retain_pr(old_git, old, draft=True)
        second = {**self.github.records[0], "number": 124,
                  "html_url": "https://github.com/constbogdan/Mosaic/pull/124"}
        old_git.run(
            "push", str(self.remotes["origin"]),
            f"{old['candidate_sha']}:refs/pull/124/head",
        )
        self.github.records.append(second)
        self.upstream(".github/workflows/second.yml", "review second\n")
        with self.assertRaisesRegex(sync.Blocked, "Multiple managed sync PRs"):
            self.observe()

    def test_malformed_older_open_managed_candidate_remains_blocked(self):
        self.upstream(".github/workflows/first.yml", "review first\n")
        old_git, old = self.observe()
        malformed = old_git.run(
            "commit-tree", old["candidate_tree"], "-p", old["candidate_sha"],
            input="Malformed managed candidate\n",
        ).stdout.strip()
        old_git.run(
            "push", str(self.remotes["origin"]),
            f"{malformed}:refs/pull/123/head",
        )
        self.github.records = [self.pr(old, head=malformed, draft=True)]
        self.upstream(".github/workflows/second.yml", "review second\n")
        with self.assertRaisesRegex(sync.Blocked, "does not contain its named authenticated input pair"):
            self.observe()

    def test_human_changes_to_pr_head_preserved(self):
        self.upstream()
        git, o = self.observe()
        self.retain_pr(git, o, head="b" * 40)
        with self.assertRaisesRegex(sync.Blocked, "preserve human changes"):
            self.observe()

    def test_publish_only_candidate_branch_without_force(self):
        self.upstream()
        git, o = self.observe()
        sync.publish(git, self.github, o, o["upstream_sha"], o["downstream_sha"])
        self.assertEqual(o["outcome"], "pr_created")
        self.assertEqual(len(git.pushes), 1)
        self.assertNotIn("--force", git.pushes[0])
        self.assertNotIn("+", git.pushes[0][-1])
        self.assertTrue(git.pushes[0][-1].endswith(o["branch"]))
        self.assertEqual(git.text("ls-remote", "--refs", "origin", "refs/heads/main").split()[0], self.anchor)

    def test_pr_failure_retry_reuses_published_branch(self):
        self.upstream()
        git, o = self.observe()
        self.github.fail_pr = True
        with self.assertRaisesRegex(sync.Blocked, "PR creation failed"):
            sync.publish(git, self.github, o, o["upstream_sha"], o["downstream_sha"])
        retry, result = self.observe()
        self.github.fail_pr = False
        sync.publish(retry, self.github, result, result["upstream_sha"], result["downstream_sha"])
        self.assertFalse(retry.pushes)
        self.assertEqual(result["outcome"], "pr_created")

    def test_push_failure_never_creates_pr(self):
        self.upstream()
        git, o = self.observe()
        with patch.object(git, "push", side_effect=sync.Blocked("push failed")):
            with self.assertRaises(sync.Blocked):
                sync.publish(git, self.github, o, o["upstream_sha"], o["downstream_sha"])
        self.assertFalse(self.github.created)

    def test_missing_app_token_stops_before_push(self):
        self.upstream()
        git, o = self.observe()
        output = io.StringIO()
        with patch.dict(os.environ, {"SYNC_PUBLISH_TOKEN": ""}), redirect_stdout(output):
            with self.assertRaisesRegex(sync.Blocked, "App token unavailable"):
                sync.publish(git, self.github, o, o["upstream_sha"], o["downstream_sha"])
        self.assertFalse(git.pushes or self.github.created)
        self.assertEqual(output.getvalue(), "SYNC_PUBLISH_TOKEN: missing\n")

    def test_token_presence_does_not_log_value(self):
        self.upstream()
        git, o = self.observe()
        output = io.StringIO()
        with redirect_stdout(output):
            sync.publish(git, self.github, o, o['upstream_sha'], o['downstream_sha'])
        self.assertEqual(output.getvalue(), 'SYNC_PUBLISH_TOKEN: present\n')
        self.assertNotIn('fixture-only-never-sent', output.getvalue())

    def test_workflow_app_output_and_permission_boundaries(self):
        workflow = (Path(__file__).resolve().parent.parent / '.github/workflows/upstream-sync.yml').read_text()
        observe, publish = workflow.split('\n  publish:\n')
        self.assertNotIn('secrets.', observe)
        self.assertNotIn('SYNC_PUBLISH_TOKEN', observe)
        self.assertNotIn(': write', observe)
        self.assertNotIn('contents: write', publish.split('    steps:')[0])
        self.assertNotIn('pull-requests: write', publish.split('    steps:')[0])
        self.assertNotIn('issues:', workflow)
        self.assertNotIn('pull_request:', workflow)
        self.assertNotIn('finalize-merged-episode', workflow)
        self.assertNotIn('--finalize-merged-pr', workflow)
        for part in (observe, publish):
            self.assertIn("github.repository == 'constbogdan/Mosaic'", part)
            self.assertNotIn("github.repository == 'constbogdan/Wholphin'", part)
            self.assertIn("github.ref == 'refs/heads/main'", part)
        self.assertIn("needs.observe.outputs.outcome != 'no_delta'", publish)
        mint, execution = publish.split('      - name: Recheck exact inputs', 1)
        self.assertIn('contains(fromJSON', mint)
        for outcome in ('ready', 'review_required', 'semantic_conflict'):
            self.assertIn(outcome, mint)
        self.assertNotIn('waiting_on_existing_pr', mint)
        self.assertIn('id: publication', mint)
        self.assertIn('uses: actions/create-github-app-token@', mint)
        for expected in ('client-id: ${{ vars.SYNC_BOT_CLIENT_ID }}', 'private-key: ${{ secrets.SYNC_BOT_PRIVATE_KEY }}',
                         'owner: ${{ github.repository_owner }}',
                         'repositories: ${{ github.event.repository.name }}',
                         'permission-contents: write',
                         'permission-pull-requests: write'):
            self.assertIn(expected, mint)
        self.assertIn('SYNC_PUBLISH_TOKEN: ${{ steps.publication.outputs.token }}', execution)
        self.assertIn('GH_TOKEN: ${{ github.token }}', execution)
        self.assertIn('EXPECTED_UPSTREAM: ${{ needs.observe.outputs.upstream }}', execution)
        self.assertIn('EXPECTED_DOWNSTREAM: ${{ needs.observe.outputs.downstream }}', execution)
        self.assertIn('EXPECTED_BLOCKING_PR: ${{ needs.observe.outputs.blocking_pr }}', execution)
        self.assertIn('EXPECTED_BLOCKING_HEAD: ${{ needs.observe.outputs.blocking_head }}', execution)
        self.assertIn('--expected-blocking-pr "$EXPECTED_BLOCKING_PR"', execution)
        self.assertIn('--expected-blocking-head "$EXPECTED_BLOCKING_HEAD"', execution)
        self.assertIn('blocking_pr: ${{ steps.observe.outputs.blocking_pr_number }}', observe)
        self.assertIn('blocking_head: ${{ steps.observe.outputs.blocking_pr_head_sha }}', observe)
        self.assertIn('if: always()', execution)
        self.assertNotIn('MOSAIC_', workflow)

    def test_mosaic_repository_drives_exact_git_and_api_targets(self):
        repository = "constbogdan/Mosaic"
        path = self.root / "Mosaic"
        path.mkdir()
        git = sync.Git(path, repository)
        self.assertEqual(
            f"https://github.com/{repository}.git",
            git.text("remote", "get-url", "origin"),
        )
        github = sync.GitHub(repository)
        completed = subprocess.CompletedProcess([], 0, stdout="[[]]", stderr="")
        with patch.object(sync, "command", return_value=completed) as command:
            self.assertEqual([], github.pages("pulls"))
        self.assertIn(f"repos/{repository}/pulls", command.call_args.args[0])
        for repository in ("constbogdan/Wholphin", "constbogdan/Mosaic2",
                           "constbogdan/mosaic", "other/Mosaic", "forks/Mosaic", ""):
            with self.subTest(repository=repository), self.assertRaises(ValueError):
                sync.GitHub(repository)

    def test_changed_job_inputs_and_late_ref_drift_block(self):
        self.upstream()
        git, o = self.observe()
        with self.assertRaisesRegex(sync.Blocked, "between read and publish"):
            sync.publish(git, self.github, o, "c" * 40, o["downstream_sha"])
        self.upstream("later.txt")
        with self.assertRaisesRegex(sync.Blocked, "moved immediately"):
            sync.publish(git, self.github, o, o["upstream_sha"], o["downstream_sha"])
        self.assertFalse(git.pushes or self.github.created)

    def test_existing_different_branch_never_overwritten(self):
        self.upstream()
        git, o = self.observe()
        git.run("push", str(self.remotes["origin"]), f"{self.anchor}:refs/heads/{o['branch']}")
        with self.assertRaisesRegex(sync.Blocked, "different work"):
            sync.publish(git, self.github, o, o["upstream_sha"], o["downstream_sha"])

    def test_removed_downstream_owned_workflows_are_observed_but_remain_absent(self):
        self.upstream(".github/workflows/main.yml", "unreviewed publisher\n")
        self.upstream(".github/workflows/release.yml", "unreviewed tag publisher\n")
        git, observation = self.observe()
        self.assertEqual("observed_excluded", observation["outcome"])
        removed = {
            change["path"]: change for change in observation["automation_changes"]
        }
        self.assertEqual(
            {".github/workflows/main.yml", ".github/workflows/release.yml"},
            set(removed),
        )
        for change in removed.values():
            self.assertEqual("DOWNSTREAM-OWNED", change["ownership"])
            self.assertIsNone(change["downstream_blob"])
        observe_summary = sync.upstream_summary(observation)
        self.assertTrue(observe_summary.startswith("## Upstream observation recorded"))
        self.assertNotIn("observed but excluded", observe_summary.splitlines()[0])
        summary = sync.upstream_summary(observation, publication=True)
        self.assertTrue(summary.startswith("## 2 upstream changes · observed but excluded"))
        self.assertIn("Mosaic state was preserved", summary)
        self.assertIn("DOWNSTREAM-OWNED: 2 — observed but excluded", summary)
        self.assertLess(summary.index("observed but excluded"), summary.index("<details>"))
        self.assertFalse(git.pushes)
        sync.publish(git, self.github, observation, observation["upstream_sha"], observation["downstream_sha"])
        self.assertFalse(self.github.created)

    def test_owned_deletion_preserves_downstream_file_and_is_excluded(self):
        self.commit(".github/workflows/main.yml", "owned\n")
        self.anchor = self.g("rev-parse", "HEAD")
        for remote in self.remotes.values():
            self.g("push", str(remote), "HEAD:refs/heads/main")
        self.g("rm", ".github/workflows/main.yml")
        self.g("commit", "-m", "Delete owned workflow")
        self.g("push", str(self.remotes["upstream"]), "HEAD:refs/heads/main")
        _, observation = self.observe()
        self.assertEqual("observed_excluded", observation["outcome"])
        self.assertEqual("D", observation["automation_changes"][0]["status"])

    def test_owned_rename_restores_both_downstream_path_states_in_mixed_candidate(self):
        old = ".github/workflows/mosaic-signing-exercise.yml"
        new = ".github/workflows/mosaic-stable-promotion.yml"
        self.commit(old, "downstream release\n")
        self.anchor = self.g("rev-parse", "HEAD")
        for remote in self.remotes.values():
            self.g("push", str(remote), "HEAD:refs/heads/main")
        self.g("mv", old, new)
        self.commit("app/example.kt", "follow\n")
        self.g("push", str(self.remotes["upstream"]), "HEAD:refs/heads/main")
        git, observation = self.observe()
        self.assertEqual("ready", observation["outcome"])
        self.assertEqual("downstream release", git.text("show", observation["candidate_sha"] + ":" + old))
        self.assertNotEqual(0, git.run("cat-file", "-e", observation["candidate_sha"] + ":" + new,
                                       check=False).returncode)
        self.assertEqual("follow", git.text("show", observation["candidate_sha"] + ":app/example.kt"))

    def test_explicit_follow_and_review_policy_have_distinct_outcomes(self):
        self.upstream(".github/actions/setup/action.yml", "follow setup\n")
        follow_git, follow = self.observe()
        self.assertEqual("ready", follow["outcome"])
        self.assertEqual("FOLLOW", follow["automation_changes"][0]["ownership"])
        self.assertEqual("follow setup", follow_git.text(
            "show", follow["candidate_sha"] + ":.github/actions/setup/action.yml"))

        self.upstream(".github/workflows/ci.yml", "review ci\n")
        review_git, review = self.observe()
        self.assertEqual("review_required", review["outcome"])
        self.assertEqual(
            [review["downstream_sha"], review["upstream_sha"]],
            review_git.text("show", "-s", "--format=%P", review["candidate_sha"]).split(),
        )
        self.assertEqual(
            review["candidate_tree"],
            review_git.text("rev-parse", review["candidate_sha"] + "^{tree}"),
        )
        ci = next(change for change in review["automation_changes"]
                  if change["path"] == ".github/workflows/ci.yml")
        self.assertEqual("REVIEW", ci["ownership"])
        self.assertIn("semantic review", ci["reason"])
        body = sync.description(review)
        self.assertIn("Git produced a textually clean candidate", body)
        self.assertIn("Semantic REVIEW:", body)
        self.assertNotIn("Git textual conflict:", body)

    def test_later_owned_change_produces_new_observed_state(self):
        first = self.upstream(".github/workflows/main.yml", "one\n")
        _, a = self.observe()
        second = self.upstream(".github/workflows/main.yml", "two\n")
        _, b = self.observe()
        self.assertEqual("observed_excluded", a["outcome"])
        self.assertEqual("observed_excluded", b["outcome"])
        self.assertEqual((first, second), (a["upstream_sha"], b["upstream_sha"]))
        self.assertNotEqual(a["automation_changes"][0]["new_blob"], b["automation_changes"][0]["new_blob"])

    def test_unknown_automation_defaults_to_review_and_creates_draft(self):
        self.upstream(".github/workflows/future.yml", "future\n")
        git, observation = self.observe()
        self.assertEqual("review_required", observation["outcome"])
        self.assertEqual("REVIEW", observation["automation_changes"][0]["ownership"])
        sync.publish(git, self.github, observation, observation["upstream_sha"], observation["downstream_sha"])
        self.assertEqual("review_pr_created", observation["outcome"])
        self.assertTrue(self.github.created[0][2])
        self.assertEqual("chore: review upstream changes to future.yml", self.github.created[0][3])
        self.assertNotIn("Tracking issue:", self.github.created[0][1])

    def test_rename_crossing_ownership_boundary_requires_review(self):
        self.commit(".github/actions/setup/action.yml", "setup\n")
        self.anchor = self.g("rev-parse", "HEAD")
        for remote in self.remotes.values():
            self.g("push", str(remote), "HEAD:refs/heads/main")
        (self.seed / ".github/workflows").mkdir(parents=True, exist_ok=True)
        self.g("mv", ".github/actions/setup/action.yml", ".github/workflows/main.yml")
        self.g("commit", "-m", "Cross ownership boundary")
        self.g("push", str(self.remotes["upstream"]), "HEAD:refs/heads/main")
        _, observation = self.observe()
        change = observation["automation_changes"][0]
        self.assertTrue(change["status"].startswith("R"))
        self.assertEqual("REVIEW", change["ownership"])
        self.assertIn("crosses ownership", change["reason"])

    def test_mixed_changes_keep_all_ownership_evidence(self):
        self.upstream("app/example.kt", "app\n")
        self.upstream(".github/actions/setup/action.yml", "setup\n")
        self.upstream(".github/workflows/future.yml", "review\n")
        self.upstream(".github/workflows/main.yml", "owned\n")
        _, observation = self.observe()
        self.assertEqual("review_required", observation["outcome"])
        self.assertEqual({"FOLLOW": 2, "REVIEW": 1, "DOWNSTREAM-OWNED": 1}, observation["ownership_counts"])
        self.assertEqual(4, len(observation["automation_changes"]))

    def test_trusted_policy_and_schedule_contract(self):
        policy = sync.load_policy()
        self.assertEqual(1, policy["schemaVersion"])
        self.assertEqual("REVIEW", policy["defaultAutomationOwnership"])
        self.assertEqual("DOWNSTREAM-OWNED", policy["paths"][".github/workflows/main.yml"])
        self.assertEqual("DOWNSTREAM-OWNED", policy["paths"][".github/workflows/release.yml"])
        self.assertEqual("FOLLOW", policy["paths"][".github/actions/setup/action.yml"])
        workflows = Path(__file__).resolve().parent.parent / ".github/workflows"
        self.assertFalse((workflows / "main.yml").exists())
        self.assertFalse((workflows / "release.yml").exists())
        workflow = (Path(__file__).resolve().parent.parent / ".github/workflows/upstream-sync.yml").read_text()
        self.assertIn("cron: '0 6,15,21 * * *'", workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("cancel-in-progress: false", workflow)

    def test_series_conflict_fixture_keeps_nonconflicting_context(self):
        series = "app/src/main/java/com/github/damontecres/wholphin/ui/detail/series/SeriesViewModel.kt"
        rtl = "app/src/main/java/com/github/damontecres/wholphin/ui/player/RtlControls.kt"
        self.commit(series, "base\n")
        self.anchor = self.g("rev-parse", "HEAD")
        for remote in self.remotes.values():
            self.g("push", str(remote), "HEAD:refs/heads/main")
        self.commit(series, "upstream duplicate search fix\n")
        self.commit(rtl, "upstream rtl\n")
        self.g("push", str(self.remotes["upstream"]), "HEAD:refs/heads/main")
        self.g("checkout", "--detach", self.anchor)
        self.commit(series, "downstream acquisition behavior\n")
        self.g("push", str(self.remotes["origin"]), "HEAD:refs/heads/main")
        git, observation = self.observe()
        self.assertEqual("semantic_conflict", observation["outcome"])
        self.assertEqual([series], observation["conflict_paths"])
        self.assertEqual("upstream rtl", git.text("show", observation["candidate_sha"] + ":" + rtl))
        self.assertFalse(git.ancestor(observation["upstream_sha"], observation["candidate_sha"]))

    def test_three_observations_reuse_one_native_draft_pr(self):
        self.upstream(".github/workflows/future.yml", "review\n")
        first_git, first = self.observe(observed_at="2026-09-10T00:00:00+00:00",
                                       run_url="https://github.com/constbogdan/Wholphin/actions/runs/1")
        sync.publish(first_git, self.github, first, first["upstream_sha"], first["downstream_sha"])
        self.retain_pr(first_git, first, draft=True, body=self.github.created[0][1])
        for hour, run in ((6, 2), (12, 3)):
            retry, observation = self.observe(
                observed_at=f"2026-09-10T{hour:02}:00:00+00:00",
                run_url=f"https://github.com/constbogdan/Wholphin/actions/runs/{run}")
            self.assertEqual("existing_draft_pr", observation["outcome"])
            self.assertEqual(123, observation["existing_pr_number"])
            self.assertEqual(first["branch"], observation["existing_pr_branch"])
            self.assertEqual(first["candidate_sha"], observation["existing_pr_head_sha"])
            with self.assertRaisesRegex(sync.Blocked, "Existing Draft state changed"):
                sync.publish(
                    retry, self.github, observation,
                    observation["upstream_sha"], observation["downstream_sha"],
                    expected_existing_pr=observation["existing_pr_number"],
                    expected_existing_branch=observation["existing_pr_branch"],
                    expected_existing_head="0" * 40,
                )
            sync.publish(
                retry, self.github, observation,
                observation["upstream_sha"], observation["downstream_sha"],
                expected_existing_pr=observation["existing_pr_number"],
                expected_existing_branch=observation["existing_pr_branch"],
                expected_existing_head=observation["existing_pr_head_sha"],
            )
            self.assertFalse(retry.pushes)
        self.assertEqual(1, len(self.github.created))

    def test_unrelated_downstream_movement_reuses_attention_episode(self):
        self.upstream(".github/workflows/future.yml", "review\n")
        first_git, first = self.observe(observed_at="2026-09-10T00:00:00+00:00")
        sync.publish(first_git, self.github, first, first["upstream_sha"], first["downstream_sha"])
        self.retain_pr(first_git, first, draft=True, body=self.github.created[0][1])
        first_episode, first_branch = first["episode_id"], first["branch"]

        self.g("checkout", "--detach", self.anchor)
        self.commit("unrelated.txt", "downstream movement\n")
        self.g("push", str(self.remotes["origin"]), "HEAD:refs/heads/main")
        retry, observation = self.observe(observed_at="2026-09-10T06:00:00+00:00")
        self.assertNotEqual(first_branch, observation["branch"])
        self.assertEqual(first_episode, observation["episode_id"])
        self.assertEqual("existing_draft_pr", observation["outcome"])
        self.assertEqual(first_branch, observation["existing_branch"])
        self.assertEqual(123, observation["existing_pr_number"])
        self.assertEqual(first_branch, observation["existing_pr_branch"])
        self.assertEqual(first["candidate_sha"], observation["existing_pr_head_sha"])
        sync.publish(
            retry, self.github, observation,
            observation["upstream_sha"], observation["downstream_sha"],
            expected_existing_pr=observation["existing_pr_number"],
            expected_existing_branch=observation["existing_pr_branch"],
            expected_existing_head=observation["existing_pr_head_sha"],
        )
        self.assertEqual(1, len(self.github.created))

    def test_new_upstream_same_area_updates_episode_evidence_without_duplicate(self):
        self.upstream(".github/workflows/future.yml", "review one\n")
        first_git, first = self.observe(observed_at="2026-09-10T00:00:00+00:00")
        sync.publish(first_git, self.github, first, first["upstream_sha"], first["downstream_sha"])
        self.retain_pr(first_git, first, draft=True, body=self.github.created[0][1])
        first_upstream = first["upstream_sha"]

        self.upstream(".github/workflows/future.yml", "review two\n")
        retry, observation = self.observe(observed_at="2026-09-10T06:00:00+00:00")
        self.assertNotEqual(first_upstream, observation["upstream_sha"])
        self.assertEqual(first["episode_id"], observation["episode_id"])
        self.assertEqual("existing_draft_pr", observation["outcome"])
        sync.publish(
            retry, self.github, observation,
            observation["upstream_sha"], observation["downstream_sha"],
            expected_existing_pr=observation["existing_pr_number"],
            expected_existing_branch=observation["existing_pr_branch"],
            expected_existing_head=observation["existing_pr_head_sha"],
        )
        self.assertEqual(1, len(self.github.created))
    def test_quiet_pr_and_rich_summary_split_operator_navigation_from_provenance(self):
        path = "app/src/SeriesViewModel.kt"
        clean_path = "app/src/RtlControls.kt"
        observation = {"episode_id": "a" * 64, "outcome": "review_required",
                       "downstream_repo": sync.ORIGIN,
                       "upstream_sha": "b" * 40,
                       "downstream_sha": "c" * 40, "pr_url": "https://github.com/constbogdan/Mosaic/pull/31",
                       "pr_number": 31, "run_url": "https://github.com/constbogdan/Mosaic/actions/runs/9",
                       "incoming_commits": [{"sha": "d" * 40, "subject": "Fix duplicates (#1946)",
                                             "url": "https://github.com/damontecres/Wholphin/commit/" + "d" * 40,
                                             "pull_request_numbers": ["1946"],
                                             "pull_request_urls": ["https://github.com/damontecres/Wholphin/pull/1946"]}],
                       "review_paths": [path], "conflict_paths": [path], "clean_path_count": 1,
                       "automation_changes": [{"path": path, "new_blob": "e" * 40,
                                                "downstream_blob": "f" * 40, "ownership": "REVIEW",
                                                "upstream_url": "https://github.com/damontecres/Wholphin/blob/" + "b" * 40 + "/" + path,
                                                "downstream_url": "https://github.com/constbogdan/Mosaic/blob/" + "c" * 40 + "/" + path},
                                               {"path": clean_path, "new_blob": "1" * 40,
                                                "downstream_blob": None, "ownership": "FOLLOW"}],
                       }
        body = sync.description(observation)
        self.assertIn("PR 1946", body)
        self.assertIn("<code>ddddddd</code>", body)
        self.assertIn("<code>app/src/SeriesViewModel.kt</code>", body)
        self.assertNotIn("github.com/damontecres", body)
        self.assertNotIn("damontecres/Wholphin#", body)
        self.assertIn("1 FOLLOW path is included by the native candidate.", body)
        self.assertNotIn(clean_path, body)
        self.assertNotIn("existing_pr_url: not available", body)
        self.assertIn("Latest observation:", body)
        self.assertIn(clean_path, json.dumps(observation))
        headings = ["## What requires attention?", "## Why?",
                    "## What integrates automatically?",
                    "## What is intentionally preserved downstream?",
                    "## What should the operator do next?",
                    "<summary>Technical provenance and upstream history</summary>"]
        self.assertEqual(headings, sorted(headings, key=body.index))
        self.assertIn(".\\scripts\\resolve-upstream.ps1", body)

        observe_summary = sync.upstream_summary(observation)
        self.assertTrue(observe_summary.startswith("## Upstream observation recorded"))
        summary = sync.upstream_summary(observation, publication=True)
        self.assertTrue(summary.startswith("## 2 upstream changes · review required"))
        self.assertIn("1 path requires semantic review", summary)
        self.assertIn("PR #31  [open](https://github.com/constbogdan/Mosaic/pull/31)", summary)
        self.assertLess(summary.index("### Review required"), summary.index("1 incoming"))
        self.assertIn("Semantic REVIEW:", summary)
        self.assertIn("Git textual conflict:", summary)
        self.assertIn("[Current Mosaic](https://github.com/constbogdan/Mosaic/blob/", summary)
        self.assertIn("[Incoming upstream](https://github.com/damontecres/Wholphin/blob/", summary)
        self.assertIn("<summary>Operator navigation</summary>", summary)
        self.assertIn("<summary>Technical details</summary>", summary)
        self.assertIn("[PR 1946](https://github.com/damontecres/Wholphin/pull/1946)", summary)
        self.assertIn("https://github.com/damontecres/Wholphin/commit/" + "d" * 40, summary)
        self.assertIn("https://github.com/damontecres/Wholphin/blob/" + "b" * 40 + "/" + path, summary)
        self.assertIn("https://github.com/constbogdan/Mosaic/blob/" + "c" * 40 + "/" + path, summary)

    def test_clean_follow_pr_stands_alone_without_journal(self):
        self.upstream("app/example.kt", "clean\n")
        git, observation = self.observe(observed_at="2026-09-10T00:00:00+00:00")
        sync.publish(git, self.github, observation,
                     observation["upstream_sha"], observation["downstream_sha"])
        self.assertEqual("pr_created", observation["outcome"])
        self.assertNotIn("github.com/damontecres", self.github.created[0][1])
        self.assertNotIn(observation["upstream_sha"][:12], self.github.created[0][3])
        self.assertNotIn("Tracking issue:", self.github.created[0][1])

    def test_machine_artifact_retains_exact_upstream_navigation_urls(self):
        self.upstream(".github/workflows/future.yml", "review\n")
        _, observation = self.observe()
        commit = observation["incoming_commits"][0]
        change = observation["automation_changes"][0]
        self.assertEqual("https://github.com/damontecres/Wholphin/commit/" + commit["sha"],
                         commit["url"])
        self.assertEqual("https://github.com/damontecres/Wholphin/blob/" +
                         observation["upstream_sha"] + "/.github/workflows/future.yml",
                         change["upstream_url"])
        self.assertIn(commit["url"], json.dumps(observation))
        self.assertIn(change["upstream_url"], json.dumps(observation))

    def test_body_escapes_external_markup_and_mentions(self):
        unsafe = "line-one#1946@team\n## injected"
        subject = ("Fixes damontecres/Wholphin#1946 and #1947 "
                   "https://github.com/damontecres/Wholphin/pull/1948 <script>@everyone</script>")
        body = sync.description({"incoming_commits": [{"sha": "a" * 40, "subject": subject}],
                                 "review_paths": [unsafe],
                                 "automation_changes": [{"path": unsafe, "new_blob": "a" * 40,
                                                         "downstream_blob": None}],
                                 "upstream_sha": "a" * 40})
        self.assertNotIn("<script>", body)
        self.assertNotIn("@everyone", body)
        self.assertNotIn("\n## injected", body)
        self.assertNotIn("github.com/damontecres", body)
        self.assertNotIn("damontecres/Wholphin#", body)
        self.assertNotIn("#1947", body)
        for number in ("1946", "1947", "1948"):
            self.assertIn("PR " + number, body)
        self.assertIn("line-one#1946&#64;team\\n## injected", body)
        title = sync.candidate_title({"review_paths": ["unsafe#1946@team.yml"]}, True)
        self.assertNotIn("#1946", title)
        self.assertNotIn("@team", title)

        summary = sync.upstream_summary({"outcome": "review_required",
            "ownership_counts": {"FOLLOW": 0, "REVIEW": 1, "DOWNSTREAM-OWNED": 0},
            "automation_changes": [{"ownership": "REVIEW", "path": "`\n## injected",
                                     "reason": "<review>@team"}]}, publication=True)
        self.assertNotIn("\n## injected", summary)
        self.assertNotIn("<review>", summary)
        self.assertIn("&lt;review&gt;&#64;team", summary)
        hostile_link = sync.upstream_summary({"outcome": "existing_draft_pr",
            "downstream_repo": sync.ORIGIN,
            "pr_number": "31", "pr_url": "https://evil.invalid/pull/31",
            "review_paths": ["safe.yml"], "conflict_paths": [],
            "automation_changes": [{"ownership": "REVIEW", "path": "safe.yml",
                                     "reason": "review"}]}, publication=True)
        self.assertNotIn("[open](https://evil.invalid", hostile_link)
        self.assertNotIn("PR #31  [open]", hostile_link)

    def test_non_hosted_cli_cannot_mutate(self):
        output = self.root / "out.json"
        runtime = {"GITHUB_ACTIONS": "false", "GITHUB_OUTPUT": str(self.root / "outputs"),
                   "GITHUB_STEP_SUMMARY": str(self.root / "summary.md")}
        with patch.dict(os.environ, runtime), patch("sys.argv", ["hosted_upstream", "--publish", "--output", str(output)]):
            self.assertEqual(sync.main(), 1)
        self.assertEqual(json.loads(output.read_text())["outcome"], "blocked")

    def test_github_subprocess_credentials_are_operation_scoped(self):
        github = sync.GitHub()
        with patch.dict(os.environ, {"GH_TOKEN": "read-only-repository-token"}), patch.object(sync, "command") as run:
            run.return_value.stdout = "[]"
            github.pulls()
            github.api("repos/constbogdan/Wholphin/issues", {"title": "blocked"})
            for call in run.call_args_list:
                self.assertEqual(call.kwargs["env"]["GH_TOKEN"], "read-only-repository-token")
                self.assertNotIn("SYNC_PUBLISH_TOKEN", call.kwargs["env"])
            run.return_value.stdout = '{"html_url": "https://github.com/constbogdan/Wholphin/pull/1"}'
            github.create_pr(sync.branch_name("a" * 40, "b" * 40), "fixture")
            self.assertEqual(run.call_args.kwargs["env"]["GH_TOKEN"], "fixture-only-never-sent")
            self.assertNotIn("SYNC_PUBLISH_TOKEN", run.call_args.kwargs["env"])
            self.assertNotIn("fixture-only-never-sent", str(run.call_args.args))

    def test_long_opaque_app_token_is_transport_only_and_redacted(self):
        token = "ghs_future." + ("opaque-Part_with-punctuation." * 20)
        github = sync.GitHub()
        with patch.dict(os.environ, {"GH_TOKEN": "read-only", "SYNC_PUBLISH_TOKEN": token}), \
                patch.object(sync, "command") as run:
            run.return_value.stdout = '{"html_url":"https://github.com/constbogdan/Wholphin/pull/1"}'
            github.create_pr(sync.branch_name("a" * 40, "b" * 40), "fixture")
            self.assertEqual(run.call_args.kwargs["env"]["GH_TOKEN"], token)
            self.assertNotIn("SYNC_PUBLISH_TOKEN", run.call_args.kwargs["env"])
            self.assertNotIn(token, " ".join(run.call_args.args[0]))
        failed = subprocess.CompletedProcess(
            ["gh", "api"], 1,
            "remote: permission denied for " + token,
            "Authorization: Bearer " + token,
        )
        with patch.object(sync.subprocess, "run", return_value=failed), self.assertRaises(sync.Blocked) as error:
            sync.command(["gh", "api"], env={"GH_TOKEN": token})
        self.assertNotIn(token, str(error.exception))
        self.assertIn("[credential redacted]", str(error.exception))

    def test_command_failure_preserves_actionable_git_push_rejection(self):
        failed = subprocess.CompletedProcess(
            ["git", "push"], 1,
            "!\trefs/heads/candidate:refs/heads/candidate\t[remote rejected] "
            "(refusing to allow a GitHub App to create or update workflow "
            ".github/workflows/release.yml without workflows permission)\nDone",
            "remote: protected branch hook declined\nerror: failed to push some refs",
        )
        with patch.object(sync.subprocess, "run", return_value=failed), \
                self.assertRaises(sync.OperationError) as error:
            sync.command(["git", "push", "--porcelain", "origin", "candidate"])
        diagnostic = str(error.exception)
        self.assertIn("permission_denied: git push failed (exit 1)", diagnostic)
        self.assertIn("protected branch hook declined", diagnostic)
        self.assertIn("[remote rejected]", diagnostic)
        self.assertIn(".github/workflows/release.yml", diagnostic)
        self.assertIn("workflows permission", diagnostic)

    def test_command_diagnostic_preserves_safe_native_failure_kinds(self):
        cases = {
            "! [rejected] candidate -> candidate (non-fast-forward)": "non-fast-forward",
            "remote: error: GH006: Protected branch update failed": "Protected branch update failed",
            "remote: Repository not found.": "Repository not found",
            "fatal: Authentication failed for 'https://github.com/constbogdan/Wholphin.git/'":
                "Authentication failed",
            "fatal: unable to access repository: Could not resolve host: github.com":
                "Could not resolve host",
            "HTTP 403: Resource not accessible by integration":
                "Resource not accessible by integration",
        }
        for native, expected in cases.items():
            with self.subTest(native=native):
                self.assertIn(expected, sync.sanitize_command_diagnostic("", native))

    def test_command_diagnostic_redacts_url_authorization_and_tokens(self):
        token = "ghs_exact-operation-token"
        failed = subprocess.CompletedProcess(
            ["git", "fetch"], 1,
            "fatal: unable to access 'https://x-access-token:" + token
            + "@github.com/constbogdan/Wholphin.git/': authorization failed",
            "Authorization: Basic c2VjcmV0\nremote repository github.com/constbogdan/Wholphin unavailable",
        )
        with patch.dict(os.environ, {"SYNC_PUBLISH_TOKEN": token}), \
                patch.object(sync.subprocess, "run", return_value=failed), \
                self.assertRaises(sync.OperationError) as error:
            sync.command(["git", "fetch", "origin", "main"], env={"GH_TOKEN": token})
        diagnostic = str(error.exception)
        self.assertNotIn(token, diagnostic)
        self.assertNotIn("x-access-token", diagnostic)
        self.assertNotIn("c2VjcmV0", diagnostic)
        self.assertIn("https://[credentials-redacted]@github.com/constbogdan/Wholphin.git/", diagnostic)
        self.assertIn("remote repository github.com/constbogdan/Wholphin unavailable", diagnostic)

    def test_command_diagnostic_neutralizes_presentation_and_workflow_commands(self):
        diagnostic = sync.sanitize_command_diagnostic(
            "\x1b[31m::error::forged message\x1b[0m\r\nremote:\x00 denied\x07",
            "\x1b]8;;https://evil.invalid\x07click\x1b]8;;\x07\n::warning::forged warning",
        )
        self.assertNotIn("\x1b", diagnostic)
        self.assertNotIn("\x00", diagnostic)
        self.assertNotIn("\x07", diagnostic)
        self.assertNotIn("::error::", diagnostic)
        self.assertNotIn("::warning::", diagnostic)
        self.assertNotIn("\n", diagnostic)
        self.assertIn(": :error::forged message", diagnostic)
        self.assertIn(": :warning::forged warning", diagnostic)
        self.assertIn("remote: denied", diagnostic)

    def test_command_diagnostic_is_deterministically_bounded(self):
        diagnostic = sync.sanitize_command_diagnostic(
            "\n".join(f"remote line {index} " + "x" * 300 for index in range(30)), ""
        )
        self.assertLessEqual(len(diagnostic), sync.DIAGNOSTIC_MAX_CHARS)
        self.assertTrue(diagnostic.endswith(sync.DIAGNOSTIC_TRUNCATION))
        self.assertIn("remote line 0", diagnostic)
        self.assertNotIn("remote line 29", diagnostic)

    def test_production_push_refspec_and_credential_isolation(self):
        git = self.instance()
        self.assertNotIn("SYNC_PUBLISH_TOKEN", git.env)
        self.assertNotIn("GH_TOKEN", git.env)
        branch = sync.branch_name("a" * 40, "b" * 40)
        with patch.object(sync, "command") as run:
            # Invoke the production implementation, not the fixture transport.
            with patch.object(git, "identities"):
                sync.Git.push(git, branch, "c" * 40)
        args = run.call_args.args[0]
        self.assertEqual(args[-2:], ["origin", "c" * 40 + ":refs/heads/" + branch])
        self.assertFalse(any(arg.startswith(("--force", "+")) for arg in args))
        self.assertNotIn("fixture-only-never-sent", " ".join(args))
        self.assertEqual(run.call_args.kwargs["env"]["GH_TOKEN"], "fixture-only-never-sent")

    def test_failed_cli_records_artifact_and_publication_error_outcome(self):
        output = self.root / "blocked.json"
        runtime = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": sync.ORIGIN,
                   "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "workflow_dispatch",
                   "RUNNER_TEMP": str(self.root), "GITHUB_STEP_SUMMARY": str(self.root / "summary.md"),
                   "GITHUB_OUTPUT": str(self.root / "outputs")}
        def conflict(git, gh, observation):
            observation.update(upstream_sha="a" * 40, downstream_sha="b" * 40,
                               branch=sync.branch_name("a" * 40, "b" * 40),
                               conflict_paths=["source.kt"], textual_conflicts=True)
            raise sync.OperationError("permission_denied: fixture publication failed.")
        with patch.dict(os.environ, runtime), patch("sys.argv", ["hosted_upstream", "--publish", "--output", str(output)]), patch.object(sync, "inspect", side_effect=conflict):
            self.assertEqual(sync.main(), 1)
        result = json.loads(output.read_text())
        self.assertTrue(result["textual_conflicts"])
        self.assertEqual(result["conflict_paths"], ["source.kt"])
        self.assertNotIn("blocked_issue_url", result)
        self.assertIn("outcome=publication_error", (self.root / "outputs").read_text())
        summary = (self.root / "summary.md").read_text()
        self.assertIn("## Upstream publication failed", summary)
        self.assertIn("No candidate PR was confirmed", summary)
        self.assertIn("Candidate branch  [inspect](https://github.com/constbogdan/Mosaic/tree/",
                      summary)
        self.assertIn("inspect the outcome artifact and branch before rerunning", summary)
        self.assertIn("permission_denied: fixture publication failed", summary)

    def test_failed_cli_surfaces_only_sanitized_command_diagnostic(self):
        output = self.root / "sanitized-failure.json"
        summary = self.root / "sanitized-summary.md"
        token = "ghs_operation-secret-value"
        runtime = {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": sync.ORIGIN,
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "RUNNER_TEMP": str(self.root),
            "GITHUB_STEP_SUMMARY": str(summary),
            "GITHUB_OUTPUT": str(self.root / "sanitized-outputs"),
            "SYNC_PUBLISH_TOKEN": token,
        }
        failed = subprocess.CompletedProcess(
            ["git", "push"], 1,
            "::error::forged\n! [remote rejected] workflow update lacks permission "
            + token + "\n" + "x" * 2000,
            "\x1b[31mremote: https://x-access-token:" + token
            + "@github.com/constbogdan/Wholphin.git rejected\x1b[0m",
        )
        with patch.dict(os.environ, runtime), patch.object(sync.subprocess, "run", return_value=failed):
            with self.assertRaises(sync.OperationError) as captured:
                sync.command(["git", "push", "--porcelain", "origin", "candidate"],
                             env={"GH_TOKEN": token})

        stderr = io.StringIO()
        with patch.dict(os.environ, runtime), \
                patch("sys.argv", ["hosted_upstream", "--publish", "--output", str(output)]), \
                patch.object(sync, "inspect", side_effect=captured.exception), \
                redirect_stderr(stderr):
            self.assertEqual(sync.main(), 1)

        surfaces = output.read_text() + summary.read_text() + stderr.getvalue()
        self.assertNotIn(token, surfaces)
        self.assertNotIn("x-access-token", surfaces)
        self.assertNotIn("::error::", surfaces)
        self.assertNotIn("\x1b", surfaces)
        self.assertIn("github.com/constbogdan/Wholphin.git", surfaces)
        self.assertIn("[remote rejected] workflow update lacks permission", surfaces)
        self.assertIn(sync.DIAGNOSTIC_TRUNCATION, surfaces)
        self.assertEqual("publication_error", json.loads(output.read_text())["outcome"])

    def test_waiting_cli_exits_green_and_binds_complete_handoff(self):
        blocker_head = "c" * 40
        current_upstream = "a" * 40
        current_downstream = "b" * 40
        runtime = {
            key: os.environ[key]
            for key in ("PATH", "SYSTEMROOT", "TEMP", "TMP")
            if key in os.environ
        }
        runtime.update({
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": sync.ORIGIN,
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "RUNNER_TEMP": str(self.root),
            "GITHUB_OUTPUT": str(self.root / "waiting-outputs"),
        })

        def waiting(git, gh, observation):
            observation.update(
                outcome="waiting_on_existing_pr",
                upstream_sha=current_upstream,
                downstream_sha=current_downstream,
                branch=sync.branch_name(current_upstream, current_downstream),
                candidate_sha="d" * 40,
                candidate_tree="e" * 40,
                candidate_parents=[current_downstream, current_upstream],
                comparison_baseline="f" * 40,
                upstream_base_sha="f" * 40,
                incoming_count=1,
                incoming_commits=[{"sha": current_upstream, "subject": "Newer upstream"}],
                changed_paths=["newer.txt"],
                automation_changes=[{"path": "newer.txt", "ownership": "FOLLOW"}],
                classification_range_count=1,
                conflict_paths=[],
                review_paths=[],
                ownership_counts={"FOLLOW": 1, "REVIEW": 0, "DOWNSTREAM-OWNED": 0},
                ancestry_validated=True,
                blocking_pr_number=123,
                blocking_pr_url="https://github.com/constbogdan/Mosaic/pull/123",
                blocking_pr_head_sha=blocker_head,
                blocking_pr_branch=sync.branch_name("1" * 40, "2" * 40),
                blocking_upstream_sha="1" * 40,
                blocking_downstream_sha="2" * 40,
            )

        observe_output = self.root / "waiting-observation.json"
        with patch.dict(os.environ, runtime, clear=True), \
                patch("sys.argv", ["hosted_upstream", "--output", str(observe_output)]), \
                patch.object(sync, "inspect", side_effect=waiting):
            self.assertEqual(0, sync.main())
        retained = json.loads(observe_output.read_text())
        self.assertEqual("waiting_on_existing_pr", retained["outcome"])
        self.assertEqual(["newer.txt"], retained["changed_paths"])
        self.assertEqual(blocker_head, retained["blocking_pr_head_sha"])
        outputs = (self.root / "waiting-outputs").read_text()
        self.assertIn("outcome=waiting_on_existing_pr", outputs)
        self.assertIn("blocking_pr_number=123", outputs)
        self.assertIn(f"blocking_pr_head_sha={blocker_head}", outputs)

        publish_output = self.root / "waiting-publication.json"
        runtime["GITHUB_OUTPUT"] = str(self.root / "waiting-publish-outputs")
        argv = [
            "hosted_upstream", "--publish",
            "--expected-upstream", current_upstream,
            "--expected-downstream", current_downstream,
            "--expected-blocking-pr", "123",
            "--expected-blocking-head", blocker_head,
            "--output", str(publish_output),
        ]
        with patch.dict(os.environ, runtime, clear=True), patch("sys.argv", argv), \
                patch.object(sync, "inspect", side_effect=waiting):
            self.assertEqual(0, sync.main())
        self.assertEqual(
            "waiting_on_existing_pr",
            json.loads(publish_output.read_text())["outcome"],
        )

    def test_upstream_contained_after_accepted_merge_no_new_pr(self):
        self.upstream()
        git, o = self.observe()
        git.run("push", str(self.remotes["origin"]), o["candidate_sha"] + ":refs/heads/main")
        _, result = self.observe()
        self.assertEqual(result["outcome"], "no_delta")

    def test_accepted_native_ancestry_ignores_stale_historical_candidate_branch(self):
        upstream = self.upstream()
        git, observation = self.observe()
        stale = sync.branch_name(upstream, self.anchor)
        git.run("push", str(self.remotes["origin"]), self.anchor + ":refs/heads/" + stale)
        git.run("push", str(self.remotes["origin"]), observation["candidate_sha"] + ":refs/heads/main")

        _, result = self.observe()

        self.assertEqual("no_delta", result["outcome"])
        self.assertEqual(upstream, result["comparison_baseline"])
        self.assertEqual([], result["changed_paths"])

    def test_hosted_failure_reason_is_printed_to_actions_log(self):
        output = self.root / "refusal.json"
        runtime = {"GITHUB_ACTIONS": "false"}
        stderr = io.StringIO()
        with patch.dict(os.environ, runtime, clear=True), \
                patch("sys.argv", ["hosted_upstream", "--output", str(output)]), \
                patch("sys.stderr", stderr):
            self.assertEqual(1, sync.main())
        self.assertIn("Hosted execution requires the canonical downstream", stderr.getvalue())

    def test_concurrent_main_movement_fails_before_publication(self):
        self.upstream()
        _, first = self.observe()
        self.g("checkout", "--detach", self.anchor)
        self.commit("downstream-moved.txt", "movement\n")
        self.g("push", str(self.remotes["origin"]), "HEAD:refs/heads/main")
        current_git, current = self.observe()
        with self.assertRaisesRegex(sync.Blocked, "Refs changed"):
            sync.publish(
                current_git,
                self.github,
                current,
                first["upstream_sha"],
                first["downstream_sha"],
            )
        self.assertFalse(current_git.pushes or self.github.created)


if __name__ == "__main__":
    unittest.main()
