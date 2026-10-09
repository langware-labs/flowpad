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


def test_every_oauth_permission_names_only_scopes_its_driver_requests():
    for name, driver in DRIVERS.items():
        manifest = driver.manifest
        if manifest is None or not manifest.permissions:
            continue
        for kind, mapping in manifest.permissions.items():
            if mapping.mechanism != "oauth":
                continue
            assert manifest.auth is not None and manifest.auth.connector, f"{name}: {kind} is OAuth without a connector"
            assert (mapping.connector or provider_of(kind)) == manifest.auth.connector, f"{name}: {kind}"
            if mapping.writes:
                # Asked for only while a source writes back: it must be one the provider lets a connect add.
                from flow_sdk.core.oauth.provider_registry import get_local_provider

                provider = get_local_provider(manifest.auth.connector)
                assert provider is not None and set(mapping.oauth_scopes) <= set(provider.optional_scopes), (
                    f"{name}: {kind} writes with a scope {manifest.auth.connector} does not offer as optional"
                )
                continue
            assert set(mapping.oauth_scopes) <= set(manifest.auth.scopes), f"{name}: {kind} names a scope auth never asks for"


@pytest.mark.parametrize("bad", ["google.drive.read", "permission.google", "permission.Google.drive", "permission..x"])
def test_a_permission_is_a_dot_path_under_permission(bad):
    with pytest.raises(ValueError):
        PermissionNeedSpec(permission=bad)
    with pytest.raises(ValueError):
        DataDriverSpec(name="x", schema=CURRENT_SCHEMA, permissions={bad: {"mechanism": "oauth"}})
