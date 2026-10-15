"""Icon packs as ASSETS — ``<scope>/agentic-assets/icon_pack/<name>/``.

Indexing one registers it with the icon registry, its tags resolve like the
built-in packs', and everything that would make it unsafe or ambiguous is a
reported problem rather than a silent precedence or a served script.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest

from flow_sdk.assets.types.chart import chart_icon_problems
from flow_sdk.assets.types.icon_pack import extract_icon_pack
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.icons.registry import IconRegistry, check_tags, read_asset_pack, svg_problems

SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24H0z"/></svg>'


def make_pack(scope: Path, name: str, kind: str, icons: dict[str, str]) -> Path:
    folder = scope / "agentic-assets" / "icon_pack" / name
    (folder / "assets").mkdir(parents=True)
    entries = []
    for leaf, svg in icons.items():
        if svg is not None:
            (folder / "assets" / f"{leaf}.svg").write_text(svg)
        entries.append({"kind": leaf, "asset": f"assets/{leaf}.svg", "source": "test"})
    (folder / "icon_pack.json").write_text(json.dumps({"version": 1, "kind": kind, "icons": entries}))
    return folder


@pytest.fixture
def registry(monkeypatch) -> IconRegistry:
    """A registry with the real built-in packs and no shipped assets, swapped in
    for the process-wide one so the extractors use it."""
    reg = IconRegistry(discover_shipped=False)
    monkeypatch.setattr("flow_sdk.icons.registry.icons", reg)
    monkeypatch.setattr("flow_sdk.assets.types.icon_pack.icons", reg)
    return reg


def test_project_pack_is_found_indexed_and_resolves(tmp_path, registry):
    project = tmp_path / "proj"
    folder = make_pack(project, "vendors", "acme-vendors", {"sonos": SVG})

    refs = repo_assets_fn([FSRef(project)], IndexerOptions())
    assert [r._path for r in refs if r.record_type == RecordType.ICON_PACK] == [folder]

    [rec] = extract_icon_pack(FSRef(folder), "00000000-0000-4000-8000-000000000001")
    assert (rec.name, rec.icon_count, rec.error) == ("acme-vendors", 1, "")

    hit = registry.resolve("acme-vendors.sonos")
    assert hit is not None and hit.exact
    assert hit.asset_path == "icon-packs/acme-vendors/assets/sonos.svg"
    assert registry.served_file("acme-vendors", "assets/sonos.svg") == (folder / "assets" / "sonos.svg").resolve()
    payload = {p["kind"]: p for p in registry.payload()}
    assert payload["acme-vendors"]["base"] == "icon-packs/acme-vendors"
    assert "brands" in payload and "lucide" in payload  # built-ins still served


def test_user_scope_pack_is_found(tmp_path, monkeypatch, registry):
    from flow_sdk.instance_settings import get_instance_settings

    settings = dataclasses.replace(get_instance_settings(), user_home=tmp_path / "home", user_asset_home=tmp_path / "own")
    monkeypatch.setattr("flow_sdk.instance_settings.get_instance_settings", lambda: settings)
    settings.user_home.mkdir()
    folder = make_pack(settings.user_asset_root, "mine", "my-icons", {"star": SVG})

    refs = repo_assets_fn([FSRef(settings.user_home, record_type=RecordType.USER_HOME_FOLDER)], IndexerOptions())
    assert [r._path for r in refs if r.record_type == RecordType.ICON_PACK] == [folder]
    extract_icon_pack(FSRef(folder), "00000000-0000-4000-8000-000000000002")
    assert registry.is_valid("my-icons.star")


def test_two_packs_with_one_kind_is_an_error_naming_both(tmp_path, registry):
    a = make_pack(tmp_path / "a", "v", "dup", {"x": SVG})
    b = make_pack(tmp_path / "b", "v", "dup", {"x": SVG})
    registry.add_asset_pack(a)
    problems = registry.add_asset_pack(b)

    assert len(problems) == 1 and str(a) in problems[0] and str(b) in problems[0]
    assert registry.problems(a) == problems
    assert registry.resolve("dup.x") is None  # neither wins
    assert registry.served_file("dup", "assets/x.svg") is None


def test_an_asset_pack_cannot_take_a_built_in_kind(tmp_path, registry):
    folder = make_pack(tmp_path, "v", "brands", {"slack": SVG})
    [problem] = registry.add_asset_pack(folder)
    assert "built-in 'brands'" in problem
    assert registry.resolve("brands.slack").asset_path.startswith("icons/brands/")


@pytest.mark.parametrize("svg, needle", [
    ('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "<script>"),
    ('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', "onload"),
    ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'
     '<image xlink:href="https://evil.example/x.png"/></svg>', "external reference"),
    ('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://e.x/a)"/></svg>', "url()"),
    ('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>', "DOCTYPE"),
    ("<svg", "well-formed"),
])
def test_unsafe_svg_is_rejected(tmp_path, registry, svg, needle):
    folder = make_pack(tmp_path, "v", "risky", {"bad": svg, "good": SVG})
    problems = registry.add_asset_pack(folder)

    assert any(needle in p for p in problems), problems
    assert registry.resolve("risky.bad") is None
    assert registry.served_file("risky", "assets/bad.svg") is None
    assert registry.is_valid("risky.good")  # the rest of the pack still serves


def test_inert_svg_passes(tmp_path):
    path = tmp_path / "ok.svg"
    path.write_text('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs>'
                    '<rect fill="url(#g)"/><use href="#g"/></svg>')
    assert svg_problems(path) == []


def test_missing_asset_file_is_reported(tmp_path, registry):
    folder = make_pack(tmp_path, "v", "gappy", {"gone": None, "here": SVG})
    [rec] = extract_icon_pack(FSRef(folder), "00000000-0000-4000-8000-000000000003")
    assert "gappy.gone: asset file 'assets/gone.svg' does not exist" in rec.error
    assert rec.icon_count == 1


def test_bad_manifest_and_illegal_tags_are_reported(tmp_path):
    folder = tmp_path / "p"
    folder.mkdir()
    (folder / "icon_pack.json").write_text(json.dumps({"icons": []}))
    pack = read_asset_pack(folder)
    assert pack.spec is None and "kind" in pack.problems[0]

    (folder / "icon_pack.json").write_text(json.dumps({"kind": "Not A Tag!", "icons": []}))
    assert "not a legal tag" in read_asset_pack(folder).problems[0]


def _chart(folder: Path, icons: list[str]) -> Path:
    folder.mkdir(parents=True)
    participants = [{"id": f"p{i}", "label": "x", "icon": icon} for i, icon in enumerate(icons)]
    (folder / "chart.json").write_text(json.dumps({"participants": participants, "messages": []}))
    return folder


def test_chart_with_unresolved_icon_is_reported(tmp_path, registry):
    project = tmp_path / "proj"
    make_pack(project, "vendors", "acme-vendors", {"sonos": SVG})
    chart = _chart(project / "docs" / "flow", ["acme-vendors.sonos", "lucide.zap", "brands.nosuch", "🎨", ""])

    problems = chart_icon_problems(chart)  # finds the project's pack on its own

    assert problems == ["participant p2: icon 'brands.nosuch' does not resolve to any icon pack"]


def test_check_tags_answers_per_tag(registry):
    result = check_tags(["lucide.zap", "lucide.nonexistent-glyph"], registry)
    assert result["lucide.zap"] is None
    assert "does not resolve" in result["lucide.nonexistent-glyph"]
