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

import contextlib
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.schema.data_spec.mcp_spec import McpSpec
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.responses.response import ApiSuccessResponse

logger = logging.getLogger(__name__)

MCP_MAIN_FILE = "mcp.json"

#: Bound on a Test probe — spawn (or dial) + handshake + tools/list. Same
#: user-approved 10s budget as ``faas/mcp_reconcile.py``'s CLI probe, restated
#: rather than imported: that one caps a ``claude mcp list`` subprocess, a
#: different probe that happens to want the same number. ``fastmcp.Client``
#: takes it directly, so no ``asyncio.wait_for`` is added. Do not raise it to
#: make a slow server pass.
MCP_PROBE_TIMEOUT_SECONDS = 10.0

#: What a bundled server is scaffolded as. The default `entrypoint`, and the
#: file `SERVER_TEMPLATE` is written to.
MCP_DEFAULT_ENTRYPOINT = "server.py"

#: The starter a "write it here" MCP is born with. Deliberately runnable on
#: creation — the point of the shape is that Test passes before you have typed
#: anything. ``fastmcp`` ships in the backend venv, whose bin dir
#: ``flow_cli_env_path`` already prepends to every worker's PATH.
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


async def probe_mcp(spec: McpSpec) -> dict:
    """Connect to one MCP server and list its tools. Never raises.

    Takes a SPEC, not an entity, so the same probe answers for a scanned
    ``MCP_SERVER`` row too — ``McpSpec.from_record`` is the bridge, and
    ``McpServerCapabilityRunner.test`` (``core/capabilities/mcp.py``) is the
    stub whose docstring defers exactly this validation.

    Probes THE PROJECTION: ``to_mcp_servers_json`` is the body claude and
    copilot are handed at spawn and ``fastmcp.Client`` accepts it directly, so
    one path covers stdio, http and sse and the probe cannot drift from launch.
    """
    from fastmcp import Client  # noqa: PLC0415

    from flow_sdk.builtin.agentic_process.cli_drivers.mcp_projection import (  # noqa: PLC0415
        to_mcp_servers_json,
    )

    client = Client(
        to_mcp_servers_json([spec]),
        init_timeout=MCP_PROBE_TIMEOUT_SECONDS,
        timeout=MCP_PROBE_TIMEOUT_SECONDS,
    )
    try:
        async with client:
            tools = await client.list_tools()
    except Exception as exc:  # noqa: BLE001 — a broken server must not 500 the button
        logger.info("mcp probe failed for %s: %s", spec.name, exc, exc_info=True)
        return {"ok": False, "tools": [], "detail": str(exc) or type(exc).__name__}
    finally:
        # REQUIRED, and not what `async with` does: a stdio transport defaults to
        # keep_alive=True, so leaving the block parks the spawned server for
        # reuse instead of reaping it. Without this every probe leaks a live
        # process for the backend's lifetime. In `finally`, not inside the
        # `with`, so a failed handshake is cleaned up too — and suppressed,
        # because a teardown that raises would replace the answer we already
        # have with a 500.
        with contextlib.suppress(Exception):
            await client.close()

    names = [getattr(t, "name", "") for t in tools]
    return {
        "ok": True,
        "tools": names,
        "detail": f"connected — {len(names)} tool{'' if len(names) == 1 else 's'}",
    }


def scaffold_mcp_folder(entity: "Mcp") -> None:
    """Write a bundled server's starter file, once.

    Runs from ``Mcp.save`` rather than the create dialog because the asset-list
    ``+``, the CLI and an agent-authored create all reach ``save`` and none of
    them sees a dialog — scaffolding client-side would quietly skip them.

    Idempotent by existence check, mirroring ``scaffold_graph_workflow_folder``:
    a later save must never clobber the code the user has since written.
    """
    if not entity.entrypoint or entity.folder is None:
        return
    target = entity.folder / entity.entrypoint
    if target.exists():
        return
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(SERVER_TEMPLATE.format(name=entity.name or "mcp"), encoding="utf-8")
    except OSError:
        logger.debug("mcp: could not scaffold %s", target, exc_info=True)


class Mcp(Entity):
    """The ROW. Its shape on disk is ``McpSpec`` (``TypeInfo.asset_spec``)."""

    type: str = APIField(default=EntityType.MCP.value)

    # ── the McpSpec fields, round-tripped through mcp.json ────────────────
    transport: str = APIField(default="stdio", description="stdio | http | sse")
    command: str = APIField(default="")
    args: list[str] = APIField(default_factory=list)
    env: dict[str, str] = APIField(default_factory=dict)
    url: str = APIField(default="")
    entrypoint: str = APIField(
        default="",
        description="Bundled server: path to the code file, relative to this asset's folder.",
    )
    asset_ref: str = APIField(default="")

    def to_spec(self) -> McpSpec:
        """The launch payload this asset describes.

        Projected field-by-field off the row rather than ``**self.model_dump()``:
        the row carries entity columns (``asset_ref``, timestamps, …) that
        ``McpSpec``'s ``extra="forbid"`` would reject.

        A BUNDLED server's ``entrypoint`` is resolved here, and only here — this
        is the one place holding both the spec fields and ``asset_ref``. The file
        keeps the relative path (portable); the launch payload gets the absolute
        one, so ``mcp_projection`` and all four harnesses stay unchanged.
        """
        args = [*(self.args or [])]
        if self.entrypoint and self.folder is not None:
            args.append(str(self.folder / self.entrypoint))
        return McpSpec(
            name=self.name or self.id,
            transport=self.transport or "stdio",
            command=self.command or "",
            args=args,
            env=dict(self.env or {}),
            url=self.url or "",
            entrypoint=self.entrypoint or "",
        )

    @action.post(action_name="test")
    async def test_action(self) -> "ApiSuccessResponse":
        """Connect to this server and list its tools. ``POST /graph/mcp/<id>/test``

        Probes THE PROJECTION, not a second description of it:
        ``to_mcp_servers_json`` is the same body claude and copilot are handed at
        spawn, and ``fastmcp.Client`` accepts it directly — so one call path
        covers stdio, http and sse, and the test cannot drift from the launch.

        Never raises: a broken command is an answer (``ok: false``), not a 500 —
        the rule ``DataSource.verify_action`` states as "a driver must not 500
        the button".
        """
        from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

        spec = self.to_spec()
        if spec.is_bundled and not (self.folder / self.entrypoint).is_file():  # folder is set once saved
            return ApiSuccessResponse(
                data={"ok": False, "tools": [], "detail": f"{self.entrypoint} is missing from this asset"}
            )
        return ApiSuccessResponse(data=await probe_mcp(spec))

    async def save(self, *args, **kwargs):  # type: ignore[override]
        """Save, then scaffold a bundled server's file if it has none yet.

        After ``super()``: ``asset_ref`` is only stamped during the save, so the
        folder is not known before it.
        """
        result = await super().save(*args, **kwargs)
        scaffold_mcp_folder(self)
        return result

    @property
    def folder(self) -> "Path | None":
        """This asset's folder, or ``None`` before it has been saved.

        ``asset_ref`` IS the folder for this type. Guarded like ``Journey.folder``:
        unguarded, an unsaved row yields ``Path("")`` → ``.``, and a caller
        would stat ``./server.py`` against the backend's cwd.
        """
        return Path(self.asset_ref) if self.asset_ref else None
