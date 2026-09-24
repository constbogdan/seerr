"""Run repository tooling tests without leaking fixture output into hosted channels."""

import argparse
import os
from pathlib import Path
import sys
import unittest


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="scripts")
    parser.add_argument("--pattern", default="test_*.py")
    args = parser.parse_args(argv)

    # Tests that explicitly need these channels supply fixture-local paths.
    # Never let an implicit lookup write synthetic evidence to the enclosing job.
    os.environ.pop("GITHUB_STEP_SUMMARY", None)
    os.environ.pop("GITHUB_OUTPUT", None)

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
