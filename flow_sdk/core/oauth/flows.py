"""One registry for every authorization flow this instance runs.

Before this there were five completion mechanisms — a global login event, a fixed
``flowpad_cloud`` request id, per-flow loopback sessions, a correlated cloud-login
table and hub polling — and every one of them told EVERY open socket that a flow
ended. None knew who had asked, so none could answer "confirm it in the screen that
started it, and only show a browser page when nobody is left to tell".

The registry records the initiator when a flow starts and delivers the result to
that initiator alone when it finishes:

* a browser tab — its WebSocket ``connection_id``;
* a CLI / SDK process — a caller parked in :func:`wait_flow`.

:func:`finish_flow` is idempotent: the local landing route, the hub's websocket push
and an HTTP poll can all race to finish the same flow, and the first result wins.
It returns ``delivered`` so the landing page can decide between closing itself and
showing a full confirmation.

Flow kinds differ only by declared traits (:data:`FLOW_TRAITS`), never by branching
on a provider name.
"""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Optional

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec

logger = logging.getLogger(__name__)


class AuthFlowKind(StrEnum):
    #: The default: the hub runs the grant, stores the credential, then returns the
    #: browser to this instance, which stores its own copy.
    HUB_CODE = "hub_code"
    #: Authorization-code grant redirected to this instance directly (RFC 8252).
    LOOPBACK = "loopback"
    #: RFC 8628 device grant — no browser redirect at all.
    DEVICE = "device"
    #: The provider shows a code the user pastes back (no reachable redirect).
    MANUAL = "manual"
    #: This instance's own FlowPad sign-in.
    CLOUD_LOGIN = "cloud_login"
    #: FlowPad sign-in for a sandbox, redeemed through its public URL.
    SANDBOX_LOGIN = "sandbox_login"


class AuthFlowStatus(StrEnum):
    PENDING = "pending"
    SUCCESS = "success"
    CANCELLED = "cancelled"
    ERROR = "error"


class AuthWindow(StrEnum):
    """Who holds the consent window, which decides whether confirmation can close it."""

    #: The app opened it (web popup / Electron child window) and closes it on confirmation.
    OWNED = "owned"
    #: The system browser holds it (a provider that refuses embedded agents, or a CLI).
    SYSTEM = "system"
    #: There is no window — the user reads a code.
    NONE = "none"


class AuthFlowTraits(DataSpec):
    """What varies between flow kinds, declared once instead of branched on."""

    #: The browser's final redirect lands on this instance's landing route.
    lands_locally: bool
    window: AuthWindow


FLOW_TRAITS: dict[AuthFlowKind, AuthFlowTraits] = {
    AuthFlowKind.HUB_CODE: AuthFlowTraits(lands_locally=True, window=AuthWindow.OWNED),
    AuthFlowKind.LOOPBACK: AuthFlowTraits(lands_locally=True, window=AuthWindow.OWNED),
    AuthFlowKind.DEVICE: AuthFlowTraits(lands_locally=False, window=AuthWindow.NONE),
    AuthFlowKind.MANUAL: AuthFlowTraits(lands_locally=False, window=AuthWindow.OWNED),
    # Google-backed sign-in refuses embedded user agents, so the system browser holds it.
    AuthFlowKind.CLOUD_LOGIN: AuthFlowTraits(lands_locally=True, window=AuthWindow.SYSTEM),
    AuthFlowKind.SANDBOX_LOGIN: AuthFlowTraits(lands_locally=True, window=AuthWindow.OWNED),
}


class AuthFlowResult(DataSpec):
    """How a flow ended — the one terminal shape every surface reads."""

    status: AuthFlowStatus
    provider: str
    identity: str = ""
    #: Machine-readable reason for a non-success (``access_denied``, ``timeout`` …).
    code: str = ""
    detail: str = ""


class AuthFlow(DataSpec):
    flow_id: str
    kind: AuthFlowKind
    provider: str
    #: TypeId string of the entity the grant should attach to, when a screen asked for one.
    target: str = ""
    #: The browser tab that started the flow; empty for CLI / SDK initiators.
    initiator_connection_id: str = ""
    result: Optional[AuthFlowResult] = None

    @property
    def traits(self) -> AuthFlowTraits:
        return FLOW_TRAITS[self.kind]


@dataclass
class _Slot:
    flow: AuthFlow
    done: asyncio.Event = field(default_factory=asyncio.Event)
    #: Serializes completion work (e.g. storing the local copy) between racing finishers.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    waiters: int = 0
    #: Decided once, at the first finish — a later caller must not see a CLI waiter
    #: that already woke and left as "nobody was told".
    delivered: bool = False


#: Bounded like the hub's session table: the oldest FINISHED flow is dropped first,
#: so an abandoned consent tab cannot grow this without limit.
_FLOW_CAPACITY = 256
_flows: "OrderedDict[str, _Slot]" = OrderedDict()


def _evict() -> None:
    while len(_flows) >= _FLOW_CAPACITY:
        finished = next((fid for fid, slot in _flows.items() if slot.flow.result is not None), None)
        _flows.pop(finished if finished is not None else next(iter(_flows)))


def start_flow(
    kind: AuthFlowKind,
    provider: str,
    *,
    flow_id: str = "",
    target: str = "",
    initiator_connection_id: str = "",
) -> AuthFlow:
    """Register a flow. ``flow_id`` is the protocol's own ``state`` where it has one."""
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

    _evict()
    flow = AuthFlow(
        flow_id=flow_id or mint_uuid(),
        kind=kind,
        provider=provider,
        target=target,
        initiator_connection_id=initiator_connection_id,
    )
    _flows[flow.flow_id] = _Slot(flow=flow)
    return flow


def get_flow(flow_id: str) -> Optional[AuthFlow]:
    slot = _flows.get(flow_id)
    return slot.flow if slot else None


async def wait_flow(flow_id: str) -> Optional[AuthFlowResult]:
    """Park until the flow finishes; ``None`` for a flow this instance never started.

    A parked caller IS an initiator (the CLI / SDK case), so while it waits the
    landing page knows someone is there to be told.
    """
    slot = _flows.get(flow_id)
    if slot is None:
        return None
    slot.waiters += 1
    try:
        await slot.done.wait()
    finally:
        slot.waiters -= 1
    return slot.flow.result


def initiator_present(flow_id: str) -> bool:
    """Whether someone who asked for this flow can still be told it ended."""
    from flow_sdk.server.routes.websocket import get_connection_infos  # noqa: PLC0415

    slot = _flows.get(flow_id)
    if slot is None:
        return False
    connection_id = slot.flow.initiator_connection_id
    return slot.waiters > 0 or bool(connection_id and connection_id in get_connection_infos())


async def finish_flow(flow_id: str, result: AuthFlowResult) -> bool:
    """Record how a flow ended and tell its initiator. Returns ``delivered``.

    First result wins; a later finish (the losing side of a race) changes nothing
    and sends nothing. The tab initiator is checked BEFORE sending because
    ``send_personal_message`` swallows a dead socket — "sent" is not "delivered".
    """
    slot = _flows.get(flow_id)
    if slot is None:
        return False
    if slot.flow.result is not None:
        return slot.delivered

    slot.delivered = initiator_present(flow_id)
    slot.flow = slot.flow.model_copy(update={"result": result})
    slot.done.set()

    connection_id = slot.flow.initiator_connection_id
    if connection_id:
        await _send_to_connection(connection_id, _message_for(flow_id, result))
    logger.info(
        "[auth-flow] %s %s ended %s (delivered=%s)", slot.flow.kind, result.provider, result.status, slot.delivered
    )
    return slot.delivered


def flow_lock(flow_id: str) -> asyncio.Lock:
    """The lock racing finishers share; a fresh one for a flow this instance never started."""
    slot = _flows.get(flow_id)
    return slot.lock if slot is not None else asyncio.Lock()


def _message_for(flow_id: str, result: AuthFlowResult) -> str:
    from flow_sdk.api.api_types.messages import OAuthMessage, OAuthMessageStatus  # noqa: PLC0415

    message = OAuthMessage(
        oauth_request_id=flow_id,
        status=OAuthMessageStatus(result.status.value),
        message=result.detail or None,
        provider=result.provider,
        identity=result.identity or None,
        code=result.code or None,
    )
    return message.model_dump_json()


async def _send_to_connection(connection_id: str, message: str) -> None:
    from flow_sdk.server.routes.websocket import get_connection_infos, send_personal_message  # noqa: PLC0415

    info = get_connection_infos().get(connection_id)
    if info is not None:
        await send_personal_message(message, info.ws)
