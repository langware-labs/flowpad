"""Pure-SDK version switch: reinstall a pinned ``flowpad`` version and let the
monitor (``flow_sdk.server.launch``) restart the server with the new code.

This is the cross-platform, Electron-independent path behind the version-popover
"Change version" / rollback flow, and behind ``flow upgrade``: both install an
explicit ``flowpad==<version>`` (uv tool or pip, whichever installed it), the same
pin the desktop app writes. ``uv tool upgrade`` cannot move past such a pin.

Restart mechanism: after a successful reinstall we simply exit this server
process. The monitor process (started by ``flow start`` — used by both the CLI
and the desktop app) detects the dead server on its next health check and
relaunches ``python -m flow_sdk.server.run`` from the now-reinstalled
site-packages, so the new version boots.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult
from importlib import metadata

from flow_sdk.utils.semver import string2semver

logger = logging.getLogger(__name__)

PACKAGE = "flowpad"
PYPI_URL = f"https://pypi.org/pypi/{PACKAGE}/json"


def latest_release(timeout: float = 8.0) -> "str | None":
    """The newest ``flowpad`` on PyPI, or ``None`` when PyPI cannot be asked. Never raises.

    A unique query string skips PyPI's CDN edge cache, whose edges disagree for minutes after
    an upload (see ``routes/version.py``)."""
    import httpx  # noqa: PLC0415

    try:
        resp = httpx.get(PYPI_URL, params={"t": time.time_ns()}, timeout=timeout)
        resp.raise_for_status()
        latest = (resp.json().get("info") or {}).get("version")
    except Exception as exc:  # noqa: BLE001 -- offline is an answer, not a crash
        logger.warning("[self-update] PyPI fetch failed: %s", exc)
        return None
    return latest if isinstance(latest, str) else None


def is_valid_version(version: str) -> bool:
    # Gate the value before it becomes a `flowpad==<version>` subprocess arg.
    # Uses the same parser that builds the PyPI release list server-side, so any
    # version offered in the picker (incl. pre-release tags like "0.2.41rc1")
    # validates here instead of being rejected by a stricter pattern.
    return string2semver(version) is not None


def is_editable_install() -> bool:
    """True when flowpad runs from a dev/editable checkout rather than an
    installed wheel.

    We must never reinstall a published wheel over a developer's working tree,
    so the install endpoint refuses when this is true. Two signals:

    * ``direct_url.json`` reports ``dir_info.editable`` (``pip install -e .``); and
    * the imported ``flow_sdk`` source does not live under a ``site-packages``
      dir (covers ``uv run`` / a bare source checkout where direct_url is absent).
    """
    try:
        dist = metadata.distribution(PACKAGE)
        raw = dist.read_text("direct_url.json")
        if raw:
            data = json.loads(raw)
            if (data.get("dir_info") or {}).get("editable"):
                return True
    except Exception:
        pass
    try:
        import flow_sdk

        src = os.path.realpath(os.path.dirname(flow_sdk.__file__))
        return "site-packages" not in src and "dist-packages" not in src
    except Exception:
        # Fail safe: if we can't tell, assume editable and refuse to reinstall.
        return True


def detect_install_method() -> str:
    """Return ``"uv"`` if running from a uv-tool venv, else ``"pip"``.

    Mirrors the detection in the ``flow upgrade`` CLI command.
    """
    uv = shutil.which("uv")
    if uv:
        try:
            result = subprocess.run([uv, "tool", "dir"], capture_output=True, text=True, timeout=10)
            if result.returncode == 0 and sys.executable.startswith(result.stdout.strip()):
                return "uv"
        except Exception as exc:
            logger.warning("[self-update] 'uv tool dir' probe failed: %s", exc)
    return "pip"


def build_install_command(version: str) -> list[str]:
    if detect_install_method() == "uv":
        # No ``--force``: a new pin already moves the tool, in place. ``--force`` rebuilds the
        # environment, and its own callers run inside it (``flow upgrade``, the server) -- on
        # Windows the delete of an interpreter in use fails ("Access is denied") halfway and
        # leaves the tool without flowpad. Proven on the Windows VM, both ways.
        return [shutil.which("uv"), "tool", "install", f"{PACKAGE}=={version}"]
    return [sys.executable, "-m", "pip", "install", f"{PACKAGE}=={version}"]


@contextlib.contextmanager
def launchers_set_aside(wait_s: float = 0.0):
    """Yields whether an install may run now: on Windows, with flowpad's launchers (``flow.exe``,
    ``flow-sdk-mcp.exe`` -- in uv's bin dir, or a pip venv's ``Scripts``) moved out of the
    installer's way; elsewhere, always.

    Windows cannot replace a running ``.exe``. uv answers "being used by another process" by
    rolling the tool back -- it deletes the whole environment, which half-fails on the interpreter
    in use and leaves no flowpad; pip stops halfway with flowpad already removed (both proven on
    the Windows VM). A uv launcher that is running cannot
    even be renamed (it holds its own file open), so a launcher that will not move means something
    still runs from it: retried for *wait_s*, then the moved ones go back and this yields False --
    no install, rather than one that destroys the tool. Moved launchers are renamed
    ``<name>.old-<pid>``; uv writes fresh ones; copies left by an earlier run are swept here.
    """
    if sys.platform != "win32":
        yield True
        return
    try:
        if detect_install_method() == "uv":
            run = subprocess.run([shutil.which("uv"), "tool", "dir", "--bin"], capture_output=True, text=True, timeout=10)
            bin_dir = Path(run.stdout.strip())
        else:
            bin_dir = Path(sys.executable).parent  # a pip venv's launchers sit beside its python.exe
        names = sorted(ep.name for ep in metadata.distribution(PACKAGE).entry_points if ep.group == "console_scripts")
    except Exception as exc:  # noqa: BLE001 -- nothing to move aside is an answer: install as before
        logger.warning("[self-update] could not find the tool's launchers: %s", exc)
        yield True
        return
    for stale in bin_dir.glob("*.exe.old-*"):
        with contextlib.suppress(OSError):
            stale.unlink()  # still running -> still locked; a later run sweeps it
    moved: list[tuple[Path, Path]] = []
    pending = [bin_dir / f"{name}.exe" for name in names]
    deadline = time.monotonic() + wait_s
    while True:
        for exe in list(pending):
            aside = exe.with_name(f"{exe.name}.old-{os.getpid()}")
            try:
                exe.rename(aside)
            except FileNotFoundError:
                pending.remove(exe)
                continue
            except OSError:
                continue  # running: try again
            moved.append((exe, aside))
            pending.remove(exe)
        if not pending or time.monotonic() >= deadline:
            break
        time.sleep(0.5)
    if pending:
        logger.warning("[self-update] still running, so not installing: %s", ", ".join(str(p) for p in pending))
    try:
        yield not pending
    finally:
        for exe, aside in moved:
            with contextlib.suppress(OSError):
                if exe.exists():
                    aside.unlink()  # the install wrote a new one; nothing runs from the old one
                else:
                    aside.rename(exe)  # no install, or it wrote no new one: put the old one back


def _wait_for_exit(pids: list[int], timeout: float) -> None:
    """Block until every process in *pids* has exited (Windows), or *timeout* passes."""
    import ctypes  # noqa: PLC0415

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    synchronize = 0x00100000
    for pid in pids:
        handle = kernel32.OpenProcess(synchronize, False, pid)
        if handle:
            kernel32.WaitForSingleObject(handle, int(timeout * 1000))
            kernel32.CloseHandle(handle)


def upgrade_after_exit(version: str, pids: list[int], log: Path) -> int:
    """The Windows half of ``flow upgrade``: install *version* once *pids* (the ``flow.exe`` that
    asked, and its Python) have exited, writing what happened to *log*. Run detached."""
    _wait_for_exit(pids, timeout=60)
    with launchers_set_aside(wait_s=60) as free:
        if not free:
            log.write_text(
                "flow upgrade did not run: a flow command is still running from this install. "
                "Close it and run `flow upgrade` again.\n",
                encoding="utf-8",
            )
            return 1
        result = subprocess.run(build_install_command(version), capture_output=True, text=True)
    tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-15:])
    verdict = f"flowpad upgraded to {version}." if result.returncode == 0 else f"flow upgrade failed (exit {result.returncode})."
    log.write_text(f"{tail}\n{verdict}\n", encoding="utf-8")
    return result.returncode


def reinstall_version(version: str, timeout: float = 180.0) -> "CliResult":
    """Run the pinned reinstall — a ``CliResult``, built the one way every
    process record is (``of_process``), so a timeout is ``timed_out`` rather than
    folded into "failed". Never raises.

    Blocking — call via ``asyncio.to_thread`` from an async route.
    """
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult  # noqa: PLC0415

    cmd = build_install_command(version)
    command = " ".join(cmd)
    logger.info("[self-update] installing %s==%s via: %s", PACKAGE, version, command)
    started = time.monotonic()
    try:
        with launchers_set_aside(wait_s=10) as free:
            if not free:
                return CliResult.of_process(
                    command, None, "", "A flow command is running from this install; close it and try again."
                )
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        logger.warning("[self-update] reinstall did not finish within %.0fs", timeout)
        return CliResult.of_process(
            command, None, _text(exc.stdout), _text(exc.stderr),
            timed_out=True, duration_s=time.monotonic() - started,
        )
    except Exception as exc:  # noqa: BLE001 — could not start: an answer, not a crash
        logger.warning("[self-update] reinstall failed: %s", exc)
        return CliResult.of_process(command, None, "", str(exc))
    answer = CliResult.of_process(
        command, result.returncode, result.stdout or "", result.stderr or "",
        duration_s=time.monotonic() - started,
    )
    if not answer.ok:
        logger.warning("[self-update] reinstall exit=%d:\n%s", result.returncode, answer.stdout + answer.stderr)
    return answer


def _text(raw) -> str:
    return raw.decode(errors="replace") if isinstance(raw, bytes) else (raw or "")


def schedule_restart(delay: float = 1.0) -> None:
    """Exit this server process after *delay*s so the monitor restarts it.

    The short delay lets the HTTP response flush before the process dies.
    """

    def _exit() -> None:
        time.sleep(delay)
        logger.info("[self-update] exiting for monitor restart")
        os._exit(0)

    threading.Thread(target=_exit, daemon=True).start()


if __name__ == "__main__":  # python -m flow_sdk.server.self_update upgrade <version> <log> <pid>...
    if len(sys.argv) >= 5 and sys.argv[1] == "upgrade":
        raise SystemExit(upgrade_after_exit(sys.argv[2], [int(p) for p in sys.argv[4:]], Path(sys.argv[3])))
