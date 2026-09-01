"""EmailInbox driver registry — where an agent's mailbox actually lives.

The behaviour side of a mailbox, the same way ``SecretOriginDriver`` is the
behaviour side of a secret pointer and ``ComputeProvider`` is the behaviour side
of a node. Callers name *an agent*; the driver decides where the address is
allocated and who holds the provider credential.

One member ships today (``flowpad-hub``), and that is deliberate rather than
provisional: the hub already fans out to AgentMail or its own in-memory provider
behind an identical interface, so "which mail vendor" is a question answered
above us. What the registry buys is that nothing upstream — the provisioning
action, the ingest driver, the UI — knows the hub is involved. A second member
(a directly-held IMAP account, say) is then a file.

The method surface is deliberately the hub's own ABC
(``flowpad/hub/external_apis/email_inbox/providers/email_inbox_provider.py``),
so the same names mean the same things at both tiers.
"""
from __future__ import annotations

from typing import Any, Optional, Protocol, runtime_checkable

from flow_sdk.builtin.secret_origin_driver import HUB_KIND_ALIASES
from flow_sdk.utils.kind_registry import KindRegistry


class EmailInboxError(Exception):
    """A mailbox backend refused or could not be reached.

    The family's own failure type, so callers above it never import a backend's.
    `status_code` follows HTTP where the backend has one and is **0 when there
    was no response at all** — the distinction a caller needs to tell "this
    mailbox is gone" (a person must act) from "the backend is unreachable" (try
    again later). Collapsing those is how an ingest source either parks on a
    dropped packet or spins forever on a mailbox that no longer exists.
    """

    def __init__(self, status_code: int, reason: str):
        self.status_code = status_code
        self.reason = reason
        super().__init__(f"email inbox error {status_code}: {reason}")


@runtime_checkable
class EmailInboxDriver(Protocol):
    """One mailbox backend.

    Every method takes the AGENT id, never an address: one inbox per agent is the
    model, and the address is an allocated attribute of the mailbox rather than
    its key. That is also why ``create_inbox`` is idempotent — asking twice for
    an agent's mailbox must not allocate (and bill for) a second one.
    """

    kind: str

    async def create_inbox(self, agent_id: str, **options: Any) -> dict:
        """Allocate this agent's mailbox, or return the one it already has."""
        ...

    async def get_inbox(self, agent_id: str) -> Optional[dict]:
        """The agent's active mailbox descriptor, or None when it has none."""
        ...

    async def delete_inbox(self, agent_id: str) -> bool:
        """Release the address. False when there was nothing to release."""
        ...

    async def list_messages(self, agent_id: str, **filters: Any) -> dict:
        ...

    async def get_message(self, agent_id: str, message_id: str) -> dict:
        """The FULL message, including a body — ``list_messages`` carries only a
        preview, and the two must never be mixed into one record."""
        ...

    async def send(self, agent_id: str, body: dict) -> dict:
        ...

    async def reply(self, agent_id: str, message_id: str, body: dict) -> dict:
        ...


def _build_default_registry(registry: "KindRegistry[EmailInboxDriver]") -> None:
    from flow_sdk.builtin.drivers.hub_email_inbox_driver import HubEmailInboxDriver

    registry.register(HubEmailInboxDriver())  # the hub — it holds the credential


#: The hub's spellings are ``secret_origin_driver``'s — one table, two families.
EMAIL_INBOX_DRIVERS: "KindRegistry[EmailInboxDriver]" = KindRegistry(
    "email inbox", aliases=HUB_KIND_ALIASES, builder=_build_default_registry
)




def get_email_inbox_driver(kind: Optional[str] = None) -> EmailInboxDriver:
    """The configured mailbox backend.

    ``kind`` defaults to ``ServiceConfig.email_inbox_provider``. Deliberately
    NOT ``email_provider``: that one names the system SENDER, and the hub keeps
    the same two apart for the same reason — one field with two meanings makes a
    value that is valid for one a hard failure for the other.
    """
    if not kind:
        from flow_sdk.config import default_service_config  # noqa: PLC0415

        kind = default_service_config.email_inbox_provider
    return EMAIL_INBOX_DRIVERS.get(kind)
