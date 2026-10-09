"""Is running ``git`` safe on this machine?

On a Mac without Apple's Command Line Tools, ``/usr/bin/git`` is a stub: it does not run git, it opens a system
dialog ("The "git" command requires the command line developer tools") and exits non-zero. A background probe that
only wants to know "is this folder a repo?" or "what is user.email?" must not do that to someone who never asked
for Git. The question is asked in one place only: the Git wizard (``ask-install-git`` / ``git-on-path``), when
the person agrees to install. Everything that runs git on its own stays quiet until the tools are there.

Only file stats on the common path, no subprocess, so it is safe to call per probe.
"""

from __future__ import annotations

import functools
import os
import shutil
import subprocess
import sys

#: What a refused git call says. A process result with this on stderr reads like a missing binary (exit 127).
NOT_USABLE_MESSAGE = "git is not usable: the macOS Command Line Tools are not installed"
EXIT_NOT_FOUND = 127

_CLT_GIT = "/Library/Developer/CommandLineTools/usr/bin/git"
_XCODE_GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git"
_STUB_GIT = "/usr/bin/git"


@functools.lru_cache(maxsize=1)
def _selected_developer_git() -> str | None:
    """git under the directory ``xcode-select -p`` names (a non-default location). Looked up at most once."""
    try:
        out = subprocess.run(["/usr/bin/xcode-select", "-p"], capture_output=True, text=True).stdout.strip()
    except OSError:
        return None
    return os.path.join(out, "usr", "bin", "git") if out else None


def git_usable() -> bool:
    """True when running ``git`` will run git (always off macOS)."""
    if sys.platform != "darwin":
        return True
    on_path = shutil.which("git")
    if on_path and on_path != _STUB_GIT:  # Homebrew, MacPorts, a bundled git: the real thing
        return True
    if os.path.exists(_CLT_GIT) or os.path.exists(_XCODE_GIT):  # the stub forwards to one of these
        return True
    selected = _selected_developer_git()
    return bool(selected and os.path.exists(selected))


def is_git_argv(argv) -> bool:
    """True when ``argv`` runs ``git`` itself (not a command that merely mentions it)."""
    return bool(argv) and os.path.basename(str(argv[0])) in ("git", "git.exe")
