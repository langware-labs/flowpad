
import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.asset import Asset
from flow_sdk.assets.materialize import MaterializationMode
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root


@pytest.fixture
def process(tmp_path):
    previous = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield AgenticProcess(worker_type=WorkerType.CLAUDE_CODE, workdir=str(tmp_path))
    set_default_records_root(previous)


def skill(process, root):
    path = root / "same-name"
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text(f"---\nid: {mint_uuid()}\nname: same-name\n---\nbody\n")
    return Asset.from_path(path)


async def test_same_name_cannot_replace_another_asset(process, tmp_path):
    first, second = skill(process, tmp_path / "one"), skill(process, tmp_path / "two")
    workspace = process.asset_workspace
    installed = await workspace._materialize_source(first.typeid, source=first, mode=MaterializationMode.LINK)
    with pytest.raises(FileExistsError):
        await workspace._materialize_source(second.typeid, source=second, mode=MaterializationMode.LINK)
    await workspace._unmaterialize_entity(second.typeid, workspace._process_assets_path())
    assert installed.path.resolve() == first.path


@pytest.mark.parametrize("mode", list(MaterializationMode))
async def test_receipt_survives_fresh_process_and_missing_source(process, tmp_path, mode):
    source = skill(process, tmp_path / "source")
    projection = await process.asset_workspace._materialize_source(source.typeid, source=source, mode=mode)
    source.path.rename(source.path.with_name("renamed"))
    fresh = AgenticProcess(id=process.id, worker_type=process.worker_type, context_data=process.context_data)
    workspace = fresh.asset_workspace
    assert await workspace._materialized_path_for(source.typeid, workspace._process_assets_path()) == projection.path
    await workspace._unmaterialize_entity(source.typeid, workspace._process_assets_path())
    assert not projection.path.exists() and not projection.path.is_symlink()
    assert source.path.with_name("renamed").exists()


async def test_external_replacement_is_not_owned(process, tmp_path):
    source = skill(process, tmp_path / "source")
    workspace = process.asset_workspace
    installed = await workspace._materialize_source(source.typeid, source=source, mode=MaterializationMode.LINK)
    installed.path.rename(installed.path.with_name("original"))
    installed.path.mkdir()
    (installed.path / "keep").write_text("someone else's asset")
    with pytest.raises(ValueError, match="replaced externally"):
        await workspace._unmaterialize_entity(source.typeid, workspace._process_assets_path())
    assert (installed.path / "keep").exists()


async def test_unowned_destination_is_never_overwritten(process, tmp_path):
    source = skill(process, tmp_path / "source")
    workspace = process.asset_workspace
    target = workspace._skills_root(workspace._process_assets_path()) / source.path.name
    target.mkdir(parents=True)
    (target / "keep").write_text("existing")
    with pytest.raises(FileExistsError, match="unowned"):
        await workspace._materialize_source(source.typeid, source=source)
    assert (target / "keep").read_text() == "existing"


async def test_copied_unstamped_skill_preserves_source_identity(process, tmp_path):
    path = tmp_path / "unstamped"
    path.mkdir()
    (path / "SKILL.md").write_text("---\nname: unstamped\n---\nbody\n")
    source = Asset.from_path(path)
    projection = await process.asset_workspace._materialize_source(source.typeid, source=source)
    assert Asset.from_path(projection.path).typeid == source.typeid
    assert "id:" not in (path / "SKILL.md").read_text()


async def test_mcp_attach_preserves_folder_identity_and_bundled_runtime(process, tmp_path):
    import json

    from flow_sdk.fs_store.record_paths import shadow_dir_for
    from flow_sdk.schema.data_spec.mcp_spec import McpSpec
    source = tmp_path / "source" / "agentic-assets" / "mcp" / "bundled"
    source.mkdir(parents=True)
    (source / "mcp.json").write_text(McpSpec(name="bundled", command="python", entrypoint="server.py").model_dump_json())
    (source / "server.py").write_text("print('server')\n")
    asset = Asset.from_path(source)
    asset.info.stamp_id(source, asset.typeid.id)
    record = shadow_dir_for(asset.typeid.type, asset.typeid.id)
    record.mkdir(parents=True)
    (record / "metadata.json").write_text(json.dumps({"type": asset.typeid.type, "id": asset.typeid.id, "asset_ref": str(source)}))
    result = await process.attach_embedded_asset(str(asset.typeid))
    assert result.status == "SUCCESS", result
    attached, = await process.get_embedded_assets()
    assert attached.typeid == asset.typeid
    assert attached.path == process.asset_workspace._process_assets_path() / "agentic-assets" / "mcp" / "bundled"
    assert (attached.path / "server.py").read_bytes() == (source / "server.py").read_bytes()
    runtime, = process.resolved_mcp_servers()
    assert runtime.args == [str(attached.path / "server.py")]
    assert (await process.detach_embedded_asset(str(asset.typeid))).status == "SUCCESS"
    assert await process.get_embedded_assets() == []
    assert process.resolved_mcp_servers() == ()
    assert (source / "server.py").exists()


async def test_registered_subagent_path_and_typeid_attachment_preserve_bytes(process, tmp_path):
    import json

    from flow_sdk.fs_store.record_paths import shadow_dir_for
    source = tmp_path / "source" / ".claude" / "agents" / "specialist.md"
    source.parent.mkdir(parents=True)
    source.write_text(f"---\nid: {mint_uuid()}\nname: friendly-title\n---\n\nExact body.\n")
    asset = Asset.from_path(source)
    record = shadow_dir_for(asset.typeid.type, asset.typeid.id)
    record.mkdir(parents=True)
    (record / "metadata.json").write_text(json.dumps({"type": asset.typeid.type, "id": asset.typeid.id, "asset_ref": str(source)}))
    for attach in (lambda: process.load_embedded_subagent_action(str(source)), lambda: process.attach_embedded_asset(str(asset.typeid))):
        result = await attach()
        assert result.status == "SUCCESS", result
        installed, = await process.get_embedded_assets()
        assert installed.path.name == source.name
        assert installed.typeid == asset.typeid
        assert installed.path.read_bytes() == source.read_bytes()
        assert (await process.detach_embedded_asset(str(asset.typeid))).status == "SUCCESS"
