"""The browsers installed on THIS machine, their profiles, and opening a URL in one.

Backs the terminal link menu's "Open in ▸" submenu. Both halves have to run on
the backend: a web page (Electron included) can neither enumerate browser
profiles nor pick one to open a link in.

Cross-platform by data, not by branches: ``CATALOG`` says where each browser
keeps its profile list and how it is launched on macOS / Windows / Linux; the
code only knows the two profile-list formats (Chromium's ``Local State`` JSON,
Firefox's ``profiles.ini``) and the three launch shapes.

A browser is listed only when BOTH its profile list and its executable are
found — a ``Local State`` left behind by an uninstalled browser offers nothing.
Nothing is cached: the files are a few KB and a profile added a minute ago
should show up on the next right-click.
"""

from __future__ import annotations

import configparser
import json
import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import urlsplit

from flow_sdk.schema.data_spec.spec import DataSpec

logger = logging.getLogger(__name__)

OsName = Literal["mac", "windows", "linux"]
# The system-wide app folder; ~/Applications is tried after it.
MAC_APPLICATIONS = Path("/Applications")
BrowserKind = Literal["chromium", "firefox"]


class BrowserDef(DataSpec):
    """One catalog row. Paths are relative to the per-OS base named in the field."""

    id: str
    name: str
    kind: BrowserKind
    # macOS: the .app name (looked up in /Applications and ~/Applications) and
    # the profile root under ~/Library/Application Support.
    mac_app: str
    mac_roots: tuple[str, ...]
    # Windows: the App Paths registry key, then install paths tried under
    # %PROGRAMFILES%, %PROGRAMFILES(X86)% and %LOCALAPPDATA%; profile roots under
    # %LOCALAPPDATA% (Chromium) or %APPDATA% (Firefox).
    win_app_path_key: Optional[str]
    win_exes: tuple[str, ...]
    win_roots: tuple[str, ...]
    # Linux: executables looked up on PATH; profile roots under $HOME (distro
    # packages, then snap and flatpak, which keep their profiles elsewhere).
    linux_bins: tuple[str, ...]
    linux_roots: tuple[str, ...]


CATALOG: tuple[BrowserDef, ...] = (
    BrowserDef(
        id="chrome",
        name="Google Chrome",
        kind="chromium",
        mac_app="Google Chrome",
        mac_roots=("Google/Chrome",),
        win_app_path_key="chrome.exe",
        win_exes=("Google/Chrome/Application/chrome.exe",),
        win_roots=("Google/Chrome/User Data",),
        linux_bins=("google-chrome", "google-chrome-stable"),
        linux_roots=(".config/google-chrome", ".var/app/com.google.Chrome/config/google-chrome"),
    ),
    BrowserDef(
        id="edge",
        name="Microsoft Edge",
        kind="chromium",
        mac_app="Microsoft Edge",
        mac_roots=("Microsoft Edge",),
        win_app_path_key="msedge.exe",
        win_exes=("Microsoft/Edge/Application/msedge.exe",),
        win_roots=("Microsoft/Edge/User Data",),
        linux_bins=("microsoft-edge", "microsoft-edge-stable"),
        linux_roots=(".config/microsoft-edge", ".var/app/com.microsoft.Edge/config/microsoft-edge"),
    ),
    BrowserDef(
        id="brave",
        name="Brave",
        kind="chromium",
        mac_app="Brave Browser",
        mac_roots=("BraveSoftware/Brave-Browser",),
        win_app_path_key="brave.exe",
        win_exes=("BraveSoftware/Brave-Browser/Application/brave.exe",),
        win_roots=("BraveSoftware/Brave-Browser/User Data",),
        linux_bins=("brave-browser", "brave"),
        linux_roots=(
            ".config/BraveSoftware/Brave-Browser",
            ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser",
            "snap/brave/current/.config/BraveSoftware/Brave-Browser",
        ),
    ),
    BrowserDef(
        id="chromium",
        name="Chromium",
        kind="chromium",
        mac_app="Chromium",
        mac_roots=("Chromium",),
        # Chromium's exe is also chrome.exe, so the App Paths key would name
        # Google Chrome — only the install path identifies it.
        win_app_path_key=None,
        win_exes=("Chromium/Application/chrome.exe",),
        win_roots=("Chromium/User Data",),
        linux_bins=("chromium", "chromium-browser"),
        linux_roots=(
            ".config/chromium",
            "snap/chromium/common/chromium",
            ".var/app/org.chromium.Chromium/config/chromium",
        ),
    ),
    BrowserDef(
        id="firefox",
        name="Firefox",
        kind="firefox",
        mac_app="Firefox",
        mac_roots=("Firefox",),
        win_app_path_key="firefox.exe",
        win_exes=("Mozilla Firefox/firefox.exe",),
        win_roots=("Mozilla/Firefox",),
        linux_bins=("firefox",),
        linux_roots=(
            ".mozilla/firefox",
            "snap/firefox/common/.mozilla/firefox",
            ".var/app/org.mozilla.firefox/.mozilla/firefox",
        ),
    ),
)


class BrowserProfile(DataSpec):
    """``id`` is what the launch names: the profile DIRECTORY for Chromium
    (``Profile 1``), the profile NAME for Firefox (``-P`` takes the name)."""

    id: str
    name: str
    email: Optional[str] = None


class Browser(DataSpec):
    id: str
    name: str
    profiles: list[BrowserProfile]


class BrowserProfiles(DataSpec):
    """``GET /api/v1/browser-profiles``."""

    browsers: list[Browser]


class OpenInProfileRequest(DataSpec):
    """``POST /api/v1/browser-profiles/open``."""

    browser: str
    profile: str
    url: str


class BrowserProfileError(Exception):
    """A refused open. ``code`` goes into the failure envelope."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def current_os() -> OsName:
    if sys.platform == "darwin":
        return "mac"
    if sys.platform == "win32":
        return "windows"
    return "linux"


# ---------------------------------------------------------------------------
# Profile lists
# ---------------------------------------------------------------------------


def _profile_roots(browser: BrowserDef, os_name: OsName) -> list[Path]:
    home = Path.home()
    if os_name == "mac":
        return [home / "Library/Application Support" / r for r in browser.mac_roots]
    if os_name == "windows":
        env = "APPDATA" if browser.kind == "firefox" else "LOCALAPPDATA"
        base = os.environ.get(env)
        return [Path(base) / r for r in browser.win_roots] if base else []
    return [home / r for r in browser.linux_roots]


def _profile_sort_key(profile: BrowserProfile) -> tuple[int, int, str]:
    # Chromium's own order: Default, then Profile 1, 2, … 10 numerically.
    if profile.id == "Default":
        return (0, 0, "")
    head, _, num = profile.id.rpartition(" ")
    return (1, int(num), head) if num.isdigit() else (2, 0, profile.id)


def read_chromium_profiles(root: Path) -> list[BrowserProfile]:
    """``<root>/Local State`` → ``profile.info_cache``; ``[]`` when absent or unreadable."""
    try:
        state = json.loads((root / "Local State").read_text(encoding="utf-8"))
        cache = state["profile"]["info_cache"]
    except FileNotFoundError:
        return []
    except (OSError, ValueError, KeyError, TypeError) as exc:
        logger.warning("browser_profiles: unreadable %s: %s", root / "Local State", exc)
        return []
    if not isinstance(cache, dict):
        return []
    profiles = [
        BrowserProfile(id=d, name=str(info.get("name") or d), email=info.get("user_name") or None)
        for d, info in cache.items()
        if isinstance(info, dict)
    ]
    return sorted(profiles, key=_profile_sort_key)


def read_firefox_profiles(root: Path) -> list[BrowserProfile]:
    """``<root>/profiles.ini`` → one profile per ``[ProfileN]`` section."""
    ini = root / "profiles.ini"
    if not ini.is_file():
        return []
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(ini, encoding="utf-8")
    except (OSError, configparser.Error) as exc:
        logger.warning("browser_profiles: unreadable %s: %s", ini, exc)
        return []
    return [
        BrowserProfile(id=parser[s]["Name"], name=parser[s]["Name"])
        for s in parser.sections()
        if s.startswith("Profile") and parser[s].get("Name")
    ]


def _read_profiles(browser: BrowserDef, os_name: OsName) -> list[BrowserProfile]:
    read = read_firefox_profiles if browser.kind == "firefox" else read_chromium_profiles
    for root in _profile_roots(browser, os_name):
        if profiles := read(root):
            return profiles
    return []


# ---------------------------------------------------------------------------
# Executables
# ---------------------------------------------------------------------------


def _windows_app_path(key: str) -> Optional[str]:
    """The registry's ``App Paths\\<exe>`` default value (HKCU, then HKLM)."""
    import winreg  # noqa: PLC0415 — Windows-only module

    sub = rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{key}"
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, sub) as k:
                value, _ = winreg.QueryValueEx(k, "")
        except OSError:
            continue
        if value:
            return str(value).strip('"')
    return None


def find_executable(browser: BrowserDef, os_name: OsName) -> Optional[str]:
    """What the launch runs: the ``.app`` path on macOS, the executable elsewhere."""
    if os_name == "mac":
        for apps in (MAC_APPLICATIONS, Path.home() / "Applications"):
            app = apps / f"{browser.mac_app}.app"
            if app.is_dir():
                return str(app)
        return None
    if os_name == "windows":
        if browser.win_app_path_key:
            found = _windows_app_path(browser.win_app_path_key)
            if found and Path(found).is_file():
                return found
        for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            base = os.environ.get(env)
            for rel in browser.win_exes if base else ():
                exe = Path(base) / rel
                if exe.is_file():
                    return str(exe)
        return None
    for name in browser.linux_bins:
        if found := shutil.which(name):
            return found
    return None


# ---------------------------------------------------------------------------
# The two verbs
# ---------------------------------------------------------------------------


def list_browser_profiles() -> BrowserProfiles:
    os_name = current_os()
    browsers = []
    for browser in CATALOG:
        profiles = _read_profiles(browser, os_name)
        if profiles and find_executable(browser, os_name):
            browsers.append(Browser(id=browser.id, name=browser.name, profiles=profiles))
    return BrowserProfiles(browsers=browsers)


def launch_argv(browser: BrowserDef, target: str, profile_id: str, url: str, os_name: OsName) -> list[str]:
    """The command line, as a list — never a shell string, so a URL is one argument whatever it contains."""
    if browser.kind == "firefox":
        args = ["-P", profile_id, "-new-tab", url]
    else:
        args = [f"--profile-directory={profile_id}", url]
    if os_name == "mac":
        # -n: without it `open` hands the args to nothing when the app is
        # already running; with it the browser forwards them to its live window.
        return ["open", "-na", target, "--args", *args]
    return [target, *args]


def _check_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc or any(c.isspace() for c in url):
        raise BrowserProfileError("BAD_URL", f"only http(s) links open in a browser profile: {url!r}")


def open_in_profile(req: OpenInProfileRequest) -> list[str]:
    """Open ``req.url`` in that browser's profile; returns the argv it ran.

    Everything the request names is checked against what is on disk NOW: the
    browser must be in the catalog and installed, the profile in its current list.
    """
    from flow_sdk.server.launch import start_detached_process  # noqa: PLC0415 — keeps core free of server at import

    _check_url(req.url)
    browser = next((b for b in CATALOG if b.id == req.browser), None)
    if browser is None:
        raise BrowserProfileError("UNKNOWN_BROWSER", f"unknown browser: {req.browser!r}")
    os_name = current_os()
    target = find_executable(browser, os_name)
    if target is None:
        raise BrowserProfileError("NOT_INSTALLED", f"{browser.name} is not installed")
    if req.profile not in {p.id for p in _read_profiles(browser, os_name)}:
        raise BrowserProfileError("UNKNOWN_PROFILE", f"{browser.name} has no profile {req.profile!r}")
    argv = launch_argv(browser, target, req.profile, req.url, os_name)
    logger.info("browser_profiles: open %s profile=%s", browser.id, req.profile)
    start_detached_process(argv)
    return argv
