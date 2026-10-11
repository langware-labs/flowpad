"""Routing integrity for the data-management skill (modelled on the connect-data-source one).

Every routing row points at a file that exists, every file is reachable from a row, and the
ground rules -- inlined in every mode file on purpose -- cannot drift apart silently. The two
that decide right from wrong answers are pinned by name: the probe gate and the silent ``Any``.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.timeout(5)

SKILL_DIR = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/data-management"
)
INDEX = SKILL_DIR / "SKILL.md"
IGNORED_DIRS = {".flow", "__pycache__"}


def _routed_paths(text: str) -> set[str]:
    return set(re.findall(r"(?:modes|references|scripts)/[A-Za-z0-9_.-]+", text))


def _authored_files() -> list[Path]:
    return [
        p for p in SKILL_DIR.rglob("*")
        if p.is_file() and p != INDEX and not any(part in IGNORED_DIRS for part in p.relative_to(SKILL_DIR).parts)
    ]


def test_the_skill_is_installed_where_it_ships_from():
    assert INDEX.is_file(), f"no SKILL.md at {SKILL_DIR}"


def test_every_routing_row_resolves():
    for ref in sorted(_routed_paths(INDEX.read_text(encoding="utf-8"))):
        assert (SKILL_DIR / ref).is_file(), f"SKILL.md routes to {ref}, which does not exist"


def test_no_unreachable_files():
    routed = _routed_paths(INDEX.read_text(encoding="utf-8"))
    for path in _authored_files():
        rel = str(path.relative_to(SKILL_DIR))
        assert rel in routed, f"{rel} is in the skill but no routing row mentions it"


def test_every_mode_file_inlines_the_ground_rules():
    for mode in sorted((SKILL_DIR / "modes").glob("*.md")):
        text = mode.read_text(encoding="utf-8")
        assert "Ground rules (inline by design)" in text, f"{mode.name} lost its ground rules"
        assert "Prove it in a probe first" in text, f"{mode.name} must gate on the probe"
        assert "silently `Any`" in text, f"{mode.name} must say an unknown kind is Any"
        assert "never widen" in text.lower(), mode.name


def test_scripts_run_on_the_workers_interpreter():
    # A bare `python3` may resolve to an interpreter without flow_sdk (the worker env contract).
    for path in [INDEX, *_authored_files()]:
        if path.suffix == ".md":
            text = path.read_text(encoding="utf-8")
            assert "python3 <" not in text and "python3 scripts" not in text, f"{path.name} runs a bare python3"


def test_the_skill_never_reaches_for_the_navigating_verb():
    forbidden = "flow " + "navigate"
    for path in [INDEX, *_authored_files()]:
        if path.suffix == ".md":
            assert forbidden not in path.read_text(encoding="utf-8"), f"{path.name} names the navigating verb"


def test_the_description_carries_the_triggering_burden():
    fm = yaml.safe_load(INDEX.read_text(encoding="utf-8").split("---")[1])
    description = fm["description"]
    assert fm["name"] == "data-management"
    for phrase in ("schema", "dataset", "rows", "probe", "migrate", "data_spec"):
        assert phrase in description.lower(), f"the description never mentions {phrase!r}"
    assert "NOT for" in description


def test_the_index_stays_an_index():
    assert len(INDEX.read_text(encoding="utf-8").splitlines()) < 300


def test_dm_ctl_shields_namespaced_kinds_from_argparse(monkeypatch, capsys):
    """``--acme--.crm.lead`` starts with ``--``: argparse read it as an option and every
    ``kind`` / ``check`` call on a project kind died with a usage error (found on a live probe)."""
    import importlib.util
    import json

    spec = importlib.util.spec_from_file_location("dm_ctl", SKILL_DIR / "scripts/dm_ctl.py")
    dm_ctl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dm_ctl)
    seen = {}
    monkeypatch.setitem(dm_ctl.VERBS, "check", (lambda args: seen.update(vars(args)) or {}, dm_ctl.VERBS["check"][1]))
    assert dm_ctl.main(["check", "--acme--.crm.lead", '{"name": "x"}']) == 0
    assert seen["kind"] == "--acme--.crm.lead" and seen["value"] == '{"name": "x"}'
    assert json.loads(capsys.readouterr().out) == {"ok": True}


def _dm_ctl():
    import importlib.util

    spec = importlib.util.spec_from_file_location("dm_ctl", SKILL_DIR / "scripts/dm_ctl.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _probe(tmp_path, ns="dmprobeabc"):
    root = tmp_path / "dm-probe-abc"
    (root / "agentic-assets/project_manifest").mkdir(parents=True)
    (root / "agentic-assets/project_manifest/project_manifest.json").write_text(f'{{"ns": "{ns}"}}')
    return root


def test_probe_copy_drops_entity_ids_so_the_probe_never_takes_over_real_rows(tmp_path):
    """A copied asset that kept its id re-pointed the REAL asset's index row at the probe on apply,
    and probe-drop then deleted it (found by a fresh review on GTM Studio)."""
    import json
    from types import SimpleNamespace

    dm_ctl, root = _dm_ctl(), _probe(tmp_path)
    src = tmp_path / "real/agentic-assets/data_schema/crm"
    (src / "agentic-assets/data_schema/crm.lead").mkdir(parents=True)
    (src / "data_schema.json").write_text('{"type": "data_schema", "id": "3b67874b-140b-4984-90f7-14a04d270143", "ns": "acme"}')
    (src / "description.md").write_text("---\nid: 3b67874b-140b-4984-90f7-14a04d270143\ntitle: CRM\n---\nThe family.\n")
    lead = src / "agentic-assets/data_schema/crm.lead"
    (lead / "data_schema.json").write_text('{"type": "data_schema", "id": "ff4967ef-c3f7-4b10-91ee-cc2643164b0e", "fields": {}}')
    out = dm_ctl.cmd_probe_copy(SimpleNamespace(root=str(root), src=[str(src)], no_rows=False))
    dest = root / "agentic-assets/data_schema/crm"
    assert out["ids_dropped"] == 2 and dm_ctl._asset_ids(dest) == {}       # the grouping folder's id is in both files
    assert set(json.loads((root / dm_ctl.PROBE_MANIFEST).read_text())["foreign_ids"]) == {
        "3b67874b-140b-4984-90f7-14a04d270143", "ff4967ef-c3f7-4b10-91ee-cc2643164b0e"}
    assert "id" not in json.loads((dest / "data_schema.json").read_text())
    assert (dest / "description.md").read_text() == "---\ntitle: CRM\n---\nThe family.\n"
    assert json.loads((src / "data_schema.json").read_text())["id"]          # the source is untouched


def test_probe_copy_renames_every_project_namespace_whichever_call_copied_it(tmp_path):
    import json
    from types import SimpleNamespace

    dm_ctl, root = _dm_ctl(), _probe(tmp_path)
    schema = tmp_path / "real/agentic-assets/data_schema/crm"
    schema.mkdir(parents=True)
    (schema / "data_schema.json").write_text('{"type": "data_schema", "ns": "acme"}')
    ds = tmp_path / "real/agentic-assets/dataset/leads"
    (ds / "examples/dana").mkdir(parents=True)
    (ds / "dataset.json").write_text('{"id": "1", "metadata": {"spec": {"examples": [{"input": "--acme--.crm.lead"}]}}}')
    dm_ctl.cmd_probe_copy(SimpleNamespace(root=str(root), src=[str(schema)], no_rows=False))
    out = dm_ctl.cmd_probe_copy(SimpleNamespace(root=str(root), src=[str(ds)], no_rows=True))   # a SECOND call
    manifest = json.loads((root / "agentic-assets/dataset/leads/dataset.json").read_text())
    assert manifest["metadata"]["spec"]["examples"][0]["input"] == "--dmprobeabc--.crm.lead"
    assert out["renamed_namespaces"] == ["acme"] and not (root / "agentic-assets/dataset/leads/examples").exists()


def test_probe_drop_refuses_a_probe_whose_assets_carry_ids(tmp_path, monkeypatch):
    from types import SimpleNamespace

    dm_ctl, root = _dm_ctl(), _probe(tmp_path)
    src = tmp_path / "real/agentic-assets/data_schema/crm"
    src.mkdir(parents=True)
    (src / "data_schema.json").write_text('{"type": "data_schema", "id": "3b67874b-140b-4984-90f7-14a04d270143", "ns": "acme"}')
    dm_ctl.cmd_probe_copy(SimpleNamespace(root=str(root), src=[str(src)], no_rows=False))
    # the probe's own apply mints ids of its own -- those never block a drop ...
    (root / "agentic-assets/data_schema/crm/data_schema.json").write_text('{"id": "9d1c0b52-63f4-4e1b-8f0e-5a7d2c1b3e4f"}')
    assert "9d1c0b52-63f4-4e1b-8f0e-5a7d2c1b3e4f" in dm_ctl._asset_ids(root)
    # ... the REAL asset's id, put back by hand, does
    (root / "agentic-assets/data_schema/crm/data_schema.json").write_text('{"id": "3b67874b-140b-4984-90f7-14a04d270143"}')
    calls = []
    monkeypatch.setattr(dm_ctl, "_call", lambda method, path, body=None: calls.append((method, path)) or {"fs_storage_mount_path": str(root)})
    with pytest.raises(ValueError, match="carry entity ids"):
        dm_ctl.cmd_probe_drop(SimpleNamespace(project_id="p1"))
    assert all(m == "GET" for m, _ in calls) and root.exists()           # nothing deleted


def _dm_calls(monkeypatch, argv, answer=None):
    """Run one dm_ctl verb with the transport doubled: what it asked the server for."""
    dm_ctl, calls = _dm_ctl(), []
    monkeypatch.setattr(dm_ctl, "_dataset", lambda ref: {"id": "ds1"})
    monkeypatch.setattr(dm_ctl, "_call", lambda method, path, body=None: calls.append((method, path, body)) or (answer or {}))
    assert dm_ctl.main(argv) == 0
    return calls


def test_dm_ctl_reads_some_rows_with_one_filter_parameter(monkeypatch, capsys):
    import json
    from urllib.parse import parse_qs, urlsplit

    match = {"op": "$GE", "operands": ["input.day", "2026-09-01"]}
    ((method, path, body),) = _dm_calls(monkeypatch, ["ds-rows", "leads", "--match", json.dumps(match), "--order", '{"input.day": "desc"}',
                                                      "--limit", "50", "--offset", "0"], {"rows": [{"key": "a"}], "total": 9, "problems": []})
    assert (method, body, urlsplit(path).path) == ("GET", None, "/graph/dataset/ds1/rows")
    assert json.loads(parse_qs(urlsplit(path).query)["filter"][0]) == {"match": match, "order_by": {"input.day": "desc"}, "limit": 50, "offset": 0}
    out = json.loads(capsys.readouterr().out)
    assert (out["count"], out["total"]) == (1, 9)                              # one came back, nine matched

    ((_, plain, _),) = _dm_calls(monkeypatch, ["ds-rows", "leads"])
    assert plain == "/graph/dataset/ds1/rows"                                   # nothing asked: every row, as before


def test_dm_ctl_counts_with_a_match_and_groups(monkeypatch):
    import json
    from urllib.parse import parse_qs, urlsplit

    ((method, path, _),) = _dm_calls(monkeypatch, ["ds-count", "leads", "--match", '{"input.stage": "won"}', "--group-by", "input.owner,input.day"])
    query = parse_qs(urlsplit(path).query)
    assert (method, urlsplit(path).path) == ("GET", "/graph/dataset/ds1/count")
    assert json.loads(query["filter"][0]) == {"match": {"input.stage": "won"}} and query["group_by"] == ["input.owner,input.day"]


def test_dm_ctl_writes_many_rows_in_one_call(monkeypatch):
    rows = '[{"key": "a", "input": {"name": "A"}}]'
    assert _dm_calls(monkeypatch, ["ds-put-many", "leads", rows, "--expected", '{"a": "v1"}']) == [
        ("POST", "/graph/dataset/ds1/put-rows", {"rows": [{"key": "a", "input": {"name": "A"}}], "expected": {"a": "v1"}})]
    assert _dm_calls(monkeypatch, ["ds-put-many", "leads", rows])[0][2] == {"rows": [{"key": "a", "input": {"name": "A"}}]}
    assert _dm_calls(monkeypatch, ["ds-sync", "leads", rows]) == [
        ("POST", "/graph/dataset/ds1/sync-rows", {"rows": [{"key": "a", "input": {"name": "A"}}], "prune": True})]
    assert _dm_calls(monkeypatch, ["ds-sync", "leads", rows, "--no-prune", "--match", '{"input.source": "crm"}'])[0][2] == {
        "rows": [{"key": "a", "input": {"name": "A"}}], "prune": False, "match": {"input.source": "crm"}}


def test_dm_ctl_deletes_one_row_or_several_in_one_step(monkeypatch, capsys):
    assert _dm_calls(monkeypatch, ["ds-delete", "leads", "a", "--expected", "v1"]) == [
        ("POST", "/graph/dataset/ds1/delete-row", {"key": "a", "expected": "v1"})]
    assert _dm_calls(monkeypatch, ["ds-delete", "leads", "a", "b", "c"]) == [
        ("POST", "/graph/dataset/ds1/delete-rows", {"keys": ["a", "b", "c"]})]
    dm_ctl = _dm_ctl()
    monkeypatch.setattr(dm_ctl, "_dataset", lambda ref: {"id": "ds1"})
    capsys.readouterr()
    assert dm_ctl.main(["ds-delete", "leads", "a", "b", "--expected", "v1"]) == 1   # one version cannot vouch for two rows
    assert "--expected takes one key" in capsys.readouterr().out
