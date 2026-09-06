"""Unit tests for the entity-FILE reflection roundtrip.

Entity files ride the same hub reflection as entity fields, with one twist:
fields REPLACE (the hub's answer is the answer) while files WRITE THROUGH — the
bytes go to the hub *and* stay in local storage, which is the cache the headless
agent reads by local path. The two halves:

* write — ``_hub_reflect._reflect_fs_to_hub`` mirrors an upload to the hub, then
  returns ``REFLECT_CONTINUE_LOCAL`` so the dispatcher still runs the local write;
* read  — ``fs_actions.fetch_remote_entity_file`` fills the local cache from the
  hub on a miss, for ANY ``remote`` entity (it was flow_message-only, and dead:
  only packed bundles were ever uploaded, never the individual files it asks for).

The hub-side authorization half (``policies.json`` granting ``fs`` on ``task``)
is covered by the hub repo; these tests exercise the client seams directly.
"""

from __future__ import annotations

import io
import uuid
from types import SimpleNamespace

import pytest
from starlette.datastructures import UploadFile

from flow_sdk.builtin.conversation import Conversation


def _entity(*, remote: bool):
    return Conversation(id=f"conv-test-{uuid.uuid4().hex[:8]}", title="t", remote=remote)


def _upload_file(name: str, content: bytes) -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(content))


@pytest.fixture()
def logged_in(monkeypatch):
    import flow_sdk.server.routes._hub_reflect as mod

    monkeypatch.setattr(mod, "is_logged_in", lambda: True)
    monkeypatch.setattr(mod, "is_local_mode", lambda: False)


# ─────────────────────────── gating ───────────────────────────


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_fs_reflects_on_remote_alone_without_opt_in(logged_in):
    """``fs`` is the ONE action that reflects without the ``Hub-Reflect`` opt-in.

    A file must be on the hub by the time another member asks for it — the
    writer may be offline by then, and unlike a field there is no second copy.
    Callers that don't set the header (the TS ``fsService``, agents, the CLI)
    must not be able to silently strand bytes on one machine.
    """
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    assert should_reflect_to_hub(_entity(remote=True), hub_reflect=False, action_name="fs") is True


@pytest.mark.timeout(30)
def test_non_fs_still_requires_opt_in(logged_in):
    """Regression guard: widening fs must NOT make every action auto-reflect."""
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    e = _entity(remote=True)
    assert should_reflect_to_hub(e, hub_reflect=False, action_name="update") is False
    assert should_reflect_to_hub(e, hub_reflect=True, action_name="update") is True


@pytest.mark.timeout(30)
def test_fs_does_not_reflect_for_a_local_only_entity(logged_in):
    """``remote`` is still the gate — a purely local entity never talks to the hub."""
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    assert should_reflect_to_hub(_entity(remote=False), hub_reflect=False, action_name="fs") is False


@pytest.mark.timeout(30)
def test_fs_does_not_reflect_when_logged_out(monkeypatch):
    import flow_sdk.server.routes._hub_reflect as mod

    monkeypatch.setattr(mod, "is_logged_in", lambda: False)
    monkeypatch.setattr(mod, "is_local_mode", lambda: False)
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    assert should_reflect_to_hub(_entity(remote=True), hub_reflect=False, action_name="fs") is False


@pytest.mark.timeout(30)
def test_fs_does_not_reflect_in_local_privacy_mode(monkeypatch):
    """Local (private) mode is the chokepoint that guarantees no bytes leave."""
    import flow_sdk.server.routes._hub_reflect as mod

    monkeypatch.setattr(mod, "is_logged_in", lambda: True)
    monkeypatch.setattr(mod, "is_local_mode", lambda: True)
    from flow_sdk.server.routes._hub_reflect import should_reflect_to_hub

    assert should_reflect_to_hub(_entity(remote=True), hub_reflect=False, action_name="fs") is False


# ─────────────────────── write half (upload) ───────────────────────


def _patch_request_files(monkeypatch, files: dict):
    """Point ``get_current_request_info`` at a stub carrying ``files`` as post data."""
    import flow_sdk.request_context.methods as methods

    class _RI:
        async def get_post_data(self):
            return files

    monkeypatch.setattr(methods, "get_current_request_info", lambda: _RI())


@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_upload_is_mirrored_to_hub_and_continues_locally(monkeypatch):
    import flow_sdk.server.routes._hub_reflect as mod
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

    sent = []

    async def _fake_upload(et, entity_id, filename, content, sub_path="upload"):
        sent.append({"et": et, "id": entity_id, "name": filename, "content": content, "sub_path": sub_path})

    monkeypatch.setattr(mod, "hub_upload_entity_file", _fake_upload)
    _patch_request_files(monkeypatch, {"uploaded_file": _upload_file("a.txt", b"hello")})

    result = await mod._reflect_fs_to_hub(BuiltinEntityType.TASK, "task-1", "upload")

    # The bytes reached the hub …
    assert len(sent) == 1
    assert sent[0]["id"] == "task-1" and sent[0]["sub_path"] == "upload"
    assert sent[0]["name"] == "a.txt"
    assert sent[0]["content"] == b"hello"
    # … and the LOCAL write must still happen (the cache).
    assert result is mod.REFLECT_CONTINUE_LOCAL


@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_upload_stream_is_rewound_for_the_local_handler(monkeypatch):
    """The local handler reads the SAME ``UploadFile`` objects after reflection.

    Reading consumes the stream, so without the rewind the local write would
    create a ZERO-BYTE file — and silently, since the upload still 'succeeds'.
    """
    import flow_sdk.server.routes._hub_reflect as mod
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

    async def _fake_upload(*a, **kw):
        return None

    monkeypatch.setattr(mod, "hub_upload_entity_file", _fake_upload)
    up = _upload_file("a.txt", b"hello")
    _patch_request_files(monkeypatch, {"uploaded_file": up})

    await mod._reflect_fs_to_hub(BuiltinEntityType.TASK, "task-1", "upload")

    assert await up.read() == b"hello", "stream not rewound — local write would be empty"


@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_non_upload_fs_actions_are_not_mirrored(monkeypatch):
    """browse / download / delete are served locally; only writes mirror."""
    import flow_sdk.server.routes._hub_reflect as mod
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

    async def _boom(*a, **kw):  # pragma: no cover - must never run
        raise AssertionError("non-upload fs action must not hit the hub")

    monkeypatch.setattr(mod, "hub_upload_entity_file", _boom)

    for sub_path in ("download/a.txt", "browse", "delete/a.txt", None):
        assert await mod._reflect_fs_to_hub(BuiltinEntityType.TASK, "t", sub_path) is mod.REFLECT_CONTINUE_LOCAL


# ─────────────────────── read half (download) ───────────────────────


class _Storage:
    def __init__(self, root):
        self.root = root

    def get_storage_path(self, vfs_path):
        return str(self.root / vfs_path)


def _patch_hub_get(monkeypatch, payload):
    import flow_sdk.utils.hub as hub

    async def _fake_hub_get(*a, **kw):
        return payload

    monkeypatch.setattr(hub, "hub_get", _fake_hub_get)
    monkeypatch.setattr(hub, "hub_base_url", lambda: "https://hub.test")


def _patch_entity_lookup(monkeypatch, entity):
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    class _Cls:
        @staticmethod
        async def get_one(_q):
            return entity

    monkeypatch.setattr(SchemaRegistry, "get_entity_cls", staticmethod(lambda _t: _Cls))


@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_cache_miss_fills_from_hub_for_any_remote_entity(monkeypatch, tmp_path):
    """The generalized fallback: no longer flow_message-only."""
    from flow_sdk.actions.fs.fs_actions import fetch_remote_entity_file
    from flow_sdk.fs_store.type_id import TypeId

    _patch_hub_get(monkeypatch, b"file-bytes")
    _patch_entity_lookup(monkeypatch, _entity(remote=True))

    tid = TypeId(f"task-{uuid.uuid4()}")
    ok = await fetch_remote_entity_file(tid, "data/a.txt", _Storage(tmp_path))

    assert ok is True
    # Cached to DISK, not merely returned — the agent reads by local path.
    assert (tmp_path / "data/a.txt").read_bytes() == b"file-bytes"


@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_cache_miss_does_not_hit_hub_for_local_only_entity(monkeypatch, tmp_path):
    from flow_sdk.actions.fs.fs_actions import fetch_remote_entity_file
    from flow_sdk.fs_store.type_id import TypeId

    _patch_hub_get(monkeypatch, b"file-bytes")
    _patch_entity_lookup(monkeypatch, _entity(remote=False))

    ok = await fetch_remote_entity_file(TypeId(f"task-{uuid.uuid4()}"), "data/a.txt", _Storage(tmp_path))
    assert ok is False
    assert not (tmp_path / "data/a.txt").exists()


@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_cache_miss_returns_false_when_hub_has_nothing(monkeypatch, tmp_path):
    """Hub 404 → False, so the caller 404s exactly as it did before."""
    from flow_sdk.actions.fs.fs_actions import fetch_remote_entity_file
    from flow_sdk.fs_store.type_id import TypeId

    _patch_hub_get(monkeypatch, None)
    _patch_entity_lookup(monkeypatch, _entity(remote=True))

    ok = await fetch_remote_entity_file(TypeId(f"task-{uuid.uuid4()}"), "data/a.txt", _Storage(tmp_path))
    assert ok is False


class _PrefixStorage:
    """Faithful stand-in for ``LocalStorageDriver``'s path contract.

    Two details the earlier fake glossed over, and which together caused a real
    ENOENT on every share-time push: ``list_dir`` yields items whose
    ``vfs_abs_path`` INCLUDES the ``<type>-<id>/`` prefix, while
    ``get_storage_path`` PREPENDS that same folder — so handing it the absolute
    path nests the id twice.
    """

    def __init__(self, root, entity_folder):
        self.root = root
        self.entity_folder = entity_folder

    def get_storage_path(self, rel: str) -> str:
        return str(self.root / self.entity_folder / rel.strip("/"))

    async def list_dir(self, _root):
        from types import SimpleNamespace

        return [
            SimpleNamespace(display_name="a1.md", is_dir=False, vfs_abs_path=f"{self.entity_folder}/a1.md"),
            SimpleNamespace(display_name="sub", is_dir=True, vfs_abs_path=f"{self.entity_folder}/sub"),
        ]


@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_share_push_reads_via_entity_relative_path(monkeypatch, tmp_path):
    """Regression: the share-time push must strip the entity prefix before
    calling ``get_storage_path``, or every file 'push' dies on ENOENT while the
    share still reports success — the bytes silently never reach the hub."""
    import flow_sdk.actions.fs.fs_actions as fsa
    import flow_sdk.utils.hub as hub
    from flow_sdk.actions.fs.fs_actions import push_entity_files_to_hub

    folder = "task-abc123"
    (tmp_path / folder).mkdir()
    (tmp_path / folder / "a1.md").write_bytes(b"payload")

    sent = []

    async def _fake_upload(et, entity_id, filename, content, sub_path="upload"):
        sent.append((entity_id, filename, content))

    monkeypatch.setattr(hub, "hub_upload_entity_file", _fake_upload)
    monkeypatch.setattr(fsa, "get_entity_storage", lambda _tid: _PrefixStorage(tmp_path, folder))
    monkeypatch.setattr(
        fsa.VFSPath, "from_entity_path", staticmethod(lambda *a, **k: SimpleNamespace(abs_vfspath=folder))
    )

    class _Ent:
        id = "abc123"
        remote = True
        typeid = "task-abc123"

        @staticmethod
        def get_type():
            return "task"

    pushed = await push_entity_files_to_hub(_Ent())

    assert pushed == 1, "the file must be pushed (a directory is skipped)"
    assert sent == [("abc123", "a1.md", b"payload")]


class _RecordBackedEntity:
    remote = True

    def __init__(self, *, entity_type: str, record):
        self.id = str(uuid.uuid4())
        self.typeid = f"{entity_type}-{self.id}"
        self._entity_type = entity_type
        self._record = record

    def get_type(self):
        return self._entity_type

    async def get_record(self):
        return self._record


class _FileBackedEntity(_RecordBackedEntity):
    type: str = "probe_file_backed"


class _FolderBackedEntity(_RecordBackedEntity):
    type: str = "probe_folder_backed"


def _register_hub_layout_probes() -> None:
    """Hub layout is ``TypeInfo``'s shape — the same facts the disk serializer
    reads — so the probes declare it there."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
    from flow_sdk.schema.layout import Folder

    SchemaRegistry.register(TypeInfo(type_name="probe_file_backed", hub_main_file="document.md"))
    SchemaRegistry.register(TypeInfo(type_name="probe_folder_backed", shape=Folder(main="SKILL.md"), hub_main_file="SKILL.md"))


_register_hub_layout_probes()


@pytest.mark.asyncio
async def test_share_push_publishes_markdown_under_canonical_hub_name(monkeypatch, tmp_path):
    import flow_sdk.utils.hub as hub
    from flow_sdk.actions.fs.fs_actions import push_entity_files_to_hub

    source = tmp_path / "sender-name.md"
    source.write_bytes(b"# Wiki doc")
    record = SimpleNamespace(main_ref=SimpleNamespace(path=str(source)), asset_ref=SimpleNamespace(path=str(source)))
    entity = _FileBackedEntity(entity_type="markdown", record=record)
    sent = []

    async def _fake_upload(et, entity_id, filename, content, sub_path="upload"):
        sent.append((entity_id, filename, content, sub_path))

    monkeypatch.setattr(hub, "hub_upload_entity_file", _fake_upload)

    assert await push_entity_files_to_hub(entity) == 1
    assert sent == [(entity.id, "document.md", b"# Wiki doc", "upload")]


@pytest.mark.asyncio
async def test_share_push_recursively_preserves_skill_folder_paths(monkeypatch, tmp_path):
    import flow_sdk.utils.hub as hub
    from flow_sdk.actions.fs.fs_actions import push_entity_files_to_hub

    skill_root = tmp_path / "my-skill"
    nested = skill_root / "references"
    nested.mkdir(parents=True)
    (skill_root / "SKILL.md").write_bytes(b"# Skill")
    (nested / "guide.md").write_bytes(b"guide")
    record = SimpleNamespace(
        main_ref=SimpleNamespace(path=str(skill_root / "SKILL.md")),
        asset_ref=SimpleNamespace(path=str(skill_root)),
    )
    entity = _FolderBackedEntity(entity_type="skill", record=record)
    sent = []

    async def _fake_upload(et, entity_id, filename, content, sub_path="upload"):
        sent.append((filename, content, sub_path))

    monkeypatch.setattr(hub, "hub_upload_entity_file", _fake_upload)

    assert await push_entity_files_to_hub(entity) == 2
    assert sent == [
        ("SKILL.md", b"# Skill", "upload"),
        ("guide.md", b"guide", "upload/references"),
    ]


@pytest.mark.asyncio
async def test_share_push_does_not_publish_symlinks_outside_skill(monkeypatch, tmp_path):
    import flow_sdk.utils.hub as hub
    from flow_sdk.actions.fs.fs_actions import push_entity_files_to_hub

    skill_root = tmp_path / "my-skill"
    skill_root.mkdir()
    (skill_root / "SKILL.md").write_bytes(b"# Skill")
    outside = tmp_path / "private.txt"
    outside.write_bytes(b"secret")
    (skill_root / "private-link.txt").symlink_to(outside)
    record = SimpleNamespace(
        main_ref=SimpleNamespace(path=str(skill_root / "SKILL.md")),
        asset_ref=SimpleNamespace(path=str(skill_root)),
    )
    entity = _FolderBackedEntity(entity_type="skill", record=record)
    sent = []

    async def _fake_upload(et, entity_id, filename, content, sub_path="upload"):
        sent.append(filename)

    monkeypatch.setattr(hub, "hub_upload_entity_file", _fake_upload)

    assert await push_entity_files_to_hub(entity) == 1
    assert sent == ["SKILL.md"]


@pytest.mark.asyncio
async def test_create_child_pushes_existing_record_bytes_after_hub_create(monkeypatch):
    import flow_sdk.actions.fs.fs_actions as fs_actions
    import flow_sdk.cli.auth.credentials as credentials
    import flow_sdk.cloud_client.client as cloud_client
    from flow_sdk.builtin.claude_memory_entities import Docs
    from flow_sdk.builtin.project import Project

    posted = []
    pushed = []

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, path, body):
            posted.append((path, body))

    async def _fake_push(entity):
        pushed.append(entity)
        return 1

    monkeypatch.setattr(credentials, "load_credentials", lambda: SimpleNamespace(api_key="key"))
    monkeypatch.setattr(cloud_client, "FlowpadClient", _Client)
    monkeypatch.setattr(cloud_client.ApiConfig, "from_env", classmethod(lambda cls: SimpleNamespace()))
    monkeypatch.setattr(fs_actions, "push_entity_files_to_hub", _fake_push)

    project = Project(id=str(uuid.uuid4()), name="Shared", remote=True)
    child = Docs(id=str(uuid.uuid4()), name="Guide", remote=False)

    result = await project.create_child(child)

    assert result is child
    assert child.remote is True
    assert len(posted) == 1
    assert pushed == [child]
