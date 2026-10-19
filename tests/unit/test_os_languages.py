"""The OS-language probe feeding the footer's quick language switch.

Keyboard layouts count as languages the user uses: a Hebrew keyboard on an
English OS must surface ``he`` even though the display list says only English.
"""

import plistlib
import subprocess
import sys
import types

import pytest

from flow_sdk.i18n import os_languages


@pytest.fixture(autouse=True)
def _fresh_cache():
    os_languages._probe.cache_clear()
    yield
    os_languages._probe.cache_clear()


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("he_IL.UTF-8", "he-IL"),
        ("en-US", "en-US"),
        ("he", "he"),
        ("C", None),
        ("POSIX", None),
        ("", None),
        ("sr@latin", "sr"),
    ],
)
def test_normalize(raw, expected):
    assert os_languages._normalize(raw) == expected


@pytest.mark.parametrize(
    ("name", "expected"),
    [("Hebrew", "he"), ("Hebrew-QWERTY", "he"), ("Arabic - PC", "ar"), ("ABC", None), ("U.S.", None)],
)
def test_macos_layout_names_map_to_supported_languages(name, expected):
    assert os_languages._layout_name_language(name) == expected


def test_macos_keyboard_layout_counts_without_a_display_language(tmp_path, monkeypatch):
    prefs = tmp_path / "Library" / "Preferences"
    prefs.mkdir(parents=True)
    # No AppleLanguages at all: the machine runs the default (English) UI.
    (prefs / ".GlobalPreferences.plist").write_bytes(plistlib.dumps({}))
    (prefs / "com.apple.HIToolbox.plist").write_bytes(
        plistlib.dumps(
            {
                "AppleEnabledInputSources": [
                    {"InputSourceKind": "Keyboard Layout", "KeyboardLayout Name": "ABC"},
                    {"InputSourceKind": "Keyboard Layout", "KeyboardLayout Name": "Hebrew"},
                ]
            }
        )
    )
    monkeypatch.setattr(os_languages.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(sys, "platform", "darwin")
    assert os_languages.get_os_languages() == ["he"]


def test_linux_env_and_xkb_layouts(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("LANGUAGE", "")
    monkeypatch.setenv("LANG", "en_US.UTF-8")
    monkeypatch.delenv("LC_ALL", raising=False)
    monkeypatch.delenv("LC_MESSAGES", raising=False)
    monkeypatch.setattr(os_languages.shutil, "which", lambda name: f"/usr/bin/{name}" if name == "gsettings" else None)
    monkeypatch.setattr(
        os_languages.subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="[('xkb', 'us'), ('xkb', 'il')]\n"),
    )
    assert os_languages.get_os_languages() == ["en-US", "en", "he"]


def test_windows_language_list_and_keyboard_preload(monkeypatch):
    values = {
        r"Control Panel\International\User Profile": {"Languages": (["en-US"], 7)},
        # 0409 = en-US keyboard, 040d = Hebrew keyboard.
        r"Keyboard Layout\Preload": [("1", "00000409", 1), ("2", "0000040d", 1)],
    }

    class _Key:
        def __init__(self, path):
            self.path = path

        def __enter__(self):
            if self.path not in values:
                raise OSError(self.path)
            return self

        def __exit__(self, *exc):
            return False

    winreg = types.SimpleNamespace(
        HKEY_CURRENT_USER=object(),
        OpenKey=lambda _root, path: _Key(path),
        QueryValueEx=lambda key, name: values[key.path][name],
        QueryInfoKey=lambda key: (0, len(values[key.path]), 0),
        EnumValue=lambda key, i: values[key.path][i],
    )
    monkeypatch.setitem(sys.modules, "winreg", winreg)
    monkeypatch.setattr(sys, "platform", "win32")
    assert os_languages.get_os_languages() == ["en-US", "he-IL"]


def test_a_failing_probe_yields_no_languages_not_an_error(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")

    def boom():
        raise RuntimeError("probe exploded")

    monkeypatch.setattr(os_languages, "_linux_languages", boom)
    assert os_languages.get_os_languages() == []
