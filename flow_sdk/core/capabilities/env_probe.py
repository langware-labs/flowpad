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


def _merge_paths(*paths: str) -> str:
    """Concatenate PATH strings in order, dropping empties and duplicates."""
    seen: set[str] = set()
    merged: list[str] = []
    for entry in os.pathsep.join(p for p in paths if p).split(os.pathsep):
        if entry and entry not in seen:
            seen.add(entry)
            merged.append(entry)
    return os.pathsep.join(merged)


def probe(executables: list[str]) -> dict:
    """Resolve each executable against the terminal PATH, then this process's.

    PATH order is the tie-break for multiple installs — the terminal PATH comes
    first, so the same binary a terminal would run still wins. ``shutil.which``
    handles absolute paths and Windows PATHEXT.

    The process PATH is *appended*, never dropped: the captured terminal PATH is
    only as good as the dotfiles that built it, and a shell whose ``$HOME`` has
    no ``.profile``/``.bashrc`` (a sandboxed HOME, a service account, a stripped
    container image) yields a PATH *narrower* than the one this process is
    already running with. Resolving against that alone reports a harness as "not
    installed" while its binary sits on the server's own PATH, executable right
    now — which then refuses ``createProcess`` and fails PTY spawn. Discovery
    must never lose a directory we can already see.
    """
    terminal_path = capture_terminal_path()
    path = _merge_paths(terminal_path, os.environ.get("PATH", ""))
    return {
        "path": path,
        "executables": {exe: shutil.which(exe, path=path) for exe in executables},
    }


def main(argv: list[str]) -> int:
    print(json.dumps(probe(argv)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
