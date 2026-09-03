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

* FlowPad — one file read (``login_block``), no keychain, no network.
* Harness  — one ``Capability`` read per harness. It does NOT probe:
  ``_device_source`` compares a ``login_state`` it is handed, so a device row
  costs nothing and is usually ``UNKNOWN`` because that field does not survive
  a restart.
* OAuth    — a hub fetch memoised for ten minutes, plus one user read.
* API keys — the expensive one, and the reason it is opt-in: ``env_local_status``
  shells out to three ``git`` subprocesses to decide whether ``.env.local`` is
  committable. Paid only when a project is named.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Optional

from flow_sdk.core.connections.types import ConnectionKind, ConnectionSpec, ConnectionState

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.project import Project


async def _flowpad_row() -> ConnectionSpec:
    """This instance's own hub account."""
    from flow_sdk.cloud_client.auth_state import login_block  # noqa: PLC0415

    block = login_block() or {}
    user = block.get("user") or {}
    logged_in = str(block.get("status") or "") == "logged_in"
    return ConnectionSpec(
        provider="flowpad",
        display_name="FlowPad",
        kind=ConnectionKind.FLOWPAD,
        state=ConnectionState.CONNECTED if logged_in else ConnectionState.DISCONNECTED,
        connected=logged_in,
        identity=str(user.get("email") or "") if isinstance(user, dict) else "",
        detail=str(block.get("reason") or ""),
    )


#: Vendor spellings. ``worker.title()`` gives "Opencode", and the screen says
#: "OpenCode" — a display name that disagrees with the UI defeats the point of
#: one list.
_HARNESS_LABELS = {
    "claude": "Claude",
    "codex": "Codex",
    "copilot": "Copilot",
    "opencode": "OpenCode",
}


async def _harness_rows() -> list[ConnectionSpec]:
    """One row per harness, from the funding resolver's own verdict.

    The DEVICE candidate specifically, not whichever source currently wins: this
    row is about the harness's own login, which must still be reported on a box
    where a stored API key outranks it.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import (  # noqa: PLC0415
        HUB_ENDPOINT_HARNESSES,
    )
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import (  # noqa: PLC0415
        device_candidate,
    )

    devices = await asyncio.gather(*(device_candidate(w) for w in HUB_ENDPOINT_HARNESSES))
    rows: list[ConnectionSpec] = []
    for worker, device in zip(HUB_ENDPOINT_HARNESSES, devices):
        source = device.source if device else None
        state = _harness_state(source)
        rows.append(
            ConnectionSpec(
                provider=worker,
                display_name=_HARNESS_LABELS.get(worker, worker.title()),
                kind=ConnectionKind.HARNESS,
                state=state,
                connected=state is ConnectionState.CONNECTED,
                # The resolver owns this sentence. Passed through untouched — it is
                # the only side that knows whether a probe ran and what it saw.
                detail=(source.reason or source.detail) if source else "",
            )
        )
    return rows


def _harness_state(source) -> ConnectionState:
    """Only assert a sign-out when a probe actually said so.

    ``login_state`` is not persisted, so its absence means "nobody has asked" —
    reporting that as DISCONNECTED would tell a signed-in user they are signed
    out on every restart.
    """
    if source is None:
        return ConnectionState.UNKNOWN
    if not source.eligible:
        return ConnectionState.DISCONNECTED
    if str(source.authority) == "cached":
        return ConnectionState.CONNECTED
    return ConnectionState.UNKNOWN


async def _credential_rows(project: "Project") -> list[ConnectionSpec]:
    """The API-key credentials this project declares, and whether they resolve.

    A credential EXISTS when its values do. A definition with no value is not a
    connection — it is an entry in the Add dialog — so it is not emitted here,
    which is the rule the browser fold used to own.
    """
    from flow_sdk.builtin.credential_spec import CredentialSpec  # noqa: PLC0415

    specs = await CredentialSpec.get_all()
    if not specs:
        return []

    resolve = await project.secret_resolve_status()
    by_var = {
        str(row.get("env_var") or ""): row
        for row in ((getattr(resolve, "data", None) or {}).get("secrets") or [])
    }

    rows: list[ConnectionSpec] = []
    for spec in specs:
        required = spec.required_var_names() or spec.var_names()
        if not required:
            continue
        if not all(str(by_var.get(var, {}).get("status") or "") == "available" for var in required):
            continue
        rows.append(
            ConnectionSpec(
                provider=str(spec.name or ""),
                display_name=str(spec.title or spec.name or ""),
                kind=ConnectionKind.API_KEY,
                state=ConnectionState.CONNECTED,
                connected=True,
                icon=str(spec.icon_name or ""),
                scope="project",
                env_vars=tuple(spec.var_names()),
            )
        )
    return rows


async def list_connections(*, project: Optional["Project"] = None) -> list[ConnectionSpec]:
    """Every connection, in the order the screen shows them.

    Machine-level kinds always; API-key credentials only when a project is named,
    because their identity IS ``(project_id, env_var)`` and there is no
    server-side notion of "the selected project" — that lives in the client. A
    caller with no project gets a smaller honest list rather than a guess.
    """
    from flow_sdk.core.connections.specs import _list_connection_specs_local  # noqa: PLC0415

    # The four resolvers share no data, so they run together; the order of the
    # result is the order the screen shows.
    flowpad, harnesses, oauth, credentials = await asyncio.gather(
        _flowpad_row(),
        _harness_rows(),
        _list_connection_specs_local(),
        _credential_rows(project) if project is not None else _none(),
    )
    rows: list[ConnectionSpec] = [flowpad, *harnesses]
    # Held only: the table lists what exists, and an unconnected provider belongs
    # in the Add dialog. The catalogue itself stays complete for the connect flow.
    rows.extend(spec for spec in oauth if spec.connected)
    rows.extend(credentials)
    return rows


async def _none() -> list[ConnectionSpec]:
    return []
