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


def default_roots() -> list[FSRef]:
    """Return the three canonical roots plus any env-supplied extras.

    USER_HOME_FOLDER comes from InstanceSettings.user_home so test mode
    (which sandboxes user_home) walks the sandbox, not the real home.
    """
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    settings = get_instance_settings()
    roots: list[FSRef] = [
        FSRef(
            settings.user_home,
            record_type=RecordType.USER_HOME_FOLDER,
            scope="user",
        ),
        FSRef(
            Path.cwd(),
            record_type=RecordType.CWD_ROOT,
            scope="project",
        ),
    ]

    try:
        from flow_sdk.config import flowpad_assistant_project_root
        system_root = flowpad_assistant_project_root()
        if system_root.is_dir():
            roots.append(
                FSRef(
                    system_root,
                    record_type=RecordType.SYSTEM_ROOT,
                    scope="system",
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
