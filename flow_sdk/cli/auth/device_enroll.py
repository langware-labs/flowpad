"""Device-code enrollment for ``flow connect`` on a machine that is not logged in.

RFC 8628 shape against the hub's ``/machine-enroll`` endpoints: ask for a code
pair, show the human-typed code (and a QR of the prefilled approval link), poll
with the machine-held ``device_code`` until a logged-in human approves in the hub
UI, then finish exactly like ``flow auth hub-login`` — the node-bound key the hub
minted becomes this instance's login, so the worker can dial and later ``flow``
commands take the direct path.
"""

from __future__ import annotations

import asyncio
import platform
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient
from flow_sdk.flowpad_types.runtime_environment import get_os_info

START_PATH = "/machine-enroll/start"
TOKEN_PATH = "/machine-enroll/token"


class EnrollmentDenied(RuntimeError):
    """A human denied this machine (or the code expired). Do not retry silently."""


@dataclass
class EnrollmentStart:
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int


@dataclass
class EnrollmentGrant:
    api_key: str
    node_id: str
    node_typeid: str
    node_name: str
    user_typeid: str


async def start_enrollment(
    *,
    machine_id: str,
    workspace_port: int | None,
    config: ApiConfig | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> EnrollmentStart:
    from flow_sdk._version import __version__

    payload = {
        "machine_id": machine_id,
        "hostname": platform.node(),
        # The same OS label the rest of the SDK reports (macOS / distro / Windows).
        "os_type": get_os_info().os_name,
        "flow_version": __version__,
        "workspace_port": workspace_port,
    }
    async with FlowpadClient(config or ApiConfig.from_env(), transport=transport) as client:
        response = await client.request("POST", START_PATH, json=payload)
    if response.status_code == 429:
        raise RuntimeError("the hub is rate-limiting enrollment from this address; try again in a minute")
    if response.status_code != 200:
        raise RuntimeError(f"hub refused to start enrollment (HTTP {response.status_code}): {response.text[:200]}")
    data = response.json()
    return EnrollmentStart(
        device_code=data["device_code"],
        user_code=data["user_code"],
        verification_uri=data["verification_uri"],
        verification_uri_complete=data["verification_uri_complete"],
        expires_in=int(data.get("expires_in", 900)),
        interval=int(data.get("interval", 5)),
    )


async def poll_for_grant(
    start: EnrollmentStart,
    *,
    config: ApiConfig | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    on_tick: Callable[[int], None] | None = None,
) -> EnrollmentGrant:
    """Poll ``/machine-enroll/token`` until approved; honours ``interval`` and ``slow_down``."""
    interval = max(1, start.interval)
    deadline = time.monotonic() + start.expires_in
    async with FlowpadClient(config or ApiConfig.from_env(), transport=transport) as client:
        while True:
            if on_tick:
                on_tick(max(0, int(deadline - time.monotonic())))
            await sleep(interval)
            try:
                response = await client.request("POST", TOKEN_PATH, json={"device_code": start.device_code})
            except httpx.RequestError as exc:
                if time.monotonic() > deadline:
                    raise EnrollmentDenied("enrollment code expired before the hub answered") from exc
                continue
            if response.status_code == 200:
                data = response.json()
                return EnrollmentGrant(
                    api_key=data["api_key"],
                    node_id=data["node_id"],
                    node_typeid=data.get("node_typeid", ""),
                    node_name=data.get("node_name", ""),
                    user_typeid=data.get("user_typeid", ""),
                )
            try:
                payload = response.json()
                status, server_interval = payload.get("status"), payload.get("interval")
            except ValueError:
                status, server_interval = None, None
            if status == "authorization_pending":
                if server_interval:
                    interval = max(interval, int(server_interval))
            elif status == "slow_down":
                interval = max(interval + 5, int(server_interval or 0))
            elif status == "access_denied":
                raise EnrollmentDenied("a hub user denied this machine")
            elif status == "expired_token":
                raise EnrollmentDenied("the enrollment code expired (15 minutes) — run `flow connect` again")
            elif status == "invalid_grant":
                raise EnrollmentDenied("the hub no longer recognises this enrollment — run `flow connect` again")
            else:
                raise RuntimeError(f"unexpected hub answer (HTTP {response.status_code}): {response.text[:200]}")
            if time.monotonic() > deadline:
                raise EnrollmentDenied("the enrollment code expired (15 minutes) — run `flow connect` again")


def render_qr(text: str) -> str | None:
    """Terminal QR (half-block characters) or ``None`` when ``segno`` is unavailable."""
    try:
        import io

        import segno
    except ImportError:
        return None
    buffer = io.StringIO()
    segno.make(text, error="m").terminal(out=buffer, compact=True, border=1)
    return buffer.getvalue()


def enrollment_banner(
    hub_url: str,
    *,
    user_code: str,
    verification_uri: str,
    verification_uri_complete: str,
    expires_in: int = 900,
    **_ignored: Any,
) -> str:
    """What the human reads: both ways in, the code, and a QR of the prefilled link.

    Takes the fields rather than an ``EnrollmentStart`` so the ``--docker`` host —
    which only ever sees the container's code marker, never its ``device_code`` —
    can print the same banner without inventing a placeholder record.
    """
    lines = [
        f"This machine is not logged in to {hub_url}.",
        "  • Run `flow auth login` here, or",
        f"  • Approve it from any logged-in browser: {verification_uri}",
        f"    enter code   {user_code}",
    ]
    qr = render_qr(verification_uri_complete)
    if qr:
        lines += ["", qr.rstrip("\n")]
    lines += ["", f"Waiting for approval (code expires in {expires_in // 60} min, Ctrl-C to stop)…"]
    return "\n".join(lines)


async def finalize_grant(grant: EnrollmentGrant) -> dict[str, Any]:
    """Make the hub-minted key this instance's login — the ``flow auth hub-login`` path."""
    from flow_sdk.cli.auth.cloud_login import _finalize_login
    from flow_sdk.cli.auth.hub_login import validate_api_key_async
    from flow_sdk.cloud_client.api.auth import LoginData

    user_info = await validate_api_key_async(grant.api_key)
    await _finalize_login(LoginData(token=grant.api_key, expires=None, refresh_token=None, user=user_info))
    return user_info
