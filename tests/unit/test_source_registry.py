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

from flow_sdk.ingest.source_registry import SourceLoadError, content_hash, load_source

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SOURCE = '''
from flow_sdk.sources.base import Source
from .helper import GREETING


class WikiSource(Source):
    provider = "{name}"
    greeting = GREETING
'''


def _folder(root: Path, name: str = "wiki", source: str | None = SOURCE, helper: str = 'GREETING = "hi"\n') -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "data_source.json").write_text(json.dumps({"schema": 1, "name": name, "title": "Wiki", "kind": "datasource.wiki"}))
    if source is not None:
        (folder / "source.py").write_text(source.format(name=name))
    (folder / "helper.py").write_text(helper)
    return folder


def test_a_folder_becomes_a_source_type_with_its_helper_imported_relatively(tmp_path):
    stype = load_source(_folder(tmp_path))
    assert (stype.provider, stype.kind, stype.cls.greeting) == ("wiki", "datasource.wiki", "hi")
    assert stype.folder == tmp_path / "wiki" and stype.content_hash == content_hash(tmp_path / "wiki")


def test_a_folder_with_no_source_py_says_so(tmp_path):
    with pytest.raises(SourceLoadError, match="no source.py"):
        load_source(_folder(tmp_path, source=None))


def test_exactly_one_source_class(tmp_path):
    two = SOURCE + "\n\nclass OtherSource(Source):\n    provider = 'other'\n"
    with pytest.raises(SourceLoadError, match="exactly one Source subclass"):
        load_source(_folder(tmp_path, source=two))


def test_the_class_names_the_manifests_source(tmp_path):
    folder = _folder(tmp_path)
    (folder / "source.py").write_text(SOURCE.format(name="not-wiki"))
    with pytest.raises(SourceLoadError, match="manifest names 'wiki'"):
        load_source(folder)


def test_an_import_error_is_a_load_error_naming_the_file(tmp_path):
    with pytest.raises(SourceLoadError, match="source.py failed to import"):
        load_source(_folder(tmp_path, source="import no_such_module_anywhere\n"))


def test_a_changed_folder_loads_as_a_new_module(tmp_path):
    folder = _folder(tmp_path)
    first = load_source(folder)
    (folder / "helper.py").write_text('GREETING = "hello"\n')
    second = load_source(folder)
    assert (first.cls.greeting, second.cls.greeting) == ("hi", "hello")
    assert first.cls.__module__ != second.cls.__module__


async def test_an_authored_folder_cannot_take_a_shipped_name(tmp_path, monkeypatch):
    from flow_sdk.ingest import source_registry
    from flow_sdk.ingest.sources import source_type

    shipped = source_type("rss")
    monkeypatch.setattr(source_registry, "_authored_folder", lambda name: _async(_folder(tmp_path, name="rss")))
    assert await source_registry.resolve_source_type("rss") is shipped


async def test_an_authored_folder_loads_on_first_use(tmp_path, monkeypatch):
    from flow_sdk.ingest import source_registry
    from flow_sdk.ingest.sources import SOURCES

    folder = _folder(tmp_path, name="wiki-authored")
    monkeypatch.setattr(source_registry, "_authored_folder", lambda name: _async(folder))
    try:
        loaded = await source_registry.resolve_source_type("wiki-authored")
        assert loaded is not None and loaded.provider == "wiki-authored"
        assert source_registry.load_error_for("wiki-authored") == ""
    finally:
        SOURCES.unregister("wiki-authored")


async def _async(value):
    return value
