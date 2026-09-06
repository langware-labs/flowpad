"""The hub as the mailbox backend.

The same relationship ``HubSecretDriver`` has to secrets: the provider credential
lives on the hub, this side calls with the CALLER's own hub login, and nothing
local ever holds a mail vendor's API key. A DataSource pointed at one of these
mailboxes carries no secret at all — which is the whole difference between this
and the ``agentmail`` ingest driver, where the key is pasted into the row and
lands in its metadata shadow on disk.

**No caching**, deliberately, exactly as ``HubSecretDriver`` argues: a mailbox
that was decommissioned or a login that was revoked must take effect on the next
call, not after a process restart.

**Failures keep their status**, and here this driver DIVERGES from
``HubSecretDriver``, which swallows everything to ``None`` because "a hub that is
down must not take a worker spawn with it". A mailbox caller has to tell "this
agent has no inbox" (a person must act) from "the hub is unreachable" (try again
next tick), and collapsing both to ``None`` makes that impossible — so this
raises with the status intact and lets the caller decide. See ``hub_get_or_raise``.

The status is re-raised as the FAMILY's ``EmailInboxError``, never as
``HubError``: everything above this file is supposed to work against any mailbox
backend, and a caller that catches a hub-specific exception silently stops
working the day a second member (a directly-held IMAP account, say) raises
something else.
"""
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote

from flow_sdk.builtin.email_inbox_driver import EmailInboxError
from flow_sdk.cloud_client.shared.errors import HubError, HubErrorCode
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

#: The hub action every mailbox call hangs off:
#: ``/api/v1/graph/agent/<id>/email_inbox/…``
INBOX_ACTION = "email_inbox"


class HubEmailInboxDriver:
    kind = "flowpad-hub"

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def create_inbox(self, agent_id: str, **options: Any) -> dict:
        """Allocate the agent's mailbox.

        Idempotent at the hub: ``Agent.allocate_inbox`` returns the existing
        ACTIVE inbox rather than allocating a second one. That is what makes a
        retry safe after a half-finished create — and it matters, because the
        address is billable and permanent.
        """
        body = {k: v for k, v in options.items() if v}
        return await self._post(agent_id, "provision", body)

    async def enable_inbox(self, agent_id: str) -> dict:
        """Provision or reactivate the agent's existing Hub allocation."""
        return await self._post(agent_id, "enable", {})

    async def disable_inbox(self, agent_id: str) -> dict:
        """Pause the Hub allocation without deleting the provider mailbox."""
        return await self._post(agent_id, "disable", {})

    async def configure_inbox(self, agent_id: str, settings: dict) -> dict:
        """Write the mailbox's allowlist / read defaults. Human-only at the hub."""
        return await self._post(agent_id, "configure", settings)

    async def get_inbox(self, agent_id: str) -> Optional[dict]:
        """The non-deleted mailbox, or None.

        The hub wraps this one (``{"inbox": … | null}``) because a bare ``None``
        does not survive its envelope — so unwrap here and let callers see the
        descriptor or nothing.
        """
        data = await self._get(agent_id, None)
        return (data or {}).get("inbox") or None

    async def delete_inbox(self, agent_id: str) -> bool:
        """Release the address.

        False when there was nothing to release: the hub answers 404 for an agent
        with no active inbox, and a caller cleaning up should not have to care
        whether it is the first or second attempt. Every other failure still
        raises — a hub that is down must not read as "already gone".
        """
        from flow_sdk.cloud_client.transport.hub_http import hub_delete  # noqa: PLC0415

        try:
            await hub_delete(BuiltinEntityType.AGENT, agent_id, INBOX_ACTION)
            return True
        except HubError as exc:
            if exc.status_code == 404:
                return False
            raise await _as_email_error(exc) from exc

    # ── messages ─────────────────────────────────────────────────────────────

    async def list_messages(self, agent_id: str, **filters: Any) -> dict:
        params = {k: str(v) for k, v in filters.items() if v is not None}
        return await self._get(agent_id, "messages", params=params)

    async def get_message(self, agent_id: str, message_id: str) -> dict:
        return await self._get(agent_id, f"messages/{_path_safe(message_id)}")

    async def send(self, agent_id: str, body: dict) -> dict:
        return await self._post(agent_id, "send", body)

    async def reply(self, agent_id: str, message_id: str, body: dict) -> dict:
        return await self._post(agent_id, f"reply/{_path_safe(message_id)}", body)

    # ── transport ────────────────────────────────────────────────────────────

    async def _get(self, agent_id: str, sub_path: Optional[str], *, params: Optional[dict] = None) -> dict:
        """Through ``hub_get_or_raise``, never ``hub_get``.

        ``hub_get`` collapses "no hub configured", "signed out", "network down",
        "5xx" and a definitive 404 all to ``None``. Callers of a mailbox have to
        act differently on those, so the status has to survive.
        """
        from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415

        try:
            return await hub_get_or_raise(
                BuiltinEntityType.AGENT, agent_id, INBOX_ACTION, sub_path, params=params
            )
        except HubError as exc:
            raise await _as_email_error(exc) from exc

    async def _post(self, agent_id: str, sub_path: str, body: dict) -> dict:
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        try:
            return await hub_post(BuiltinEntityType.AGENT, body, agent_id, INBOX_ACTION, sub_path) or {}
        except HubError as exc:
            raise await _as_email_error(exc) from exc


async def _as_email_error(exc: HubError) -> EmailInboxError:
    """Hub failure → the family's failure, status intact, "missing" normalised.

    A missing target is ONE code here whatever the hub said — a 404, the
    ``target_not_found`` marker, or an older Hub's bare 401 for it. On that last
    ambiguous shape, verify the same credential against ``current-user``:
    success proves authentication is valid, so the denial can be classified
    without matching unstable error prose.
    """
    code = exc.code
    if exc.is_target_missing or (
        exc.status_code == 401 and not code and await _hub_login_is_valid()
    ):
        code = HubErrorCode.TARGET_NOT_FOUND.value
    return EmailInboxError(exc.status_code, exc.reason or "", code=code)


async def _hub_login_is_valid() -> bool:
    """Whether the configured Hub resolves the credential currently in use."""
    from flow_sdk.cloud_client.transport.hub_http import _hub_client  # noqa: PLC0415

    try:
        # The process-shared client: a fresh ``FlowpadClient`` per call rebuilds
        # the TLS context, which is the cost ``hub_http`` exists to avoid.
        async with _hub_client() as client:
            await client.get_user()
    except Exception:  # noqa: BLE001 — preserve the original mailbox failure
        return False
    return True


def _path_safe(message_id: str) -> str:
    """A Message-ID carries angle brackets and rides in the URL PATH.

    ``hub_graph_url`` does no quoting, so an unencoded id makes a malformed path
    — the trap the AgentMail driver's tests already pin.
    """
    return quote(message_id or "", safe="")
