"""Connections × channels, end to end, with nobody at a consent screen.

A real backend (``live_backend``), the dummy provider (``tests/utils/dummy_oauth_server.py``) and
the env-gated test providers (``FLOWPAD_ENABLE_TEST_OAUTH``). Each connection kind is connected the
way a person would — through ``flow connections connect`` and through the Python SDK, each in its
own process — with ``BROWSER`` pointed at a follower that clicks Allow. Then it is proved: the row
reads connected, the provider accepts the token, and the token is the one the dummy issued.

The browser channel is the Playwright suite in ``ui/tests/e2e/connections``; the hub-run default
flow is ``tests/hub_tests/test_connections_hub_e2e.py``.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from flow_sdk.core.oauth.provider_registry import TEST_DEVICE, TEST_LOOPBACK
from tests.utils.connections_channels import connections_cli, last_json, sdk_probe
from tests.utils.dummy_oauth_server import dummy_oauth_server

FOLLOWER = Path(__file__).resolve().parents[1] / "utils" / "follow_auth_url.py"
KINDS = [TEST_LOOPBACK, TEST_DEVICE]


@pytest.fixture()
def dummy():
    with dummy_oauth_server() as server:
        yield server


@pytest.fixture()
def backend(dummy, monkeypatch):
    """Everything the backend and its callers must see; tests list it before ``live_backend``."""
    monkeypatch.setenv("FLOWPAD_ENABLE_TEST_OAUTH", "1")
    monkeypatch.setenv("DUMMY_OAUTH_BASE_URL", dummy.base_url)
    # Fernet SOD key, as CI's e2e backend uses: keeps every secrets path off the OS keyring.
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("BROWSER", f"{sys.executable} {FOLLOWER} %s")


@pytest.mark.parametrize("provider", KINDS)
def test_the_cli_connects_and_lists_it_connected(backend, live_backend, dummy, provider):
    connected = connections_cli(os.environ, "connect", provider, "--json")

    assert connected.returncode == 0, connected.stderr
    assert last_json(connected.stdout)["connected"] is True
    rows = last_json(connections_cli(os.environ, "list", "--json").stdout)["connections"]
    assert {row["provider"]: row["state"] for row in rows}.get(provider) == "connected"
    assert dummy.latest_token is not None


@pytest.mark.parametrize("provider", KINDS)
def test_the_sdk_connects_requires_tests_and_reads_the_issued_token(backend, live_backend, dummy, provider):
    run = sdk_probe(os.environ, provider, connect=True)

    assert run.returncode == 0, run.stderr
    result = last_json(run.stdout)
    assert result["connected"] is True and result["ok"] is True
    assert result["identity"] == "dummyuser"
    assert result["token_sha256"] == hashlib.sha256(dummy.latest_token.encode()).hexdigest()


def test_connections_test_is_a_setup_check_it_exits_on_the_verdict(backend, live_backend, dummy):
    """``flow connections test`` is the completion check of ``flow project setup``'s connect step:
    exit 1 before the connection exists and for a scope the grant lacks, 0 once it holds — and it
    never prints the token."""
    before = connections_cli(os.environ, "test", TEST_LOOPBACK, "--json")
    assert before.returncode == 1, before.stdout + before.stderr

    assert connections_cli(os.environ, "connect", TEST_LOOPBACK, "--json").returncode == 0
    after = connections_cli(os.environ, "test", TEST_LOOPBACK, "--json")
    assert after.returncode == 0, after.stdout + after.stderr
    assert last_json(after.stdout)["ok"] is True
    assert dummy.latest_token not in after.stdout + after.stderr

    wider = connections_cli(os.environ, "test", TEST_LOOPBACK, "--scope", "never-granted", "--json")
    assert wider.returncode == 1 and last_json(wider.stdout)["missing_scopes"] == ["never-granted"]
