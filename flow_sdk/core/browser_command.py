"""A command that opens its browser pages in one chosen browser profile.

Programs that open a browser for you (`gcloud auth login`, `gh auth login`, Python's
``webbrowser``, ``xdg-open``) honour the ``BROWSER`` environment variable: a command
line they run with the URL appended. Pointing it at this module routes every page the
command opens through ``open_in_profile`` — the same launcher the link menu's
"Open in ▸ profile" uses — so the page lands in that profile on every OS.

    python -m flow_sdk.core.browser_command --browser chrome --profile "Profile 1" <url>

``with_browser`` writes the assignment in the grammar of the shell that will read the
line. ``browser_env`` is the same value for a caller that sets the environment itself.
"""

from __future__ import annotations

import argparse
import shlex
import sys
from typing import Literal

from flow_sdk.core.browser_profiles import BrowserProfileError, OpenInProfileRequest, ProfileChoice, open_in_profile

Grammar = Literal["posix", "powershell", "cmd"]


def browser_env(choice: ProfileChoice) -> str:
    """The ``BROWSER`` value: this module's command line, which the URL is appended to.

    Readers split it POSIX-style (Python's ``webbrowser`` uses ``shlex.split`` on every
    OS), where a backslash escapes — so a Windows interpreter path is written with ``/``.
    """
    python = sys.executable.replace("\\", "/") if sys.platform == "win32" else sys.executable
    return shlex.join([python, "-m", "flow_sdk.core.browser_command", "--browser", choice.browser, "--profile", choice.profile])


def grammar_of(shell: str) -> Grammar:
    """The grammar of the shell at ``shell`` (a path or a name)."""
    name = shell.replace("\\", "/").rsplit("/", 1)[-1].lower().removesuffix(".exe")
    if name in ("pwsh", "powershell"):
        return "powershell"
    return "cmd" if name == "cmd" else "posix"


def with_browser(command: str, choice: ProfileChoice | None, grammar: Grammar) -> str:
    """``command`` with ``BROWSER`` set for it, or unchanged for the system default (``None``).

    POSIX scopes the variable to the command (`BROWSER=… cmd`). PowerShell and cmd have no
    per-command form, so there it stays set in that shell afterwards.
    """
    if choice is None:
        return command
    value = browser_env(choice)
    if grammar == "posix":
        return f"BROWSER={shlex.quote(value)} {command}"
    if grammar == "powershell":
        return "$env:BROWSER = '{}'; {}".format(value.replace("'", "''"), command)
    return f'set "BROWSER={value}" && {command}'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="browser_command", description="Open a URL in one browser profile.")
    parser.add_argument("--browser", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("url")
    args = parser.parse_args(argv)
    try:
        open_in_profile(OpenInProfileRequest(browser=args.browser, profile=args.profile, url=args.url))
    except BrowserProfileError as exc:
        print(f"browser_command: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
