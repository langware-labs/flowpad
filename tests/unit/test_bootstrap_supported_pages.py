"""Unit tests for the dev-only hub/desktop page selection at bootstrap.

`_resolve_supported_pages` reads two preferences and decides which SPA page the
local desktop server advertises. The `hub` page is gated on Dev view mode so a
stale `app_page=hub` can never strand a non-dev user (the toggle that clears it
is dev-only). See flow_sdk/server/routes/bootstrap.py.
"""
import pytest

from flow_sdk.server.routes import bootstrap


@pytest.fixture
def fake_prefs(monkeypatch):
    """Back _resolve_supported_pages with an in-memory preferences dict."""
    prefs: dict[str, str] = {}

    def _read(key: str, default):
        return prefs.get(key, default)

    monkeypatch.setattr(bootstrap, "_read_pref", _read)
    return prefs


def test_default_is_desk(fake_prefs):
    # No preferences set at all → desktop page.
    assert bootstrap._resolve_supported_pages() == ["desk"]


def test_dev_plus_hub_serves_hub(fake_prefs):
    fake_prefs[bootstrap._VIEW_MODE_KEY] = "dev"
    fake_prefs[bootstrap._APP_PAGE_KEY] = "hub"
    assert bootstrap._resolve_supported_pages() == ["hub"]


def test_dev_plus_desk_serves_desk(fake_prefs):
    fake_prefs[bootstrap._VIEW_MODE_KEY] = "dev"
    fake_prefs[bootstrap._APP_PAGE_KEY] = "desk"
    assert bootstrap._resolve_supported_pages() == ["desk"]


@pytest.mark.parametrize("view_mode", ["vibe", "standard", "advanced"])
def test_hub_pref_ignored_outside_dev(fake_prefs, view_mode):
    # The gate: a stale app_page=hub must not take effect below Dev mode.
    fake_prefs[bootstrap._VIEW_MODE_KEY] = view_mode
    fake_prefs[bootstrap._APP_PAGE_KEY] = "hub"
    assert bootstrap._resolve_supported_pages() == ["desk"]
