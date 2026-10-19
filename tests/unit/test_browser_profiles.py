"""Browser profiles for the terminal link menu: discovery and launch on all three OSes.

Hermetic: every test builds a fake home (and fake %LOCALAPPDATA% / %APPDATA% /
Program Files) under ``tmp_path`` and pins the OS, so the macOS, Windows and
Linux paths are all exercised on whatever machine runs the suite. The launch is
captured at ``start_detached_process`` — the argv is the contract; whether the
OS then opens the right window is the manual per-OS check in the plan.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.core import browser_profiles as bp

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

LOCAL_STATE = {
    "profile": {
        "info_cache": {
            "Profile 10": {"name": "Ten", "user_name": ""},
            "Profile 2": {"name": "Work", "user_name": "me@work.test"},
            "Default": {"name": "Personal", "user_name": "me@home.test"},
        }
    }
}

PROFILES_INI = """\
[Install4F96D1932A9F858E]
Default=abc.default-release

[Profile1]
Name=dev-edition
Path=xyz.dev
IsRelative=1

[Profile0]
Name=default-release
Path=abc.default-release
IsRelative=1
Default=1

[General]
StartWithLastProfile=1
"""


def _local_state(root: Path, state: dict = LOCAL_STATE) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "Local State").write_text(json.dumps(state), encoding="utf-8")


def _profiles_ini(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "profiles.ini").write_text(PROFILES_INI, encoding="utf-8")


def _touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("")
    return path


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setattr(bp, "MAC_APPLICATIONS", tmp_path / "Applications")
    return home


@pytest.fixture
def launched(monkeypatch):
    calls: list[list[str]] = []
    import flow_sdk.server.launch as launch

    monkeypatch.setattr(launch, "start_detached_process", lambda argv, **kw: calls.append(argv))
    return calls


def _as(monkeypatch, os_name: str) -> None:
    monkeypatch.setattr(bp, "current_os", lambda: os_name)


def _listed(result: bp.BrowserProfiles) -> dict[str, list[tuple[str, str, str | None]]]:
    return {b.id: [(p.id, p.name, p.email) for p in b.profiles] for b in result.browsers}


CHROME_PROFILES = [
    ("Default", "Personal", "me@home.test"),
    ("Profile 2", "Work", "me@work.test"),
    ("Profile 10", "Ten", None),
]
FIREFOX_PROFILES = [("dev-edition", "dev-edition", None), ("default-release", "default-release", None)]


# ── macOS ────────────────────────────────────────────────────────────────────


@pytest.fixture
def mac(home, tmp_path, monkeypatch):
    _as(monkeypatch, "mac")
    support = home / "Library/Application Support"
    _local_state(support / "Google/Chrome")
    (tmp_path / "Applications/Google Chrome.app").mkdir(parents=True)
    _profiles_ini(support / "Firefox")
    (home / "Applications/Firefox.app").mkdir(parents=True)  # the per-user folder counts too
    _local_state(support / "Microsoft Edge")  # left behind: no Microsoft Edge.app
    return tmp_path


def test_mac_lists_installed_browsers_in_chromium_order(mac):
    assert _listed(bp.list_browser_profiles()) == {"chrome": CHROME_PROFILES, "firefox": FIREFOX_PROFILES}


def test_mac_launch_goes_through_open_with_new_instance(mac, launched):
    bp.open_in_profile(bp.OpenInProfileRequest(browser="chrome", profile="Profile 2", url="https://a.test/x?q=1&r=2"))
    bp.open_in_profile(bp.OpenInProfileRequest(browser="firefox", profile="dev-edition", url="http://b.test/"))
    assert launched == [
        ["open", "-na", str(mac / "Applications/Google Chrome.app"), "--args",
         "--profile-directory=Profile 2", "https://a.test/x?q=1&r=2"],
        ["open", "-na", str(mac / "home/Applications/Firefox.app"), "--args",
         "-P", "dev-edition", "-new-tab", "http://b.test/"],
    ]


# ── Windows ──────────────────────────────────────────────────────────────────


@pytest.fixture
def windows(home, tmp_path, monkeypatch):
    _as(monkeypatch, "windows")
    local, roaming, pf, pf86 = (tmp_path / n for n in ("Local", "Roaming", "PF", "PF86"))
    for env, path in (("LOCALAPPDATA", local), ("APPDATA", roaming), ("PROGRAMFILES", pf), ("PROGRAMFILES(X86)", pf86)):
        monkeypatch.setenv(env, str(path))
    registry = {"msedge.exe": str(_touch(tmp_path / "Edge/msedge.exe"))}
    monkeypatch.setattr(bp, "_windows_app_path", lambda key: registry.get(key))

    _local_state(local / "Google/Chrome/User Data")
    _touch(pf / "Google/Chrome/Application/chrome.exe")  # no App Paths entry: install-path fallback
    _local_state(local / "Microsoft/Edge/User Data")  # found through the registry
    _local_state(local / "Chromium/User Data")
    _touch(local / "Chromium/Application/chrome.exe")  # per-user install
    _profiles_ini(roaming / "Mozilla/Firefox")
    _touch(pf86 / "Mozilla Firefox/firefox.exe")
    _local_state(local / "BraveSoftware/Brave-Browser/User Data")  # not installed
    return tmp_path


def test_windows_finds_executables_by_registry_then_install_paths(windows):
    listed = _listed(bp.list_browser_profiles())
    assert list(listed) == ["chrome", "edge", "chromium", "firefox"]
    assert listed["firefox"] == FIREFOX_PROFILES


def test_windows_runs_the_executable_directly(windows, launched):
    url = "https://a.test/?a=1&b=2^|<x>"  # cmd metacharacters: harmless without a shell
    bp.open_in_profile(bp.OpenInProfileRequest(browser="edge", profile="Default", url=url))
    bp.open_in_profile(bp.OpenInProfileRequest(browser="chromium", profile="Profile 10", url=url))
    assert launched == [
        [str(windows / "Edge/msedge.exe"), "--profile-directory=Default", url],
        [str(windows / "Local/Chromium/Application/chrome.exe"), "--profile-directory=Profile 10", url],
    ]


def test_windows_without_localappdata_lists_nothing(windows, monkeypatch):
    monkeypatch.delenv("LOCALAPPDATA")
    assert list(_listed(bp.list_browser_profiles())) == ["firefox"]


# ── Linux ────────────────────────────────────────────────────────────────────


@pytest.fixture
def linux(home, tmp_path, monkeypatch):
    _as(monkeypatch, "linux")
    bins = {"google-chrome-stable": "/usr/bin/google-chrome-stable", "chromium": "/snap/bin/chromium",
            "firefox": "/usr/bin/firefox"}
    monkeypatch.setattr(bp.shutil, "which", lambda name: bins.get(name))
    _local_state(home / ".var/app/com.google.Chrome/config/google-chrome")  # flatpak
    _local_state(home / "snap/chromium/common/chromium")  # snap
    _profiles_ini(home / "snap/firefox/common/.mozilla/firefox")
    _local_state(home / ".config/microsoft-edge")  # no binary
    return home


def test_linux_finds_snap_and_flatpak_profiles(linux):
    listed = _listed(bp.list_browser_profiles())
    assert listed == {"chrome": CHROME_PROFILES, "chromium": CHROME_PROFILES, "firefox": FIREFOX_PROFILES}


def test_linux_prefers_the_distro_profile_root(linux):
    _local_state(linux / ".config/google-chrome", {"profile": {"info_cache": {"Default": {"name": "Distro"}}}})
    assert _listed(bp.list_browser_profiles())["chrome"] == [("Default", "Distro", None)]


def test_linux_runs_the_binary_from_path(linux, launched):
    bp.open_in_profile(bp.OpenInProfileRequest(browser="chrome", profile="Default", url="https://a.test"))
    bp.open_in_profile(bp.OpenInProfileRequest(browser="firefox", profile="default-release", url="https://a.test"))
    assert launched == [
        ["/usr/bin/google-chrome-stable", "--profile-directory=Default", "https://a.test"],
        ["/usr/bin/firefox", "-P", "default-release", "-new-tab", "https://a.test"],
    ]


# ── what a profile list tolerates ────────────────────────────────────────────


@pytest.mark.parametrize(
    "content",
    ["{not json", json.dumps({"profile": {}}), json.dumps({"profile": {"info_cache": []}}), json.dumps([1])],
)
def test_malformed_local_state_lists_no_profiles(tmp_path, content):
    (tmp_path / "Local State").write_text(content, encoding="utf-8")
    assert bp.read_chromium_profiles(tmp_path) == []


def test_malformed_profiles_ini_lists_no_profiles(tmp_path):
    (tmp_path / "profiles.ini").write_text("no section header\n", encoding="utf-8")
    assert bp.read_firefox_profiles(tmp_path) == []


# ── refusals ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("browser", "profile", "url", "code"),
    [
        ("chrome", "Default", "file:///etc/passwd", "BAD_URL"),
        ("chrome", "Default", "javascript:alert(1)", "BAD_URL"),
        ("chrome", "Default", "--disable-web-security", "BAD_URL"),
        ("chrome", "Default", "https://a.test --headless", "BAD_URL"),
        ("chrome", "Default", "https://", "BAD_URL"),
        ("netscape", "Default", "https://a.test", "UNKNOWN_BROWSER"),
        ("chrome", "Profile 99", "https://a.test", "UNKNOWN_PROFILE"),
        ("chrome", "--user-data-dir=/tmp/x", "https://a.test", "UNKNOWN_PROFILE"),
        ("edge", "Default", "https://a.test", "NOT_INSTALLED"),
    ],
)
def test_refused_opens_launch_nothing(mac, launched, browser, profile, url, code):
    with pytest.raises(bp.BrowserProfileError) as err:
        bp.open_in_profile(bp.OpenInProfileRequest(browser=browser, profile=profile, url=url))
    assert err.value.code == code
    assert launched == []


# ── routes ───────────────────────────────────────────────────────────────────


def _client(monkeypatch, assigned=None):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from flow_sdk.server.routes import browser_profiles as route

    monkeypatch.setattr(route, "get_assigned_runtime", lambda: assigned)
    app = FastAPI()
    app.include_router(route.router)
    return TestClient(app)


def test_route_lists_and_opens(mac, launched, monkeypatch):
    client = _client(monkeypatch)
    body = client.get("/api/v1/browser-profiles").json()
    assert body["status"] == "SUCCESS"
    assert [b["id"] for b in body["data"]["browsers"]] == ["chrome", "firefox"]
    assert body["data"]["browsers"][0]["profiles"][1] == {"id": "Profile 2", "name": "Work", "email": "me@work.test"}

    ok = client.post("/api/v1/browser-profiles/open", json={"browser": "chrome", "profile": "Default", "url": "https://a.test"})
    assert ok.json()["data"] == {"opened": True}
    assert len(launched) == 1


def test_route_reports_a_refusal_code(mac, launched, monkeypatch):
    resp = _client(monkeypatch).post(
        "/api/v1/browser-profiles/open", json={"browser": "chrome", "profile": "Default", "url": "file:///x"}
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["status"] == "FAIL"
    assert body["data"]["error_code"] == "BAD_URL"


def test_route_refuses_off_the_users_machine(mac, launched, monkeypatch):
    from flow_sdk.models.bootstrap_models import RuntimeKind

    client = _client(monkeypatch, assigned=RuntimeKind.SANDBOX)
    for resp in (
        client.get("/api/v1/browser-profiles"),
        client.post("/api/v1/browser-profiles/open", json={"browser": "chrome", "profile": "Default", "url": "https://a.test"}),
    ):
        assert resp.status_code == 403
        assert resp.json()["data"]["error_code"] == "NOT_LOCAL"
    assert launched == []
