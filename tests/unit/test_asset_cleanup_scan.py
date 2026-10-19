from flow_sdk.assets.cleanup import collect_asset_inventory


def test_asset_inventory_is_bounded_to_contract_paths(tmp_path):
    skill = tmp_path / ".claude" / "skills" / "release-notes" / "SKILL.md"
    agent = tmp_path / ".claude" / "agents" / "probe.md"
    distractor = tmp_path / "records" / "agentic_process" / "metadata.json"
    for path, text in ((skill, "skill body"), (agent, "agent body"), (distractor, "noise")):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    found = collect_asset_inventory([tmp_path])

    assert [(item.kind, item.name) for item in found] == [
        ("agent", "probe"),
        ("skill", "release-notes"),
    ]
    assert [item.content for item in found] == ["agent body", "skill body"]


def test_duplicate_scan_roots_do_not_repeat_candidates(tmp_path):
    command = tmp_path / ".claude" / "commands" / "probe.md"
    command.parent.mkdir(parents=True)
    command.write_text("inspect")
    assert len(collect_asset_inventory([tmp_path, tmp_path / "."])) == 1


def test_backup_candidates_never_include_settings_secrets(tmp_path):
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir()
    settings.write_text('{"token":"cleanup-secret-sentinel"}')
    backup = settings.with_name("settings.json.backup")
    backup.write_text('{"token":"cleanup-secret-sentinel-old"}')
    found = collect_asset_inventory([tmp_path])
    assert len(found) == 1
    assert found[0].content is None
    assert found[0].live_settings_modified_at == settings.stat().st_mtime
    assert "cleanup-secret-sentinel" not in found[0].model_dump_json()
