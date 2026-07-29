"""Project ``.env.local`` — the second local secret value store.

Alongside the per-instance encrypted ``sodot`` store (``flow_sdk/cli/auth/secrets.py``),
a project may keep secret values in a plaintext ``.env.local`` at its mount root.
This is a *value* store, so — unlike the value-free ``assets/sodot/*.json``
reference, which IS committed and shared — ``.env.local`` MUST be gitignored so a
value never travels when the project's folder is git-shared.

Invariant: ``write_env_local`` force-adds ``.env.local`` to the project's
``.gitignore`` BEFORE writing, and refuses to write if that assertion cannot be
established. See ``docs/secret_share.md``.

Two read surfaces, deliberately split by side effect:

* :func:`list_env_local` and :func:`gitignore_status` are **read-only**. They
  never touch the filesystem's contents — ``gitignore_status`` in particular
  must not be confused with :func:`ensure_gitignored`, which *appends* a line.
* :func:`list_env_local` returns **key names and line numbers only, never
  values**. Naming a key is safe; the value is what must not travel.

There is deliberately **no delete helper**. Flowpad never removes an entry from
a user's ``.env.local`` — the app (vite, dotenv, whatever else the project runs)
loads that file, and keeping it in sync is the user's business, not ours.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from dotenv import dotenv_values, set_key

if TYPE_CHECKING:
    from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)

ENV_LOCAL_FILENAME = ".env.local"
_GITIGNORE_FILENAME = ".gitignore"
_GITIGNORE_LINE = ".env.local"

# ``FOO=``/``export FOO=`` — the assignment forms dotenv recognizes. Anchored on
# the key so the value (everything past the ``=``) is never captured.
_ASSIGNMENT_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")

# gitignore_status result codes.
GITIGNORE_NO_DIR = "no-project-dir"
GITIGNORE_NOT_A_REPO = "not-a-repo"
GITIGNORE_IGNORED = "ignored"
GITIGNORE_NOT_IGNORED = "not-ignored"
GITIGNORE_TRACKED = "tracked"
GITIGNORE_GIT_FAILURE = "git-failure"

_REASONS = {
    GITIGNORE_NO_DIR: "The project has no readable folder on this machine.",
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
    """Every flag is a function of the code, so derive them rather than
    restating them per branch — hand-built dicts drift."""
    return {
        "in_repo": code not in (GITIGNORE_NO_DIR, GITIGNORE_NOT_A_REPO),
        "ignored": code in (GITIGNORE_NO_DIR, GITIGNORE_NOT_A_REPO, GITIGNORE_IGNORED),
        "tracked": code == GITIGNORE_TRACKED,
        "code": code,
        "reason": _REASONS[code],
    }


class EnvLocalNotWritable(RuntimeError):
    """Raised when the project has no writable mount dir, or ``.env.local`` cannot
    be proven gitignored — writing a value would risk leaking it on git-share.

    ``code`` is one of the ``GITIGNORE_*`` constants, so a caller can render the
    specific fix instead of parsing the message.
    """

    def __init__(self, message: str, *, code: str = GITIGNORE_NOT_IGNORED) -> None:
        super().__init__(message)
        self.code = code


def _project_dir(project: "Project") -> Optional[Path]:
    mount = getattr(project, "fs_storage_mount_path", None)
    if not mount:
        return None
    p = Path(mount)
    return p if p.is_dir() else None


def _env_path(project: "Project") -> Optional[Path]:
    d = _project_dir(project)
    return (d / ENV_LOCAL_FILENAME) if d is not None else None


def env_local_path(project: "Project") -> Optional[Path]:
    """The project's ``.env.local`` path, whether or not the file exists.

    Public because callers need somewhere to point the user (the editor
    deep-link on the detected-keys table opens exactly this path).
    """
    return _env_path(project)


def list_env_local(project: "Project") -> list[dict[str, Any]]:
    """Key names present in the project's ``.env.local``, with line numbers.

    **Names only — a value is never read, returned, or logged.** That is why
    this parses by hand instead of calling ``dotenv_values``: the latter
    materializes every value just to hand back the keys.

    Duplicate keys collapse to the **last** definition, matching dotenv's
    last-wins resolution, so the reported line is the one actually in effect.
    Results are ordered by that effective line.
    """
    path = _env_path(project)
    if path is None or not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:  # noqa: BLE001
        logger.warning("[env-local] could not read %s: %s", path, e)
        return []

    effective: dict[str, int] = {}
    for lineno, raw in enumerate(text.splitlines(), start=1):
        # The regex anchors on a leading identifier, so blanks and #-comments
        # already fail to match — no pre-filter needed.
        match = _ASSIGNMENT_RE.match(raw)
        if match is None:
            continue
        effective[match.group(1)] = lineno

    return [{"key": key, "line": line} for key, line in sorted(effective.items(), key=lambda kv: kv[1])]


def gitignore_status(project: "Project") -> dict[str, Any]:
    """Is ``.env.local`` excluded by git? **Read-only** — never mutates.

    Asks git rather than reading ``.gitignore`` by hand, because only git
    resolves the full rule set: ``*.local`` / ``.env*`` wildcards, a global
    ``core.excludesFile``, nested ``.gitignore`` files, and — the case a
    line-match gets backwards — a later ``!.env.local`` negation re-including
    the file.

    Returns ``{in_repo, ignored, code, reason}``. A missing folder or a repo-less
    directory reports ``ignored=True``: there is no git history for a value to
    leak into, which is the same call :func:`ensure_gitignored` already makes.
    """
    from flow_sdk.utils.git import _run_git  # noqa: PLC0415

    d = _project_dir(project)
    if d is None:
        return _status(GITIGNORE_NO_DIR)

    cwd = str(d)
    try:
        inside = _run_git(["git", "rev-parse", "--is-inside-work-tree"], cwd, timeout=10)
        if inside.returncode != 0 or inside.stdout.strip() != "true":
            return _status(GITIGNORE_NOT_A_REPO)
        # check-ignore: 0 = ignored, 1 = not ignored, anything else = failure.
        probe = _run_git(["git", "check-ignore", "-q", "--", ENV_LOCAL_FILENAME], cwd, timeout=10)
        # Ignore rules do NOT apply to files git already tracks, so a tracked
        # .env.local keeps getting committed however the ignore file reads.
        # This is the case a gitignore-only check reports as safe when it isn't.
        tracked = _run_git(
            ["git", "ls-files", "--error-unmatch", "--", ENV_LOCAL_FILENAME], cwd, timeout=10
        ).returncode == 0
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


def ensure_gitignored(project: "Project") -> dict[str, Any]:
    """Make sure ``.env.local`` is excluded by the project's ``.gitignore``.

    Idempotent: appends the line only when absent, then **asks git whether the
    file is actually ignored now**. The verify step is what closes the hole a
    plain line-append leaves open — a later ``!.env.local`` negation, or a rule
    in a nested ignore file, can re-include the file no matter what line we
    added. Appending and assuming is how a value would end up committable while
    we reported success.

    Returns the VERIFIED status dict, not a bool — the caller needs the code to
    explain a refusal, and re-probing to get it would spawn three more git
    processes for an answer we already have.
    """
    d = _project_dir(project)
    if d is None:
        return _status(GITIGNORE_NO_DIR)

    # Append even when this isn't a repo yet: `git init` later would otherwise
    # find an unprotected .env.local sitting there. Cheap insurance.
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

    # Verify, don't assume.
    return gitignore_status(project)


def env_local_block(status: dict[str, Any]) -> Optional[dict[str, Any]]:
    """The reason a value must not be written here, or ``None`` if it may be.

    Takes an already-computed status rather than probing again: each
    ``gitignore_status`` costs three git subprocesses, and callers always have
    one in hand.
    """
    if status["ignored"]:
        return None
    return {"code": status["code"], "reason": status["reason"]}


def write_env_local(project: "Project", key: str, value: str) -> None:
    """Write ``key=value`` into the project's ``.env.local``.

    Force-gitignores first and verifies with git; refuses (raises) otherwise, so
    a value never lands in a committable file.
    """
    path = _env_path(project)
    if path is None:
        raise EnvLocalNotWritable(
            "project has no writable mount dir for .env.local", code=GITIGNORE_NO_DIR
        )
    status = ensure_gitignored(project)
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


def read_env_local(project: "Project", key: str) -> Optional[str]:
    path = _env_path(project)
    if path is None or not path.exists():
        return None
    return dotenv_values(str(path)).get(key)
