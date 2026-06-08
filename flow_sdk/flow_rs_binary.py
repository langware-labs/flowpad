"""Locate and invoke the separately-signed, vendored ``flow-rs`` binary.

The signed binaries are packaged under ``flow_sdk/rust/bin/<platform>/`` (see
``pyproject.toml`` ``package-data`` and ``scripts/deploy_to_github.sh``):

    flow_sdk/rust/bin/darwin/flow-rs       # macOS universal2, Developer ID + notarized
    flow_sdk/rust/bin/win32/flow-rs.exe    # Windows x64, Azure Code Signing

Going through this signed binary for OS-keychain access (instead of the
unsigned Python process via the ``keyring`` library) is what binds the keychain
entry's ACL trust list to a trusted identity — see
``electron/flow-rs-keychain.js`` for the Electron-side equivalent. The CLI
contract this module relies on (``flow_sdk/rust/src/bin/flow-rs.rs``):

    get_key_restricted <service> <name>   exit 0 + value on stdout (no newline);
                                          exit 1 if absent; other non-zero = error
    set_key_restricted <service> <name> <val>   exit 0 ok; non-zero = error
"""

from __future__ import annotations

import importlib.resources
import os
import stat
import subprocess
import sys
from pathlib import Path

# Account-slot suffix, identical to electron/flow-rs-keychain.js ``sodKeyAccount()``
# (``${FLOW_INSTANCE||'prod'}.flow-rs``). Keeping it in sync means the
# pip-installed backend and the desktop app share the SAME signed-ACL keychain
# entry at ``(Flowpad.ai.sod_key, <instance>.flow-rs)``.
FLOW_RS_ACCOUNT_SUFFIX = ".flow-rs"

# Set (to any non-empty value) to force the keyring fallback and never shell out
# to the vendored binary. The test suite sets this so it never reaches the real
# OS keychain (tests run an in-memory keyring backend — see tests/conftest.py).
ENV_DISABLE_VENDORED_FLOW_RS = "FLOWPAD_DISABLE_VENDORED_FLOW_RS"

# Maps sys.platform -> (vendored sub-dir, binary filename).
_PLATFORM_BINARIES = {
    "darwin": ("darwin", "flow-rs"),
    "win32": ("win32", "flow-rs.exe"),
}


def vendored_flow_rs_path() -> Path | None:
    """Return the path to the vendored signed ``flow-rs`` for the current OS.

    Pure location lookup — no policy. Returns ``None`` on unsupported platforms
    (e.g. Linux — no signed binary is vendored) or when the binary is not
    present in the installed package (e.g. a source checkout that has not run
    the signing step yet).
    """
    entry = _PLATFORM_BINARIES.get(sys.platform)
    if entry is None:
        return None
    subdir, filename = entry
    path = Path(str(importlib.resources.files("flow_sdk") / "rust" / "bin" / subdir / filename))
    return path if path.is_file() else None


def vendored_flow_rs_enabled() -> bool:
    """True when keychain ops should route through the signed vendored binary.

    False when disabled via ``FLOWPAD_DISABLE_VENDORED_FLOW_RS`` (tests) or when
    no signed binary is vendored for this platform (Linux / source checkout).
    """
    if os.environ.get(ENV_DISABLE_VENDORED_FLOW_RS):
        return False
    return vendored_flow_rs_path() is not None


def _resolve_or_raise() -> Path:
    path = vendored_flow_rs_path()
    if path is None:
        raise RuntimeError("no vendored flow-rs binary available for this platform")
    # pip may not preserve the executable bit on package-data; restore it
    # best-effort so execfile/subprocess can run the binary. (.exe needs none.)
    if sys.platform != "win32":
        try:
            mode = path.stat().st_mode
            if not (mode & stat.S_IXUSR):
                path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        except OSError:
            pass  # read-only install dir; exec may still succeed
    return path


def flow_rs_get_restricted(service: str, account: str) -> str | None:
    """Read ``(service, account)`` via the signed binary's ``get_key_restricted``.

    Returns the stored value, or ``None`` if absent. Raises ``RuntimeError`` on
    any other failure (or when no vendored binary is available).
    """
    bin_path = _resolve_or_raise()
    # No timeout: a first-time write/read can legitimately surface the OS
    # keychain prompt, which must be allowed to block for the user.
    proc = subprocess.run(
        [str(bin_path), "get_key_restricted", service, account],
        capture_output=True,
        encoding="utf-8",
    )
    if proc.returncode == 0:
        return proc.stdout  # flow-rs prints the value with no trailing newline
    if proc.returncode == 1:
        return None
    raise RuntimeError(
        f"flow-rs get_key_restricted exit {proc.returncode}: {(proc.stderr or proc.stdout).strip()}"
    )


def flow_rs_set_restricted(service: str, account: str, value: str) -> None:
    """Write ``(service, account) = value`` via ``set_key_restricted`` (ACL bound
    to the signed binary). Raises ``RuntimeError`` on failure."""
    bin_path = _resolve_or_raise()
    proc = subprocess.run(
        [str(bin_path), "set_key_restricted", service, account, value],
        capture_output=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"flow-rs set_key_restricted exit {proc.returncode}: {(proc.stderr or proc.stdout).strip()}"
        )
