"""Run repository tooling tests without leaking fixture output into hosted channels."""

import argparse
import os
from pathlib import Path
import re
import sys
import unittest


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="scripts")
    parser.add_argument("--pattern", default="test_*.py")
    args = parser.parse_args(argv)

    if not re.fullmatch(r"test_[A-Za-z0-9_*?\[\].-]+\.py", args.pattern):
        parser.error("offline test pattern must be a test_*.py basename pattern")

    # Tests that explicitly need these channels supply fixture-local paths.
    # Never let an implicit lookup write synthetic evidence to the enclosing job.
    os.environ.pop("GITHUB_STEP_SUMMARY", None)
    os.environ.pop("GITHUB_OUTPUT", None)
    for key in (
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "SYNC_APP_ID",
        "SYNC_APP_PRIVATE_KEY",
        "SYNC_PUBLISH_TOKEN",
    ):
        os.environ.pop(key, None)

    suite = unittest.defaultTestLoader.discover(str(Path(args.start)), pattern=args.pattern)
    if suite.countTestCases() == 0:
        print(
            f"No offline tooling tests matched pattern {args.pattern!r} "
            f"under {str(Path(args.start))!r}.",
            file=sys.stderr,
        )
        return 1
    result = unittest.TextTestRunner(verbosity=2, buffer=True).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
