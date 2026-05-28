"""Stable cross-platform machine id.

Cache → OS-specific id → brittle uuid.getnode() fallback. Cached at
``<flow_home>/global/system.json`` (cross-instance shared) so all
instances + restarts on one machine see the same value.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from filelock import FileLock, Timeout

logger = logging.getLogger(__name__)

CACHE_FILENAME = "system.json"
CACHE_KEY = "machine_id"


def get_machine_id(flow_home: Optional[Path] = None) -> str:
    """Return the stable per-machine identifier.

    Args:
        flow_home: override for the cache root. Defaults to
            ``InstanceSettings.flow_home`` so the cache picks up the
            same FLOW_HOME / HOME redirection tests rely on.
    """
    home = flow_home or _resolve_flow_home()
    cache_path = home / "global" / CACHE_FILENAME

    cached = _read_cache(cache_path)
    if cached:
        return cached

    derived, provenance = _derive_machine_id()
    _write_cache(cache_path, derived, provenance)
    return derived


# ----------------------------------------------------------------------
# OS-specific derivation — public so the FaaS remote-execution path can
# embed the same logic into the script it runs on the compute node.
# ----------------------------------------------------------------------

DERIVATION_SCRIPT_LINUX = """\
import os
for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
    if os.path.isfile(path):
        with open(path) as f:
            v = f.read().strip()
        if v:
            print(v); break
"""


def _derive_machine_id() -> tuple[str, str]:
    """Read the OS-specific stable identifier. Returns ``(id, provenance)``."""
    system = platform.system()
    try:
        if system == "Linux":
            for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                p = Path(path)
                if p.is_file():
                    val = p.read_text(encoding="utf-8").strip()
                    if val:
                        return val, f"linux:{path}"
        elif system == "Darwin":
            out = subprocess.check_output(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                text=True, timeout=5,
            )
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    # Format: ... "IOPlatformUUID" = "XXXX-XXXX-..."
                    parts = line.split('"')
                    if len(parts) >= 4:
                        return parts[3], "darwin:IOPlatformUUID"
        elif system == "Windows":
            import winreg
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Cryptography",
            ) as key:
                val, _ = winreg.QueryValueEx(key, "MachineGuid")
                if val:
                    return val, "windows:MachineGuid"
    except (OSError, subprocess.SubprocessError, ImportError) as exc:
        logger.warning("machine_id: stable derivation failed (%s): %s",
                       system, exc)

    # Brittle fallback (uuid.getnode() drifts on MAC randomization); cache fixes it on first call.
    logger.warning(
        "machine_id: no stable OS identifier on %s — using brittle fallback. "
        "First call will cache the value, so subsequent calls are stable.",
        system,
    )
    return (f"fallback-{platform.machine()}-{uuid.getnode()}",
            f"fallback:{system}")


# ----------------------------------------------------------------------
# Cache file I/O
# ----------------------------------------------------------------------

def _read_cache(cache_path: Path) -> Optional[str]:
    """Return the cached machine_id or None. Never raises."""
    if not cache_path.is_file():
        return None
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("machine_id: cache unreadable, will recompute: %s", exc)
        return None
    if not isinstance(data, dict):
        return None
    val = data.get(CACHE_KEY)
    if isinstance(val, str) and val:
        return val
    return None


def _write_cache(cache_path: Path, machine_id: str, provenance: str) -> None:
    """Atomic JSON write + filelock. Failures are logged, not raised."""
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = str(cache_path) + ".lock"

    try:
        with FileLock(lock_path, timeout=5):
            # Double-checked locking.
            existing = _read_cache(cache_path)
            if existing:
                return
            payload = {
                CACHE_KEY: machine_id,
                "_provenance": provenance,
                "_first_seen": datetime.now(timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ",
                ),
                "_created_by_version": _flow_version(),
            }
            fd, tmp_path = tempfile.mkstemp(
                prefix=".system_", suffix=".tmp",
                dir=str(cache_path.parent),
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(payload, fh, indent=2, sort_keys=True)
                os.replace(tmp_path, str(cache_path))
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
    except (Timeout, OSError) as exc:
        # Read-only fs, lock contention, etc. — return without caching.
        # Next call will retry. Don't raise: the caller already has the
        # derived id and shouldn't fail on a cache write.
        logger.warning("machine_id: cache write failed: %s", exc)


# ----------------------------------------------------------------------
# Internals — resolver helpers
# ----------------------------------------------------------------------

def _resolve_flow_home() -> Path:
    """Pull from InstanceSettings — the single source of truth for FLOW_HOME.

    ``instance_settings`` is a leaf module with no flow_sdk imports of its
    own, so it is always importable by the time this helper is called.
    Reproducing the FLOW_HOME read here was a latent SoT violation.
    """
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings().flow_home


def _flow_version() -> str:
    try:
        from flow_sdk._version import __version__
        return __version__
    except Exception:
        return "unknown"
