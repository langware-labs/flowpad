"""Fast contract matrix for the runtime asset identity seam."""

from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import read_frontmatter_id, write_frontmatter_id
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    read_folder_capsule_id,
    write_folder_capsule_id,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.type_info import TypeMetadata

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V5 = str(uuid.uuid5(uuid.NAMESPACE_URL, "existing"))
V7 = "018f0000-0000-7000-8000-000000000000"


@pytest.mark.parametrize("existing", [V4, V5])
@pytest.mark.parametrize("folder_backed", [False, True])
def test_extract_id_dispatches_by_layout_and_adopts_without_writing(
    tmp_path: Path, existing: str, folder_backed: bool
) -> None:
    path = tmp_path / ("asset" if folder_backed else "asset.md")
    path.mkdir() if folder_backed else path.write_text("body", encoding="utf-8")
    calls: list[str] = []
    info = TypeInfo(
        type_name="probe",
        main_layout="folder" if folder_backed else "file",
        id_from_file_fn=lambda p: calls.append("file") or existing,
        id_from_folder_fn=lambda p: calls.append("folder") or existing,
        id_write_fn=lambda p, value: calls.append("write") or True,
    )

    assert info.extract_id(FSRef(path)) == existing
    assert calls == ["folder" if folder_backed else "file"]


@pytest.mark.parametrize("candidate", [None, "garbage", V7])
def test_extract_id_rejects_missing_or_non_entity_ids(tmp_path: Path, candidate: str | None) -> None:
    info = TypeInfo(type_name="probe", id_from_file_fn=lambda path: candidate)
    assert info.extract_id(tmp_path / "asset.md") is None


@pytest.mark.parametrize("folder_backed", [False, True])
def test_mint_id_persists_one_v4_in_the_configured_carrier(tmp_path: Path, folder_backed: bool) -> None:
    path = tmp_path / ("asset" if folder_backed else "asset.md")
    path.mkdir() if folder_backed else path.write_text("body", encoding="utf-8")
    reader = read_folder_capsule_id if folder_backed else read_frontmatter_id
    writer = write_folder_capsule_id if folder_backed else write_frontmatter_id
    info = TypeInfo(
        type_name="probe",
        main_layout="folder" if folder_backed else "file",
        id_from_folder_fn=reader if folder_backed else None,
        id_from_file_fn=None if folder_backed else reader,
        id_write_fn=writer,
    )

    first = info.mint_id(path)
    assert uuid.UUID(first).version == 4
    assert reader(path) == first
    assert info.mint_id(path) == first


@pytest.mark.parametrize("writer", [None, lambda path, value: False])
def test_unpersisted_random_id_falls_back_to_stable_path_v5(tmp_path: Path, writer) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body", encoding="utf-8")
    info = TypeInfo(
        type_name="probe",
        id_from_file_fn=read_frontmatter_id,
        id_write_fn=writer,
    )

    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert info.mint_id(path) == expected
    assert info.mint_id(path) == expected
    assert read_frontmatter_id(path) is None


def test_stable_key_mints_v5_in_the_configured_namespace(tmp_path: Path) -> None:
    namespace = uuid.NAMESPACE_DNS
    info = TypeInfo(
        type_name="probe",
        id_from_file_fn=lambda path: None,
        id_stable_key_fn=lambda path: "provider:natural-key",
        id_namespace=namespace,
    )
    assert info.mint_id(tmp_path / "virtual") == str(uuid.uuid5(namespace, "provider:natural-key"))


def test_stable_key_receives_original_fsref_context(tmp_path: Path) -> None:
    ref = FSRef(tmp_path / "settings.json", json_path="/hooks/pre")
    info = TypeInfo(
        type_name="probe",
        id_from_file_fn=lambda candidate: None,
        id_stable_key_fn=lambda candidate: candidate.json_path,
    )
    assert info.mint_id(ref) == str(uuid.uuid5(uuid.NAMESPACE_URL, "/hooks/pre"))


def test_type_metadata_carries_every_identity_trait_to_runtime() -> None:
    reader = lambda ref: V4  # noqa: E731
    key = lambda ref: "key"  # noqa: E731
    writer = lambda ref, entity_id: True  # noqa: E731
    info = TypeMetadata(
        type="probe",
        id_from_file_fn=reader,
        id_stable_key_fn=key,
        id_namespace=uuid.NAMESPACE_DNS,
        id_write_fn=writer,
    ).to_type_info()
    assert (info.id_from_file_fn, info.id_stable_key_fn, info.id_namespace, info.id_write_fn) == (
        reader, key, uuid.NAMESPACE_DNS, writer,
    )


def test_mint_returns_the_id_observed_after_write(tmp_path: Path) -> None:
    state: dict[str, str] = {}
    info = TypeInfo(
        type_name="probe",
        id_from_file_fn=lambda ref: state.get("id"),
        id_write_fn=lambda ref, proposed: state.update(id=V5) is None,
    )
    assert info.mint_id(tmp_path / "asset.md") == V5


def test_concurrent_mint_calls_commit_one_portable_id(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body", encoding="utf-8")
    info = TypeInfo(
        type_name="probe",
        id_from_file_fn=read_frontmatter_id,
        id_write_fn=write_frontmatter_id,
    )
    with ThreadPoolExecutor(max_workers=8) as pool:
        ids = set(pool.map(info.mint_id, [FSRef(path) for _ in range(32)]))
    assert ids == {read_frontmatter_id(path)}


def test_frontmatter_legacy_adoption_and_write_do_not_clean_fields(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text(f"---\nid: invalid\nasset_id: {V4}\nlegacy: keep\n---\n\nbody\n", encoding="utf-8")
    before = path.read_text(encoding="utf-8")
    assert read_frontmatter_id(path) == V4
    assert path.read_text(encoding="utf-8") == before

    assert write_frontmatter_id(path, V5)
    after = path.read_text(encoding="utf-8")
    assert f"id: {V5}" in after
    assert f"asset_id: {V4}" in after
    assert "legacy: keep" in after and "body" in after


def test_frontmatter_writer_rejects_foreign_ids(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body", encoding="utf-8")
    assert write_frontmatter_id(path, V7) is False


def test_folder_writer_rejects_foreign_ids(tmp_path: Path) -> None:
    folder = tmp_path / "asset"
    folder.mkdir()
    assert write_folder_capsule_id(folder, V7) is False
