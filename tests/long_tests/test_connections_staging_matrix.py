"""The connection matrix against STAGING: every real provider × CLI and Python SDK.

Opt-in and never in CI: it drives a launcher-owned instance logged in to staging
(``FLOWPAD_STAGING_MATRIX_INSTANCE=<name>``, launched with
``scripts/instance_ctl.sh launch <name> --hub https://staging.flowpad.ai``). Each provider is
connected through ``flow connections connect`` — adopting the owner's hub grant, or reporting
the one already held — then proved through the SDK in a fresh process: ``require()`` passes,
``test()`` is accepted by the provider itself, and a token resolves.

The browser channel of the same matrix is the instance's Connections screen; the unattended
dummy-provider version is ``test_connections_e2e_matrix.py``.
"""

from __future__ import annotations

import pytest

from tests.utils.connections_channels import connections_cli, last_json, sdk_probe

ENV_KEY = "FLOWPAD_STAGING_MATRIX_INSTANCE"
STAGING_HOST = "staging.flowpad.ai"
PROVIDERS = ["anthropic", "atlassian", "flowpad", "github", "gitlab", "linear", "notion", "slack"]


@pytest.fixture(autouse=True)
def staging_instance(resolve_live_e2e_instance):
    """A live, launcher-owned instance — and one whose hub is staging, or nothing runs."""
    instance = resolve_live_e2e_instance(ENV_KEY)
    if STAGING_HOST not in instance.hub_url:
        pytest.fail(f"{instance.name} targets {instance.hub_url}, not staging", pytrace=False)
    return instance


def _connections(instance) -> list[dict]:
    listed = connections_cli(instance.subprocess_env(), "list", "--json")
    assert listed.returncode == 0, listed.stderr
    return last_json(listed.stdout)["connections"]


def test_the_flowpad_account_is_signed_in_to_staging(staging_instance):
    account = next(row for row in _connections(staging_instance) if row["kind"] == "flowpad")

    assert account["state"] == "connected", account


@pytest.mark.parametrize("provider", PROVIDERS)
def test_cli_connects_and_lists_connected(staging_instance, provider):
    connected = connections_cli(staging_instance.subprocess_env(), "connect", provider, "--json")

    assert connected.returncode == 0, connected.stderr
    assert last_json(connected.stdout)["connected"] is True
    states = {row["provider"]: row["state"] for row in _connections(staging_instance) if row["kind"] == "oauth"}
    assert states.get(provider) == "connected"


@pytest.mark.parametrize("provider", PROVIDERS)
def test_sdk_requires_tests_and_resolves_a_token(staging_instance, provider):
    run = sdk_probe(staging_instance.subprocess_env(), provider)

    assert run.returncode == 0, run.stderr
    result = last_json(run.stdout)
    assert result["connected"] is True
    assert result["ok"] is True, result
    assert result["token_sha256"]
