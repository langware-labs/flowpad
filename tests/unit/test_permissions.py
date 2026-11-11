"""Permissions: declared by the asset that needs them, collected by the registry, never a provider table.

A permission names a capability (``permission.google.drive.read``); its mapping says how a place grants
it. The raw scopes on the wire stay ``auth.scopes`` — so a driver's OAuth permissions may only name
scopes its ``auth`` actually requests.
"""
from __future__ import annotations

import pytest

from flow_sdk import permissions
from flow_sdk.ingest.driver_runtime import DRIVERS
from flow_sdk.schema.data_spec.data_driver_spec import CURRENT_SCHEMA, DataDriverSpec
from flow_sdk.schema.data_spec.permission_spec import PermissionNeedSpec, provider_of

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


def test_the_ontology_walks_by_provider():
    assert permissions.kinds_under("permission.google") == [
        "permission.google.drive.read",
        "permission.google.drive.write",
        "permission.google.secret_manager.access",
        "permission.google.storage.read",
        "permission.google.storage.write",
    ]
    assert permissions.mapping("permission.google.drive.read").oauth_scopes == [
        "https://www.googleapis.com/auth/drive.readonly"
    ]
    assert permissions.mapping("permission.nobody.declares.this") is None


def test_an_api_key_permission_names_the_variable_that_grants_it():
    realtime = permissions.mapping("permission.openai.realtime")
    assert (realtime.mechanism, realtime.api_key) == ("api_key", "OPENAI_API_KEY")


def test_a_drivers_needs_come_from_its_own_manifest():
    assert [n.permission for n in permissions.needs_of_driver("teams")] == [
        "permission.microsoft.teams.messages.read",
        "permission.microsoft.teams.messages.send",
    ]
    assert permissions.needs_of_driver("rss") == []


def _signin_of(name: str, manifest) -> str:
    """The provider a driver signs in through: its ``auth.connector``, or the ``kind: oauth`` way of the
    credential it owns (a driver that also takes a token, e.g. Slack's bot-or-sign-in)."""
    import json

    from tests.unit.test_credential_asset._shipped import shipped_credential_folders

    auth = manifest.auth
    if auth is None:
        return ""
    if auth.connector or not auth.credential:
        return auth.connector
    folder = shipped_credential_folders().get(auth.credential)
    variables = json.loads((folder / "credential.json").read_text()).get("vars", {}) if folder else {}
    return next((v.get("provider", "") for v in variables.values() if v.get("kind") == "oauth"), "")


def test_every_oauth_permission_names_only_scopes_its_driver_requests():
    for name, driver in DRIVERS.items():
        manifest = driver.manifest
        if manifest is None or not manifest.permissions:
            continue
        signin = _signin_of(name, manifest)
        for kind, mapping in manifest.permissions.items():
            if mapping.mechanism != "oauth":
                continue
            assert signin, f"{name}: {kind} is OAuth without a connector"
            assert (mapping.connector or provider_of(kind)) == signin, f"{name}: {kind}"
            if mapping.writes or mapping.rows:
                # Asked for only while a source writes back (or a dataset keeps its rows there): it must be
                # one the provider lets a connect add,
                # or one the sign-in already asks for (GitHub's `repo` both reads and comments).
                from flow_sdk.core.oauth.provider_registry import get_local_provider

                provider = get_local_provider(signin)
                allowed = set(provider.optional_scopes) | set(manifest.auth.scopes) if provider is not None else set()
                assert provider is not None and set(mapping.oauth_scopes) <= allowed, (
                    f"{name}: {kind} writes with a scope {signin} does not offer as optional"
                )
                continue
            assert set(mapping.oauth_scopes) <= set(manifest.auth.scopes), f"{name}: {kind} names a scope auth never asks for"


@pytest.mark.parametrize("bad", ["google.drive.read", "permission.google", "permission.Google.drive", "permission..x"])
def test_a_permission_is_a_dot_path_under_permission(bad):
    with pytest.raises(ValueError):
        PermissionNeedSpec(permission=bad)
    with pytest.raises(ValueError):
        DataDriverSpec(name="x", schema=CURRENT_SCHEMA, permissions={bad: {"mechanism": "oauth"}})
