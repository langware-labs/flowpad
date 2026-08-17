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

#: Spellings that mean the hub. Mirrors ``secret_origin_driver._KIND_ALIASES``,
#: including the bare ``hub`` — the two families should not disagree about what
#: "the hub" is called.
_KIND_ALIASES = {
    "hub": "flowpad-hub",
    "flowpad_hub": "flowpad-hub",
}


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


class EmailInboxDriverRegistry:
    def __init__(self) -> None:
        self._drivers: dict[str, EmailInboxDriver] = {}

    def register(self, driver: EmailInboxDriver) -> None:
        self._drivers[driver.kind] = driver

    def kinds(self) -> list[str]:
        return sorted(self._drivers)

    def get(self, kind: str) -> EmailInboxDriver:
        name = normalize_email_inbox_kind(kind)
        try:
            return self._drivers[name]
        except KeyError as exc:
            raise KeyError(f"Unknown email inbox kind: {kind!r}") from exc


def normalize_email_inbox_kind(kind: Any) -> str:
    key = str(kind or "").strip().lower()
    return _KIND_ALIASES.get(key, key)


def _build_default_registry() -> EmailInboxDriverRegistry:
    from flow_sdk.builtin.drivers.hub_email_inbox_driver import HubEmailInboxDriver

    registry = EmailInboxDriverRegistry()
    registry.register(HubEmailInboxDriver())  # the hub — it holds the credential
    return registry


_DEFAULT_REGISTRY: Optional[EmailInboxDriverRegistry] = None


def get_email_inbox_registry() -> EmailInboxDriverRegistry:
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        _DEFAULT_REGISTRY = _build_default_registry()
    return _DEFAULT_REGISTRY


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
    return get_email_inbox_registry().get(kind)
