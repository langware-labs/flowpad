"""An authored driver's payload kind resolves on a READ, with no sync and no await.

This is the defect the whole namespace seam exists to close, and it cost real data: a
project-authored driver minted `ingest.feed.item.usgs_earthquake` under its namespace,
wrote its values under the BARE name, and every read of the 252 rows it had just
ingested failed — in the same process that wrote them. The source parked on
`transient_error` and the rows were deleted by hand.

Two halves, both pinned here:
  * the tag written is the key registered (`--acme--.…`), so a value round-trips;
  * a kind whose namespace names a project is loadable from a synchronous read, which
    is the only thing `kind_type` can do — it runs inside a pydantic validator.

The subprocess is the point: a registry is process-global, so a test sharing one with
its neighbours proves nothing about a server that has just restarted.
"""
from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SOURCE = '''
from typing import ClassVar, Optional

from flow_sdk.sources.base import CollectionSource
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.values.items import FeedItemData, SourceItemSpec


class QuakeData(FeedItemData):
    spec_kind: ClassVar[str] = "ingest.feed.item.quake"
    magnitude: Optional[float] = None


class QuakeConfig(SourceConfig):
    feed: str = "all_day"


class QuakeSource(CollectionSource):
    Config = QuakeConfig
    provider = "quakes"

    def query(self) -> None:
        return None

    async def _lookup(self, key):
        return None

    async def _scan(self, query):
        return []

    def _item(self, key, raw) -> SourceItemSpec:
        return SourceItemSpec(origin=self.origin(key), data=QuakeData())
'''

PROBE = '''
import sys
from pathlib import Path

from flow_sdk.fs_store.operations import namespace_roots
from flow_sdk.fs_store.schema_registry import SchemaRegistry

# What the indexer does when it sees the project's manifest. Nothing else has run:
# no source has synced, no driver has been resolved by name.
namespace_roots.remember("acme", Path(sys.argv[1]))

shape = SchemaRegistry.kind_type("--acme--.ingest.feed.item.quake")
print(getattr(shape, "__name__", None))
print(SchemaRegistry.kind_type("ingest.feed.item.quake") is None)
'''


def _project(root: Path, *, ns: str = "acme") -> Path:
    folder = root / "agentic-assets" / "data_driver" / "quakes"
    folder.mkdir(parents=True)
    (folder / "data_driver.json").write_text(
        json.dumps({
            "schema": 1,
            "name": "quakes",
            "ns": ns,
            "title": "Quakes",
            "config": {"feed": {"type": "text", "label": "Feed"}},
        }),
        encoding="utf-8",
    )
    (folder / "source.py").write_text(textwrap.dedent(SOURCE), encoding="utf-8")
    return root


def _probe(root: Path) -> list[str]:
    done = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(PROBE), str(root)],
        capture_output=True, text=True, check=True,
        env={"FLOWPAD_SKIP_DOTENV": "true", "PATH": ""},
    )
    return done.stdout.split()


def test_an_authored_kind_resolves_in_a_process_that_never_synced(tmp_path):
    """The restart case. Before this, the only loader a read could reach scanned the
    SHIPPED tree, and an authored driver was reachable solely through an `async`
    resolve — which a validator cannot await."""
    assert _probe(_project(tmp_path)) == ["QuakeData", "True"]


def test_the_kind_is_not_reachable_under_the_bare_name(tmp_path):
    """The other half of the namespace's job: an authored asset cannot answer for a
    name in OUR ontology, even when it declares the same string a shipped one does."""
    assert _probe(_project(tmp_path))[1] == "True"


def test_an_unknown_namespace_loads_nothing(tmp_path):
    """No search of other projects for a matching kind: finding one under the wrong
    owner is exactly the collision the namespace exists to prevent."""
    _project(tmp_path, ns="acme")
    probe = PROBE.replace('"--acme--.ingest', '"--nobody--.ingest')
    done = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(probe), str(tmp_path)],
        capture_output=True, text=True, check=True,
        env={"FLOWPAD_SKIP_DOTENV": "true", "PATH": ""},
    )
    assert done.stdout.split()[0] == "None"
