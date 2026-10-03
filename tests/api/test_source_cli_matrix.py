"""The data source matrix, CLI surface: every shipped data source × every verb, through ``flow source``.

The same scenario as the REST matrix (``tests/api/_source_matrix.py``), driven through the real typer
commands with their HTTP bridged into the in-process app — the one thing a run against a live server
has that a test cannot — so the option shapes, the envelope parsing and the exit codes are the
command's own.
"""
from __future__ import annotations

import pytest

from tests.api._source_matrix import NAMES, CliDriver, run_case

pytestmark = pytest.mark.asyncio


async def test_types_and_list_answer(client, monkeypatch):
    # `types` lists the INDEXED data drivers -- what the boot index of the shipped assets leaves in
    # a real instance. A test client never runs that index, so it indexes the shipped drivers this
    # matrix runs; without it the answer depended on whether an earlier test had indexed one.
    from flow_sdk.config import system_projects_root
    from tests.fixtures.identity import index_path

    shipped = system_projects_root() / "flowpad_assistant" / "agentic-assets" / "data_driver"
    for name in NAMES:
        await index_path("data_driver", shipped / name, write=False)

    driver = CliDriver(client, monkeypatch)
    assert isinstance((await driver.flow("list"))["sources"], list)
    listed = {row["name"] for row in (await driver.flow("types"))["types"]}
    assert set(NAMES) <= listed, f"shipped drivers missing from `flow source types`: {sorted(set(NAMES) - listed)}"


@pytest.mark.parametrize("name", NAMES)
async def test_the_source_works_through_the_cli(name, client, monkeypatch, tmp_path):
    await run_case(name, CliDriver(client, monkeypatch), client, monkeypatch, tmp_path)
