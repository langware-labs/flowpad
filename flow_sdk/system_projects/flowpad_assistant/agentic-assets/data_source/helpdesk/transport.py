"""``AppHub`` — the Flowpad hub as the help desk source reaches it on this machine.

The shared client's bearer, refresh and local-privacy gate, with its failures in the contract's
words a person can act on. Built by ``HelpdeskSource.build``; a test hands the source its own.
"""
from __future__ import annotations


class AppHub:
    """The ``HubTransport`` a help desk source is built over."""

    async def get(self, entity_type, entity_id, action):
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
        from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415

        try:
            return await hub_get_or_raise(entity_type, entity_id, action)
        except HubError as exc:
            raise hub_refusal(exc, signed_in=bool(self.me())) from exc

    async def post(self, entity_type, payload, entity_id, action):
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415
        from flow_sdk.sources.errors import Rejected  # noqa: PLC0415

        try:
            answer = await hub_post(entity_type, payload, entity_id, action)
        except HubError as exc:
            raise hub_refusal(exc, signed_in=bool(self.me())) from exc
        if answer is None:
            raise Rejected("Flowpad Cloud is not configured on this instance.")
        return answer

    def me(self) -> str:
        """The logged-in hub user, or "" when signed out — the instance config's user pointer."""
        try:
            from flow_sdk.cli.app_config import get_user  # noqa: PLC0415

            return str((get_user() or {}).get("id") or "")
        except Exception:  # noqa: BLE001
            return ""


def hub_refusal(exc, *, signed_in: bool):
    """A hub failure as the contract error that decides whether a desk keeps polling.

    The hub answers 401 "Forbidden access" to a caller with no role on the target, deliberately
    not distinguishing "no such desk" from "not a member" so existence does not leak: with a login
    in hand that is the membership answer, without one it is the login.
    """
    from flow_sdk.sources.errors import AccessDenied, NotFound, Rejected, SourceUnavailable  # noqa: PLC0415

    reason = str(getattr(exc, "reason", "") or "")
    status = int(getattr(exc, "status_code", 0) or 0)
    if status == 0:
        if "not configured" in reason:
            return Rejected(f"Flowpad Cloud is not configured on this instance ({reason}).")
        return SourceUnavailable(f"the hub could not be reached: {reason}")
    if status in (401, 403):
        return AccessDenied("You are not a member of this desk, or it does not exist." if signed_in else "Log in to Flowpad Cloud to read this desk.")
    if status == 404:
        return NotFound("This desk no longer exists on the hub.")
    if status == 429 or status >= 500:
        return SourceUnavailable(f"the hub answered {status}: {reason}")
    return Rejected(f"the hub refused the request ({status}): {reason}")


__all__ = ["AppHub", "hub_refusal"]
