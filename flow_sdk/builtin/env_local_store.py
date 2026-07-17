"""Project ``.env.local`` — the second local secret value store.

Alongside the per-instance encrypted ``sodot`` store (``flow_sdk/cli/auth/secrets.py``),
a project may keep secret values in a plaintext ``.env.local`` at its mount root.
This is a *value* store, so — unlike the value-free ``assets/sodot/*.json``
reference, which IS committed and shared — ``.env.local`` MUST be gitignored so a
value never travels when the project's folder is git-shared.

Invariant: ``write_env_local`` force-adds ``.env.local`` to the project's
``.gitignore`` BEFORE writing, and refuses to write if that assertion cannot be
established. See ``docs/secret_share.md``.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from dotenv import dotenv_values, set_key, unset_key

if TYPE_CHECKING:
    from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)

ENV_LOCAL_FILENAME = ".env.local"
_GITIGNORE_FILENAME = ".gitignore"
_GITIGNORE_LINE = ".env.local"


class EnvLocalNotWritable(RuntimeError):
    """Raised when the project has no writable mount dir, or ``.env.local`` cannot
    be proven gitignored — writing a value would risk leaking it on git-share."""


def _project_dir(project: "Project") -> Optional[Path]:
    mount = getattr(project, "fs_storage_mount_path", None)
    if not mount:
        return None
    p = Path(mount)
    return p if p.is_dir() else None


def _env_path(project: "Project") -> Optional[Path]:
    d = _project_dir(project)
    return (d / ENV_LOCAL_FILENAME) if d is not None else None


def ensure_gitignored(project: "Project") -> bool:
    """Make sure ``.env.local`` is excluded by the project's ``.gitignore``.

    Idempotent: appends the line only when absent. Returns True when the exclusion
    is in place (or the dir isn't a git repo, in which case there's nothing to leak
    *to* — a share requires a git origin). Returns False only when we can't write
    the ``.gitignore`` at all.
    """
    d = _project_dir(project)
    if d is None:
        return False
    gitignore = d / _GITIGNORE_FILENAME
    try:
        existing = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
        lines = {ln.strip() for ln in existing.splitlines()}
        if _GITIGNORE_LINE in lines:
            return True
        sep = "" if (existing == "" or existing.endswith("\n")) else "\n"
        gitignore.write_text(f"{existing}{sep}{_GITIGNORE_LINE}\n", encoding="utf-8")
        return True
    except OSError as e:  # noqa: BLE001
        logger.warning("[env-local] could not write .gitignore for %s: %s", d, e)
        return False


def write_env_local(project: "Project", key: str, value: str) -> None:
    """Write ``key=value`` into the project's ``.env.local``.

    Force-gitignores first; refuses (raises) if that can't be established so a value
    never lands in a committable file.
    """
    path = _env_path(project)
    if path is None:
        raise EnvLocalNotWritable("project has no writable mount dir for .env.local")
    if not ensure_gitignored(project):
        raise EnvLocalNotWritable(".env.local could not be gitignored; refusing to write a value")
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


def delete_env_local(project: "Project", key: str) -> None:
    path = _env_path(project)
    if path is None or not path.exists():
        return
    unset_key(str(path), key)
