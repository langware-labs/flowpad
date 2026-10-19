"""Filesystem MCP specs and portable entrypoint resolution."""
from pathlib import Path

from flow_sdk.assets.asset import Asset
from flow_sdk.schema.data_spec.mcp_spec import McpSpec


def resolve_mcp_spec(spec: McpSpec, folder: Path | None) -> McpSpec:
    if not spec.entrypoint or folder is None:
        return spec
    root = folder.resolve()
    entrypoint = (root / spec.entrypoint).resolve()
    if not entrypoint.is_relative_to(root):
        raise ValueError("MCP entrypoint escapes its asset folder")
    return spec.model_copy(update={"args": [*spec.args, str(entrypoint)]})


def read_mcp_assets(paths: list[Path]) -> tuple[McpSpec, ...]:
    specs = []
    for path in paths:
        if not path.exists():
            continue
        asset = Asset.from_path(path)
        spec = McpSpec.model_validate_json(asset.layout.body.read_text(encoding="utf-8"))
        specs.append(resolve_mcp_spec(spec, asset.path))
    return tuple(specs)
