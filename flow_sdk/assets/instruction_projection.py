"""Shared instruction file writer; each driver declares its discovery files."""
from pathlib import Path

from flow_sdk.assets.directory import AssetDir


def _project(assets: AssetDir, relative_path: str, content: str) -> Path:
    """Write ``content`` unless the file already holds exactly it.

    The system prompt is recomposed on every turn and is usually unchanged, so
    an unconditional write would be a temp-dir + atomic replace per file per turn.
    """
    target = assets.os_path / relative_path
    try:
        if not target.is_symlink() and target.read_text(encoding="utf-8") == content:
            return target
    except OSError:
        pass
    return assets.load_asset(relative_path, content=content)


def project_instructions(
    assets: AssetDir, instructions: str, *, discovery_file: str | None = None,
    frontmatter: str = "",
) -> Path | None:
    if not instructions:
        return None
    prompt_file = _project(assets, "CLAUDE.md", instructions + "\n")
    if discovery_file:
        _project(assets, discovery_file, frontmatter + instructions + "\n")
    return prompt_file
