"""The source loader: an asset folder becomes a source type, and every way it cannot says why.

The shipped sources are the happy path the whole suite rides on; these pin the author's failures —
no ``source.py``, two classes, a class that names another source, an import error — the relative
import of a helper module beside the source, the reload of a changed folder, and a folder that
claims a shipped source's name.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_registry import DriverLoadError, content_hash, load_driver

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SOURCE = '''
from flow_sdk.sources.families import RecordSource
from .helper import GREETING


class WikiSource(RecordSource):
    provider = "{name}"
    greeting = GREETING
'''


def _folder(root: Path, name: str = "wiki", source: str | None = SOURCE, helper: str = 'GREETING = "hi"\n') -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    # `ns`: this folder is not under SHIPPED_ROOT, so it is an EXTERNAL driver and
    # must name the ontology its kinds belong to. See the refusal test below.
    (folder / "data_driver.json").write_text(json.dumps(
        {"schema": 1, "name": name, "title": "Wiki", "kind": "datasource.wiki", "ns": "acme"}
    ))
    if source is not None:
        (folder / "source.py").write_text(source.format(name=name))
    (folder / "helper.py").write_text(helper)
    return folder


def test_an_external_driver_must_name_its_ontology(tmp_path):
    """A driver outside the shipped tree mints kinds into SOMEONE's namespace.

    Left unnamed they land in ours, so an authored `whatsapp` declaring
    `ingest.message.whatsapp` collides with the shipped one and whichever
    imported second used to win in silence. Refused before `source.py` is
    imported, because the import is what registers the kinds.
    """
    folder = _folder(tmp_path)
    body = json.loads((folder / "data_driver.json").read_text())
    body.pop("ns")
    (folder / "data_driver.json").write_text(json.dumps(body))

    with pytest.raises(DriverLoadError, match="declares no `ns`"):
        load_driver(folder)


def test_a_folder_becomes_a_source_type_with_its_helper_imported_relatively(tmp_path):
    stype = load_driver(_folder(tmp_path))
    assert (stype.provider, stype.kind, stype.cls.greeting) == ("wiki", "datasource.wiki", "hi")
    assert stype.folder == tmp_path / "wiki" and stype.content_hash == content_hash(tmp_path / "wiki")


def test_a_folder_with_no_source_py_says_so(tmp_path):
    with pytest.raises(DriverLoadError, match="no source.py"):
        load_driver(_folder(tmp_path, source=None))


def test_exactly_one_source_class(tmp_path):
    two = SOURCE + "\n\nclass OtherSource(RecordSource):\n    provider = 'other'\n"
    with pytest.raises(DriverLoadError, match="exactly one Source subclass"):
        load_driver(_folder(tmp_path, source=two))


def test_the_class_names_the_manifests_source(tmp_path):
    folder = _folder(tmp_path)
    (folder / "source.py").write_text(SOURCE.format(name="not-wiki"))
    with pytest.raises(DriverLoadError, match="manifest names 'wiki'"):
        load_driver(folder)


def test_a_driver_extends_one_family(tmp_path):
    """``Source`` alone is no family: the author picks files, records or messages — and a message source
    that cannot answer is refused, so "sends" is the family and nothing else."""
    bare = SOURCE.replace("from flow_sdk.sources.families import RecordSource", "from flow_sdk.sources.base import Source")
    with pytest.raises(DriverLoadError, match="extends Source directly"):
        load_driver(_folder(tmp_path, source=bare.replace("(RecordSource)", "(Source)")))
    mute = SOURCE.replace("RecordSource", "MessageSource")
    with pytest.raises(DriverLoadError, match="must send and reply"):
        load_driver(_folder(tmp_path, name="mute", source=mute))


def test_the_manifest_reflect_modes_are_the_familys(tmp_path):
    """A file source lands on disk (filesystem modes); a record or message source lands as records."""
    files = SOURCE.replace("RecordSource", "ObjectSource")
    with pytest.raises(DriverLoadError, match="cannot offer reflect `record`"):
        load_driver(_folder(tmp_path, name="drive", source=files))
    folder = _folder(tmp_path, name="table")
    body = json.loads((folder / "data_driver.json").read_text())
    (folder / "data_driver.json").write_text(json.dumps({**body, "reflect": ["copy"]}))
    with pytest.raises(DriverLoadError, match=r'must be \["record"\]'):
        load_driver(folder)


def test_every_shipped_driver_has_the_family_its_items_are():
    """The shipped split, pinned: four file sources, two record sources, and every channel a message source."""
    from flow_sdk.ingest.driver_registry import SHIPPED_ROOT

    families: dict[str, list[str]] = {}
    for folder in sorted(SHIPPED_ROOT.iterdir()):
        if (folder / "data_driver.json").is_file():
            families.setdefault(load_driver(folder).cls.family.value, []).append(folder.name)
    assert families["object"] == ["folder", "gcs", "gdrive", "git"]
    assert families["record"] == ["hackernews", "rss"]
    assert len(families["message"]) == 15 and "slack" in families["message"]


def test_an_import_error_is_a_load_error_naming_the_file(tmp_path):
    with pytest.raises(DriverLoadError, match="source.py failed to import"):
        load_driver(_folder(tmp_path, source="import no_such_module_anywhere\n"))


def test_a_changed_folder_loads_as_a_new_module(tmp_path):
    folder = _folder(tmp_path)
    first = load_driver(folder)
    (folder / "helper.py").write_text('GREETING = "hello"\n')
    second = load_driver(folder)
    assert (first.cls.greeting, second.cls.greeting) == ("hi", "hello")
    assert first.cls.__module__ != second.cls.__module__


async def test_an_authored_folder_cannot_take_a_shipped_name(tmp_path, monkeypatch):
    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.ingest import driver_registry

    shipped = DataDriver.loaded("rss")
    monkeypatch.setattr(driver_registry, "_authored_folder", lambda name: _async(_folder(tmp_path, name="rss")))
    assert await DataDriver.get("rss") is shipped


async def test_an_authored_folder_loads_on_first_use(tmp_path, monkeypatch):
    from flow_sdk.ingest import driver_registry
    from flow_sdk.ingest.driver_runtime import DRIVERS

    folder = _folder(tmp_path, name="wiki-authored")
    monkeypatch.setattr(driver_registry, "_authored_folder", lambda name: _async(folder))
    try:
        loaded = await DataDriver.get("wiki-authored")
        assert loaded is not None and loaded.provider == "wiki-authored"
        assert driver_registry.load_error_for("wiki-authored") == ""
    finally:
        DRIVERS.unregister("wiki-authored")


async def _async(value):
    return value
