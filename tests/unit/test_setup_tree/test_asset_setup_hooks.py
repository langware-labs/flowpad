"""`GET asset_setup/<id>/hooks` names the wizard each hook fires — the one the setup run would pick.

Two projects may ship a wizard by one name; the run takes the copy closest to the node's own folder
(``core/setup/derive``). A screen showing a setup has to show that same wizard, not the first by name.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.asset_setup import AssetSetup
from flow_sdk.builtin.wizard import Wizard

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]


async def _wizard(project: Path, name: str) -> Wizard:
    folder = project / "agentic-assets" / "wizard" / name
    folder.mkdir(parents=True)
    wizard = Wizard(id=str(uuid.uuid4()), name=name, asset_ref=str(folder))
    await wizard.save()
    return wizard


async def test_each_hook_names_the_wizard_nearest_the_setup(tmp_path: Path):
    name = f"boot-{uuid.uuid4().hex[:6]}"
    mine = await _wizard(tmp_path / "mine", name)
    await _wizard(tmp_path / "other", name)
    setup = AssetSetup(
        id=str(uuid.uuid4()), name="db", run=name, on_load="no-such-wizard",
        asset_ref=str(tmp_path / "mine" / "agentic-assets" / "asset_setup" / "db"),
    )

    hooks = (await setup.hooks_action()).data

    assert hooks == {"prepare": None, "run": str(mine.typeid), "on_load": None}
