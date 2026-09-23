"""Pure-SDK version switch: reinstall a pinned ``flowpad`` version and let the
monitor (``flow_sdk.server.launch``) restart the server with the new code.

This is the cross-platform, Electron-independent path behind the version-popover
"Change version" / rollback flow. It mirrors how ``flow upgrade`` detects whether
flowpad was installed via ``uv tool`` or ``pip`` (see ``flow_sdk/cli/flow_cli.py``),
but pins an explicit version instead of going to latest.

Restart mechanism: after a successful reinstall we simply exit this server
process. The monitor process (started by ``flow start`` — used by both the CLI
and the desktop app) detects the dead server on its next health check and
relaunches ``python -m flow_sdk.server.run`` from the now-reinstalled
site-packages, so the new version boots.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult
from importlib import metadata

from flow_sdk.utils.semver import string2semver

logger = logging.getLogger(__name__)

PACKAGE = "flowpad"


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
        return [shutil.which("uv"), "tool", "install", f"{PACKAGE}=={version}", "--force"]
    return [sys.executable, "-m", "pip", "install", f"{PACKAGE}=={version}"]


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
