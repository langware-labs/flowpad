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

import concurrent.futures
import json
import os
import shutil
import signal
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

    So ask the system instead of reporting ourselves — and then UNION that with
    what we already had, because a shell that launched the backend may have
    added directories the registry never saw (an activated venv's Scripts dir is
    the case that bit). No subprocess and no wait: two key opens and two value
    reads, which is why this is the cheap branch even though the unix one spawns
    a whole login shell.

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
    if not parts:
        return ""

    # UNION with this process's PATH, never a replacement.
    #
    # The registry is the fresh half — it is where an installer writes, and the
    # only reason this function exists. But it is not the whole truth: a shell
    # that launched the backend can have added directories that were never
    # persisted, and an activated venv's Scripts dir is exactly that. Returning
    # registry-only silently un-discovered anything living in one, which is a
    # regression this function introduced and this line removes.
    #
    # Adding can never hide a new install, so the union keeps the fix intact:
    # registry first (fresh wins a tie), then whatever else we already had.
    # ``ntpath.pathsep``, not ``os.pathsep``, for the same reason as
    # ``expandvars`` above: identical on Windows, and it lets the composition be
    # tested from a platform whose separator is ":" — which would otherwise cut
    # every "C:\..." entry in half.
    sep = ntpath.pathsep
    seen = {entry.lower() for part in parts for entry in part.split(sep) if entry}
    for entry in (os.environ.get("PATH") or "").split(sep):
        if entry and entry.lower() not in seen:
            seen.add(entry.lower())
            parts.append(entry)
    return sep.join(parts)


def capture_terminal_path() -> str:
    """The PATH a standard terminal would have (``read_terminal_path``), then this process's own.

    Both platforms answer the SAME question — what would a terminal opened right
    now resolve? — which is the only reading under which a freshly installed
    harness is discoverable without a restart. A login zsh never reads ``~/.profile``,
    where rustup puts ``~/.cargo/bin``, so this process's own entries stay, after the
    terminal's. Falls back to this process's PATH on any failure — degraded, never empty.
    """
    return _union(read_terminal_path()[0], os.environ.get("PATH", ""))


#: Brackets the PATH in the login shell's output: a dotfile that prints a banner before the command
#: or a logout hook / EXIT trap after it would otherwise corrupt "the last line".
_MARK = "__FLOWPAD_TERMINAL_PATH__"

#: How long a login shell may take; a dotfile waiting on input, a network mount or a lock is cut off.
_SHELL_SECONDS = 4


def login_shell() -> str:
    """The user's shell: ``$SHELL``, else their login shell from the user database, else ``/bin/sh``.

    A service manager (systemd, a container entrypoint) may start the backend with no ``$SHELL`` at
    all, and ``/bin/sh`` reads none of the user's zsh or bash setup.
    """
    shell = os.environ.get("SHELL")
    if shell:
        return shell
    try:
        import pwd

        return pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
    except (ImportError, KeyError):
        return "/bin/sh"


def read_terminal_path() -> tuple[str, str]:
    """``(PATH, "")`` as a terminal opened now would have it, or ``("", why not)``.

    Windows reads the registry (see ``_windows_registry_path``). Unix runs the user's shell as
    login+interactive -- dotfiles run, so version managers like nvm/pyenv build the real PATH -- over
    plain pipes, no PTY, ``stdin=DEVNULL``, which sidesteps TTY-gated prompts that hang dotfiles
    under a PTY. The shell gets its own process group so a timeout kills what a dotfile started too;
    otherwise a backgrounded child keeps the pipe open and the read never returns.
    """
    if sys.platform == "win32":
        try:
            return _windows_registry_path(), ""
        except Exception as exc:
            return "", f"registry read failed ({type(exc).__name__}: {exc})"
    shell = login_shell()
    try:
        proc = subprocess.Popen(
            [shell, "-ilc", f'printf "\\n{_MARK}%s{_MARK}\\n" "$PATH"'],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            start_new_session=True,
        )
    except OSError as exc:
        return "", f"{shell} did not start ({exc})"
    try:
        out, err = proc.communicate(timeout=_SHELL_SECONDS)
    except subprocess.TimeoutExpired:
        # flow_sdk.utils.process_tree.kill_process_tree, inlined: this module stays stdlib-only.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            proc.kill()
        proc.communicate()
        return "", f"{shell} -ilc did not finish in {_SHELL_SECONDS}s (a dotfile is waiting on something)"
    parts = out.split(_MARK)
    if len(parts) >= 3 and parts[-2].strip():
        return parts[-2].strip(), ""
    said = (err.strip().splitlines() or [""])[-1][:200]
    return "", f"{shell} -ilc exited {proc.returncode} without printing PATH{f': {said}' if said else ''}"


def _union(*paths: str) -> str:
    """The entries of *paths*, in order, each once."""
    return os.pathsep.join(dict.fromkeys(e for p in paths for e in p.split(os.pathsep) if e))


def adopt_path(terminal: str) -> list[str]:
    """Run this process with *terminal*'s PATH; returns the entries that were missing.

    A backend launched from the Dock starts with launchd's bare PATH, never the one the user's
    dotfiles build, so nvm's node was "not installed" for every check, worker and MCP spawn while
    the user's terminal ran it fine -- and every child inherits ``os.environ``. Order: this
    interpreter's folder (``flow`` stays THIS build), the terminal's entries, then the ones this
    process already had.

    PATH only, on purpose. A dotfile also exports Flowpad's own wiring (``FLOWPAD_BACKEND_URL``)
    and funding (``COPILOT_PROVIDER_API_KEY``); adopting those would let a stale shell line override
    what Flowpad chose. PATH decides which tools exist, and that is the whole job.
    """
    before = os.environ.get("PATH", "")
    os.environ["PATH"] = _union(os.path.dirname(sys.executable), terminal, before)
    had = set(before.split(os.pathsep))
    return [e for e in os.environ["PATH"].split(os.pathsep) if e not in had]


def start_terminal_path_capture() -> "concurrent.futures.Future[tuple[str, str]]":
    """Start reading the terminal's PATH in the background; ``adopt_terminal_path`` waits for it.

    The login shell costs about a second, so a server starts it first and overlaps it with its own
    imports.
    """
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="terminal-path")
    future = pool.submit(read_terminal_path)
    pool.shutdown(wait=False)
    return future


def adopt_terminal_path(captured: "concurrent.futures.Future[tuple[str, str]]") -> tuple[list[str], str]:
    """``adopt_path`` the captured PATH: ``(entries added, why it could not be read)``, ``""`` when
    it was. The reason is the caller's to log: a silent fallback reads exactly like "that tool is not
    installed".
    """
    terminal, why = captured.result()
    return adopt_path(terminal), why


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
