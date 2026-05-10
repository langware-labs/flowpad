"""Indexer function: USER_HOME_FOLDER -> PROJECT.

Given a user HOME directory node, enumerates encoded project directories
under <home>/.claude/projects/ and emits one PROJECT node per directory.

With opts.include_temp=False (default), encoded dirs whose decoded path
starts with a temp-dir prefix (/tmp/, /var/folders/, /private/tmp/,
/private/var/folders/) are skipped. Downstream functions (sessions,
memory) never visit those dirs because the walker never descends.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_records.claude.claude_project import _TEMP_PATH_PREFIXES
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _is_temp_encoded(encoded: str) -> bool:
    """Mirror of ClaudeProjectFsRecord._is_valid_project_dir (inverted)."""
    decoded = "/" + encoded.lstrip("-").replace("-", "/")
    return decoded.startswith(_TEMP_PATH_PREFIXES)


async def claude_projects_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    import uuid as _uuid
    out: list[FSRef] = []
    for node in nodes:
        projects_dir = Path(node.path) / ".claude" / "projects"
        if not projects_dir.is_dir():
            continue
        for child in sorted(projects_dir.iterdir()):
            if not child.is_dir():
                continue
            if not opts.include_temp and _is_temp_encoded(child.name):
                continue
            # Derive project_id from the decoded path so descendants inherit
            # it via the FSRef parent chain. Matches Project.allocate_id's
            # uuid5(DNS, "project:<mount_path>") so the id round-trips.
            decoded = "/" + child.name.lstrip("-").replace("-", "/")
            pid = str(_uuid.uuid5(_uuid.NAMESPACE_DNS, f"project:{decoded}"))
            out.append(
                FSRef(
                    child,
                    record_type=RecordType.PROJECT,
                    parent=node,
                    scope="project",
                    project_id=pid,
                )
            )
    return out
