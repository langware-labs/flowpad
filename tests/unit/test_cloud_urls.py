"""Unit tests for the desktop login callback URL.

The callback URL is the carrier of the per-(machine, instance) identity the
hub uses to name the desktop API-key slot (``desktop-cli:<instance id>``). If the
``instance`` param is ever dropped, the hub falls back to the host:port slot —
which every machine shares — and cross-machine logins on the same account
start revoking each other's keys again ("Cloud sign-in expired" ping-pong).
"""

from __future__ import annotations

from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from flow_sdk.cli.auth.cloud_urls import desktop_login_callback_url


class _Settings:
    def __init__(self, port: int = 9008, docker_public_url: str | None = None):
        self.port = port
        self.docker_public_url = docker_public_url


INSTANCE_ID = "0d51f14e-3f3f-5d4e-9a8b-1c2d3e4f5a6b"


def test_callback_url_carries_the_instance_id():
    with (
        patch("flow_sdk.instance_settings.get_instance_settings", return_value=_Settings(port=9008)),
        patch("flow_sdk.utils.machine_id.desktop_instance_id", return_value=INSTANCE_ID),
    ):
        url = desktop_login_callback_url()

    parsed = urlparse(url)
    assert parsed.hostname == "127.0.0.1"
    assert parsed.port == 9008
    assert parsed.path == "/auth/login_callback"
    assert parse_qs(parsed.query)["instance"] == [INSTANCE_ID]


def test_callback_url_honors_docker_public_url():
    with (
        patch(
            "flow_sdk.instance_settings.get_instance_settings",
            return_value=_Settings(docker_public_url="http://host.docker.internal:9010"),
        ),
        patch("flow_sdk.utils.machine_id.desktop_instance_id", return_value=INSTANCE_ID),
    ):
        url = desktop_login_callback_url()

    parsed = urlparse(url)
    assert parsed.hostname == "host.docker.internal"
    assert parsed.port == 9010
    assert parse_qs(parsed.query)["instance"] == [INSTANCE_ID]
