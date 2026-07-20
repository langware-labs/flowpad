"""cookie-gate secret store — get/set, and the caching that makes an
every-request check free."""

from __future__ import annotations

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
def test_value_is_cached(sod_env, stored):
    """Absence is cached too — it is the common case (every desktop install), and
    an uncached miss would pay a decrypt-and-fail on every request. Guards the
    ``.get() is not None`` trap inherited from privacy_mode.py:46.
    """
    with patch.object(cookie_gate, "_read", return_value=stored) as read:
        assert cookie_gate.get_cookie_gate() == stored
        assert cookie_gate.get_cookie_gate() == stored
        assert cookie_gate.get_cookie_gate() == stored

    assert read.call_count == 1


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
