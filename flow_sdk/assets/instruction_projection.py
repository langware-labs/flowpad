"""Shared instruction file writer; each driver declares its discovery files."""
from pathlib import Path

from flow_sdk.assets.directory import AssetDir


def project_instructions(
    assets: AssetDir, instructions: str, *, discovery_file: str | None = None,
    frontmatter: str = "",
) -> Path | None:
    if not instructions:
        return None
    prompt_file = assets.load_asset("CLAUDE.md", content=instructions + "\n")
    if discovery_file:
        assets.load_asset(discovery_file, content=frontmatter + instructions + "\n")
    return prompt_file
