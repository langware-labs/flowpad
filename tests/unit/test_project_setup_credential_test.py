"""A credential's declared test, and its last result here, travel onto its project-setup requirement."""

from types import SimpleNamespace

from flow_sdk.builtin.project_setup import _from_row
from flow_sdk.schema.data_spec.credential_status_spec import CredentialStatusRowSpec, CredentialTestResultSpec


def _row(**over) -> CredentialStatusRowSpec:
    base = dict(typeid="credential-x", name="google-cloud", scope="project", value_store="env", state="connected")
    return CredentialStatusRowSpec(**{**base, **over})


def test_env_requirement_carries_the_test_and_its_result():
    result = CredentialTestResultSpec(state="ok", at="2026-11-01T00:00:00Z")
    req = _from_row(_row(has_test=True, test_result=result), [], SimpleNamespace(fs_storage_mount_path=""))
    assert req.has_test is True
    assert req.test_result == result


def test_no_test_declared_reads_as_none():
    req = _from_row(_row(), [], SimpleNamespace(fs_storage_mount_path=""))
    assert req.has_test is False
    assert req.test_result is None


def test_oauth_requirement_carries_them_too():
    req = _from_row(_row(kind="oauth", has_test=True), [], SimpleNamespace(fs_storage_mount_path=""))
    assert req.has_test is True
