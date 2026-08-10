"""cookie-gate secret store — get/set, and the caching that makes an
every-request check free."""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from flow_sdk.instance_settings import cookie_gate
from flow_sdk.instance_settings.base_settings import SecretsNotEnabledError

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _clear_cache():
    """Clear before AND after: restoring only at the end leaves the first test
    after a leak seeing polluted state (tests/api/conftest.py:107-110)."""
    cookie_gate.reset_cache()
    yield
    cookie_gate.reset_cache()


def _arm_marker(settings):
    """Arm the marker without writing the sod, so the sod read is reached and its
    failure mode is what's actually under test."""
    settings.instance_dir.mkdir(parents=True, exist_ok=True)
    settings.cookie_gate_marker_path.touch()


def _fake_settings(mock, settings, *, armed: bool):
    """Point a patched get_instance_settings at a real instance dir, so only the
    sod is a mock."""
    mock.return_value.instance_name = settings.instance_name
    mock.return_value.instance_dir = settings.instance_dir
    marker = settings.cookie_gate_marker_path
    if armed:
        _arm_marker(settings)
    mock.return_value.cookie_gate_marker_path = marker


# ---------------------------------------------------------------------------
# Unarmed
# ---------------------------------------------------------------------------


def test_unset_instance_is_not_gated(sod_env):
    assert cookie_gate.get_cookie_gate() is None
    assert cookie_gate.is_gated() is False


def test_unarmed_never_touches_the_sod(sod_env):
    """Load-bearing, not a micro-optimization.

    Decrypting the sod fetches the Fernet key, which on a normal install means an
    OS keychain prompt (file_sod._cipher). ``sod.read`` only short-circuits when
    the sodot file is absent, and a logged-in instance always has one — so
    consulting the sod to learn we are ungated would prompt the keychain on the
    first HTTP request after every restart, on desktop installs that are never
    gated. The armed-marker stat() is what prevents that.
    """
    with patch.object(cookie_gate, "get_instance_settings") as settings:
        _fake_settings(settings, sod_env, armed=False)

        assert cookie_gate.get_cookie_gate() is None
        settings.return_value.sod.read.assert_not_called()


# ---------------------------------------------------------------------------
# Arming
# ---------------------------------------------------------------------------


def test_set_then_get_roundtrip(sod_env):
    cookie_gate.set_cookie_gate("s3cret")

    assert cookie_gate.get_cookie_gate() == "s3cret"
    assert cookie_gate.is_gated() is True


def test_set_writes_the_marker(sod_env):
    assert not sod_env.cookie_gate_marker_path.exists()

    cookie_gate.set_cookie_gate("s3cret")

    assert sod_env.cookie_gate_marker_path.exists()


def test_marker_is_not_world_readable(sod_env):
    """0600 to match every other artifact in instance_dir. It holds no secret,
    but a lone 0644 among 0600 siblings is an exception that needs a reason."""
    cookie_gate.set_cookie_gate("s3cret")

    assert sod_env.cookie_gate_marker_path.stat().st_mode & 0o077 == 0


def test_set_survives_a_cache_drop(sod_env):
    """The value is persisted, not just memoized."""
    cookie_gate.set_cookie_gate("s3cret")
    cookie_gate.reset_cache()

    assert cookie_gate.get_cookie_gate() == "s3cret"


def test_set_rejects_empty(sod_env):
    """Storing "" would read back as unset — open while looking locked."""
    with pytest.raises(ValueError):
        cookie_gate.set_cookie_gate("")

    assert cookie_gate.is_gated() is False


def test_armed_marker_alone_does_not_gate(sod_env):
    """Marker present but no secret in the sod → ungated. Never a gate with
    nothing to compare against."""
    _arm_marker(sod_env)

    assert cookie_gate.get_cookie_gate() is None


# ---------------------------------------------------------------------------
# Caching
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("stored", [None, "s3cret"])
def test_value_is_cached_while_the_marker_holds_still(sod_env, stored):
    """A steady-state gated instance decrypts ONCE, not once per request.

    Absence is cached too — a marker present with nothing behind it would
    otherwise pay a decrypt-and-fail on every request. Guards the
    ``.get() is not None`` trap inherited from privacy_mode.py:46.
    """
    _arm_marker(sod_env)

    with patch.object(cookie_gate, "_read", return_value=stored) as read:
        assert cookie_gate.get_cookie_gate() == stored
        assert cookie_gate.get_cookie_gate() == stored
        assert cookie_gate.get_cookie_gate() == stored

    assert read.call_count == 1


def test_a_secret_rotated_by_another_process_is_seen_without_a_restart(sod_env):
    """The load-bearing half of the mtime key.

    The hub arms and rotates the gate with `flow auth set-cookie-gate`, which is
    a DIFFERENT process. Caching the answer outright meant this one kept serving
    a value the file no longer held — enforcing the wrong secret, or nothing at
    all, until it restarted. That window is exactly the one the gate exists to
    close.
    """
    cookie_gate.set_cookie_gate("first")
    assert cookie_gate.get_cookie_gate() == "first"

    # What the other process does: rewrite the secret, re-touch the marker.
    # utime rather than a bare touch — the two writes can land inside one
    # filesystem timestamp tick, and then the test proves nothing.
    marker = sod_env.cookie_gate_marker_path
    sod_env.sod.write("cookie_gate", "second")
    bumped = marker.stat().st_mtime + 5
    os.utime(marker, (bumped, bumped))

    assert cookie_gate.get_cookie_gate() == "second"


# ---------------------------------------------------------------------------
# Clearing
# ---------------------------------------------------------------------------


def test_clear_disarms_the_instance(sod_env):
    cookie_gate.set_cookie_gate("s3cret")
    assert cookie_gate.is_gated() is True

    assert cookie_gate.clear_cookie_gate() is True

    assert cookie_gate.is_gated() is False
    assert not sod_env.cookie_gate_marker_path.exists()


def test_clear_takes_effect_in_this_process_immediately(sod_env):
    """No restart, and no ``reset_cache`` — a server that kept enforcing a gate
    whose marker is gone would be locked shut with no way back in."""
    cookie_gate.set_cookie_gate("s3cret")
    assert cookie_gate.get_cookie_gate() == "s3cret"

    cookie_gate.clear_cookie_gate()

    assert cookie_gate.get_cookie_gate() is None


def test_clear_on_an_unarmed_instance_reports_nothing_changed(sod_env):
    """So a caller can say "already open" instead of implying it did something."""
    assert cookie_gate.clear_cookie_gate() is False
    assert cookie_gate.is_gated() is False


def test_clear_removes_the_marker_before_the_secret(sod_env):
    """The EXACT reverse of arming, and for the same reason.

    Deleting the secret first leaves a window where the marker still says
    "armed" while the comparison value is gone — and ``_read`` resolves a
    missing secret to ``None``, i.e. it fails OPEN. Same end state, reached
    through a moment that looks locked and is not.
    """
    seen = {}

    with patch.object(cookie_gate, "get_instance_settings") as settings:
        _fake_settings(settings, sod_env, armed=True)
        settings.return_value.sod.delete.side_effect = lambda _name: seen.setdefault(
            "marker_still_there", sod_env.cookie_gate_marker_path.exists()
        )

        assert cookie_gate.clear_cookie_gate() is True

    assert seen["marker_still_there"] is False


def test_clear_leaves_the_instance_open_even_if_the_secret_will_not_delete(sod_env):
    """The marker is already gone by then, so the instance is open — which is the
    whole point of the call. An orphaned secret is inert: nothing reads it
    without a marker, and re-arming overwrites it."""
    with patch.object(cookie_gate, "get_instance_settings") as settings:
        _fake_settings(settings, sod_env, armed=True)
        settings.return_value.sod.delete.side_effect = RuntimeError("store is unwritable")

        assert cookie_gate.clear_cookie_gate() is True

    assert not sod_env.cookie_gate_marker_path.exists()


def test_set_populates_cache_without_a_reread(sod_env):
    cookie_gate.set_cookie_gate("s3cret")

    with patch.object(cookie_gate, "_read", side_effect=AssertionError("re-read")) as read:
        assert cookie_gate.get_cookie_gate() == "s3cret"

    read.assert_not_called()


def test_cache_is_keyed_per_instance(sod_env, tmp_path):
    """A process that switches FLOW_INSTANCE mid-run must not read another
    instance's secret."""
    cookie_gate.set_cookie_gate("instance-one-secret")
    assert cookie_gate.get_cookie_gate() == "instance-one-secret"

    with patch.object(cookie_gate, "get_instance_settings") as settings:
        settings.return_value.instance_name = "some-other-instance"
        settings.return_value.cookie_gate_marker_path = tmp_path / "other" / ".armed"

        assert cookie_gate.get_cookie_gate() is None

    assert cookie_gate.get_cookie_gate() == "instance-one-secret"


# ---------------------------------------------------------------------------
# Fail-open — deliberate; see docs/cookie-gate.md
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "boom",
    [
        # FLOWPAD_DESKTOP=1 before Electron seeds the sod key. Desktop is never
        # gated anyway, and bricking every request over a keychain handoff is the
        # worse failure.
        SecretsNotEnabledError("no key"),
        # A corrupt sod.
        ValueError("corrupt"),
    ],
)
def test_unreadable_sod_resolves_to_ungated(sod_env, boom):
    with patch.object(cookie_gate, "get_instance_settings") as settings:
        _fake_settings(settings, sod_env, armed=True)
        settings.return_value.sod.read.side_effect = boom

        assert cookie_gate.get_cookie_gate() is None
        assert cookie_gate.is_gated() is False
        settings.return_value.sod.read.assert_called_once()
