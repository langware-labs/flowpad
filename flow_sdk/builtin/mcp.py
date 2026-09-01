"""``Mcp`` — FlowPad's own MCP-server asset.

A folder at ``<scope>/agentic-assets/mcp/<name>/`` whose ``mcp.json`` IS an
``McpSpec``. Attach one to an Agent by writing it under that agent's folder and
every process the agent creates launches with it, on any harness.

Distinct from ``MCP_SERVER`` (``fs_store/indexer/functions/mcp_server.py``),
which is the read-only INVENTORY of servers already configured in a vendor's own
files (``~/.claude.json``, ``.codex/config.toml``, …). That one records a
definition site we do not own and cannot write; this one is ours end to end.

``asset_class="repo"`` rather than ``"shared"`` on purpose: SHARED means fan-out
into each harness's dot-dir, and no harness reads MCP from a dot-dir — they take
it on the command line (see ``cli_drivers/mcp_projection.py``). A flowpad-native
asset is REPO.
"""
from __future__ import annotations

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.data_spec.mcp_spec import McpSpec
from flow_sdk.schema.types import EntityType

MCP_MAIN_FILE = "mcp.json"


class Mcp(Entity):
    """The ROW. Its shape on disk is ``McpSpec`` (``TypeInfo.asset_spec``)."""

    type: str = APIField(default=EntityType.MCP.value)

    # ── the McpSpec fields, round-tripped through mcp.json ────────────────
    transport: str = APIField(default="stdio", description="stdio | http | sse")
    command: str = APIField(default="")
    args: list[str] = APIField(default_factory=list)
    env: dict[str, str] = APIField(default_factory=dict)
    url: str = APIField(default="")
    asset_ref: str = APIField(default="")

    def to_spec(self) -> McpSpec:
        """The launch payload this asset describes.

        Projected field-by-field off the row rather than ``**self.model_dump()``:
        the row carries entity columns (``asset_ref``, timestamps, …) that
        ``McpSpec``'s ``extra="forbid"`` would reject.
        """
        return McpSpec(
            name=self.name or self.id,
            transport=self.transport or "stdio",
            command=self.command or "",
            args=list(self.args or []),
            env=dict(self.env or {}),
            url=self.url or "",
        )
