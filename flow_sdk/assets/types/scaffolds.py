"""Type-declared, additive asset scaffolds. Existing authored files win."""
from __future__ import annotations

from pathlib import Path

from flow_sdk.assets.directory import AssetDir
from flow_sdk.assets.types.graph_workflow_doc import GraphWorkflowDoc
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.mcp_spec import McpSpec


def render_graph_document(spec, info) -> str | None:
    """Only a complete typed graph is a write; a metadata-only row is not."""
    if not isinstance(spec, GraphWorkflowDoc):
        return None
    return spec.model_dump_json(indent=2, by_alias=True, exclude_none=True) + "\n"


SERVER_TEMPLATE = '''"""MCP server for {name}.

Every function decorated with ``@mcp.tool`` becomes a tool the agent can call;
the docstring is what it reads to decide when to call it. Edit freely — this
file IS the server, and it ships inside this asset.
"""

from fastmcp import FastMCP

mcp = FastMCP({name!r})


@mcp.tool
def hello(who: str = "world") -> str:
    """Say hello. Replace this with a tool of your own."""
    return f"hello {{who}}"
'''


def _missing_file(directory: AssetDir, name: str, content: str) -> None:
    target = directory.os_path / name
    if not target.exists() and not target.is_symlink():
        directory.load_asset(name, content=content)


def _graph(path: Path, spec: GraphWorkflowDoc, typeid: TypeId, *, scripts: bool) -> None:
    directory = AssetDir(path)
    directory.ensure()
    for name in (("runs", "scripts") if scripts else ("runs",)):
        if not (path / name).exists():
            directory.subdir(name)
    _missing_file(directory, "graph.json", render_graph_document(spec.model_copy(update={"id": typeid.id}), None))
    _missing_file(directory, "display.json", '{"version": 1, "nodes": {}}\n')


def scaffold_graph_workflow(path: Path, spec: GraphWorkflowDoc, typeid: TypeId) -> None:
    _graph(path, spec, typeid, scripts=True)


def scaffold_journey(path: Path, spec: GraphWorkflowDoc, typeid: TypeId) -> None:
    _graph(path, spec, typeid, scripts=False)


def scaffold_mcp(path: Path, spec: McpSpec, typeid: TypeId) -> None:
    from flow_sdk.assets.types.mcp import resolve_mcp_spec

    if spec.entrypoint:
        resolve_mcp_spec(spec, path)  # Validate containment before creating anything.
        _missing_file(AssetDir(path), spec.entrypoint, SERVER_TEMPLATE.format(name=spec.name))


def render_whiteboard_document(spec, info) -> str:
    from flow_sdk.assets.frontmatter import _render_frontmatter
    from flow_sdk.assets.types.whiteboard_spec import WhiteboardSpec

    document = WhiteboardSpec.model_validate(spec.model_dump(include={"name", "description"}))
    return _render_frontmatter(document.model_dump()) + "\n\n"


def scaffold_whiteboard(path: Path, spec, typeid: TypeId) -> None:
    """Repair only the absent main document; authored board data always wins."""
    from flow_sdk.assets.types.whiteboard import WHITE_BOARD_MD

    _missing_file(AssetDir(path), WHITE_BOARD_MD, render_whiteboard_document(spec, None))
