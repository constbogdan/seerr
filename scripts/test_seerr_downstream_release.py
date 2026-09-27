import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock

import seerr_downstream_release as release


class GitHubFake:
    def __init__(self, tag=None, published_release=None):
        self.tag_value = tag
        self.release_value = published_release
        self.annotated = {}
        self.created_tags = []
        self.created_releases = []

    def tag(self, version_tag):
        return self.tag_value

    def annotated_tag(self, sha):
        return self.annotated[sha]

    def create_tag(self, version_tag, source_sha):
        self.created_tags.append((version_tag, source_sha))
        self.tag_value = {"object": {"type": "commit", "sha": source_sha}}
        return self.tag_value

    def release(self, version_tag):
        return self.release_value

    def create_release(self, version_tag, source_sha, title, body):
        self.created_releases.append((version_tag, source_sha, title, body))
        self.release_value = matching_release(version_tag, source_sha, title, body)
        return self.release_value


class ResponseFake:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exception_type, exception, traceback):
        return False

    def read(self):
        return self.payload

def tag_at(sha):
    return {"object": {"type": "commit", "sha": sha}}


def matching_release(version_tag, source_sha, title, body):
    return {
        "tag_name": version_tag,
        "target_commitish": source_sha,
        "name": title,
        "body": body,
        "draft": False,
        "prerelease": False,
        "assets": [],
        "html_url": f"https://github.com/{release.REPOSITORY}/releases/tag/{version_tag}",
    }


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.source = "1" * 40
        self.version = "custom-v1.0.8"
        self.digest = "sha256:" + "2" * 64
        self.title = self.version
        self.body = "release body\n"

    def metadata(self, path, reference, *, source=None, version=None, digest=None):
        value = {
            "name": reference,
            "manifest": {
                "digest": digest or self.digest,
                "annotations": {
                    "org.opencontainers.image.revision": source or self.source,
                    "org.opencontainers.image.version": version or self.version,
                },
            },
        }
        path.write_text(json.dumps(value), encoding="utf-8")

    def image_files(self, root):
        version = root / "version.json"
        source = root / "source.json"
        rolling = root / "rolling.json"
        self.metadata(version, f"{release.IMAGE}:{self.version}")
        self.metadata(source, f"{release.IMAGE}:{self.source}")
        self.metadata(rolling, f"{release.IMAGE}:custom")
        return version, source, rolling

    def test_first_successful_publication_verifies_all_tags_and_creates_release(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.image_files(Path(directory))
            self.assertEqual(
                self.digest,
                release.verify_published_images(
                    self.source, self.version, *paths, self.digest
                ),
            )
        github = GitHubFake()
        result = release.reconcile_release(
            github, self.version, self.source, self.title, self.body
        )
        self.assertEqual("created", result["outcome"])
        self.assertEqual([(self.version, self.source)], github.created_tags)
        self.assertEqual(1, len(github.created_releases))

    def test_matching_tag_and_release_are_idempotently_complete(self):
        github = GitHubFake(
            tag_at(self.source),
            matching_release(self.version, self.source, self.title, self.body),
        )
        result = release.reconcile_release(
            github, self.version, self.source, self.title, self.body
        )
        self.assertEqual("existing", result["outcome"])
        self.assertEqual([], github.created_tags)
        self.assertEqual([], github.created_releases)

    def test_matching_tag_with_absent_release_creates_only_release(self):
        github = GitHubFake(tag_at(self.source))
        result = release.reconcile_release(
            github, self.version, self.source, self.title, self.body
        )
        self.assertEqual("created", result["outcome"])
        self.assertEqual([], github.created_tags)
        self.assertEqual(1, len(github.created_releases))

    def test_conflicting_tag_refuses_before_mutation(self):
        github = GitHubFake(tag_at("3" * 40))
        with self.assertRaisesRegex(release.ReleaseError, "different source"):
            release.reconcile_release(
                github, self.version, self.source, self.title, self.body
            )
        self.assertEqual([], github.created_tags)
        self.assertEqual([], github.created_releases)

    def test_conflicting_release_refuses_before_mutation(self):
        existing = matching_release(
            self.version, self.source, self.title, "different body\n"
        )
        github = GitHubFake(tag_at(self.source), existing)
        with self.assertRaisesRegex(release.ReleaseError, "presentation conflicts"):
            release.reconcile_release(
                github, self.version, self.source, self.title, self.body
            )
        self.assertEqual([], github.created_tags)
        self.assertEqual([], github.created_releases)

    def test_release_without_authenticated_tag_refuses(self):
        github = GitHubFake(
            published_release=matching_release(
                self.version, self.source, self.title, self.body
            )
        )
        with self.assertRaisesRegex(release.ReleaseError, "no authenticated Git tag"):
            release.reconcile_release(
                github, self.version, self.source, self.title, self.body
            )

    def test_image_identity_digest_and_tag_mismatches_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = list(self.image_files(root))
            self.metadata(
                paths[1],
                f"{release.IMAGE}:{self.source}",
                source="4" * 40,
            )
            with self.assertRaisesRegex(release.ReleaseError, "OCI identity"):
                release.verify_published_images(
                    self.source, self.version, *paths, self.digest
                )

            paths = list(self.image_files(root))
            self.metadata(
                paths[2],
                f"{release.IMAGE}:custom",
                digest="sha256:" + "5" * 64,
            )
            with self.assertRaisesRegex(release.ReleaseError, "one image digest"):
                release.verify_published_images(
                    self.source, self.version, *paths, self.digest
                )

            paths = self.image_files(root)
            with self.assertRaisesRegex(release.ReleaseError, "build publication"):
                release.verify_published_images(
                    self.source,
                    self.version,
                    *paths,
                    "sha256:" + "6" * 64,
                )

    def test_only_authenticated_recovery_may_omit_new_build_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.image_files(Path(directory))
            with self.assertRaisesRegex(release.ReleaseError, "did not report"):
                release.verify_published_images(
                    self.source, self.version, *paths, expected_digest=""
                )
            self.assertEqual(
                self.digest,
                release.verify_published_images(
                    self.source,
                    self.version,
                    *paths,
                    expected_digest="",
                    image_already_published=True,
                ),
            )

    def test_annotated_tag_may_resolve_to_exact_commit(self):
        tag_object = "7" * 40
        github = GitHubFake({"object": {"type": "tag", "sha": tag_object}})
        github.annotated[tag_object] = {
            "object": {"type": "commit", "sha": self.source}
        }
        result = release.reconcile_release(
            github, self.version, self.source, self.title, self.body
        )
        self.assertEqual("created", result["outcome"])
        self.assertEqual([], github.created_tags)

    def test_github_release_payload_is_published_latest_without_assets(self):
        expected = matching_release(
            self.version, self.source, self.title, self.body
        )
        opener = Mock(return_value=ResponseFake(expected))
        github = release.GitHub(token="fixture-token", opener=opener)

        github.create_release(
            self.version, self.source, self.title, self.body
        )

        request = opener.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual("POST", request.method)
        self.assertEqual(self.version, payload["tag_name"])
        self.assertEqual(self.source, payload["target_commitish"])
        self.assertFalse(payload["draft"])
        self.assertFalse(payload["prerelease"])
        self.assertEqual("true", payload["make_latest"])
        self.assertNotIn("assets", payload)


class ReleaseNotesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.git("init", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.commit_path("README.md", "base\n", "base")
        self.baseline = self.git("rev-parse", "HEAD")

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

    def commit_path(self, path, content, message):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        self.git("add", path)
        self.git("commit", "-m", message)

    def test_notes_include_product_changes_and_exclude_tooling_only_commits(self):
        self.commit_path("docs/note.md", "tooling documentation\n", "tooling only")
        self.commit_path("src/product.ts", "product\n", "feat: product <unsafe>")
        source = self.git("rev-parse", "HEAD")
        notes = release.release_notes(
            self.root,
            self.baseline,
            source,
            "custom-v1.0.8",
            "sha256:" + "8" * 64,
        )
        self.assertNotIn("tooling only", notes)
        self.assertIn("feat: product \\<unsafe\\>", notes)
        self.assertIn("## Changes", notes)
        self.assertIn(f"`{source}`", notes)
        self.assertNotIn("## Highlights", notes)


if __name__ == "__main__":
    unittest.main()
