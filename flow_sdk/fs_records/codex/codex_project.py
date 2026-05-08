"""CodexProjectFsRecord — backward-compat alias for the consolidated ``ProjectFsRecord``.

Codex projects are no longer a distinct record type. They share the single
``RecordType.PROJECT`` row with their Claude counterparts, distinguished by
the ``codex_project: bool`` provenance flag. The id is a random uuid4 and
the natural key is the canonical posix cwd.

This module is retained for backward compatibility — existing imports of
``CodexProjectFsRecord`` continue to work, and helper functions used by the
Codex indexer (``_is_valid_cwd``, ``_read_codex_projects_from_config``) are
preserved here for the indexer-function module to import.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.fs_records.claude.claude_project import ProjectFsRecord

try:  # Python 3.11+
    import tomllib as _tomllib  # type: ignore[import-not-found]
except ImportError:  # Python 3.10 — repo includes tomli in venv.
    import tomli as _tomllib  # type: ignore[import-not-found,no-redef]


_TEMP_PATH_PREFIXES = (
    "/tmp/",
    "/var/folders/",
    "/private/var/folders/",
    "/private/tmp/",
)


def _codex_project_id(cwd: str) -> str:
    """Backward-compat: deterministic id used by old code that pre-computed
    Codex project ids by path. The consolidated record uses random uuid4 ids
    and is fetched by ``cwd`` (see ``ProjectFsRecord.find_by_cwd``); this helper
    is retained only because the system-profile collectors still call it. Phase 7
    of the consolidation removes both the helper and its callers.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"codex_project:{cwd}"))


def _is_valid_cwd(cwd: str) -> bool:
    """Filter out system/temp paths that should never appear as user projects."""
    if not cwd or not cwd.startswith("/"):
        return False
    return not cwd.startswith(_TEMP_PATH_PREFIXES)


def _read_codex_projects_from_config(config_path: Path) -> dict[str, dict]:
    """Return ``{absolute_path: {trust_level}}`` from ``config.toml``."""
    if not config_path.is_file():
        return {}
    try:
        with open(config_path, "rb") as fh:
            data = _tomllib.load(fh)
    except (OSError, ValueError):
        return {}
    projects = data.get("projects")
    if not isinstance(projects, dict):
        return {}
    out: dict[str, dict] = {}
    for path, entry in projects.items():
        if not isinstance(path, str) or not _is_valid_cwd(path):
            continue
        if isinstance(entry, dict):
            out[path] = {"trust_level": entry.get("trust_level")}
        else:
            out[path] = {"trust_level": None}
    return out


# ──────────────────────────────────────────────────────────────────────────
# Backward-compat alias
# ──────────────────────────────────────────────────────────────────────────
# All Codex-specific record behavior now lives on ``ProjectFsRecord`` with
# the ``codex_project=True`` flag. This name is kept so existing imports
# resolve; Phase 7 of the consolidation removes it entirely.

CodexProjectFsRecord = ProjectFsRecord


if TYPE_CHECKING:
    # Keep the type checker happy for imports of the alias as a class symbol.
    _: type[ProjectFsRecord] = CodexProjectFsRecord
