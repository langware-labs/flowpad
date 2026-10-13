"""The box's gate, in memory — for tests of its doors.

One armed secret, one way to mint what the hub would hand a browser (a ticket) and what a door
keeps (a grant cookie), one way to read a cookie back off a response. Five test files used to
carry their own copies and drifted on whether the denylist was reset.
"""

from __future__ import annotations

import time
from unittest.mock import patch

from flow_sdk.server import grants
from flow_sdk.server.service_proxy import SYSTEM_AUDIENCE, Grant, sign_grant

SECRET = "test-cookie-gate-secret"
ENDPOINT = "7b6d6ee3-82bb-4d27-b7b3-b19186648124"
CALLER = "user-alice"


def armed(secret: str | None = SECRET):
    """The stored secret as every reader sees it (the codec, the routes); the denylist starts empty."""
    grants.reset_for_tests()
    return patch("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", return_value=secret)


def ticket(
    audience: str = SYSTEM_AUDIENCE, caller: str = CALLER, endpoint: str = ENDPOINT, secret: str = SECRET
) -> str:
    """What the hub hands a browser: the grant subject, signed with the box's gate secret."""
    return sign_grant(Grant(caller, audience, endpoint), secret, now=int(time.time()))


def grant_cookie(audience: str = SYSTEM_AUDIENCE, caller: str = CALLER, endpoint: str = ENDPOINT) -> str:
    """A grant cookie as this process mints it, under the armed secret."""
    with armed():
        return grants.mint_grant(Grant(caller, audience, endpoint))


def cookie_value(response) -> str:
    """The grant a response set, exactly as a browser would send it back (still percent-encoded)."""
    return response.headers["set-cookie"].split(";", 1)[0].split("=", 1)[1]


__all__ = ["CALLER", "ENDPOINT", "SECRET", "armed", "cookie_value", "grant_cookie", "ticket"]
