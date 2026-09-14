"""Application defaults for the filesystem subagent loader."""

from pathlib import Path

from flow_sdk.assets.types.subagent import get_subagent as read_subagent_record
from flow_sdk.assets.types.subagent import load_subagent as read_subagent
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.instance_settings import get_instance_settings


def _system_roots() -> list[Path]:
    from flow_sdk.config import flowpad_assistant_project_root

    return [
        flowpad_assistant_project_root() / ".claude" / "agents",
        Path.home() / "Flowpad workspace" / ".flow" / "system_assets" / "agents",
    ]


def load_system_subagent(name: str) -> FSRecord | None:
    return read_subagent(name, _system_roots())


def load_subagent(name: str, project_dir: str | Path | None = None) -> FSRecord | None:
    roots = [get_instance_settings().claude_agents_dir]
    if project_dir is not None:
        roots.insert(0, Path(project_dir) / ".claude" / "agents")
    return read_subagent(name, roots) or load_system_subagent(name)


def get_subagent(uid: str) -> FSRecord | None:
    return (
        read_subagent_record(uid)
        or read_subagent(uid, [get_instance_settings().claude_agents_dir])
        or load_system_subagent(uid)
    )
