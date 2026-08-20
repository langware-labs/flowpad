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


def merge_paths(primary: str, secondary: str) -> str:
    """``primary`` entries first, then any ``secondary`` entry not already in it.

    Order is the tie-break for multiple installs, so the terminal PATH must stay
    ahead of this process's PATH. Appending — rather than replacing — means a
    binary the server can plainly see is never invisible to discovery just
    because the login shell's dotfiles did not add its directory.
    """
    seen: set[str] = set()
    merged: list[str] = []
    for entry in primary.split(os.pathsep) + secondary.split(os.pathsep):
        if entry and entry not in seen:
            seen.add(entry)
            merged.append(entry)
    return os.pathsep.join(merged)


def capture_terminal_path() -> str:
    """The PATH a standard terminal would have, plus this process's own PATH.

    Unix: spawn the user's default shell as login+interactive (dotfiles run,
    so version managers like nvm/pyenv build the real PATH) over plain pipes
    — no PTY, ``stdin=DEVNULL`` — which sidesteps TTY-gated prompts that hang
    dotfiles under a PTY. The last stdout line skips dotfile chatter.
    Windows: GUI processes already get the registry-backed PATH terminals
    use; return it directly.

    This process's PATH is appended behind the captured one (never in front, so
    the terminal keeps the tie-break). A login shell only reports what its
    dotfiles build, which silently omits directories the server itself already
    resolves against — a backend started from a shell that exports PATH without
    a dotfile, or under a HOME with no dotfiles at all, would otherwise report a
    perfectly runnable CLI as "not installed".

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
            return merge_paths(out.stdout.strip().splitlines()[-1], fallback)
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
