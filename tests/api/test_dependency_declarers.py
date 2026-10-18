"""``GET project/<id>/dependencies?declarers=1`` lists every declaring asset, not deduped."""
import pytest

from tests.unit.test_asset_dependencies import _clean, _depends, _layers, _source  # noqa: F401 — autouse fixture

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def test_two_assets_declaring_one_dependency_are_both_declarers(bootstrapped_client, tmp_path):
    (personal, team, company), (me_p, _, _) = await _layers(tmp_path)
    twin = await _source(tmp_path, me_p, "twin")
    _depends(twin, {"dependencies": {"team-kb": str(team.typeid)}})
    url = f"/api/v1/graph/project/{me_p.id}/dependencies"

    plain = (await bootstrapped_client.get(url)).json()["data"]
    assert "declarers" not in plain
    assert [s["name"] for s in plain["dependencies"]].count("team-kb") == 1, "the walk still lists it once"

    response = await bootstrapped_client.get(url, params={"declarers": "1"})
    assert response.status_code == 200, response.text
    declarers = {d["asset"]: d for d in response.json()["data"]["declarers"]}
    team_entry = {"key": "team-kb", "source": str(team.typeid), "typeid": str(team.typeid), "name": "team-kb", "state": "ready"}
    for own in (personal, twin):
        assert declarers[str(own.typeid)]["via_path"] == []
        assert declarers[str(own.typeid)]["type"] == own.typeid.type
        assert declarers[str(own.typeid)]["dependencies"] == [team_entry]
    reached = declarers[str(team.typeid)]
    assert reached["via_path"] == ["data_source/personal", "team-kb"]
    assert [d["typeid"] for d in reached["dependencies"]] == [str(company.typeid)]
    assert reached["dependencies"][0]["name"] == "Company knowledge"
    assert declarers[str(twin.typeid)]["path"] == "agentic-assets/data_source/twin"


async def test_a_docs_chart_is_an_own_declarer_named_by_its_folder(bootstrapped_client, tmp_path):
    """A chart found by the docs walk (``docs/**``) declares like any own asset: listed with
    ``via_path`` ``[]``; the chart it reaches is named by its own folder, not the entry label."""
    import uuid
    from pathlib import Path

    from flow_sdk.builtin.chart import Chart
    from tests.unit.test_asset_dependencies import _project

    project = await _project(tmp_path, "net")
    root = Path(project.fs_storage_mount_path)

    async def chart(name: str) -> Chart:
        folder = root / "docs" / "network" / name
        folder.mkdir(parents=True)
        cid = str(uuid.uuid4())
        (folder / "CHART.md").write_text(f"---\nid: {cid}\nname: {name}\n---\n", encoding="utf-8")
        row = Chart(id=cid, name=name, project_id=str(project.id), asset_ref=str(folder))
        await row.save()
        return row

    overview, hue, step = await chart("overview"), await chart("hue"), await chart("step")
    _depends(overview, {"dependencies": {"hue": {"ref": str(hue.typeid), "name": "Connection flow chart"}}})
    _depends(hue, {"dependencies": {"step": str(step.typeid)}})
    # ``hue`` is both an own declarer and reached from ``overview`` — listed once, as its own.
    response = await bootstrapped_client.get(f"/api/v1/graph/project/{project.id}/dependencies", params={"declarers": "1"})
    assert response.status_code == 200, response.text
    rows = response.json()["data"]["declarers"]
    by_name = {d["name"]: d for d in rows}
    assert sorted(by_name) == ["hue", "overview"] and len(rows) == 2
    assert by_name["overview"]["path"] == "docs/network/overview" and by_name["overview"]["via_path"] == []
    assert by_name["overview"]["asset"] == str(overview.typeid)
    assert [(e["typeid"], e["name"], e["state"]) for e in by_name["overview"]["dependencies"]] == [
        (str(hue.typeid), "Connection flow chart", "ready")]
    assert by_name["hue"]["via_path"] == [] and by_name["hue"]["dependencies"][0]["typeid"] == str(step.typeid)
