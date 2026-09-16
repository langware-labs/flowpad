"""FrontMatterFsRef — markdown file reference with YAML frontmatter support."""

from __future__ import annotations

from flow_sdk.fs_store.fs_ref.base import FSRef, _read_existing_frontmatter


class FrontMatterFsRef(FSRef):
    """Markdown file reference with YAML frontmatter read/write support.

    ref_type = "frontmatter_md"

    Provides typed access to the frontmatter dict and body of a .md file.
    All write methods raise IOError when the ref is read-only.
    """

    def _ref_type(self) -> str:
        return "frontmatter_md"

    def read_frontmatter(self) -> dict:
        """Parse and return the YAML frontmatter dict. Returns {} if file absent or no frontmatter."""
        if not self._path.exists():
            return {}
        return _read_existing_frontmatter(self._path)

    def read_body(self) -> str:
        """Return the markdown body (text after the closing --- delimiter). Returns '' if file absent."""
        if not self._path.exists():
            return ""
        from flow_sdk.assets.document import read_document

        return read_document(self._path).body.strip()

    def write_frontmatter(self, fields: dict) -> None:
        """Merge fields into the existing frontmatter, preserving the body."""
        if self.read_only:
            raise IOError(f"FrontMatterFsRef at {self.path!r} is read-only")
        from flow_sdk.assets.document import write_document

        write_document(self._path, fields=fields)

    def write_body(self, body: str) -> None:
        """Replace the body while preserving the existing frontmatter."""
        if self.read_only:
            raise IOError(f"FrontMatterFsRef at {self.path!r} is read-only")
        from flow_sdk.assets.document import write_document

        write_document(self._path, body=body)

    def write_doc(self, body: str, frontmatter: dict) -> None:
        """Atomically write frontmatter + body while preserving capsule blocks."""
        if self.read_only:
            raise IOError(f"FrontMatterFsRef at {self.path!r} is read-only")
        from flow_sdk.assets.document import write_document

        write_document(self._path, body=body, fields=frontmatter, replace_fields=True)
