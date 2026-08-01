"""Runtime kind — the consolidation, the assignment gate, and the one property
that makes the whole design work: it is resolved PER REQUEST, so a single local
server answers ``desktop`` to the Electron shell and ``browser`` to a browser
tab at the same moment."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from flow_sdk.instance_settings import runtime
from flow_sdk.models.bootstrap_models import RuntimeKind

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _clear_cache():
    """Clear before AND after — an assignment leaked from one test would make the
    next one's `desktop`/`browser` expectations silently wrong."""
    runtime.reset_cache()
    yield
    runtime.reset_cache()


@pytest.fixture
def _no_assignment():
    """A plain local install: nothing was ever written to config.json."""
    with patch.object(runtime.app_config, "get_config", return_value=None):
        yield


# ---------------------------------------------------------------------------
# Consolidation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "assigned,electron,expected",
    [
        (None, True, RuntimeKind.DESKTOP),
        (None, False, RuntimeKind.BROWSER),
        # An assignment wins over the local signal in BOTH directions: the hub
        # knows it launched us into a box, and we cannot tell from the inside.
        (RuntimeKind.SANDBOX, False, RuntimeKind.SANDBOX),
        (RuntimeKind.SANDBOX, True, RuntimeKind.SANDBOX),
        (RuntimeKind.AGENT, False, RuntimeKind.AGENT),
        (RuntimeKind.AGENT, True, RuntimeKind.AGENT),
    ],
)
def test_resolve_runtime_truth_table(assigned, electron, expected):
    with patch.object(runtime, "get_assigned_runtime", return_value=assigned):
        info = runtime.resolve_runtime(electron=electron)

    assert info.kind == expected
    # The inputs survive onto the object so the answer is inspectable from a
    # bootstrap payload rather than being an enum with no provenance.
    assert info.assigned == assigned
    assert info.electron is electron
    assert info.host == "local"


def test_electron_is_per_call_not_sticky(_no_assignment):
    """The property the whole per-request design rests on: asking twice with
    different flags must give different answers, in either order."""
    assert runtime.resolve_runtime(electron=True).kind == RuntimeKind.DESKTOP
    assert runtime.resolve_runtime(electron=False).kind == RuntimeKind.BROWSER
    assert runtime.resolve_runtime(electron=True).kind == RuntimeKind.DESKTOP


# ---------------------------------------------------------------------------
# The assignment gate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", [RuntimeKind.SANDBOX, RuntimeKind.AGENT])
def test_assignable_kinds_round_trip(kind):
    stored: dict = {}
    with (
        patch.object(runtime.app_config, "set_config", lambda k, v: stored.update({k: v})),
        patch.object(runtime.app_config, "get_config", lambda k, default=None: stored.get(k, default)),
    ):
        assert runtime.set_assigned_runtime(kind) == kind
        runtime.reset_cache()
        assert runtime.get_assigned_runtime() == kind


@pytest.mark.parametrize("kind", [RuntimeKind.DESKTOP, RuntimeKind.BROWSER, RuntimeKind.HUB])
def test_hub_cannot_assign_a_local_or_hub_kind(kind):
    """`desktop`/`browser` are decided per request from the electron flag, and
    `hub` is what the hub's own bootstrap returns — an instance can never be
    TOLD it is one of those."""
    with pytest.raises(ValueError):
        runtime.set_assigned_runtime(kind)


def test_unknown_assignment_is_rejected():
    with pytest.raises(ValueError):
        runtime.set_assigned_runtime("not-a-runtime")


@pytest.mark.parametrize("stored", ["not-a-runtime", "desktop", ""])
def test_unreadable_stored_value_degrades_to_no_assignment(stored):
    """A config written by a newer (or buggier) build must not brick bootstrap:
    an unknown or non-assignable value reads as "no assignment", not an error."""
    with patch.object(runtime.app_config, "get_config", return_value=stored):
        assert runtime.get_assigned_runtime() is None
        assert runtime.resolve_runtime(electron=False).kind == RuntimeKind.BROWSER
