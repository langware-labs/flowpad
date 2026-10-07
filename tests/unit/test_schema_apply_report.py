"""`flow schema apply` reports each data schema folder from the row indexed at its path."""

from __future__ import annotations

from pathlib import Path

from flow_sdk.cli.commands.schema_cmd import apply_report, schema_folders_under


def test_each_folder_reports_ok_its_error_or_not_indexed():
    ok, bad, missing = (Path("/p") / n for n in ("gtm.icp", "gtm.campaign", "gtm.lost"))
    report = apply_report(
        {
            ok: {"name": "gtm.icp", "subkind": "record", "fields": {"title": {}, "name": {}}},
            bad: {"name": "gtm.campaign", "error": "'gtm.chanel' names a kind nobody defines"},
            missing: None,
        }
    )
    assert report[0] == {
        "folder": str(ok),
        "kind": "gtm.icp",
        "status": "ok",
        "subkind": "record",
        "fields": ["name", "title"],
    }
    assert report[1]["status"] == "error" and "nobody defines" in report[1]["error"]
    assert report[2] == {"folder": str(missing), "kind": "gtm.lost", "status": "error", "error": "not indexed"}


def test_the_kind_is_the_folder_name_not_a_stale_name_in_the_file():
    renamed = Path("/p/gtm.touchpoint")
    (entry,) = apply_report({renamed: {"name": "gtm.channel", "fields": {}}})
    assert entry["kind"] == "gtm.touchpoint" and entry["status"] == "ok"


def test_a_second_folder_defining_the_same_kind_is_a_duplicate():
    one, two = Path("/a/gtm.icp"), Path("/b/gtm.icp")
    report = apply_report({one: {"name": "gtm.icp", "fields": {}}, two: None})
    assert report[0]["status"] == "ok"
    assert report[1]["status"] == "error" and str(one) in report[1]["error"]


def test_a_folder_under_a_grouping_folder_without_a_manifest_says_what_to_write(tmp_path):
    inner = tmp_path / "agentic-assets" / "data_schema" / "gtm" / "agentic-assets" / "data_schema" / "gtm.ref"
    inner.mkdir(parents=True)
    (entry,) = apply_report({inner: None})
    assert "data_schema/gtm groups schemas" in entry["error"] and '"type": "data_schema"' in entry["error"]


def test_apply_finds_the_schemas_from_a_group_its_family_folder_or_agentic_assets(tmp_path):
    def schema(parent, name):
        folder = parent / "agentic-assets" / "data_schema" / name
        folder.mkdir(parents=True)
        (folder / "data_schema.json").write_text('{"type": "data_schema"}')
        return folder

    group = schema(tmp_path, "people")
    persona, use_case = schema(group, "gtm.persona"), schema(group, "gtm.use_case")
    icp = schema(tmp_path, "gtm.icp")
    everything = {group, persona, use_case, icp}
    assert set(schema_folders_under(group)) == {group, persona, use_case}
    assert set(schema_folders_under(tmp_path / "agentic-assets" / "data_schema")) == everything
    assert set(schema_folders_under(tmp_path / "agentic-assets")) == everything
    assert set(schema_folders_under(tmp_path)) == everything
    assert schema_folders_under(persona) == [persona]
