"""A re-index of written files mints only what the walk would index.

Every file a session writes is handed to ``reindex_paths(placed_only=True)`` (the
agentic process's write reindex). It used to classify by extension alone, so a scratch ``engine.js``
became a ``dynamic_workflow`` row with no scope and no project — and the project
filter shows a scope-less workflow under every project. Thirteen of them were
listed in one project's Assets panel on a live instance.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.reindex import reindex_paths
from tests.unit.test_fs_store._index_handler_fakes import _Handler

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]


async def test_a_scratch_js_file_is_not_minted_as_a_workflow(tmp_path: Path):
    script = tmp_path / "scratchpad" / "knesset" / "engine.js"
    script.parent.mkdir(parents=True)
    script.write_text("export const meta = {name: 'x'}\n", encoding="utf-8")

    result = await reindex_paths([str(script)], placed_only=True)

    assert result.minted == [], f"a scratch .js was minted as an asset: {result.minted}"
    assert await Entity.get_by_asset_ref(str(script), resolve_containing=False) is None


async def test_a_workflow_in_its_folder_is_still_minted(tmp_path: Path):
    script = tmp_path / ".claude" / "workflows" / "review.js"
    script.parent.mkdir(parents=True)
    script.write_text("export const meta = {name: 'review', description: 'r'}\n", encoding="utf-8")

    result = await reindex_paths([str(script)], placed_only=True)

    assert len(result.minted) == 1, f"a placed workflow was not minted: {result.as_dict()}"


async def test_a_session_writing_a_scratch_js_leaves_no_row(tmp_path: Path):
    """Through the session's own seam: what every flush and turn end schedules."""
    script = tmp_path / "scratchpad" / "fix" / "probe.body.js"
    script.parent.mkdir(parents=True)
    script.write_text("console.log(1)\n", encoding="utf-8")
    ap = AgenticProcess(name="scratch-writer", agent_type="claude", cwd=str(tmp_path))

    await ap._reindex_touched([str(script)])

    row = await Entity.get_by_asset_ref(str(script), resolve_containing=False)
    assert row is None, f"the session's scratch file became a {row.type} with scope={row.scope!r}"


class _InvalidateRequest:
    """The request context of ``POST /fs-records/invalidate`` — its JSON body, nothing else."""

    def __init__(self, body: dict):
        self.request = self
        self._body = body

    async def json(self) -> dict:
        return self._body


async def test_the_invalidate_route_does_not_mint_a_scratch_js_either(tmp_path: Path):
    """The route any client can hand changed paths to: the same arbitrary paths, the same rule."""
    script = tmp_path / "scratchpad" / "memfix" / "live.js"
    script.parent.mkdir(parents=True)
    script.write_text("console.log(1)\n", encoding="utf-8")

    resp = await _Handler()._handle_fs_records_invalidate(_InvalidateRequest({"paths": [str(script)]}))

    assert resp.data["minted"] == [], f"the route minted a scratch .js: {resp.data}"
    assert await Entity.get_by_asset_ref(str(script), resolve_containing=False) is None
