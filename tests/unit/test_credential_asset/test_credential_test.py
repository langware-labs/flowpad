"""A credential's optional ``test``: are the values GOOD, not only present.

``credential.json`` may carry ``test`` (a ``CliOp``): run with the credential's values in its environment
and its own folder as the working folder, exit 0 = the provider takes them. The answer is recorded on the
row for this machine only, never in the file, and a value never reaches the detail.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from flow_sdk.builtin import credential_service as svc
from flow_sdk.builtin.credential_service import CredentialError, save_credential, set_credential_values
from flow_sdk.builtin.credential_status import credentials_status

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

KEY = "bd-secret-0123456789abcdef"


def _test_op(script: str) -> dict:
    return {"commands": {sys.platform: script}}


async def _bright_data(project, test: dict | None = None):
    manifest = {"name": "bright_data", "vars": {"BRIGHT_DATA_API": {"required": "MUST"}}, "setup": "From Bright Data."}
    if test is not None:
        manifest["test"] = test
    saved = await save_credential(manifest=manifest, scope="project", project_id=str(project.id))
    return saved["typeid"] if isinstance(saved, dict) else str(saved.typeid)


def _manifest(project) -> dict:
    path = Path(project.fs_storage_mount_path) / "agentic-assets" / "credential" / "bright_data" / "credential.json"
    return json.loads(path.read_text())


def _row(status, name="bright_data"):
    return next(r for r in status.credentials if r.name == name)


async def test_no_test_writes_no_key_and_answers_untested(home, project):
    await _bright_data(project)
    assert "test" not in _manifest(project)
    answer = await svc.test_credential("bright_data", str(project.id))
    assert answer == {"name": "bright_data", "has_test": False, "state": "untested", "detail": "", "at": ""}


async def test_test_travels_in_the_file(home, project):
    await _bright_data(project, _test_op('test -n "$BRIGHT_DATA_API"'))
    assert _manifest(project)["test"]["commands"][sys.platform] == 'test -n "$BRIGHT_DATA_API"'


async def test_ok_when_the_command_takes_the_value(home, project):
    typeid = await _bright_data(project, _test_op(f'test "$BRIGHT_DATA_API" = "{KEY}"'))
    await set_credential_values(typeid, {"BRIGHT_DATA_API": KEY})
    answer = await svc.test_credential("bright_data", str(project.id))
    assert answer["state"] == "ok" and answer["has_test"] and answer["at"]
    row = _row(await credentials_status(project))
    assert row.has_test and row.test_result.state == "ok"
    assert "test_result" not in _manifest(project), "a result is this machine's, never the file's"


async def test_invalid_scrubs_the_value_from_the_detail(home, project):
    typeid = await _bright_data(project, _test_op('echo "key $BRIGHT_DATA_API rejected" >&2; exit 22'))
    await set_credential_values(typeid, {"BRIGHT_DATA_API": KEY})
    answer = await svc.test_credential("bright_data", str(project.id))
    assert answer["state"] == "invalid"
    assert KEY not in answer["detail"] and "rejected" in answer["detail"]
    assert _row(await credentials_status(project)).test_result.state == "invalid"


async def test_runs_in_the_credential_folder(home, project):
    """A longer test lives in a ``test.py`` beside credential.json; the command finds it by a relative path."""
    typeid = await _bright_data(project, _test_op("test -f credential.json"))
    await set_credential_values(typeid, {"BRIGHT_DATA_API": KEY})
    assert (await svc.test_credential("bright_data", str(project.id)))["state"] == "ok"


async def test_no_value_is_an_error_not_a_rejection(home, project):
    await _bright_data(project, _test_op("exit 0"))
    answer = await svc.test_credential("bright_data", str(project.id))
    assert answer["state"] == "error" and "BRIGHT_DATA_API" in answer["detail"]


async def test_unknown_credential_is_refused(home, project):
    with pytest.raises(CredentialError):
        await svc.test_credential("nope", str(project.id))


async def test_a_test_just_written_to_the_file_runs_before_any_reindex(home, project):
    """An agent writes ``test`` into credential.json and runs it at once: the file is the truth."""
    typeid = await _bright_data(project)
    await set_credential_values(typeid, {"BRIGHT_DATA_API": KEY})
    path = Path(project.fs_storage_mount_path) / "agentic-assets" / "credential" / "bright_data" / "credential.json"
    document = json.loads(path.read_text())
    document["test"] = _test_op(f'test "$BRIGHT_DATA_API" = "{KEY}"')
    path.write_text(json.dumps(document))
    answer = await svc.test_credential("bright_data", str(project.id))
    assert answer["has_test"] and answer["state"] == "ok"


async def test_status_offers_a_test_written_to_the_file_before_reindex(home, project):
    await _bright_data(project)
    path = Path(project.fs_storage_mount_path) / "agentic-assets" / "credential" / "bright_data" / "credential.json"
    document = json.loads(path.read_text())
    document["test"] = _test_op("exit 0")
    path.write_text(json.dumps(document))
    assert _row(await credentials_status(project)).has_test
