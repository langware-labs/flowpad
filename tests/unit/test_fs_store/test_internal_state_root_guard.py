"""Guard: Flowpad's own state dir must never become a folder-walk root.

Sibling of ``test_real_project_cwd_home_guard``. That one covers a root at or
ABOVE ``$HOME``; this covers the state directory BELOW it, which an ancestor
check lets straight through.

``<flow_home>/instances/<name>/`` holds per-instance DBs and a ``records/``
shadow tree — one directory per indexed record. Registered as a project root it
makes the indexer walk its own output, and it compounds: every launched
instance adds a root, and each grows with use. Measured on one machine: 21 such
roots contributed 155,914 of 166,310 walked folders (94%), turning a ~2s skill
discovery into ~25s and timing out the per-type index test.

The root is read from ``InstanceSettings.flow_home`` (never a literal), so a
relocated ``FLOW_HOME`` is covered, and containment goes through the shared
``canonical_posix_path`` + ``is_path_under`` pair so the answer is the same on
Windows and on case-insensitive/NFD macOS volumes.
"""

from __future__ import annotations

import pytest

from flow_sdk.fs_store.indexer.roots import is_internal_state_path
from flow_sdk.instance_settings import get_instance_settings


def _flow_home() -> str:
    return str(get_instance_settings().flow_home)


@pytest.mark.parametrize(
    ("suffix", "expected"),
    [
        ("", True),                          # flow_home itself
        ("/instances", True),                # the instances dir
        ("/instances/oss", True),            # one instance root
        ("/instances/oss/records/project", True),  # deep inside the shadow tree
        ("/capability-probes", True),        # other internal state
    ],
)
def test_paths_inside_flow_home_are_internal(suffix, expected):
    assert is_internal_state_path(_flow_home() + suffix) is expected


def test_a_sibling_with_a_shared_prefix_is_not_internal():
    """Segment-safe: ``<flow_home>data`` must not read as inside ``<flow_home>``.

    A naive ``startswith`` would swallow it. This is why the check goes through
    ``is_path_under`` rather than comparing strings here.
    """
    assert is_internal_state_path(_flow_home() + "data") is False


def test_a_real_project_is_not_internal(tmp_path):
    project = tmp_path / "dev" / "repo"
    project.mkdir(parents=True)
    assert is_internal_state_path(project) is False


def test_the_guard_follows_a_relocated_flow_home(tmp_path, monkeypatch):
    """No literal ``~/.flow`` anywhere: point FLOW_HOME elsewhere and the guard
    moves with it — which is also what keeps sandboxed test instances covered."""
    relocated = tmp_path / "elsewhere" / "flowhome"
    (relocated / "instances" / "inst").mkdir(parents=True)
    monkeypatch.setenv("FLOW_HOME", str(relocated))

    from flow_sdk.instance_settings import get_instance_settings as _gs

    if str(_gs().flow_home) != str(relocated):
        pytest.skip("FLOW_HOME is resolved/cached elsewhere in this process")
    assert is_internal_state_path(relocated / "instances" / "inst") is True
