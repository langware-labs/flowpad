"""The baseline every diagnosis carries: the machine and the tail of its logs.

Collected by the runner BEFORE any diagnose runs, from nothing but files and settings -- so a
diagnose that raises, hangs or is missing still leaves the helper something to read. Every
helper here is best-effort and never raises.
"""

from __future__ import annotations

import logging
import platform
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from flow_sdk.schema.data_spec.diagnose_spec import DiagnosisEnvironment, LogTail

logger = logging.getLogger(__name__)

#: How many lines of each log travel. Enough to see the last error and what led to it.
TAIL_LINES = 80

# Secrets that show up in our logs: bearer tokens, key=value credentials, provider keys, JWTs.
_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"), r"\1[redacted]"),
    (
        re.compile(
            r"(?i)\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[\w-]*)"
            r"(\"?\s*[:=]\s*\"?)([^\s\"',;&]{4,})"
        ),
        r"\1\2[redacted]",
    ),
    (re.compile(r"\b(?:sk|pk|rk|ghp|gho|xox[abprs])[-_][A-Za-z0-9_-]{12,}"), "[redacted]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "[redacted]"),
)


def redact(line: str) -> str:
    for pattern, replacement in _REDACTIONS:
        line = pattern.sub(replacement, line)
    return line


def tail(path: Path, lines: int = TAIL_LINES) -> list[str]:
    """The last ``lines`` lines of ``path``, redacted; reads at most the file's last 256 KB."""
    try:
        with path.open("rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 256 * 1024))
            text = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    return [redact(line) for line in text.splitlines()[-lines:]]


def newest_boot_log(folder: Path) -> Optional[Path]:
    """The newest per-boot log in ``folder`` -- they are named for their start time
    (``4Jul2026_18_04_12.log``), which keeps ``stacks.log`` and other side files out."""
    try:
        files = [p for p in folder.iterdir() if p.is_file() and p.name[:1].isdigit()]
    except OSError:
        return None
    return max(files, key=lambda p: p.stat().st_mtime, default=None)


def log_tails() -> list[LogTail]:
    """This instance's newest server log, newest monitor log and the CLI log -- whichever exist."""
    try:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        logs = get_instance_settings().logs_dir
    except Exception as exc:  # noqa: BLE001
        logger.warning("[diagnose] no logs dir: %s", exc)
        return []
    out: list[LogTail] = []
    for path in (newest_boot_log(logs / "server"), newest_boot_log(logs / "monitor"), logs / "cli.log.jsonl"):
        if path is not None and path.is_file():
            lines = tail(path, TAIL_LINES if path.suffix != ".jsonl" else 20)
            if lines:
                out.append(LogTail(file=str(path), lines=lines))
    return out


def _who() -> str:
    try:
        from flow_sdk.server.routes.bootstrap import get_email, get_name  # noqa: PLC0415

        name, email = get_name(), get_email()
        if name or email:
            return f"{name} <{email}>" if name and email else (email or name)
    except Exception:  # noqa: BLE001
        pass
    # Signed out (a supporter's request runs with no account): the login on this computer.
    try:
        import getpass  # noqa: PLC0415
        import platform  # noqa: PLC0415

        return f"{getpass.getuser()} on {platform.node()}"
    except Exception:  # noqa: BLE001
        return ""


def environment() -> DiagnosisEnvironment:
    """Who, when, which machine and which Flowpad -- without touching the network."""
    try:
        from flow_sdk._version import __version__ as app_version  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        app_version = ""
    instance, port, hub_url = "", None, ""
    try:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        settings = get_instance_settings()
        instance, port, hub_url = settings.instance_name, settings.port, settings.hub_url or ""
    except Exception:  # noqa: BLE001
        pass
    return DiagnosisEnvironment(
        reported_by=_who(),
        occurred_at=datetime.now(timezone.utc).isoformat(),
        os=platform.platform(),
        app_version=app_version or "",
        python=sys.version.split()[0],
        instance=instance,
        backend_port=port,
        hub_url=hub_url,
    )
