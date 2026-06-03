"""FolderNote — the ``<folder>/<folder>.md`` doc that represents a folder.

Obsidian "folder note" convention: a directory ``auth/`` is represented by a
sibling markdown file inside it whose stem matches the folder basename
(case-insensitive) — ``auth/auth.md``. In flowpad this is the doc that adopts
its siblings as children (via ``reconcile_folder_doc_edges`` on the entity
side); here, in the pure-python library, it is simply a recognised
:class:`MarkdownDocument` flavor.

The index uses it for two things: it is excluded from a folder's summarisable
"doc" leaves (a folder note represents the folder, it is not content *in* it),
and a parent index links to a subfolder via the subfolder's folder-note name
(``[[auth]]``).
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.llm_index.markdown_document import MarkdownDocument


class FolderNote(MarkdownDocument):
    """The folder note for a directory. ``FolderNote.path_for(dir)`` → its path."""

    @staticmethod
    def path_for(folder: Path | str) -> Path:
        folder = Path(folder)
        return folder / f"{folder.name}.md"

    @staticmethod
    def is_folder_note(path: Path | str) -> bool:
        """True when ``path`` is the folder note for its own directory."""
        path = Path(path)
        parent = path.parent.name
        return bool(parent) and path.stem.lower() == parent.lower()

    @classmethod
    def for_folder(cls, folder: Path | str) -> "FolderNote | None":
        """Load the folder note if it exists on disk, else ``None``."""
        note_path = cls.path_for(folder)
        if note_path.is_file():
            return cls.from_path(note_path)  # type: ignore[return-value]
        return None

    @staticmethod
    def link_name(folder: Path | str) -> str:
        """The wiki-link target a parent index uses to reference this folder."""
        return Path(folder).name
