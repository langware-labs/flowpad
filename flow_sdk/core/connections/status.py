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
* Harness  — one ``Capability`` read per harness, and only for harnesses whose
  CLI is actually installed. It does NOT probe: ``_device_source`` compares a
  ``login_state`` it is handed, so a device row costs nothing. That field does
  not survive a restart, which is why a fresh box reads UNKNOWN until someone
  runs :func:`check_harness_logins` — a separate verb, because probing writes
  and this list is read on paths a person is waiting on (``require()``).
* OAuth    — a hub fetch memoised for ten minutes, plus one user read.
* API keys — the expensive one, and the reason it is opt-in: ``env_local_status``
  shells out to three ``git`` subprocesses to decide whether ``.env.local`` is
  committable. Paid only when a project is named.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Optional

from flow_sdk.core.connections.types import ConnectionKind, ConnectionSpec, ConnectionState
from flow_sdk.flowpad_types.vendors import vendor_or_none
from flow_sdk.schema.data_spec.llm_source_spec import LLMSourceAuthority

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


async def _harness_rows() -> list[ConnectionSpec]:
    """One row per INSTALLED harness, from the funding resolver's own verdict.

    The DEVICE candidate specifically, not whichever source currently wins: this
    row is about the harness's own login, which must still be reported on a box
    where a stored API key outranks it.

    Uninstalled harnesses are not rows. A sign-in status for a CLI that is not on
    this machine is a question about nothing — the four vendors shipped as
    "Not checked" whether or not you had ever installed them, which is how the
    column stopped meaning anything.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import (  # noqa: PLC0415
        device_candidate,
    )

    workers = _installed_harnesses()
    # ONE capability read per harness: the verdict is derived from it and the
    # account line is carried on it, and `device_candidate` would otherwise
    # fetch the same row again a line later.
    caps = await asyncio.gather(*(_harness_capability(w) for w in workers))
    devices = await asyncio.gather(*(device_candidate(w, cap) for w, cap in zip(workers, caps)))
    rows: list[ConnectionSpec] = []
    for worker, cap, device in zip(workers, caps, devices):
        source = device.source if device else None
        state = _harness_state(source)
        vendor = vendor_or_none(worker)
        rows.append(
            ConnectionSpec(
                provider=worker,
                display_name=vendor.label if vendor else worker.title(),
                kind=ConnectionKind.HARNESS,
                state=state,
                connected=state is ConnectionState.CONNECTED,
                identity=str(getattr(cap, "login_identity", "") or ""),
                account=_account_for(worker, cap, state),
                # The resolver owns this sentence. Passed through untouched — it is
                # the only side that knows whether a probe ran and what it saw.
                detail=(source.reason or source.detail) if source else "",
            )
        )
    return rows


def _installed_harnesses() -> list[str]:
    """The harnesses whose CLI is on this machine, in display order.

    Disk-verified through ``worker_executable``, the same resolution a spawn and
    the auth probe use — not "discovery once saw it", so a CLI uninstalled after
    discovery stops being a row instead of reporting a login it cannot have.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        worker_executable,
    )
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import (  # noqa: PLC0415
        HUB_ENDPOINT_HARNESSES,
    )

    return [w for w in HUB_ENDPOINT_HARNESSES if worker_executable(w) is not None]


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

    checked = await asyncio.gather(*(one(w) for w in _installed_harnesses()), return_exceptions=True)
    return {result[0]: result[1] for result in checked if isinstance(result, tuple)}


async def _harness_capability(worker: str):
    """The harness's ``Capability`` row, or ``None`` on a box that has none."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        worker_capability_kind,
    )
    from flow_sdk.builtin.capability import Capability  # noqa: PLC0415

    return await Capability.get_by_kind(worker_capability_kind(worker))


def _account_for(worker: str, cap, state: ConnectionState) -> str:
    """WHAT KIND of account is signed in — the vendor's own words where it says.

    Only claude reports a plan today; the rest answer signed-in/out and nothing
    more, so they get the vendor's noun and no invented tier. Nothing is claimed
    for a harness that is not signed in: an account line under "Not checked"
    would assert the thing the status just declined to.
    """
    if state is not ConnectionState.CONNECTED:
        return ""
    vendor = vendor_or_none(worker)
    noun = vendor.account_noun if vendor else ""
    plan = str(getattr(cap, "login_plan", "") or "").strip()
    if not plan:
        return noun
    # "max" -> "Max". Capitalised and otherwise untouched: a tier name of our own
    # would be a claim about someone's billing.
    plan = f"{plan[:1].upper()}{plan[1:]}"
    return f"{noun} · {plan}" if noun else plan


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
    # PRESUMED is the only authority that means "nobody asked". CACHED and PROVEN
    # are both answers -- PROVEN is the STRONGEST one the resolver can issue, and
    # reading it as unknown is the precise bug the browser ladder had before this
    # fold moved here. Written as "only presumed is unknown" rather than a list of
    # the good ones, so a new authority reads as an answer instead of silently
    # joining the not-checked pile.
    if str(source.authority) == str(LLMSourceAuthority.PRESUMED):
        return ConnectionState.UNKNOWN
    return ConnectionState.CONNECTED


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

    A pure read: nothing here probes, and :func:`check_harness_logins` is the
    verb that does. ``flow_sdk.connections.require`` resolves through here on
    paths a person is waiting on.
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
