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
    #: The provider's opaque id for the ACCOUNT a token belongs to, read from a
    #: token response or a probe body. Not the display identity above: that is
    #: for humans and may change, this is compared for equality to notice that a
    #: connection was re-authorized as somebody else. None when the provider does
    #: not say — and a None never counts as a match.
    account_key: Optional[Callable[[dict[str, Any]], Optional[str]]] = None
    #: True when this probe has NOT been exercised against a live token of this
    #: provider. A rejection from an unverified probe may mean "the endpoint does
    #: not accept this token type" rather than "the token is bad", so it is
    #: reported as inconclusive instead of a failure — claiming a good token is
    #: dead would send the user to re-authorize for nothing.
    unverified: bool = False


_PROBES: dict[str, ProviderProbe] = {
    "github": ProviderProbe(
        # The numeric id, never `login` — a GitHub account can be renamed, and a
        # renamed account is still the same account.
        account_key=lambda body: str(body["id"]) if body.get("id") is not None else None,
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
        # No identity from this endpoint — it lists models, it does not say who
        # you are. Returning a model COUNT here would put a number where the UI
        # shows an account. `identity_from_credential` supplies the real one from
        # the stored response, which carries the account email.
        identity=lambda body: None,
        headers=lambda token: {"Authorization": f"Bearer {token}", "anthropic-version": "2023-06-01"},
        unverified=True,
    ),
    "slack": ProviderProbe(
        # `auth.test` returns team_id + user_id; the pair is the account, because
        # one user across two workspaces is two different connections.
        account_key=lambda body: (
            f"{body.get('team_id')}:{body.get('user_id')}"
            if body.get("team_id") and body.get("user_id")
            else None
        ),
        # Slack's own token-test endpoint, and it is documented as exactly this:
        # verify the token and return the identity it belongs to.
        url="https://slack.com/api/auth.test",
        identity=lambda body: body.get("user") or body.get("team"),
        body_error=lambda body: None if body.get("ok") else str(body.get("error") or "invalid_auth"),
    ),
}


def account_key_from(provider: str, body: dict[str, Any]) -> Optional[str]:
    """The account id this body identifies, or None when the provider is silent.

    Lives beside the probes because they already own "who is this token" — one
    table answering both halves of that question rather than a second one that
    can disagree with it.
    """
    probe = _PROBES.get((provider or "").strip().lower())
    if probe is None or probe.account_key is None:
        return None
    try:
        return probe.account_key(body or {})
    except Exception:  # noqa: BLE001 — a provider body is untrusted input
        return None


def token_from_credential(value: Any) -> Optional[str]:
    """The bearer token inside a stored credential, whatever shape it was saved in.

    Providers do not agree on this. GitHub's SOD entry is the token string;
    Anthropic's is the whole normalized OAuth response — a dict with
    ``access_token``, ``refresh_token``, ``expires_at`` and identity fields
    (``desktop_oauth._normalize_credential_dict``, selected by the provider's
    ``TokenShape``). Handing that dict
    to a probe would send ``Bearer {'provider': 'anthropic', ...}`` and read the
    provider's refusal as a dead token.

    Also unwraps a JSON-encoded dict, because a SOD driver may hand back the
    string it stored.
    """
    if not value:
        return None
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("{"):
            import json  # noqa: PLC0415

            try:
                return token_from_credential(json.loads(text))
            except Exception:  # noqa: BLE001
                return text
        return text or None
    if isinstance(value, dict):
        for key in ("access_token", "token", "api_key"):
            inner = value.get(key)
            if isinstance(inner, str) and inner.strip():
                return inner.strip()
    return None


def identity_from_credential(value: Any) -> Optional[str]:
    """An identity the credential already carries, for providers whose probe does
    not return one. Anthropic's stored response holds the account email."""
    if isinstance(value, dict):
        for key in ("email", "account", "organization_name", "account_uuid"):
            found = value.get(key)
            if isinstance(found, str) and found.strip():
                return found.strip()
    return None


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
        # user to re-authorize for nothing. httpx transport errors often carry an
        # empty str(), so fall back to the class name — "Could not reach github: "
        # tells the user nothing at all.
        reason = str(e) or type(e).__name__
        return ProbeResult(ok=None, detail=f"Could not reach {provider}: {reason}")

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
