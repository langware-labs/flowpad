"""``.env.local`` — the default value store for a credential.

Every credential scope has a root folder: a project's mount, or the user's home.
The scope's ``.env.local`` sits at that root. The encrypted vault
(``flow_sdk/cli/auth/secrets.py``) is the alternative store.

``.env.local`` is plaintext, so inside a git work tree it MUST be excluded by git
before a value is written — a value must never travel when the folder is
git-shared. Outside a repo there is no history to leak into, and nothing is
added to any ``.gitignore`` (a user's home is not a place to drop one).

Two read surfaces, deliberately split by side effect:

* :func:`list_env_local` and :func:`gitignore_status` are **read-only**.
* :func:`list_env_local` returns **key names and line numbers only, never values**.

There is deliberately **no delete helper**. Flowpad never removes an entry from a
user's ``.env.local`` — other tools load that file, and keeping it tidy is the
user's business.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Optional

from dotenv import dotenv_values, set_key

from flow_sdk.schema.data_spec.credential_contract import ENV_VAR_RE

logger = logging.getLogger(__name__)

ENV_LOCAL_FILENAME = ".env.local"
_GITIGNORE_FILENAME = ".gitignore"
_GITIGNORE_LINE = ".env.local"

# ``FOO=``/``export FOO=`` — anchored on the key so a value is never captured.
_ASSIGNMENT_RE = re.compile(rf"^\s*(?:export\s+)?({ENV_VAR_RE.pattern.strip('^$')})\s*=")

# gitignore_status result codes.
GITIGNORE_NO_DIR = "no-project-dir"
GITIGNORE_NOT_A_REPO = "not-a-repo"
GITIGNORE_IGNORED = "ignored"
GITIGNORE_NOT_IGNORED = "not-ignored"
GITIGNORE_TRACKED = "tracked"
GITIGNORE_GIT_FAILURE = "git-failure"

_REASONS = {
    GITIGNORE_NO_DIR: "There is no readable folder for this scope on this machine.",
    GITIGNORE_NOT_A_REPO: "Not a git repository — nothing for a value to leak into.",
    GITIGNORE_IGNORED: ".env.local is excluded by git.",
    GITIGNORE_NOT_IGNORED: ".env.local is NOT excluded by git — values would be committable.",
    GITIGNORE_TRACKED: (
        ".env.local is already TRACKED by git. Ignore rules do not apply to tracked files, "
        "so its contents would still be committed. Run `git rm --cached .env.local` first."
    ),
    GITIGNORE_GIT_FAILURE: "Could not ask git whether .env.local is ignored.",
}


def _status(code: str) -> dict[str, Any]:
    """Every flag is a function of the code."""
    return {
        "in_repo": code not in (GITIGNORE_NO_DIR, GITIGNORE_NOT_A_REPO),
        "ignored": code in (GITIGNORE_NO_DIR, GITIGNORE_NOT_A_REPO, GITIGNORE_IGNORED),
        "tracked": code == GITIGNORE_TRACKED,
        "code": code,
        "reason": _REASONS[code],
    }


class EnvLocalNotWritable(RuntimeError):
    """The scope has no folder, or ``.env.local`` cannot be proven excluded by git.

    ``code`` is one of the ``GITIGNORE_*`` constants, so a caller can render the
    specific fix instead of parsing the message.
    """

    def __init__(self, message: str, *, code: str = GITIGNORE_NOT_IGNORED) -> None:
        super().__init__(message)
        self.code = code


def _root_dir(root: Path | str | None) -> Optional[Path]:
    if not root:
        return None
    p = Path(root)
    return p if p.is_dir() else None


def env_local_path(root: Path | str | None) -> Optional[Path]:
    """The scope's ``.env.local`` path, whether or not the file exists."""
    d = _root_dir(root)
    return (d / ENV_LOCAL_FILENAME) if d is not None else None


def list_env_local(root: Path | str | None) -> list[dict[str, Any]]:
    """Key names present in ``<root>/.env.local``, with line numbers.

    **Names only — a value is never read, returned, or logged.** Duplicate keys
    collapse to the **last** definition (dotenv's last-wins), ordered by line.
    """
    path = env_local_path(root)
    if path is None or not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:  # noqa: BLE001
        logger.warning("[env-local] could not read %s: %s", path, e)
        return []

    effective: dict[str, int] = {}
    for lineno, raw in enumerate(text.splitlines(), start=1):
        match = _ASSIGNMENT_RE.match(raw)
        if match is None:
            continue
        effective[match.group(1)] = lineno

    return [{"key": key, "line": line} for key, line in sorted(effective.items(), key=lambda kv: kv[1])]


def _inside_work_tree(cwd: str) -> bool:
    from flow_sdk.utils.git import _run_git  # noqa: PLC0415

    inside = _run_git(["git", "rev-parse", "--is-inside-work-tree"], cwd, timeout=10)
    return inside.returncode == 0 and inside.stdout.strip() == "true"


def gitignore_status(root: Path | str | None) -> dict[str, Any]:
    """Is ``<root>/.env.local`` excluded by git? **Read-only** — never mutates.

    Asks git rather than reading ``.gitignore`` by hand: only git resolves
    wildcards, a global excludes file, nested ignore files and negations.
    """
    from flow_sdk.utils.git import _run_git  # noqa: PLC0415

    d = _root_dir(root)
    if d is None:
        return _status(GITIGNORE_NO_DIR)

    cwd = str(d)
    try:
        if not _inside_work_tree(cwd):
            return _status(GITIGNORE_NOT_A_REPO)
        # check-ignore: 0 = ignored, 1 = not ignored, anything else = failure.
        probe = _run_git(["git", "check-ignore", "-q", "--", ENV_LOCAL_FILENAME], cwd, timeout=10)
        # Ignore rules do NOT apply to files git already tracks.
        tracked = (
            _run_git(["git", "ls-files", "--error-unmatch", "--", ENV_LOCAL_FILENAME], cwd, timeout=10).returncode
            == 0
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[env-local] gitignore probe failed for %s: %s", cwd, e)
        return _status(GITIGNORE_GIT_FAILURE)

    if tracked:
        return _status(GITIGNORE_TRACKED)
    if probe.returncode == 0:
        return _status(GITIGNORE_IGNORED)
    if probe.returncode == 1:
        return _status(GITIGNORE_NOT_IGNORED)
    logger.warning("[env-local] check-ignore exited %s for %s", probe.returncode, cwd)
    return _status(GITIGNORE_GIT_FAILURE)


def ensure_gitignored(root: Path | str | None) -> dict[str, Any]:
    """Make sure ``<root>/.env.local`` is excluded by git, then verify with git.

    Only inside a git work tree: outside one there is nothing to leak into, and
    writing a ``.gitignore`` into a folder that is not a repo (a home directory)
    would be a surprise. Returns the VERIFIED status dict.
    """
    status = gitignore_status(root)
    if status["code"] != GITIGNORE_NOT_IGNORED and status["code"] != GITIGNORE_TRACKED:
        # Already excluded, not a repo, no folder, or git failed: nothing to append.
        return status

    d = _root_dir(root)
    gitignore = d / _GITIGNORE_FILENAME
    try:
        existing = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
        lines = {ln.strip() for ln in existing.splitlines()}
        if _GITIGNORE_LINE not in lines:
            sep = "" if (existing == "" or existing.endswith("\n")) else "\n"
            gitignore.write_text(f"{existing}{sep}{_GITIGNORE_LINE}\n", encoding="utf-8")
    except OSError as e:  # noqa: BLE001
        logger.warning("[env-local] could not write .gitignore for %s: %s", d, e)
        return _status(GITIGNORE_GIT_FAILURE)

    # Verify, don't assume: a later negation can re-include the file.
    return gitignore_status(d)


def env_local_block(status: dict[str, Any]) -> Optional[dict[str, Any]]:
    """The reason a value must not be written here, or ``None`` if it may be."""
    if status["ignored"] and status["code"] != GITIGNORE_NO_DIR:
        return None
    return {"code": status["code"], "reason": status["reason"]}


def write_env_local(root: Path | str | None, key: str, value: str) -> None:
    """Write ``key=value`` into ``<root>/.env.local``.

    Excludes the file from git first (inside a repo) and verifies; refuses
    (raises) otherwise, so a value never lands in a committable file.
    """
    path = env_local_path(root)
    if path is None:
        raise EnvLocalNotWritable("no writable folder for .env.local", code=GITIGNORE_NO_DIR)
    status = ensure_gitignored(root)
    if not status["ignored"]:
        raise EnvLocalNotWritable(
            f".env.local is not excluded by git; refusing to write a value ({status['reason']})",
            code=status["code"],
        )
    path.touch(mode=0o600, exist_ok=True)
    try:
        path.chmod(0o600)
    except OSError:  # best-effort on platforms without chmod semantics
        pass
    # quote_mode="always" keeps values with spaces/specials intact.
    set_key(str(path), key, value, quote_mode="always")


def read_env_local_values(root: Path | str | None) -> dict[str, str]:
    """Every value in ``<root>/.env.local`` — for injection only, never for display."""
    path = env_local_path(root)
    if path is None or not path.exists():
        return {}
    return {k: v for k, v in dotenv_values(str(path)).items() if v is not None}
