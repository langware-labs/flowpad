"""Single source of truth for establishing local hub-login state in tests.

Production logs in through one funnel (``cloud_login``) that persists BOTH
halves of "logged in":

  * the token  → the sodot credential store via ``save_credentials``
  * the user record → ``config.json`` via ``set_user``

Login-gated code reads the *user record* (``is_logged_in()`` → ``get_user()``;
``hub_auth_available()``), NOT the token. A test that writes only the token is
"half-logged-in" — a state production never produces — and the app correctly
behaves as logged-out (e.g. ``handle_conversation_list`` skips the hub
catch-up). That is exactly how several hub tests drifted: each reimplemented
credential injection at the storage layer and most forgot ``set_user``.

Route every test that needs to be cloud-logged-in through ``login_as`` so the
local state mirrors the production funnel and can never be partial.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.cli.app_config import set_user
from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials


def login_as(hub_login_payload: Any) -> str:
    """Persist the full local login state for ``hub_login_payload``.

    Mirrors the production ``cloud_login`` funnel's local writes: the sodot
    token AND the ``config.json`` user record. Returns the api_key (JWT) so
    callers can pass it as a Bearer token for direct hub HTTP calls.
    """
    creds = UserHubCredentials.from_login_payload(hub_login_payload)
    save_credentials(creds)
    # The user record is what `is_logged_in()` / `hub_auth_available()` read.
    # The hub /login payload always carries a populated user dict; guard only
    # against a malformed payload so the failure is loud rather than a silent
    # "logged out".
    if not creds.user:
        raise AssertionError(
            "login payload carried no user record — cannot establish a logged-in "
            "state; check the hub /login response shape"
        )
    set_user(creds.user)
    return creds.api_key
