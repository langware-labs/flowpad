"""Default root set for the FSIndexer.

The indexer's roots are the entry points of the scope graph. This module
provides the canonical set:

  USER_HOME_FOLDER   — Path.home(),        scope="user"
  SYSTEM_ROOT        — flowpad_assistant,   scope="system"   (if available)
  CWD_ROOT           — Path.cwd(),          scope="project"

Plus any extra roots specified via the FLOWPAD_*_DIRS env vars; those get
scope="user" to match the legacy walkers, which checked env-supplied dirs
during the user-level scan.
"""

from __future__ import annotations

import os
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


_ENV_VAR_TO_TYPE = (
    "FLOWPAD_DOC_DIRS",
    "FLOWPAD_PLAN_DIRS",
    "FLOWPAD_SKILL_DIRS",
    "FLOWPAD_AGENT_DIRS",
    "FLOWPAD_WORKFLOW_DIRS",
)


def lookup_project_id_by_uname(uname: str) -> str | None:
    """Sync sqlite read of a project entity's id by uname.

    `default_roots()` is sync but the entity API is async; reading via the
    sqlite file directly avoids needing an event loop here. Returns None if
    the project hasn't been created yet, or on any DB-access error.
    """
    import sqlite3

    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    db_path = get_instance_settings().db_path
    if not db_path:
        return None
    try:
        conn = open_sqlite(db_path)
    except sqlite3.Error:
        return None
    try:
        cur = conn.execute(
            "SELECT id FROM entities WHERE type='project' AND uname=? LIMIT 1",
            (uname,),
        )
        row = cur.fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def classify_path(path: str | Path) -> str | None:
    """Classify a filesystem path into a scope tag matching ``default_roots()``.

    Returns ``"system"`` when ``path`` lives under the SDK-shipped system
    project, ``"user"`` when under InstanceSettings.user_home, ``"project"``
    when under ``Path.cwd()``, else ``None``. Used by HTTP create handlers to
    stamp scope at create time so POST-created records match indexer-discovered
    ones.
    """
    if not path:
        return None
    try:
        target = Path(path).resolve()
    except (OSError, ValueError):
        return None

    try:
        from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415
        system_root = flowpad_assistant_project_root().resolve()
        if target == system_root or system_root in target.parents:
            return "system"
    except Exception:
        pass

    try:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
        user_home = get_instance_settings().user_home.resolve()
        if target == user_home or user_home in target.parents:
            return "user"
    except Exception:
        pass

    try:
        cwd = Path.cwd().resolve()
        if target == cwd or cwd in target.parents:
            return "project"
    except OSError:
        pass

    return None


def default_roots() -> list[FSRef]:
    """Return the three canonical roots plus any env-supplied extras.

    USER_HOME_FOLDER comes from InstanceSettings.user_home so test mode
    (which sandboxes user_home) walks the sandbox, not the real home.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_store.scope import Scope  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    settings = get_instance_settings()
    cwd = Path.cwd()
    roots: list[FSRef] = [
        FSRef(
            settings.user_home,
            record_type=RecordType.USER_HOME_FOLDER,
            scope=Scope.USER.value,
        ),
    ]

    # Only register the CWD as a project root when it isn't the user's home
    # directory. The desktop app can launch the backend with cwd=$HOME; treating
    # $HOME as a project root makes project_folder_walker_fn recurse the whole
    # home tree (Desktop, ~/Library/Mobile Documents, other-app containers, the
    # media library) — each first access trips a macOS TCC prompt attributed to
    # Flowpad. USER_HOME_FOLDER already covers home via targeted expanders, so a
    # home-rooted CWD_ROOT adds nothing but that recursive walk.
    try:
        cwd_is_home = cwd.resolve() == settings.user_home.resolve()
    except OSError:
        cwd_is_home = False
    if not cwd_is_home:
        roots.append(
            FSRef(
                cwd,
                record_type=RecordType.CWD_ROOT,
                scope=Scope.PROJECT.value,
                project_id=Project.derive_id_for_path(cwd),
            )
        )

    try:
        from flow_sdk.config import (
            FLOWPAD_ASSISTANT_PROJECT_UNAME,
            flowpad_assistant_project_root,
        )
        system_root = flowpad_assistant_project_root()
        if system_root.is_dir():
            # Use the project's stored id (may be uuid5 or legacy uuid4) so
            # children stamped via FSRef parent-chain inheritance match the
            # entity DocsCategory queries against.
            system_pid = lookup_project_id_by_uname(FLOWPAD_ASSISTANT_PROJECT_UNAME)
            roots.append(
                FSRef(
                    system_root,
                    record_type=RecordType.SYSTEM_ROOT,
                    scope="system",
                    project_id=system_pid,
                )
            )
    except Exception:
        pass

    seen: set[str] = {str(r._path) for r in roots}
    for env_var in _ENV_VAR_TO_TYPE:
        for raw in os.environ.get(env_var, "").split(":"):
            p = raw.strip()
            if not p:
                continue
            path = Path(p)
            if not path.is_dir():
                continue
            resolved = str(path.resolve())
            if resolved in seen:
                continue
            seen.add(resolved)
            # Env-supplied dirs get scope="user" to match legacy behavior
            # (they were checked inside the user-level walk).
            roots.append(
                FSRef(
                    path,
                    record_type=RecordType.CWD_ROOT,
                    scope="user",
                )
            )

    return roots
