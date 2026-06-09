"""Capability environment probe — child-process CLI resolver.

Run as ``python -m flow_sdk.core.capabilities.env_probe <exe> [<exe> …]``.
Captures the PATH a *standard terminal* would have (login+interactive shell
on unix; the registry-backed process PATH on Windows, where GUI and terminal
agree) and resolves each requested executable against it, printing JSON:

    {"path": "<captured PATH>",
     "executables": {"codex": "/abs/.../bin/codex", "claude": null, ...}}

Runs as a clean ``subprocess`` (never fork) so a hanging dotfile can't wedge
the server — the parent (``discovery.run_discovery``) applies the kill cap.
STDLIB-ONLY by design: importing the server stack here would defeat the
isolation and slow every sweep down.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys


def capture_terminal_path() -> str:
    """The PATH a standard terminal would have.

    Unix: spawn the user's default shell as login+interactive (dotfiles run,
    so version managers like nvm/pyenv build the real PATH) over plain pipes
    — no PTY, ``stdin=DEVNULL`` — which sidesteps TTY-gated prompts that hang
    dotfiles under a PTY. The last stdout line skips dotfile chatter.
    Windows: GUI processes already get the registry-backed PATH terminals
    use; return it directly.

    Falls back to this process's PATH on any failure — degraded, never empty.
    """
    fallback = os.environ.get("PATH", "")
    if sys.platform == "win32":
        return fallback
    shell = os.environ.get("SHELL") or "/bin/sh"
    try:
        out = subprocess.run(
            [shell, "-ilc", 'printf "%s" "$PATH"'],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=4,  # parent caps the whole probe at 5s; leave headroom
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip().splitlines()[-1]
    except Exception:
        pass
    return fallback


def probe(executables: list[str]) -> dict:
    """Resolve each executable against the captured terminal PATH.

    PATH order is the tie-break for multiple installs — the same binary a
    terminal would run wins. ``shutil.which`` handles absolute paths and
    Windows PATHEXT.
    """
    path = capture_terminal_path()
    return {
        "path": path,
        "executables": {exe: shutil.which(exe, path=path) for exe in executables},
    }


def main(argv: list[str]) -> int:
    print(json.dumps(probe(argv)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
