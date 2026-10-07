"""`flow schema apply` reports each data schema folder from the row its index wrote."""

from __future__ import annotations

from flow_sdk.cli.commands.schema_cmd import apply_report


def test_each_folder_reports_ok_its_error_or_not_indexed(tmp_path):
    ok, bad, missing = (str(tmp_path / n) for n in ("ok", "bad", "missing"))
    rows = [
        {
            "name": "gtm.icp",
            "subkind": "record",
            "fields": {"title": {}, "name": {}},
            "asset_occurrences": [{"path": ok}],
        },
        {
            "name": "gtm.campaign",
            "error": "'gtm.chanel' names a kind nobody defines",
            "asset_occurrences": [{"path": bad}],
        },
    ]
    report = apply_report([ok, bad, missing], rows)
    assert report[0] == {
        "folder": ok,
        "kind": "gtm.icp",
        "status": "ok",
        "subkind": "record",
        "fields": ["name", "title"],
    }
    assert report[1]["status"] == "error" and "nobody defines" in report[1]["error"]
    assert report[2] == {"folder": missing, "status": "error", "error": "not indexed"}


def test_a_second_folder_defining_the_same_kind_is_a_duplicate(tmp_path):
    one, two = str(tmp_path / "one"), str(tmp_path / "two")
    rows = [{"name": "gtm.icp", "fields": {}, "asset_occurrences": [{"path": one}, {"path": two}]}]
    report = apply_report([one, two], rows)
    assert report[0]["status"] == "ok"
    assert report[1]["status"] == "error" and one in report[1]["error"]
