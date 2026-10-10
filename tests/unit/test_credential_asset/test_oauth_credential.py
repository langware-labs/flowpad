"""An OAuth connection is a kind of credential: ``kind: oauth`` names a provider and the scopes its grant must
cover, and carries no variables — the token is held by the connection, never a value a person types.

Every provider this build can sign in with ships a template, so a project that needs one declares it the way it
declares an API-key credential.
"""
from __future__ import annotations

import json

import pytest

from flow_sdk.schema.data_spec.credential_contract import CredentialKind
from flow_sdk.schema.data_spec.credential_spec import CredentialSpec
from tests.unit.test_credential_asset._shipped import shipped_credential_folders

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SHIPPED = shipped_credential_folders()

#: Flowpad's own sign-in is not something a project needs: no template.
NOT_A_PROJECT_CREDENTIAL = {"flowpad"}


def _registry_providers() -> list[str]:
    from flow_sdk.core.oauth.provider_registry import _PROVIDERS

    names = list(_PROVIDERS) if isinstance(_PROVIDERS, dict) else [p.name for p in _PROVIDERS]
    return [n for n in names if n not in NOT_A_PROJECT_CREDENTIAL]


@pytest.mark.parametrize("provider", _registry_providers())
def test_every_provider_this_build_signs_in_with_ships_an_oauth_template(provider):
    assert provider in SHIPPED, f"OAuth provider {provider!r} has no credential template (credential/{provider}/)"
    spec = CredentialSpec.model_validate(json.loads((SHIPPED[provider] / "credential.json").read_text()))
    assert spec.kind is CredentialKind.OAUTH and spec.provider == provider and spec.vars == {}


def test_an_oauth_credential_is_a_provider_and_scopes_and_no_variables():
    spec = CredentialSpec.model_validate({"schema": 2, "name": "google", "kind": "oauth", "provider": "Google",
                                          "scopes": ["https://www.googleapis.com/auth/drive.readonly"]})
    assert spec.provider == "google", "provider names are matched lower-case"
    assert spec.scopes == ["https://www.googleapis.com/auth/drive.readonly"] and spec.title == "google"


@pytest.mark.parametrize("manifest, why", [
    ({"kind": "oauth"}, "names its provider"),
    ({"kind": "oauth", "provider": "google", "lm_provider": "openai", "vars": {"K": {}}}, "cannot fund"),
    ({}, "at least one variable"),
    ({"vars": {"K": {}}, "provider": "google"}, "belong to an oauth credential"),
    ({"vars": {"K": {}}, "scopes": ["x"]}, "belong to an oauth credential"),
])
def test_the_kind_rules_are_load_errors(manifest, why):
    with pytest.raises(ValueError, match=why):
        CredentialSpec.model_validate({"schema": 2, "name": "x", **manifest})


def test_an_env_credential_is_unchanged_by_the_new_kind():
    spec = CredentialSpec.model_validate({"schema": 2, "name": "twilio", "vars": {"TWILIO_AUTH_TOKEN": {}}})
    assert spec.kind is CredentialKind.ENV and spec.provider == "" and spec.scopes == []


# ── declared by the project, its status read from the connection ─────────────

DRIVE = "https://www.googleapis.com/auth/drive.readonly"
GCS = "https://www.googleapis.com/auth/devstorage.read_only"


@pytest.mark.asyncio
async def test_a_needed_connection_is_declared_once_and_widened_in_place(project, catalogue):
    from flow_sdk.builtin.credential_service import declare_oauth

    catalogue("google")
    first, changed = await declare_oauth(project, "google", [DRIVE])
    again, unchanged = await declare_oauth(project, "Google", [DRIVE])
    wider, widened = await declare_oauth(project, "google", [GCS])

    assert changed and not unchanged and widened
    assert first.scope == "project" and first.is_oauth and first.provider == "google" and first.title == "Google"
    assert str(again.id) == str(first.id) == str(wider.id), "one credential per provider in a project"
    assert wider.scopes == [DRIVE, GCS], "the union of what its sources need"


@pytest.mark.asyncio
async def test_a_provider_only_the_hub_defines_is_declared_from_its_name(project):
    from flow_sdk.builtin.credential_service import declare_oauth

    spec, changed = await declare_oauth(project, "notion", ["read"])
    assert changed and spec.is_oauth and spec.provider == "notion" and spec.scopes == ["read"]


@pytest.mark.asyncio
async def test_an_env_credential_named_like_the_provider_is_never_overwritten(project, catalogue):
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.builtin.credential_service import declare_oauth, save_credential

    catalogue("google")
    key = await save_credential(manifest={"name": "google", "vars": {"GOOGLE_API_KEY": {}}, "setup": "Console."},
                                scope="project", project_id=project.id)
    spec, _ = await declare_oauth(project, "google", [DRIVE])
    assert spec.name == "google-oauth" and spec.is_oauth
    kept = await Credential.get("google", project)
    assert str(kept.id) == str(key.id) and not kept.is_oauth and "GOOGLE_API_KEY" in kept.vars


def _grants(monkeypatch, state=None, missing=()):
    """The connection list says ``state`` for google (None: no row), its grant covering all but ``missing``."""
    from flow_sdk.core.connections import specs
    from flow_sdk.schema.data_spec.connection_spec import ConnectionKind, ConnectionSpec

    async def listed():
        if state is None:
            return []
        return [ConnectionSpec(provider="google", display_name="Google", kind=ConnectionKind.OAUTH, state=state,
                               connected=state.value == "connected",
                               scopes=[s for s in (DRIVE, GCS) if s not in missing])]

    monkeypatch.setattr(specs, "_list_connection_specs_local", listed)


@pytest.mark.asyncio
@pytest.mark.parametrize("state, missing, expected", [
    (None, (), ("missing", [])),
    ("disconnected", (), ("missing", [])),
    ("needs_reauth", (), ("needs_reauth", [])),
    ("connected", (), ("connected", [])),
    ("connected", (GCS,), ("partial", [GCS])),
])
async def test_an_oauth_credential_reads_its_state_from_the_connection(project, catalogue, monkeypatch, state,
                                                                      missing, expected):
    from flow_sdk.builtin.credential_service import declare_oauth
    from flow_sdk.builtin.credential_status import credentials_status
    from flow_sdk.schema.data_spec.connection_spec import ConnectionState

    catalogue("google")
    await declare_oauth(project, "google", [DRIVE, GCS])
    _grants(monkeypatch, ConnectionState(state) if state else None, missing)

    (row,) = [r for r in (await credentials_status(project)).credentials if r.name == "google"]
    assert (row.state, row.missing_scopes) == expected
    assert row.kind == "oauth" and row.provider == "google" and row.vars == [] and row.value_store == "connection"


@pytest.mark.asyncio
async def test_creating_a_source_declares_the_connection_it_acts_through(project, catalogue):
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.builtin.data_source import DataSource

    catalogue("google")
    source = DataSource(name="drive", provider="gdrive", project_id=str(project.id), read_only=True,
                        config={})
    await source.save()

    google = await Credential.get("google", project)
    assert google.scope == "project" and google.is_oauth
    assert DRIVE in google.scopes, "declared at create with what the source reads"


@pytest.mark.asyncio
async def test_an_oauth_credential_a_source_needs_is_skipped_locally_never_always(project, catalogue, monkeypatch):
    from flow_sdk.builtin import project_setup
    from flow_sdk.builtin.data_source import DataSource

    catalogue("google")
    rows = [DataSource(name="drive", provider="gdrive")]

    async def of_project(_project):
        return rows

    monkeypatch.setattr(project_setup, "project_sources", of_project)
    _grants(monkeypatch, None)

    (google,) = [r for r in await project_setup.collect_requirements(project) if r.name == "google"]
    assert google.is_oauth and not google.can_skip_always and "needed by drive" in google.why_not_always
    with pytest.raises(project_setup.SkipRefused, match="needed by drive"):
        await project_setup.skip_requirement(project, google.typeid, scope="always")

    await project_setup.skip_requirement(project, google.typeid, scope="local")
    readiness = await project_setup.readiness_of(project)
    assert [r.name for r in readiness.skipped] == ["google"] and "google" not in [r.name for r in readiness.to_do]


@pytest.mark.asyncio
async def test_a_missing_dependency_is_skipped_on_the_project_row(project, monkeypatch):
    from flow_sdk.builtin import project_setup
    from flow_sdk.builtin.project import Project
    from flow_sdk.schema.data_spec.flow_json_spec import DependencyState

    async def deps(self, **_kw):
        return [DependencyState(name="shared-lib", source="git+https://example.invalid/lib", state="missing")]

    monkeypatch.setattr(Project, "dependencies", deps)
    (dep,) = [r for r in await project_setup.collect_requirements(project) if r.kind == "dependency"]
    assert dep.typeid == str(project.typeid) and dep.required

    await project_setup.skip_requirement(project, dep.typeid, scope="local", name="shared-lib")

    stored = await Project.get_by_id(str(project.id))
    assert "shared-lib" in stored.setup_skipped
    readiness = await project_setup.readiness_of(project)
    assert [r.name for r in readiness.skipped] == ["shared-lib"] and readiness.to_do == []
