"""Execute the declarative read-only probe attached to each OAuth provider."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Optional

from flow_sdk.core.oauth.provider_registry import OAuthProbeSpec, get_local_provider

# This is the existing single-round-trip ceiling, not a retry budget.
PROBE_TIMEOUT_SECONDS = 10

# Backward-compatible name for callers that used the old probe carrier.
ProviderProbe = OAuthProbeSpec


def _field(body: dict[str, Any], path: str) -> Any:
    value: Any = body
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _first_text(body: dict[str, Any], fields: tuple[str, ...]) -> Optional[str]:
    for field in fields:
        value = _field(body, field)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def get_probe(provider: str) -> Optional[OAuthProbeSpec]:
    descriptor = get_local_provider(provider)
    return descriptor.probe if descriptor is not None else None


def account_key_from(provider: str, body: dict[str, Any]) -> Optional[str]:
    probe = get_probe(provider)
    if probe is None:
        return None
    if probe.account_key_parts:
        parts = [_field(body, field) for field in probe.account_key_parts]
        if any(value is None or not str(value).strip() for value in parts):
            return None
        return ":".join(str(value).strip() for value in parts)
    return _first_text(body, probe.account_key_fields)


def token_from_credential(value: Any) -> Optional[str]:
    """Unwrap bearer-string and structured credentials without provider logic."""
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
    if isinstance(value, dict):
        for key in ("email", "account", "organization_name", "account_uuid"):
            found = value.get(key)
            if isinstance(found, str) and found.strip():
                return found.strip()
    return None


@dataclass
class ProbeResult:
    ok: Optional[bool]
    identity: Optional[str] = None
    account_key: Optional[str] = None
    detail: Optional[str] = None
    code: Optional[str] = None

    def as_data(self) -> dict[str, Any]:
        return asdict(self)


async def run_probe(provider: str, token: str) -> ProbeResult:
    """Execute a provider descriptor's strict verification request."""
    probe = get_probe(provider)
    if probe is None:
        return ProbeResult(
            ok=None,
            detail=f"No connection test defined for {provider}",
            code="probe_unavailable",
        )
    if not token:
        return ProbeResult(ok=False, detail="No token stored for this provider", code="missing_token")

    import httpx  # noqa: PLC0415

    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        **dict(probe.headers),
    }
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SECONDS) as client:
            response = await client.request(
                probe.method,
                probe.url,
                params=dict(probe.query),
                headers=headers,
            )
    except Exception as exc:  # noqa: BLE001
        reason = str(exc) or type(exc).__name__
        return ProbeResult(
            ok=None,
            detail=f"Could not reach {provider}: {reason}",
            code="verification_unreachable",
        )

    if response.status_code in (401, 403):
        return ProbeResult(
            ok=False,
            detail="The provider rejected this token (revoked or expired)",
            code="token_rejected",
        )
    if response.status_code >= 400:
        return ProbeResult(
            ok=False,
            detail=f"{provider} answered {response.status_code}",
            code="provider_error",
        )
    try:
        payload = response.json()
    except Exception:  # noqa: BLE001
        return ProbeResult(
            ok=None,
            detail=f"{provider} returned an unreadable verification response",
            code="invalid_response",
        )
    if not isinstance(payload, dict):
        return ProbeResult(
            ok=None,
            detail=f"{provider} returned an invalid verification response",
            code="invalid_response",
        )
    body = payload
    if probe.success_field and _field(body, probe.success_field) is not True:
        error = _field(body, probe.error_field) if probe.error_field else None
        return ProbeResult(
            ok=False,
            detail=f"The provider rejected this token ({error or 'invalid_token'})",
            code=str(error or "token_rejected"),
        )

    return ProbeResult(
        ok=True,
        identity=_first_text(body, probe.identity_fields),
        account_key=account_key_from(provider, body),
    )
