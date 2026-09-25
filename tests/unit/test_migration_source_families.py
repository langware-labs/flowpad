"""``migration_2026_09_source_families``: an authored driver written before the families existed gets
the family its class body says, still loads, and a second run changes nothing."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.ingest.driver_registry import load_driver
from flow_sdk.migrations.migration_2026_09_source_families import convert_text, migrate

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

FEED = '''from flow_sdk.sources.base import CollectionSource
from flow_sdk.sources.values.items import FeedItemData, SourceItemSpec


class QuakeSource(CollectionSource):
    provider = "{name}"

    async def _scan(self, query):
        return []

    async def _lookup(self, key):
        return None

    def _item(self, key, raw) -> SourceItemSpec: ...
'''

FILES = '''from flow_sdk.sources.base import Source


class ShareSource(Source):
    provider = "{name}"
    reflects = True
    local_tree_key = "root"
'''

CHAT = '''from flow_sdk.sources.base import Source


class ChatSource(Source):
    provider = "{name}"

    def message_for(self, **kwargs): ...

    async def send(self, data): ...

    async def reply(self, origin, data): ...
'''


def _driver(root: Path, name: str, source: str, reflect: list[str] | None = None) -> Path:
    folder = root / "agentic-assets" / "data_driver" / name
    folder.mkdir(parents=True)
    manifest = {"schema": 1, "name": name, "kind": f"datasource.test.{name}", "ns": "acme"}
    if reflect:
        manifest["reflect"] = reflect
    (folder / "data_driver.json").write_text(json.dumps(manifest))
    (folder / "source.py").write_text(source.format(name=name))
    return folder


def test_each_authored_driver_gets_its_family_and_loads(tmp_path):
    quake = _driver(tmp_path, "quake", FEED)
    share = _driver(tmp_path, "share", FILES, reflect=["none"])
    chat = _driver(tmp_path, "chatter", CHAT)

    dry = migrate(dry_run=True, roots=[tmp_path])
    assert dict(dry.converted) == {"RecordSource": 1, "ObjectSource": 1, "MessageSource": 1}
    assert "RecordSource" not in (quake / "source.py").read_text(), "a dry run writes nothing"

    applied = migrate(dry_run=False, roots=[tmp_path])
    assert applied.changed and not applied.unconverted
    assert "class QuakeSource(RecordSource, CollectionSource):" in (quake / "source.py").read_text()
    assert "reflects" not in (share / "source.py").read_text()
    assert [load_driver(f).cls.family.value for f in (quake, share, chat)] == ["record", "object", "message"]

    again = migrate(dry_run=False, roots=[tmp_path])
    assert not again.converted and again.scanned == 3


def test_a_file_it_cannot_read_safely_is_reported_and_left(tmp_path):
    two = FEED + "\n\nclass Other(CollectionSource):\n    provider = 'other'\n"
    folder = _driver(tmp_path, "twice", two)
    report = migrate(dry_run=False, roots=[tmp_path])
    assert not report.converted and list(report.unconverted.values()) == [[str((folder / "source.py").resolve())]]
    assert (folder / "source.py").read_text() == two.format(name="twice")


def test_a_driver_that_already_has_a_family_is_untouched():
    text = "from flow_sdk.sources.families import RecordSource\n\n\nclass X(RecordSource):\n    provider = 'x'\n"
    assert convert_text(text) == (text, "")
