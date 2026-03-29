"""AssetRef — a folder of agent assets (skills, agents, etc.) with worker preparation."""

from __future__ import annotations

import os
from pathlib import Path

from flow_sdk.flowpad_types.enums import WorkerType


class AssetRef:
    """A folder of local assets (skills, agents, …) that can be prepared for a worker.

    The folder layout is flat — skills, agents, and other asset dirs live directly
    under the root::

        local_assets/
          skills/
          agents/

    ``prepare(WorkerType.CLAUDE_CODE)`` makes the folder usable as a Claude Code
    ``--add-dir`` target by creating a ``.claude`` symlink inside it that points
    back to the folder itself::

        local_assets/
          skills/
          agents/
          .claude -> .          ← symlink to current dir

    With ``--add-dir local_assets/``, Claude Code finds ``.claude/`` (via the
    symlink) and discovers ``skills/``, ``agents/``, etc. inside it.
    """

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)

    @property
    def path(self) -> Path:
        return self._path

    def exists(self) -> bool:
        return self._path.is_dir()

    def has_content(self) -> bool:
        """True if the folder exists and contains at least one non-hidden entry."""
        if not self.exists():
            return False
        return any(p for p in self._path.iterdir() if not p.name.startswith("."))

    def link(self, path: str | Path, worker_type: WorkerType = WorkerType.CLAUDE_CODE) -> None:
        """Create a cross-platform symlink inside the asset root pointing to path,
        then prepare the folder for the given worker type.

        The symlink is named after the target's basename::

            local_assets/<path.name> -> <resolved path>

        Typical usage — link a skills directory so Claude can discover it::

            process.local_assets.link(skills_dir)
            # creates: local_assets/skills -> skills_dir
            # then:    local_assets/.claude -> .
        """
        target = Path(path).resolve()
        self._path.mkdir(parents=True, exist_ok=True)
        link_path = self._path / target.name
        if not link_path.exists() and not link_path.is_symlink():
            os.symlink(target, link_path, target_is_directory=target.is_dir())
        self.prepare(worker_type)

    def prepare(self, worker_type: WorkerType) -> None:
        """Prepare the asset folder for the given worker type."""
        if worker_type == WorkerType.CLAUDE_CODE:
            self._prepare_claude()

    def _prepare_claude(self) -> None:
        """Create ``<root>/.claude -> .`` so Claude Code can discover assets via --add-dir."""
        self._path.mkdir(parents=True, exist_ok=True)
        claude_link = self._path / ".claude"
        if claude_link.exists() or claude_link.is_symlink():
            return
        os.symlink(Path("."), claude_link, target_is_directory=True)
