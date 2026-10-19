"""This interpreter's ``flow``, as one shell command line.

A command an agent or a check runs must reach the same install and instance the caller runs in — not
whichever ``flow`` happens to be first on a spawned shell's PATH (none, on a fresh box).
"""
from __future__ import annotations

import shlex
import sys


def flow_command(*args: str, platform: str = sys.platform) -> str:
    if platform == "win32":
        quoted = " ".join("'" + a.replace("'", "''") + "'" for a in args)
        return f"& '{sys.executable}' -m flow_sdk.cli.flow_cli {quoted}"
    return " ".join([shlex.quote(sys.executable), "-m", "flow_sdk.cli.flow_cli", *map(shlex.quote, args)])
