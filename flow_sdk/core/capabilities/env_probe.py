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


def _windows_registry_path() -> str:
    """The PATH a NEW Windows terminal would inherit, read from the registry.

    Windows composes a new process's PATH from two values — the machine's and
    the user's — and an installer that extends PATH writes to the user's.
    ``os.environ["PATH"]`` is this process's copy, taken when it launched, and
    nothing refreshes it: a harness installed while the backend is running
    stays invisible until the backend restarts. That is the whole bug — the
    install button would land its binary and the probe would keep saying "not
    installed".

    So ask the system instead of reporting ourselves. No subprocess and no
    wait: two key opens and two value reads, which is why this is the cheap
    branch even though the unix one spawns a whole login shell.

    ``REG_EXPAND_SZ`` is the normal type here, so ``%SystemRoot%``-style
    references have to be expanded — Windows expands them itself when it builds
    a process environment, and an unexpanded entry resolves nothing. Expansion
    goes through ``ntpath`` rather than ``os.path`` because only the former
    speaks ``%VAR%``: they are the same object on Windows, so this changes no
    behaviour there, and it lets the rule be tested from any platform.

    Returns "" when neither value can be read, which the caller treats as a
    failed probe and answers with the process PATH.
    """
    import ntpath  # noqa: PLC0415
    import winreg  # noqa: PLC0415  (Windows-only; importing at module scope breaks every other platform)

    keys = (
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        (winreg.HKEY_CURRENT_USER, "Environment"),
    )
    # Machine first, then user — the order Windows itself composes them in, and
    # therefore the order that decides which of two installs wins a tie.
    parts: list[str] = []
    for root, sub in keys:
        try:
            with winreg.OpenKey(root, sub) as key:
                value, _ = winreg.QueryValueEx(key, "Path")
        except OSError:
            # A missing HKCU\Environment\Path is ordinary (a user who has never
            # had one); a missing machine key is not, but neither is worth
            # failing the whole probe over while the other still answers.
            continue
        expanded = ntpath.expandvars(str(value)).strip()
        if expanded:
            parts.append(expanded)
    return os.pathsep.join(parts)


def capture_terminal_path() -> str:
    """The PATH a standard terminal would have.

    Unix: spawn the user's default shell as login+interactive (dotfiles run,
    so version managers like nvm/pyenv build the real PATH) over plain pipes
    — no PTY, ``stdin=DEVNULL`` — which sidesteps TTY-gated prompts that hang
    dotfiles under a PTY. The last stdout line skips dotfile chatter.
    Windows: read the registry values a new terminal is built from (see
    ``_windows_registry_path``) rather than this process's launch-time copy.

    Both branches answer the SAME question — what would a terminal opened right
    now resolve? — which is the only reading under which a freshly installed
    harness is discoverable without a restart.

    Falls back to this process's PATH on any failure — degraded, never empty.
    """
    fallback = os.environ.get("PATH", "")
    if sys.platform == "win32":
        try:
            return _windows_registry_path() or fallback
        except Exception:
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
    # stdout IS this module's protocol: the parent runs it as a subprocess and
    # parses this single JSON line (see discovery.run_discovery). Not logging.
    print(json.dumps(probe(argv)))  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
