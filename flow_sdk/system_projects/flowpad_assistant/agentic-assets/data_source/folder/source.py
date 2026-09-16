"""``WatchedFolderSource`` — the ``folder`` data source: a local directory someone watches.

The generic ``FolderSource`` plus the policy a watched tree needs. Hidden entries and
dependency trees are pruned as the walk goes, so a poll never enumerates a ``node_modules``;
setup is verified in the words a person acts on. It runs in-process: it reads this machine's
own tree and holds no credential.
"""
from __future__ import annotations

import os

from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.folder import FolderSource
from flow_sdk.sources.protocols import Verdict

#: Directory names never descended, beyond anything hidden. Not a ``.gitignore``: the indexer
#: owns that for its own walk; this is the minimum that keeps a poll off a dependency tree.
DEPENDENCY_DIRS = frozenset({"node_modules", "__pycache__", "venv"})


def _skipped(name: str) -> bool:
    return name.startswith(".") or name in DEPENDENCY_DIRS


class WatchedFolderSource(FolderSource):
    provider = "folder"
    skip = staticmethod(_skipped)

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        if not binding.config.get("root"):
            raise ValueError("Set the folder to watch.")
        return super().namespace_for(binding)

    async def verify(self) -> Verdict:
        """Whether setup is finished — every unfinished state here is a person's to fix."""
        return await self._blocking(_verdict, self.root)

    @classmethod
    def origin_id_for(cls, row: object, ref: str, root: object) -> str:
        """The filesystem's own handle for the file at ``ref``: its inode.

        It survives a rename within the volume, which a path cannot. Re-read after every index
        pass, because stamping a capsule rewrites the file atomically and moves the inode; an
        editor that saves atomically is honestly a new file. Meaningless off its volume, so it is
        scoped to the source and never shared.
        """
        st = os.stat(ref)  # OSError → reflection falls back to the path
        return f"folder:{getattr(row, 'id', '')}:ino:{st.st_dev}:{st.st_ino}"


def _verdict(root: str) -> Verdict:
    if not os.path.exists(root):
        return Verdict(ready=False, detail=f"{root} does not exist yet.")
    if not os.path.isdir(root):
        return Verdict(ready=False, detail=f"{root} is a file, not a folder.")
    if not os.access(root, os.R_OK | os.X_OK):
        return Verdict(ready=False, detail=f"{root} is not readable.")
    return Verdict(ready=True)


__all__ = ["DEPENDENCY_DIRS", "WatchedFolderSource"]
