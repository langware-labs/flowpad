"""A miss on the targeted discover path never becomes a full index run.

``resolve_asset`` → ``index_one`` resolves ONE path and indexes ONE asset; a path
that is not an asset of the type asked for answers None. The indexer entry
is spied on, so a regression that "recovers" by walking the roots fails here
rather than in a user's ten-second click.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer import FSIndexer
from flow_sdk.schema.type_info import register_all
from tests.fixtures.identity import index_path


@pytest.fixture(scope="module", autouse=True)
def _registry() -> None:
    register_all()


@pytest.fixture
def indexer_spy(monkeypatch: pytest.MonkeyPatch) -> list:
    calls: list = []

    async def _index(self, *args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("targeted discover must not run the indexer")

    monkeypatch.setattr(FSIndexer, "index", _index)
    return calls


async def test_a_miss_does_not_walk(tmp_path: Path, indexer_spy: list) -> None:
    assert await index_path("skill", str(tmp_path / "no-such-skill")) is None
    assert await index_path("markdown", str(tmp_path / "missing.md")) is None
    assert indexer_spy == []


async def test_a_type_that_does_not_claim_the_path_is_a_miss(tmp_path: Path, indexer_spy: list) -> None:
    py = tmp_path / "server.py"
    py.write_text("x = 1\n", encoding="utf-8")

    assert await index_path("markdown", str(py)) is None
    assert indexer_spy == []


async def test_a_hit_indexes_exactly_that_asset(tmp_path: Path, indexer_spy: list) -> None:
    doc = tmp_path / "one.md"
    doc.write_text("# one\n", encoding="utf-8")

    record = await index_path("markdown", str(doc))

    assert record is not None and record.id
    assert Path(record.asset_path) == doc.resolve()
    assert indexer_spy == []
