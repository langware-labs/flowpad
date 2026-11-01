"""os_open_command: open vs reveal (select in the file manager) per OS."""

from flow_sdk.api.fs.desktop_open import os_open_command


def test_mac_open_and_reveal():
    assert os_open_command("Darwin", "/a/b.md") == ["open", "/a/b.md"]
    assert os_open_command("Darwin", "/a/b.md", reveal=True) == ["open", "-R", "/a/b.md"]


def test_windows_reveal_selects_in_explorer():
    assert os_open_command("Windows", r"C:\a\b.md", reveal=True) == ["explorer", r"/select,C:\a\b.md"]
    assert os_open_command("Windows", r"C:\a\b.md")[:3] == ["cmd", "/c", "start"]


def test_linux_reveal_opens_parent():
    assert os_open_command("Linux", "/a/b.md", reveal=True) == ["xdg-open", "/a"]
    assert os_open_command("Linux", "/a/b.md") == ["xdg-open", "/a/b.md"]


def test_unknown_os():
    assert os_open_command("Plan9", "/a") is None
