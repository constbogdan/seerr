"""Shared normalization helpers for cross-platform tooling tests."""

import re


ANSI_CONTROL = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
OSC8_CONTROL = re.compile(r"\x1b\]8;;[^\x1b\x07]*(?:\x07|\x1b\\)")


def normalized_native_output(result):
    """Remove observed PowerShell presentation and retain semantic diagnostics."""
    presentation = OSC8_CONTROL.sub("", (result.stdout or "") + (result.stderr or ""))
    presentation = ANSI_CONTROL.sub("", presentation)
    presentation = re.sub(r"(?<!\S)\|(?=\s|$)", " ", presentation)
    return " ".join(presentation.split())
