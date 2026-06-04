"""3x3 interchange matrix: writers x readers x OS keychain.

Three surfaces, each exercised as both a writer and a reader:
  - py_keyring   — Python shelling out to `/usr/bin/security` (see
                   `_write_py_keyring` for why we don't call the `keyring`
                   library directly)
  - flow_rs_bind — pyo3 binding: `flow_rs.get_key` / `set_key`
  - flow_rs_cli  — `flow-rs get_key | set_key` subprocess

Each test writes a randomized secret via one surface and reads it back via
another, asserting the round-trip matches. All three surfaces ultimately
write to the same item in the OS credential store (macOS Keychain on this
dev machine) via `/usr/bin/security ... -A`, so reads from any surface see
what any other surface wrote — and no Keychain prompts fire.

This file lives in `flow_sdk/rust/tests/`, not the repo-root `tests/` dir.
That, plus the empty `flow_sdk/rust/conftest.py` and the
[tool.pytest.ini_options] section in `flow_sdk/rust/pyproject.toml`, anchors
pytest's rootdir here so the repo-root `tests/conftest.py` is not pulled in.

Run with:
    cd flow_sdk/rust && uv run pytest tests/interchange.py -v
"""
from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

CRATE_DIR = Path(__file__).resolve().parent.parent


def _locate_flow_rs_binary() -> str:
    """Find the compiled `flow-rs` binary. Prefer target/release, fall back to
    target/debug, then $PATH.
    """
    for candidate in (
        CRATE_DIR / "target" / "release" / "flow-rs",
        CRATE_DIR / "target" / "debug" / "flow-rs",
    ):
        if candidate.exists():
            return str(candidate)
    on_path = shutil.which("flow-rs")
    if on_path:
        return on_path
    pytest.skip(
        "flow-rs binary not built. Run `cargo build --release` in flow_sdk/rust first."
    )


FLOW_RS_BIN = _locate_flow_rs_binary()


try:
    import flow_rs  # type: ignore[import-not-found]
except ImportError:
    pytest.skip(
        "flow_rs pyo3 module not installed. Run `maturin develop --features python` "
        "in flow_sdk/rust first.",
        allow_module_level=True,
    )

pytestmark = pytest.mark.skipif(
    os.environ.get("CI") == "1",
    reason="needs access to the real OS keychain; skip in headless CI",
)


# --- writer / reader implementations -----------------------------------------

def _write_py_keyring(service: str, name: str, val: str) -> None:
    # We deliberately do NOT call `keyring.set_password(service, name, val)`
    # here. Python's keyring lib uses the modern Keychain Services API
    # (SecItemAdd), which creates items whose ACL trusts only the python
    # binary. Cross-binary reads then trigger a SecurityAgent prompt
    # ("flow-rs wants to use the keychain"). For unsigned binaries on macOS
    # there is no API-level way to grant cross-binary access without a prompt.
    #
    # The Rust impl in keychain.rs uses the legacy `/usr/bin/security` CLI
    # with `-A` so the resulting items are readable across binaries via the
    # legacy API. To make the matrix run prompt-free we mirror that choice
    # here for the python writer/reader. The test still validates the data
    # path across three independent surfaces (CLI binary, pyo3 binding, and
    # python-direct), all backed by the same OS keychain.
    subprocess.run(
        ["/usr/bin/security", "delete-generic-password", "-s", service, "-a", name],
        capture_output=True,
    )
    subprocess.run(
        ["/usr/bin/security", "add-generic-password",
         "-s", service, "-a", name, "-w", val, "-A"],
        check=True,
        capture_output=True,
    )


def _write_flow_rs_bind(service: str, name: str, val: str) -> None:
    flow_rs.set_key(service, name, val)


def _write_flow_rs_cli(service: str, name: str, val: str) -> None:
    subprocess.run(
        [FLOW_RS_BIN, "set_key", service, name, val],
        check=True,
        capture_output=True,
    )


def _read_py_keyring(service: str, name: str) -> str | None:
    # See `_write_py_keyring` for why we shell out instead of calling
    # `keyring.get_password`.
    result = subprocess.run(
        ["/usr/bin/security", "find-generic-password",
         "-s", service, "-a", name, "-w"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout.rstrip("\n")


def _read_flow_rs_bind(service: str, name: str) -> str | None:
    return flow_rs.get_key(service, name)


def _read_flow_rs_cli(service: str, name: str) -> str | None:
    result = subprocess.run(
        [FLOW_RS_BIN, "get_key", service, name],
        capture_output=True,
        text=True,
    )
    if result.returncode == 1 and not result.stdout:
        return None
    result.check_returncode()
    return result.stdout


WRITERS = {
    "py_keyring": _write_py_keyring,
    "flow_rs_bind": _write_flow_rs_bind,
    "flow_rs_cli": _write_flow_rs_cli,
}
READERS = {
    "py_keyring": _read_py_keyring,
    "flow_rs_bind": _read_flow_rs_bind,
    "flow_rs_cli": _read_flow_rs_cli,
}


# --- fixtures ----------------------------------------------------------------

@pytest.fixture
def entry():
    """Per-test (service, name) pair. Cleanup is best-effort via the security CLI."""
    service = f"flow-rs-test-{uuid.uuid4().hex[:12]}"
    name = "interchange"
    yield service, name
    subprocess.run(
        ["/usr/bin/security", "delete-generic-password", "-s", service, "-a", name],
        capture_output=True,
    )


# --- the 3x3 matrix ----------------------------------------------------------

@pytest.mark.parametrize("writer_name", list(WRITERS))
@pytest.mark.parametrize("reader_name", list(READERS))
def test_interchange(writer_name: str, reader_name: str, entry):
    service, name = entry
    val = secrets.token_hex(16)

    WRITERS[writer_name](service, name, val)
    got = READERS[reader_name](service, name)

    assert got == val, (
        f"write({writer_name}) -> read({reader_name}) round-trip failed: "
        f"expected {val!r}, got {got!r}"
    )


def test_get_absent_returns_none_or_empty():
    """Sanity: reading a never-set entry yields None / empty via every reader."""
    service = f"flow-rs-test-{uuid.uuid4().hex[:12]}"
    name = "never-set"

    assert _read_py_keyring(service, name) is None
    assert _read_flow_rs_bind(service, name) is None
    assert _read_flow_rs_cli(service, name) is None
