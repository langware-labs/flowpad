"""Prove a connection actually works, by calling the provider with the token.

"Connected" in the Connections tab means a token exists and a project is allowed
to use it. It does NOT mean the token is still valid: it can be revoked at the
provider, expire, or have been issued for scopes that no longer cover what we
ask. None of that changes the local row, so the tab can read Connected while
every call fails.

A probe is the cheapest read-only call that answers "does this token still
work, and who is it": one request, no writes, no cost.

Providers without a probe return ``ok=None`` — "not checked" — rather than a
cheerful pass. A test button that reports success without testing anything is
worse than no test button.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

#: A probe is a single HTTP round-trip; this is its ceiling, not a retry budget.
PROBE_TIMEOUT_SECONDS = 10


@dataclass(frozen=True)
class ProviderProbe:
    """One read-only call that identifies the holder of a token."""

    url: str
    #: Pull the human-readable identity out of a successful body.
    identity: Callable[[dict[str, Any]], Optional[str]]
    #: Slack answers HTTP 200 with ``{"ok": false, "error": ...}``, so a probe
    #: cannot rely on the status code alone.
    body_error: Optional[Callable[[dict[str, Any]], Optional[str]]] = None
    #: The provider's auth headers for a token. One builder rather than an
    #: auth-header template plus an extras dict — the same shape
    #: ``cli/auth/lm_api_keys`` already uses for its key probes, so a provider
    #: that authenticates differently is a data change here.
    headers: Callable[[str], dict[str, str]] = lambda token: {"Authorization": f"Bearer {token}"}
    #: True when this probe has NOT been exercised against a live token of this
    #: provider. A rejection from an unverified probe may mean "the endpoint does
    #: not accept this token type" rather than "the token is bad", so it is
    #: reported as inconclusive instead of a failure — claiming a good token is
    #: dead would send the user to re-authorize for nothing.
    unverified: bool = False


_PROBES: dict[str, ProviderProbe] = {
    "github": ProviderProbe(
        # The canonical "who am I" for a user token. Read-only, no scopes needed
        # beyond what any token has.
        url="https://api.github.com/user",
        identity=lambda body: body.get("login") or body.get("name"),
    ),
    "anthropic": ProviderProbe(
        # The repo's own Anthropic reachability probe (`cli/auth/lm_api_keys`)
        # uses this endpoint — but with `x-api-key`, for an API KEY. An OAuth
        # token is a bearer, and whether this endpoint accepts one has NOT been
        # confirmed against a live claude.ai token. Hence `unverified`: a 401
        # here is reported as "could not verify", not "your token is dead".
        url="https://api.anthropic.com/v1/models",
        identity=lambda body: (
            f"{len(body.get('data') or [])} models" if isinstance(body.get("data"), list) else None
        ),
        headers=lambda token: {"Authorization": f"Bearer {token}", "anthropic-version": "2023-06-01"},
        unverified=True,
    ),
    "slack": ProviderProbe(
        # Slack's own token-test endpoint, and it is documented as exactly this:
        # verify the token and return the identity it belongs to.
        url="https://slack.com/api/auth.test",
        identity=lambda body: body.get("user") or body.get("team"),
        body_error=lambda body: None if body.get("ok") else str(body.get("error") or "invalid_auth"),
    ),
}


def get_probe(provider: str) -> Optional[ProviderProbe]:
    return _PROBES.get((provider or "").strip().lower())


@dataclass
class ProbeResult:
    """``ok`` is three-valued on purpose: True/False are answers, None means the
    question was never asked."""

    ok: Optional[bool]
    identity: Optional[str] = None
    detail: Optional[str] = None

    def as_data(self) -> dict[str, Any]:
        return asdict(self)


async def run_probe(provider: str, token: str) -> ProbeResult:
    """Call ``provider``'s probe with ``token`` and say what happened."""
    probe = get_probe(provider)
    if probe is None:
        return ProbeResult(ok=None, detail=f"No connection test defined for {provider}")
    if not token:
        return ProbeResult(ok=False, detail="No token stored for this provider")

    import httpx  # noqa: PLC0415

    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SECONDS) as client:
            response = await client.get(
                probe.url,
                headers={"Accept": "application/json", **probe.headers(token)},
            )
    except Exception as e:  # noqa: BLE001
        # A network failure is not an invalid token, and saying so would send the
        # user to re-authorize for nothing.
        return ProbeResult(ok=None, detail=f"Could not reach {provider}: {e}")

    if response.status_code in (401, 403):
        if probe.unverified:
            return ProbeResult(
                ok=None,
                detail=(
                    f"{provider} refused this probe — the token may be fine and the "
                    "probe endpoint simply may not accept OAuth tokens"
                ),
            )
        return ProbeResult(ok=False, detail="The provider rejected this token (revoked or expired)")

    try:
        body = response.json()
    except Exception:  # noqa: BLE001
        body = {}
    if not isinstance(body, dict):
        body = {}

    if response.status_code >= 400:
        return ProbeResult(ok=False, detail=f"{provider} answered {response.status_code}")

    if probe.body_error is not None:
        error = probe.body_error(body)
        if error:
            return ProbeResult(ok=False, detail=f"The provider rejected this token ({error})")

    return ProbeResult(ok=True, identity=probe.identity(body))
