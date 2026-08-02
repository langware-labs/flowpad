from flow_sdk.asset_cleanup.scan import collect_asset_inventory


def test_asset_inventory_is_bounded_to_contract_paths(tmp_path):
    skill = tmp_path / ".claude" / "skills" / "release-notes" / "SKILL.md"
    agent = tmp_path / ".claude" / "agents" / "probe.md"
    distractor = tmp_path / "records" / "agentic_process" / "metadata.json"
    for path, text in ((skill, "skill body"), (agent, "agent body"), (distractor, "noise")):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    found = collect_asset_inventory([tmp_path])

    assert [(item["kind"], item["name"]) for item in found] == [
        ("agent", "probe"),
        ("skill", "release-notes"),
    ]
    assert [item["content"] for item in found] == ["agent body", "skill body"]
