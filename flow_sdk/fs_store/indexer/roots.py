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


def is_home_or_ancestor(path: Path | str, home: Path) -> bool:
    """True if ``path`` is ``$HOME``, an ancestor of ``$HOME``, or the FS root.

    Such a path must never become a folder-walker root: it would recurse the
    entire home tree (~900k folders / minutes per scan) and, where outermost
    dedup applies, subsume every real project. Used by every root-construction
    flow that feeds ``project_folder_walker_fn`` — the CWD_ROOT guard in
    ``default_roots`` and the REAL_PROJECT_CWD guard in ``_resolve_scoped_roots``.
    """
    try:
        c = Path(path).resolve()
        h = home.resolve()
    except OSError:
        return False
    # Direction matters: home relative-to path ⇒ path is home or an ancestor.
    return h.is_relative_to(c)


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


_CWD_PID_CACHE: dict[str, str | None] = {}


def resolve_project_id_for_cwd(cwd: str | None) -> str | None:
    """Sync resolve a ``cwd`` to the project id to stamp on a record.

    The single cross-worker, cross-platform primitive for "which project owns
    this path". Used by the indexer to stamp ``project_id`` on cwd-bearing
    records whose FSRef parent chain has no project-scoped ancestor — codex /
    copilot sessions (expanded under USER_HOME_FOLDER, not under a PROJECT
    node), received transcripts, etc.

    Resolution, all over the *canonical* posix path so it matches how Projects
    store ``fs_storage_mount_path`` regardless of OS / symlinks / unicode form:

      1. An existing Project entity at this canonical path → its **real entity
         id** (scanned from the few project rows; mount path lives in the JSON
         ``data`` blob, not a column, so a column lookup isn't possible).
      2. Otherwise the path-derived uuid5 alias
         (``Project.derive_id_for_path``). ``resolve_project_scope`` already
         normalizes that alias to the real id at query time, and the frontend
         ``getProjectByPath`` resolves it authoritatively at tab time, so a
         not-yet-created project still scopes correctly and reconciles on the
         next project re-index.

    Sync (indexer context) — reads the sqlite file directly, mirroring
    ``lookup_project_id_by_uname``. Returns ``None`` only for an empty cwd.
    """
    if not cwd:
        return None

    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

    # Cache only confirmed real-id hits — a project's id won't change once it
    # exists. The derived-alias fallback is intentionally NOT cached so a
    # project created later in this process's lifetime (e.g. by a project
    # walker in the same index run) is picked up on the next call instead of
    # being masked by a stale alias. Keyed by the RAW cwd so a repeat hit —
    # the common case, many sessions sharing one project cwd — skips both the
    # Path.resolve() syscall and the project-table scan.
    cached = _CWD_PID_CACHE.get(cwd)
    if cached is not None:
        return cached

    try:
        canonical = canonical_posix_path(cwd)
    except OSError:
        return None

    real = _lookup_project_id_by_cwd(canonical)
    if real is not None:
        _CWD_PID_CACHE[cwd] = real
        return real
    return Project.derive_id_for_path(canonical)


def _lookup_project_id_by_cwd(canonical: str) -> str | None:
    """Sync sqlite scan for the real Project entity id at ``canonical`` posix cwd.

    ``fs_storage_mount_path`` lives inside the JSON ``data`` column (not a
    dedicated column), so we load the few project rows and compare canonical
    paths in Python — the sync mirror of ``Project.find_by_cwd``. Returns the
    matching entity id, or ``None`` (no project yet / any DB error).
    """
    import json
    import sqlite3

    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    db_path = get_instance_settings().db_path
    if not db_path:
        return None
    try:
        conn = open_sqlite(db_path)
    except sqlite3.Error:
        return None
    try:
        cur = conn.execute("SELECT id, data FROM entities WHERE type='project'")
        for row in cur.fetchall():
            raw = row[1]
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            mount = data.get("fs_storage_mount_path") or data.get("cwd")
            if not mount:
                continue
            try:
                if canonical_posix_path(mount) == canonical:
                    return row[0]
            except OSError:
                continue
        return None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def flowpad_assistant_scoped_roots() -> tuple[FSRef, ...]:
    """The SYSTEM_ROOT FSRef(s) for the SDK-shipped Flowpad Assistant project,
    anchored at the **live install location** (``flowpad_assistant_project_root``
    resolves via ``importlib.resources`` → wherever flow_sdk is installed).

    Shared by ``default_roots()`` and the startup system-asset index so both
    scope the assistant subtree identically (and re-anchor to the current
    install on every run). Empty tuple when the project tree isn't present.
    """
    try:
        from flow_sdk.config import (  # noqa: PLC0415
            FLOWPAD_ASSISTANT_PROJECT_UNAME,
            flowpad_assistant_project_root,
        )
        system_root = flowpad_assistant_project_root()
        if not system_root.is_dir():
            return ()
        # Use the project's stored id (may be uuid5 or legacy uuid4) so children
        # stamped via FSRef parent-chain inheritance match the entity rows the
        # DocsCategory / asset list query against.
        system_pid = lookup_project_id_by_uname(FLOWPAD_ASSISTANT_PROJECT_UNAME)
        return (
            FSRef(
                system_root,
                record_type=RecordType.SYSTEM_ROOT,
                scope="system",
                project_id=system_pid,
            ),
        )
    except Exception:
        return ()


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
    if not is_home_or_ancestor(cwd, settings.user_home):
        roots.append(
            FSRef(
                cwd,
                record_type=RecordType.CWD_ROOT,
                scope=Scope.PROJECT.value,
                project_id=Project.derive_id_for_path(cwd),
            )
        )

    roots.extend(flowpad_assistant_scoped_roots())

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
