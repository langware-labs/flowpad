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
        try:
            from flow_sdk.fs_records._frontmatter import _extract_body
            return _extract_body(self._path.read_text(encoding="utf-8"))
        except Exception:
            return ""

    def write_frontmatter(self, fields: dict) -> None:
        """Merge fields into the existing frontmatter, preserving the body."""
        if self.read_only:
            raise IOError(f"FrontMatterFsRef at {self.path!r} is read-only")
        from flow_sdk.fs_records._frontmatter import _extract_body, _render_frontmatter
        existing_fm = _read_existing_frontmatter(self._path) if self._path.exists() else {}
        existing_fm.update(fields)
        body = ""
        if self._path.exists():
            body = _extract_body(self._path.read_text(encoding="utf-8"))
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(_render_frontmatter(existing_fm) + "\n" + body, encoding="utf-8")

    def write_body(self, body: str) -> None:
        """Replace the body while preserving the existing frontmatter."""
        if self.read_only:
            raise IOError(f"FrontMatterFsRef at {self.path!r} is read-only")
        from flow_sdk.fs_records._frontmatter import _render_frontmatter
        existing_fm = _read_existing_frontmatter(self._path) if self._path.exists() else {}
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(_render_frontmatter(existing_fm) + "\n" + body, encoding="utf-8")

    def write_doc(self, body: str, frontmatter: dict) -> None:
        """Atomically write frontmatter + body without reading the existing file first."""
        if self.read_only:
            raise IOError(f"FrontMatterFsRef at {self.path!r} is read-only")
        from flow_sdk.fs_records._frontmatter import _render_frontmatter
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(_render_frontmatter(frontmatter) + "\n" + body, encoding="utf-8")
