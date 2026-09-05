"""Project FSRecord identity adoption and deterministic minting."""

from __future__ import annotations

import inspect
import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store import FSRecord, RecordType
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import Derived
from flow_sdk.fs_store.indexer.functions import claude_projects
from flow_sdk.fs_store.indexer.functions.claude_projects import (
    claude_project_identity_key,
    existing_project_record_id,
    extract_claude_project,
)
from flow_sdk.schema.type_info.project_type_info import PROJECT

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V5 = str(uuid.uuid5(uuid.NAMESPACE_URL, "existing-project"))


def _project_ref(tmp_path: Path, cwd: str, encoded: bool) -> FSRef:
    if not encoded:
        return FSRef(cwd)
    project_dir = tmp_path / ".claude" / "projects" / "-encoded-project"
    project_dir.mkdir(parents=True)
    (project_dir / "session.jsonl").write_text(json.dumps({"cwd": cwd}) + "\n", encoding="utf-8")
    return FSRef(project_dir)


@pytest.mark.asyncio
@pytest.mark.parametrize("existing_id", [V4, V5])
@pytest.mark.parametrize("encoded", [False, True])
async def test_existing_project_record_id_is_preserved(tmp_path: Path, existing_id: str, encoded: bool) -> None:
    cwd = "/flowpad-tests/project-identity-existing"
    FSRecord(RecordType.PROJECT, existing_id, cwd=cwd, name=cwd).save()
    ref = _project_ref(tmp_path, cwd, encoded)
    info = PROJECT

    assert info.mint_entity_id(ref) == existing_id
    parsed = await extract_claude_project(ref, existing_id)
    assert parsed[0].id == existing_id
    assert FSRecord.discover(RecordType.PROJECT)[0].id == existing_id


@pytest.mark.asyncio
async def test_missing_project_record_mints_and_persists_dns_v5() -> None:
    cwd = "/flowpad-tests/project-identity-new"
    ref = FSRef(cwd)
    info = PROJECT
    expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project-fsref:{Path(cwd).resolve().as_posix()}"))

    assert info.read_id(ref) is None
    assert info.mint_entity_id(ref) == expected
    parsed = await extract_claude_project(ref, expected)
    assert parsed[0].id == expected
    assert FSRecord.discover(RecordType.PROJECT)[0].id == expected


def test_project_parser_and_identity_registration_contract() -> None:
    for parser in (
        claude_projects._upsert_project_for_cwd,
        claude_projects.extract_claude_project,
    ):
        signature = inspect.signature(parser)
        assert signature.parameters["resolved_id"].default is inspect.Parameter.empty
    source = inspect.getsource(claude_projects)
    assert "uuid4" not in source
    assert "mint_uuid" not in source
    assert claude_project_identity_key(FSRef("/repo")) == "project-fsref:/repo"
    backend = PROJECT.identity_carrier
    assert isinstance(backend, Derived)
    assert backend.reader is existing_project_record_id
