"""Existing temporary projects retain their ontology owner after process startup."""
import json

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.project_manifest import manifest_path
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.project_manifest import ensure_project_namespace
from flow_sdk.fs_store.operations import namespace_roots
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def test_existing_temporary_project_restores_lazy_kinds(tmp_path):
    namespace = 'restart_' + str(mint_uuid()).replace('-', '')
    manifest = manifest_path(tmp_path)
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({'ns': namespace}))
    schema = tmp_path / 'agentic-assets/data_schema/restart.record'
    schema.mkdir(parents=True)
    (schema / 'data_schema.json').write_text(json.dumps({'fields': {'name': {'shape': 'string'}}}))
    before = manifest.read_bytes()

    ensure_project_namespace(Project(name='Explicit fixture', fs_storage_mount_path=str(tmp_path)))

    assert namespace_roots.root_for(namespace) == tmp_path.resolve()
    kind = SchemaRegistry.kind_type(f'--{namespace}--.restart.record')
    assert kind is not None and kind.model_validate({'name': 'restored'}).name == 'restored'
    assert manifest.read_bytes() == before


def test_temporary_discovered_project_is_not_given_manifest(tmp_path):
    ensure_project_namespace(Project(name='Unclaimed fixture', fs_storage_mount_path=str(tmp_path)))
    assert not manifest_path(tmp_path).exists()


def test_schema_registration_after_kind_name_resolution_builds_dependencies(tmp_path):
    from flow_sdk.schema.data_spec.declared import kind_in, register_folder

    namespace = 'readfirst_' + str(mint_uuid()).replace('-', '')
    manifest = manifest_path(tmp_path)
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({'ns': namespace}))
    for name, fields in [('parent', {'child': {'shape': 'child'}}), ('child', {'name': {'shape': 'string'}})]:
        folder = tmp_path / 'agentic-assets/data_schema' / name
        folder.mkdir(parents=True)
        (folder / 'data_schema.json').write_text(json.dumps({'fields': fields}))
    # The kinds/resolve endpoint reads names before the schema is applied. A read is not a build.
    assert kind_in(tmp_path, 'parent') == f'--{namespace}--.parent'
    assert kind_in(tmp_path, 'child') == f'--{namespace}--.child'
    assert register_folder(tmp_path / 'agentic-assets/data_schema/parent') == ''
    assert SchemaRegistry.kind_type(f'--{namespace}--.parent') is not None
