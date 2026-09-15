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
    driver = CliDriver(client, monkeypatch)
    assert isinstance((await driver.flow("list"))["sources"], list)
    assert (await driver.flow("types"))["types"]


@pytest.mark.parametrize("name", NAMES)
async def test_the_source_works_through_the_cli(name, client, monkeypatch, tmp_path):
    await run_case(name, CliDriver(client, monkeypatch), client, monkeypatch, tmp_path)
