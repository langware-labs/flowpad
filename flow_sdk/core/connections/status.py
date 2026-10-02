"""Every connection this box has, in one list.

The Connections screen used to fold four separate fetches in the browser — OAuth
grants, API-key credentials, the FlowPad account and the harness logins — which
put the definition of "connected" in the UI. Two surfaces then computed it
differently and disagreed in public twice: the LLM sources screen and Connections
reporting the same key differently, and a status ladder that read the strongest
verdict a resolver can issue as "nobody has asked".

So the composition happens here, once, and everything reads the result: the
screen, ``flow connections list`` and :mod:`flow_sdk.connections`.

**A live read, not a stored copy.** Nothing here is cached or mirrored into a
field — every call asks the four resolvers, all of which already exist and each
of which remains the only authority on its own kind. This module adds no
detection logic; it only projects what they answer into one shape.

Costs, since they are not uniform:

* FlowPad and harnesses — projections of the status record (``core.status``): one
  ``Capability`` read per harness and the hub socket's own verdict, no probe and no
  network. A harness nobody has probed reads UNKNOWN until :func:`check_harness_logins`
  runs -- a separate verb, because probing writes and this list is read on paths a
  person is waiting on (``require()``).
* OAuth    — a hub fetch memoised for ten minutes, plus one user read.
* Credentials — one ``.env.local`` listing and one git probe (three ``git``
  subprocesses) per scope root: the user's home always, the project's when one
  is named.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Optional

from flow_sdk.core.status.spec import HarnessStatusSpec, HubLogin, HubStatusSpec, InstallState, LoginState
from flow_sdk.flowpad_types.vendors import vendor_or_none
from flow_sdk.schema.data_spec.connection_spec import (
    FLOWPAD_ACCOUNT_PROVIDER,
    ConnectionKind,
    ConnectionSpec,
    ConnectionState,
)

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.project import Project


#: The status record's login words, in the Connections vocabulary -- one table per
#: vocabulary, so a new state is a KeyError here rather than a row that silently picks a word.
_HARNESS_STATE: dict[LoginState, ConnectionState] = {
    LoginState.SIGNED_IN: ConnectionState.CONNECTED,
    LoginState.SIGNED_OUT: ConnectionState.DISCONNECTED,
    LoginState.ERROR: ConnectionState.NEEDS_REAUTH,
    LoginState.SIGNING_IN: ConnectionState.SIGNING_IN,
    LoginState.NOT_CHECKED: ConnectionState.UNKNOWN,
    LoginState.N_A: ConnectionState.N_A,
}

_HUB_STATE: dict[HubLogin, ConnectionState] = {
    HubLogin.SIGNED_IN: ConnectionState.CONNECTED,
    HubLogin.SIGNED_OUT: ConnectionState.DISCONNECTED,
    HubLogin.REJECTED: ConnectionState.NEEDS_REAUTH,
    HubLogin.SIGNING_IN: ConnectionState.SIGNING_IN,
    #: A credential is stored but the hub has not confirmed it: not checked, not "out".
    HubLogin.OFFLINE: ConnectionState.UNKNOWN,
}


def _flowpad_row(hub: HubStatusSpec) -> ConnectionSpec:
    """This instance's own hub account, as the status record has it."""
    state = _HUB_STATE[hub.login]
    return ConnectionSpec(
        provider=FLOWPAD_ACCOUNT_PROVIDER,
        display_name="FlowPad",
        kind=ConnectionKind.FLOWPAD,
        sign_in="oauth",
        state=state,
        connected=state is ConnectionState.CONNECTED,
        identity=hub.email,
        detail=hub.error,
    )


def _harness_row(h: HarnessStatusSpec) -> ConnectionSpec:
    """One harness, projected from its status record -- never from what funds it.

    A missing CLI is NOT_INSTALLED, not "Not checked" (a login question about a CLI that is
    not there) and not absent (which hid why nothing funds it).
    """
    if h.install in (InstallState.NOT_INSTALLED, InstallState.UNKNOWN):
        return ConnectionSpec(
            provider=h.worker_type,
            display_name=h.label,
            kind=ConnectionKind.HARNESS,
            state=ConnectionState.NOT_INSTALLED,
            connected=False,
            sign_in="device" if h.has_device_login else "api_key",
            detail=f"{h.label} is not installed on this machine",
        )
    state = _HARNESS_STATE[h.login]
    return ConnectionSpec(
        provider=h.worker_type,
        display_name=h.label,
        kind=ConnectionKind.HARNESS,
        state=state,
        connected=state is ConnectionState.CONNECTED,
        identity=h.account.identity,
        account=_account_for(h),
        sign_in="device" if h.has_device_login else "api_key",
        detail=h.login_message,
    )


async def check_harness_logins(*, force: bool = False) -> dict[str, str]:
    """Ask the installed vendor CLIs whether they are signed in.

    A WRITE, and a separate verb for that reason: it mirrors each verdict onto
    ``Capability.login_state``, which is what makes every surface — this list,
    the LLM sources screen, the login modal — stop saying "not checked" at once.
    Folding it into :func:`list_connections` would have made a GET spawn
    subprocesses on the same path ``require()`` resolves through.

    Only the harnesses nobody has asked about, unless ``force``. ``login_state``
    is ``Persist.FALSE``, so ``None`` means exactly "nobody has asked" — probing
    the rest would re-shell a vendor CLI on every visit to answer a question
    already answered. ``force`` is the user saying "look again", the same words
    the Test button uses.

    Returns ``{worker: login_state}`` for the harnesses it asked. Never raises:
    a vendor that cannot be reached costs a verdict, not the screen.
    """

    async def one(worker: str) -> tuple[str, str] | None:
        cap = await _harness_capability(worker)
        if cap is None or (cap.login_state is not None and not force):
            return None
        await cap.refresh_login_state()
        return worker, str(getattr(cap.login_state, "value", cap.login_state) or "")

    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        worker_is_installed,
    )
    from flow_sdk.flowpad_types.vendors import VENDORS  # noqa: PLC0415

    installed = [v.key for v in VENDORS if worker_is_installed(v.key)]
    checked = await asyncio.gather(*(one(w) for w in installed), return_exceptions=True)
    return {result[0]: result[1] for result in checked if isinstance(result, tuple)}


async def _harness_capability(worker: str):
    """The harness's ``Capability`` row, or ``None`` on a box that has none."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        worker_capability_kind,
    )
    from flow_sdk.builtin.capability import Capability  # noqa: PLC0415

    return await Capability.get_by_kind(worker_capability_kind(worker))


def _account_for(h: HarnessStatusSpec) -> str:
    """WHAT KIND of account is signed in -- the vendor's own words where it says.

    Only claude reports a plan today; the rest get the vendor's noun and no invented tier.
    Nothing is claimed for a harness that is not signed in.
    """
    if h.login is not LoginState.SIGNED_IN:
        return ""
    vendor = vendor_or_none(h.worker_type)
    noun = vendor.account_noun if vendor else ""
    plan = h.account.plan.strip()
    if not plan:
        return noun
    # "max" -> "Max". Capitalised and otherwise untouched: a tier name of our own
    # would be a claim about someone's billing.
    plan = f"{plan[:1].upper()}{plan[1:]}"
    return f"{noun} · {plan}" if noun else plan


async def _credential_rows(project: Optional["Project"]) -> list[ConnectionSpec]:
    """The connected credentials: every user-scope one, plus the project's.

    A credential is a connection once every required value is in its store; a
    definition with no value is an entry in the Add dialog, not a row here.
    """
    from flow_sdk.builtin.credential_status import credentials_status  # noqa: PLC0415

    status = await credentials_status(project)
    return [
        ConnectionSpec(
            provider=row.name,
            display_name=row.title or row.name,
            kind=ConnectionKind.API_KEY,
            sign_in="api_key",
            state=ConnectionState.CONNECTED,
            connected=True,
            icon=row.icon_name,
            scope=row.scope,
            env_vars=tuple(var.env_var for var in row.vars),
        )
        for row in status.credentials
        if row.state == "connected"
    ]


async def list_connections(
    *, project: Optional["Project"] = None, include_unconnected: bool = False
) -> list[ConnectionSpec]:
    """Every connection, in the order the screen shows them.

    Machine-level kinds and user-scope credentials always; a project's own
    credentials only when a project is named — there is no server-side notion of
    "the selected project", that lives in the client.

    A pure read: nothing here probes, and :func:`check_harness_logins` is the
    verb that does. ``flow_sdk.connections.require`` resolves through here on
    paths a person is waiting on.

    ``include_unconnected`` keeps every OAuth provider — connected or not — in the
    same place in the order. The screen's table leaves it off (an unconnected
    provider belongs in its Add dialog); the SDK turns it on, because code asks
    "which providers exist, and is each connected" and each row says which.
    """
    from flow_sdk.core.connections.specs import _list_connection_specs_local  # noqa: PLC0415

    # The four resolvers share no data, so they run together; the order of the
    # result is the order the screen shows.
    from flow_sdk.core.status import build_status  # noqa: PLC0415

    status, oauth, credentials = await asyncio.gather(
        build_status(),
        _list_connection_specs_local(),
        _credential_rows(project),
    )
    rows: list[ConnectionSpec] = [_flowpad_row(status.hub), *(_harness_row(h) for h in status.harnesses)]
    # Held only by default: the table lists what exists, and an unconnected provider
    # belongs in the Add dialog. The catalogue itself stays complete for the connect flow.
    rows.extend(spec for spec in oauth if include_unconnected or spec.connected)
    rows.extend(credentials)
    return rows
