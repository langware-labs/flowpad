"""A command's browser pages land in the chosen profile: ``BROWSER`` in each shell's grammar."""

from __future__ import annotations

import shlex
import subprocess
import sys

import pytest

from flow_sdk.core import browser_command
from flow_sdk.core.browser_command import browser_env, grammar_of, with_browser
from flow_sdk.core.browser_profiles import ProfileChoice

pytestmark = pytest.mark.timeout(10)

WORK = ProfileChoice(browser="chrome", profile="Profile 1")


def test_system_default_leaves_the_command_alone():
    assert with_browser("gcloud auth login", None, "posix") == "gcloud auth login"


def test_env_value_is_a_command_line_webbrowser_can_split():
    argv = shlex.split(browser_env(WORK))
    assert argv[1:] == ["-m", "flow_sdk.core.browser_command", "--browser", "chrome", "--profile", "Profile 1"]


def test_posix_scopes_browser_to_the_command_and_a_shell_reads_it_back():
    line = with_browser('python3 -c "import os; print(os.environ[\'BROWSER\'])"', WORK, "posix")
    assert line.startswith("BROWSER=")
    out = subprocess.run(["bash", "-c", line], capture_output=True, text=True, check=True).stdout.strip()
    assert out == browser_env(WORK)


def test_powershell_and_cmd_forms():
    quoted = ProfileChoice(browser="chrome", profile="it's")
    value = browser_env(quoted).replace("'", "''")  # PowerShell doubles a quote inside '…'
    assert with_browser("gcloud auth login", quoted, "powershell") == f"$env:BROWSER = '{value}'; gcloud auth login"
    assert with_browser("gcloud auth login", WORK, "cmd").startswith('set "BROWSER=')


@pytest.mark.parametrize(
    ("shell", "grammar"),
    [("/bin/zsh", "posix"), ("bash", "posix"), ("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell"),
     ("powershell", "powershell"), ("C:\\Windows\\System32\\cmd.exe", "cmd")],
)
def test_grammar_of(shell, grammar):
    assert grammar_of(shell) == grammar


def test_main_opens_the_url_in_that_profile(monkeypatch):
    opened = []
    monkeypatch.setattr(browser_command, "open_in_profile", opened.append)
    assert browser_command.main(["--browser", "chrome", "--profile", "Work", "https://example.org/a"]) == 0
    assert (opened[0].browser, opened[0].profile, opened[0].url) == ("chrome", "Work", "https://example.org/a")


def test_main_reports_a_refused_open(monkeypatch, capsys):
    from flow_sdk.core.browser_profiles import BrowserProfileError

    def refuse(_req):
        raise BrowserProfileError("UNKNOWN_PROFILE", "Google Chrome has no profile 'Nope'")

    monkeypatch.setattr(browser_command, "open_in_profile", refuse)
    assert browser_command.main(["--browser", "chrome", "--profile", "Nope", "https://example.org"]) == 1
    assert "no profile" in capsys.readouterr().err


def test_module_runs_as_a_script():
    out = subprocess.run([sys.executable, "-m", "flow_sdk.core.browser_command", "--help"], capture_output=True, text=True)
    assert out.returncode == 0 and "--profile" in out.stdout
