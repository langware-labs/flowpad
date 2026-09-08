"""The discovered capability dir outranks the service PATH — but not the flow pin.

Two PATH requirements collide at spawn time:

* the DISCOVERED vendor bin folder must beat the service PATH, or spawn fails
  with "codex not found despite discovery" (D02);
* this backend's venv bin dir must stay first, because that is the whole
  version-skew guard — workers shell out to ``flow`` (record/show/context) and
  a globally installed older ``flow`` silently breaks worker↔backend contracts.

They collide because vendor bin folders are routinely SHARED directories
(``~/.local/bin``) that carry their own ``flow``. Prepending the vendor folder
unconditionally therefore defeated the guard exactly where it matters.

``insert_capability_path_dir`` resolves it by ordering rather than choosing:
venv pin first, capability folder immediately behind it, service PATH after.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    insert_capability_path_dir,
    prepend_path_dir,
)

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(5)

SEP = os.pathsep
VENV_BIN = str(Path(sys.executable).parent)
FLOW_EXE = "flow.exe" if sys.platform == "win32" else "flow"
HAS_PIN = (Path(VENV_BIN) / FLOW_EXE).exists()

pin_only = pytest.mark.skipif(not HAS_PIN, reason="no `flow` beside this interpreter — nothing to pin")


def test_no_pin_present_behaves_exactly_like_prepend():
    """Without the venv pin first there is nothing to protect."""
    path = SEP.join(["/usr/bin", "/bin"])
    assert insert_capability_path_dir("/opt/vendor/bin", path) == prepend_path_dir("/opt/vendor/bin", path)


def test_empty_path_yields_the_folder():
    assert insert_capability_path_dir("/opt/vendor/bin", "") == "/opt/vendor/bin"
    assert insert_capability_path_dir("/opt/vendor/bin", None) == "/opt/vendor/bin"


def test_already_first_is_left_alone():
    path = SEP.join(["/opt/vendor/bin", "/usr/bin"])
    assert insert_capability_path_dir("/opt/vendor/bin", path) == path


@pin_only
def test_capability_dir_lands_behind_the_venv_pin():
    """The regression: the vendor dir must NOT displace the pin."""
    path = SEP.join([VENV_BIN, "/usr/bin", "/bin"])
    result = insert_capability_path_dir("/opt/vendor/bin", path).split(SEP)

    assert result[0] == VENV_BIN, "the venv `flow` pin must stay first"
    assert result[1] == "/opt/vendor/bin", "the capability dir must still beat the service PATH"
    assert result[2:] == ["/usr/bin", "/bin"]


@pin_only
def test_a_vendor_dir_that_ships_its_own_flow_cannot_win():
    """The concrete failure: a shared bin dir carrying `flow`.

    ``prepend_path_dir`` put it first, so the worker's ``flow`` resolved to the
    vendor copy instead of this backend's — the version skew the pin exists to
    prevent.
    """
    shared_dir = str(Path.home() / ".local" / "bin")
    path = SEP.join([VENV_BIN, "/usr/bin"])

    assert prepend_path_dir(shared_dir, path).split(SEP)[0] == shared_dir  # the old behaviour
    assert insert_capability_path_dir(shared_dir, path).split(SEP)[0] == VENV_BIN


@pin_only
def test_idempotent_across_restarts():
    path = SEP.join([VENV_BIN, "/usr/bin"])
    once = insert_capability_path_dir("/opt/vendor/bin", path)
    assert insert_capability_path_dir("/opt/vendor/bin", once) == once
