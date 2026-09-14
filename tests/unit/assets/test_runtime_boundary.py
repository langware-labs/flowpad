"""Exercise the public library in a fresh interpreter, before app registration."""
import subprocess
import sys
import textwrap


def run_isolated(source: str) -> None:
    result = subprocess.run([sys.executable, "-c", textwrap.dedent(source)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_filesystem_operations_never_import_application_or_resolve_settings():
    run_isolated('''
        import sys, tempfile, json
        from pathlib import Path
        blocked = ('flow_sdk.builtin', 'flow_sdk.core', 'flow_sdk.db', 'flow_sdk.server',
                   'flow_sdk.actions', 'flow_sdk.app', 'flow_sdk.fs_store.indexer',
                   'flow_sdk.config', 'flow_sdk.instance_settings', 'flow_sdk.ingest')
        class Boundary:
            def find_spec(self, name, path=None, target=None):
                if name.startswith(blocked):
                    raise AssertionError(f'Forbidden filesystem dependency: {name}')
        sys.meta_path.insert(0, Boundary())
        from flow_sdk.assets import Asset, AssetFolder
        from flow_sdk.assets.serialization import read_asset_data
        from flow_sdk.assets.projection import read_asset_tree
        from flow_sdk.assets.git_origin import PortableGitOrigin
        from flow_sdk.fs_store.schema_registry import SchemaRegistry
        assert {'skill', 'markdown', 'task', 'mcp', 'graph_workflow', 'journey'} <= set(SchemaRegistry.get_all_types())
        from flow_sdk.schema.data_spec.credential_manifest_spec import CredentialManifestSpec
        from flow_sdk.schema.data_spec.data_source_manifest_spec import ManifestSpec
        CredentialManifestSpec.model_validate({'schema': 2, 'name': 'api', 'lm_provider': 'openai', 'vars': {'API_KEY': {}}})
        ManifestSpec.model_validate({'schema': 1, 'name': 'source', 'reflect': ['copy']})
        import subprocess, socket
        def forbidden_command(*args, **kwargs):
            raise AssertionError('Filesystem operations may not execute commands or network calls')
        subprocess.Popen = forbidden_command
        socket.create_connection = forbidden_command
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / '.claude/skills/source'
            source.mkdir(parents=True)
            (source / 'SKILL.md').write_text('---\\nname: source\\ndescription: nested\\n---\\nHello\\n')
            asset = Asset.from_path(source)
            copy = asset.install(root / '.agents/skills/copy')
            assert asset.typeid == copy.typeid and asset.path != copy.path
            assert len(AssetFolder(path=root).assets()) == 2
            assert read_asset_data(copy.path, copy.info).body == 'Hello'
            from flow_sdk.fs_store.fs_ref import FSRef
            assert copy.info.from_disk_fn(FSRef(copy.path), copy.typeid.id)[0].body == 'Hello'
            (root / '.git').mkdir()
            origin = PortableGitOrigin(provider='github', owner='owner', name='repo', branch='main',
                                       head_commit='a'*40, rel_path='.agents/skills/copy')
            assert read_asset_tree(entity_type='skill', expected_id=copy.typeid.id,
                                   checkout_root=root, origin=origin).id == copy.typeid.id
            copy.remove()
            assert source.exists() and not copy.path.exists()
            from flow_sdk.assets import DocumentPatch
            from flow_sdk.schema.data_spec.skill_spec import SkillSpec
            from flow_sdk.schema.types import EntityType
            created = Asset.create(root / '.claude/skills/new', type=EntityType.SKILL,
                                   spec=SkillSpec(name='new', description='Created without application state'))
            document = created.read_document()
            changed = created.update_document(DocumentPatch(body='Edited'), expected_revision=document.revision)
            assert changed.body == 'Edited'
            records = root / 'records'
            record = records / created.typeid.type / created.typeid.id / 'metadata.json'
            record.parent.mkdir(parents=True)
            record.write_text(json.dumps({'type': created.typeid.type, 'id': created.typeid.id,
                                          'asset_ref': str(created.path)}))
            assert Asset.from_typeid(created.typeid, records_root=records).path == created.path
        assert not any(name.startswith(blocked) for name in sys.modules)
    ''')


def test_failed_declaration_import_cannot_silently_hide_a_type():
    run_isolated('''
        import sys
        class BrokenDeclaration:
            def find_spec(self, name, path=None, target=None):
                if name == 'flow_sdk.schema.type_info.skill_type_info':
                    raise ImportError('deliberately missing declaration dependency')
        sys.meta_path.insert(0, BrokenDeclaration())
        from flow_sdk.fs_store.schema_registry import SchemaRegistry
        for attempt in range(2):
            try:
                SchemaRegistry.get_all_types()
            except RuntimeError as error:
                assert 'skill_type_info' in str(error)
                assert not SchemaRegistry._loaded
            else:
                raise AssertionError('Incomplete registry accepted as complete')
    ''')
