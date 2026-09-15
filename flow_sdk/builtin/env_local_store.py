"""``.env.local`` — the env file a credential's values live in, and the ``env_file`` store's disk.

Every credential scope has a root folder: a project's mount, or the user's home.
Each environment has its own file at that root — ``.env.local`` for
``development`` (this computer) and ``.env.<env>.local`` for a named one
(``credential_contract.env_file_name``). The encrypted vault is the other store
(``flow_sdk/secrets``).

The primitives take a file PATH (``*_env_file``, ``env_file_status``) — what the
``env_file`` store is configured with. The ``root`` + ``environment`` functions
are the credential scope's spelling of the same path.

An env file is plaintext, so inside a git work tree it MUST be excluded by git
before a value is written — a value must never travel when the folder is
git-shared. Outside a repo there is no history to leak into, and nothing is
added to any ``.gitignore`` (a user's home is not a place to drop one).

Two read surfaces, deliberately split by side effect:

* :func:`list_env_file` and :func:`env_file_status` are **read-only**.
* :func:`list_env_file` returns **key names and line numbers only, never values**.

There is deliberately **no delete helper**. Flowpad never removes an entry from a
user's env file — other tools load that file, and keeping it tidy is the
user's business.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Mapping, Optional

from dotenv import dotenv_values, set_key

from flow_sdk.schema.data_spec.credential_contract import (
    DEFAULT_ENVIRONMENT,
    ENV_LOCAL_FILENAME,
    ENV_VAR_RE,
    env_file_name,
)

logger = logging.getLogger(__name__)

_GITIGNORE_FILENAME = ".gitignore"

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
    GITIGNORE_IGNORED: "{file} is excluded by git.",
    GITIGNORE_NOT_IGNORED: "{file} is NOT excluded by git — values would be committable.",
    GITIGNORE_TRACKED: (
        "{file} is already TRACKED by git. Ignore rules do not apply to tracked files, "
        "so its contents would still be committed. Run `git rm --cached {file}` first."
    ),
    GITIGNORE_GIT_FAILURE: "Could not ask git whether {file} is ignored.",
}


def _status(code: str, file: str = ENV_LOCAL_FILENAME) -> dict[str, Any]:
    """Every flag is a function of the code."""
    return {
        "in_repo": code not in (GITIGNORE_NO_DIR, GITIGNORE_NOT_A_REPO),
        "ignored": code in (GITIGNORE_NO_DIR, GITIGNORE_NOT_A_REPO, GITIGNORE_IGNORED),
        "tracked": code == GITIGNORE_TRACKED,
        "code": code,
        "reason": _REASONS[code].format(file=file),
    }


class EnvLocalNotWritable(RuntimeError):
    """The scope has no folder, or its env file cannot be proven excluded by git.

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


def _file(path: Path | str | None) -> tuple[Optional[Path], Optional[Path], str]:
    """``(file, its folder when it exists, file name)``."""
    if not path:
        return None, None, ENV_LOCAL_FILENAME
    p = Path(path)
    return p, _root_dir(p.parent), p.name


def env_local_path(root: Path | str | None, environment: str = DEFAULT_ENVIRONMENT) -> Optional[Path]:
    """The environment's env file under the scope root, whether or not it exists."""
    d = _root_dir(root)
    return (d / env_file_name(environment)) if d is not None else None


# ── by path ─────────────────────────────────────────────────────────────────
def list_env_file(path: Path | str | None) -> list[dict[str, Any]]:
    """Key names present in the env file at ``path``, with line numbers.

    **Names only — a value is never read, returned, or logged.** Duplicate keys
    collapse to the **last** definition (dotenv's last-wins), ordered by line.
    """
    p, _, _ = _file(path)
    if p is None or not p.exists():
        return []
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:  # noqa: BLE001
        logger.warning("[env-local] could not read %s: %s", p, e)
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


def env_file_status(path: Path | str | None) -> dict[str, Any]:
    """Is the env file at ``path`` excluded by git? **Read-only** — never mutates.

    Asks git rather than reading ``.gitignore`` by hand: only git resolves
    wildcards, a global excludes file, nested ignore files and negations.
    """
    from flow_sdk.utils.git import _run_git  # noqa: PLC0415

    _, d, name = _file(path)
    if d is None:
        return _status(GITIGNORE_NO_DIR, name)

    cwd = str(d)
    try:
        if not _inside_work_tree(cwd):
            return _status(GITIGNORE_NOT_A_REPO, name)
        # check-ignore: 0 = ignored, 1 = not ignored, anything else = failure.
        probe = _run_git(["git", "check-ignore", "-q", "--", name], cwd, timeout=10)
        # Ignore rules do NOT apply to files git already tracks.
        tracked = _run_git(["git", "ls-files", "--error-unmatch", "--", name], cwd, timeout=10).returncode == 0
    except Exception as e:  # noqa: BLE001
        logger.warning("[env-local] gitignore probe failed for %s: %s", cwd, e)
        return _status(GITIGNORE_GIT_FAILURE, name)

    if tracked:
        return _status(GITIGNORE_TRACKED, name)
    if probe.returncode == 0:
        return _status(GITIGNORE_IGNORED, name)
    if probe.returncode == 1:
        return _status(GITIGNORE_NOT_IGNORED, name)
    logger.warning("[env-local] check-ignore exited %s for %s", probe.returncode, cwd)
    return _status(GITIGNORE_GIT_FAILURE, name)


def ensure_env_file_ignored(path: Path | str | None) -> dict[str, Any]:
    """Make sure the env file at ``path`` is excluded by git, then verify with git.

    Only inside a git work tree: outside one there is nothing to leak into, and
    writing a ``.gitignore`` into a folder that is not a repo (a home directory)
    would be a surprise. Appends the file's OWN name, so a project that ignores
    only ``.env.local`` still protects ``.env.production.local``. Returns the
    VERIFIED status dict.
    """
    status = env_file_status(path)
    if status["code"] != GITIGNORE_NOT_IGNORED and status["code"] != GITIGNORE_TRACKED:
        # Already excluded, not a repo, no folder, or git failed: nothing to append.
        return status

    _, d, name = _file(path)
    gitignore = d / _GITIGNORE_FILENAME
    try:
        existing = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
        lines = {ln.strip() for ln in existing.splitlines()}
        if name not in lines:
            sep = "" if (existing == "" or existing.endswith("\n")) else "\n"
            gitignore.write_text(f"{existing}{sep}{name}\n", encoding="utf-8")
    except OSError as e:  # noqa: BLE001
        logger.warning("[env-local] could not write .gitignore for %s: %s", d, e)
        return _status(GITIGNORE_GIT_FAILURE, name)

    # Verify, don't assume: a later negation can re-include the file.
    return env_file_status(path)


def write_env_file(path: Path | str | None, values: Mapping[str, str]) -> None:
    """Write every ``key=value`` into the env file at ``path``.

    Excludes the file from git first (inside a repo) and verifies; refuses
    (raises) otherwise, so a value never lands in a committable file.
    """
    p, d, name = _file(path)
    if p is None or d is None:
        raise EnvLocalNotWritable(f"no writable folder for {name}", code=GITIGNORE_NO_DIR)
    status = ensure_env_file_ignored(p)
    if not status["ignored"]:
        raise EnvLocalNotWritable(
            f"{name} is not excluded by git; refusing to write a value ({status['reason']})",
            code=status["code"],
        )
    p.touch(mode=0o600, exist_ok=True)
    try:
        p.chmod(0o600)
    except OSError:  # best-effort on platforms without chmod semantics
        pass
    for key, value in values.items():
        # quote_mode="always" keeps values with spaces/specials intact.
        set_key(str(p), key, value, quote_mode="always")


def read_env_file_values(path: Path | str | None) -> dict[str, str]:
    """Every value in the env file at ``path`` — for injection only, never for display.

    Parses without touching ``os.environ``: the same read a future "fetch
    secrets → env file" step feeds, so no process-wide ``load_dotenv`` is needed.
    """
    p, _, _ = _file(path)
    if p is None or not p.exists():
        return {}
    return {k: v for k, v in dotenv_values(str(p)).items() if v is not None}


# ── by credential scope root + environment ─────────────────────────────────
def list_env_local(root: Path | str | None, environment: str = DEFAULT_ENVIRONMENT) -> list[dict[str, Any]]:
    return list_env_file(env_local_path(root, environment))


def gitignore_status(root: Path | str | None, environment: str = DEFAULT_ENVIRONMENT) -> dict[str, Any]:
    path = env_local_path(root, environment)
    return env_file_status(path) if path is not None else _status(GITIGNORE_NO_DIR, env_file_name(environment))


def ensure_gitignored(root: Path | str | None, environment: str = DEFAULT_ENVIRONMENT) -> dict[str, Any]:
    path = env_local_path(root, environment)
    return ensure_env_file_ignored(path) if path is not None else _status(GITIGNORE_NO_DIR, env_file_name(environment))


def env_local_block(status: dict[str, Any]) -> Optional[dict[str, Any]]:
    """The reason a value must not be written here, or ``None`` if it may be."""
    if status["ignored"] and status["code"] != GITIGNORE_NO_DIR:
        return None
    return {"code": status["code"], "reason": status["reason"]}


def write_env_local(
    root: Path | str | None, key: str, value: str, environment: str = DEFAULT_ENVIRONMENT
) -> None:
    path = env_local_path(root, environment)
    if path is None:
        raise EnvLocalNotWritable(f"no writable folder for {env_file_name(environment)}", code=GITIGNORE_NO_DIR)
    write_env_file(path, {key: value})


def read_env_local_values(root: Path | str | None, environment: str = DEFAULT_ENVIRONMENT) -> dict[str, str]:
    return read_env_file_values(env_local_path(root, environment))
