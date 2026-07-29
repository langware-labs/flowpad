"""Run a hub-defined provider's OAuth flow — on the hub, from the desktop.

The desktop cannot complete these flows itself, and that is not a gap to close
locally. Two things make it structural:

* **The client secret lives on the hub.** ``OauthProviderConfig`` requires one
  per provider, and shipping it to every desktop install would publish it.
* **The redirect URI is registered with the provider and points at the hub.**
  Slack redirects to ``<hub>/api/v1/graph/oauth/slack/callback``. A desktop
  process is not reachable there and cannot re-register a URI per install.

So the desktop delegates the whole flow: it asks the hub to open a session, the
browser visits the provider, the provider redirects to the hub, and the hub does
the code exchange and stores the token. This module is that delegation, and
nothing more — no provider config, no secret, no exchange.

What comes back is already the shape the client wants: the hub returns
``{oauth_request_id, provider, auth_url}`` (``OauthClientRequestInfo``), which is
exactly what ``oauthService.connect`` opens a popup for.

The one thing the desktop does NOT get for free is the completion signal: the
hub broadcasts it on its own websocket, which this process is not on. See
``poll_hub_credential`` — the same long-poll shape the GitHub device flow
already uses.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

logger = logging.getLogger(__name__)

#: How long to wait for the user to finish at the provider before handing the
#: wait back to the caller. NOT a retry budget being widened to mask a slow
#: path — it is how long a human plausibly takes to log in and approve, and it
#: matches the desktop device flow's own window.
from flow_sdk.app.actions.desktop_oauth import OAUTH_CALLBACK_TIMEOUT  # noqa: E402

#: Gap between hub polls while waiting. The hub has no push channel to this
#: process, so this is the resolution of "has the token landed yet".
POLL_INTERVAL_SECONDS = 3


async def hub_start_auth(provider: str) -> Optional[dict[str, Any]]:
    """Ask the hub to open an OAuth session for ``provider``.

    Returns the hub's ``OauthClientRequestInfo`` payload, or ``None`` when the
    hub is unreachable / not logged in / does not know the provider — callers
    fall back to their own error, so a hub outage reads as "cannot connect this
    provider" rather than a traceback.
    """
    from flow_sdk.core.oauth.hub_providers import _cloud_user_id, _hub_reachable  # noqa: PLC0415

    if not _hub_reachable():
        logger.debug("[oauth] hub not reachable; cannot start a hub flow for %r", provider)
        return None
    user_id = _cloud_user_id()
    if not user_id:
        return None

    try:
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        payload = await hub_get(BuiltinEntityType.USER, user_id, action="oauth", sub_path=f"{provider}/auth")
    except Exception as e:  # noqa: BLE001
        logger.warning("[oauth] hub refused to start a flow for %r: %s", provider, e)
        return None

    if not isinstance(payload, dict):
        return None
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    if not isinstance(data, dict) or not data.get("auth_url"):
        logger.warning("[oauth] hub returned no auth_url for %r", provider)
        return None
    return data


async def hub_holds_credential(credentials_name: str) -> bool:
    """Whether the hub user's env table now carries ``credentials_name``.

    Read against the hub's own table rather than a status endpoint: the row
    appearing IS the definition of "the flow completed and the token was
    stored", so there is no second source to disagree with.
    """
    from flow_sdk.core.oauth.hub_providers import _cloud_user_id  # noqa: PLC0415

    user_id = _cloud_user_id()
    if not user_id:
        return False
    try:
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        payload = await hub_get(BuiltinEntityType.USER, user_id, action="env-var", sub_path="table")
    except Exception as e:  # noqa: BLE001
        logger.debug("[oauth] hub credential check failed: %s", e)
        return False

    if not isinstance(payload, dict):
        return False
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    values = data.get("values") if isinstance(data, dict) else None
    if not isinstance(values, list):
        return False
    return any(isinstance(v, dict) and v.get("name") == credentials_name for v in values)


async def poll_hub_credential(credentials_name: str, timeout: int = OAUTH_CALLBACK_TIMEOUT) -> bool:
    """Wait until the hub holds ``credentials_name``, or ``timeout`` elapses.

    The desktop is not on the hub's websocket, so the hub's completion message
    never reaches this process. Polling the hub's table is the same shape the
    GitHub device flow already uses for its own wait — bounded, and the caller
    reports a plain "not yet" rather than hanging.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if await hub_holds_credential(credentials_name):
            return True
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
    return await hub_holds_credential(credentials_name)


async def hub_credential_value(credentials_name: str) -> Optional[str]:
    """Read the token the hub stored, through the one route that returns a value.

    Needed only for providers with LOCAL consumers of the raw token: `git push`,
    the `gh` capability and the repo actions all read `github_credentials` out of
    local SOD, so a GitHub token that exists only on the hub would leave them
    broken while the Connections tab claimed success.

    Providers with no local consumer (Slack) keep their token on the hub and are
    resolved at launch time, which is the design everything else follows.
    """
    from flow_sdk.core.oauth.hub_providers import _cloud_user_id  # noqa: PLC0415

    user_id = _cloud_user_id()
    if not user_id:
        return None

    # Ask only for something the hub says it has. Requesting a value the hub does
    # not hold is not merely wasted — a refusal from the hub surfaces to the user
    # as "Cloud request rejected", so the routine "not connected yet" case would
    # pop an error toast at them for nothing.
    if not await hub_holds_credential(credentials_name):
        logger.debug("[oauth] hub does not hold %r; not asking for its value", credentials_name)
        return None

    try:
        from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

        payload = await hub_get(
            BuiltinEntityType.USER, user_id, action="env-var", sub_path=f"{credentials_name}/value"
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[oauth] could not read %r from the hub: %s", credentials_name, e)
        return None

    if not isinstance(payload, dict):
        return None
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    if not isinstance(data, dict):
        return None
    value = data.get("value")
    return str(value) if value else None


def hub_credentials_name_for(provider: str) -> str:
    """The hub's own naming for a provider's user token: ``{PROVIDER}_OAUTH_USER_TOKEN``.

    Mirrors ``OauthProviderConfig.user_credentials_name`` on the hub. Needed
    because a provider can be named differently on each side — GitHub's token is
    ``github_credentials`` locally and ``GITHUB_OAUTH_USER_TOKEN`` on the hub —
    and the poll has to watch the hub's name while the local row keeps ours.
    """
    return f"{(provider or '').strip().upper()}_OAUTH_USER_TOKEN"
