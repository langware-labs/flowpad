"""Which ``LLMSource`` funds a spawn — the inventory, the overlay, and the resolver.

The shape itself lives in ``schema/data_spec/llm_source_spec`` (stdlib + pydantic, no
cycle). This module is everything that needs to look at the box: what sources exist for
a harness right now, which of them may fund it, and which one wins.

Two producers, deliberately separate:

* **inventory** (``_inventory``) — what EXISTS: installed harnesses and their cached
  login state, configured provider keys, the hub endpoints this box may spend. Cheap,
  context-free, and served by the memos that already exist.
* **overlay** (``list_llm_sources``) — what may fund THIS process: eligibility, rank,
  reasons. Pure and per-call.

Keeping them apart is not tidiness. It is what lets the resolver promise the thing that
matters: **resolution makes no network calls.** It needs a typeid, a local key read and
cached availability -- nothing else. Merge the two and the first person to need a fresh
endpoint list puts an ``await`` on the hub in front of every worker spawn.

The ladder, most specific first::

    1. process.llm_endpoint_typeid    hard -- this process was told to spend it
    2. project.llm_endpoint_typeid    hard -- the project enforces it
    3. Capability.auth_mode/provider  hard -- what the user explicitly asked for
    4. device -> api_key -> endpoint  soft -- the default order, when nobody asked

Everything EXPLICIT is hard; only the default order is soft. When a hard rung cannot be
honoured we raise, naming what imposed it -- falling back would lose the accounting the
constraint existed to guarantee and silently spend something the caller did not choose.
Rung 4 is the only one that yields, because nothing was asked for in the first place.

### Why the device rung is not simply "first"

``Capability.login_state`` is ``Persist.FALSE`` -- runtime-only. It is ``None`` after
every backend restart, and ``_mirror_probe_to_login_state`` deliberately never writes a
verdict for a probe that did not decide. So ``None`` means *"nobody has asked"*, not
*"asked and it failed"*, and it is the COMMON state, not an edge case.

That leaves two failure modes pulling in opposite directions:

* treat ``None`` as usable and a fresh sandbox -- claude installed, never logged in --
  picks device login and hangs the turn on a vendor login picker;
* treat ``None`` as unusable and every desktop user who never opened the harness screen
  loses a device login that works perfectly well.

The signal that separates them is the **box binding**: the hub pushing an endpoint to a
box is a deliberate act that says what that box is for. So an unproven device login
keeps its place at the head of the order on an unbound box (which is exactly today's
behaviour, preserved), and yields to the endpoint on a bound one. A device login the
box has positively been TOLD is signed out is ineligible either way -- that is a
verdict, and we honour verdicts.
"""

from __future__ import annotations

import logging
from typing import NamedTuple

from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import driver_api_auth_spec
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.schema.data_spec.llm_source_spec import (
    LLMSource,
    LLMSourceAuthority,
    LLMSourceKind,
    LLMSourceOrigin,
)

logger = logging.getLogger(__name__)

#: Rank bands. Device sits at the head of the order, and drops to the tail on a bound
#: box when nobody has proven it -- see the module docstring.
_RANK_DEVICE = 0
_RANK_KEY = 10
_RANK_ENDPOINT = 20
_RANK_DEVICE_UNPROVEN = 30

#: Namespace stored provider keys live under (``flow_sdk.cli.auth.lm_api_keys._PREFIX``).
_LM_PREFIX = "lm_api."

class _Endpoint(NamedTuple):
    """The three things a source needs off an endpoint, from EITHER the hub listing or the
    pushed binding — so the builder below reads one shape instead of branching per field."""

    name: str
    provider: str
    enabled: bool


class LLMSourceError(Exception):
    """No source can fund this spawn. Carries every candidate's reason.

    The message is a rendering of the list, not a separate sentence written here: the
    whole point of ``LLMSource.reason`` is that one explanation serves the picker and
    the failure alike.
    """

    def __init__(self, worker_type: str, sources: list[LLMSource]):
        self.worker_type = worker_type
        self.sources = list(sources)
        lines = [f"  - {s.name or s.kind}: {s.reason or 'unavailable'}" for s in self.sources]
        body = "\n".join(lines) if lines else "  (no source of any kind is configured)"
        super().__init__(f"{worker_type} has no usable LLM source:\n{body}")

# ── inventory ────────────────────────────────────────────────────────────────────

def _device_source(worker_type: str, login_state, box_bound: bool) -> LLMSource:
    """The vendor device login for *worker_type*, and what we actually know about it.

    Deliberately says nothing about whether the CLI is INSTALLED. That is a different
    question with an owner already: ``build_worker_spawn_env`` refuses a missing binary
    with ``no_worker_message``, which distinguishes "codex is not installed" from
    "nothing is installed". Answering it here too would only mean an uninstalled harness
    failed earlier, in a different place, with a worse sentence.
    """
    name = f"{worker_type} device login"
    # ``.value``, never ``str()``: ``DeviceLoginState`` is a plain ``(str, Enum)``, not a
    # ``StrEnum``, so ``str(DeviceLoginState.AUTHENTICATED)`` is the REPR
    # ``"DeviceLoginState.AUTHENTICATED"``. Comparing that to ``"authenticated"`` never
    # matched, so every verdict fell through to "nobody has asked" -- which silently made a
    # harness the probe had positively called SIGNED OUT eligible, and picking it hands the
    # turn to a vendor login picker and hangs it.
    state = getattr(login_state, "value", login_state) or ""
    if state == "authenticated":
        return LLMSource(
            kind=LLMSourceKind.DEVICE, name=name, rank=_RANK_DEVICE, eligible=True, auto=True,
            authority=LLMSourceAuthority.CACHED, detail="signed in",
        )
    if state in ("idle", "error"):
        # A probe positively said so. We only assert signed-out when we were told.
        return LLMSource(
            kind=LLMSourceKind.DEVICE, name=name, rank=_RANK_DEVICE, eligible=False,
            reason=f"{worker_type} is signed out", authority=LLMSourceAuthority.CACHED,
        )
    # Nobody has asked (the common case: the field does not survive a restart). Usable, so
    # no ``reason`` -- the caveat is display, and putting it in ``reason`` made a perfectly
    # good device login report it as its status message.
    return LLMSource(
        kind=LLMSourceKind.DEVICE,
        name=name,
        rank=_RANK_DEVICE_UNPROVEN if box_bound else _RANK_DEVICE,
        eligible=True,
        auto=not box_bound,
        authority=LLMSourceAuthority.PRESUMED,
        detail=(
            "sign-in not checked; this box is bound to a hub endpoint"
            if box_bound
            else "sign-in state not checked"
        ),
    )

def _key_sources(spec, configured: set[str]) -> list[LLMSource]:
    """One source per provider this harness supports AND has a stored key for.

    Validity is deliberately NOT checked: ``validate_lm_api`` is a network call, and a
    spawn must never wait on a provider's account API to find out whether it may start.
    A bad key fails at the first request, loudly and quickly.
    """
    out: list[LLMSource] = []
    for provider in spec.supported_providers:
        if provider is LMApiProvider.FLOWPAD:
            continue  # the hub endpoint is its own kind, not a "key"
        has_key = provider.value in configured
        out.append(
            LLMSource(
                kind=LLMSourceKind.API_KEY,
                provider=provider.value,
                name=f"{provider.value} key",
                rank=_RANK_KEY,
                eligible=has_key,
                auto=has_key,
                authority=LLMSourceAuthority.PROVEN,
                reason="" if has_key else f"no {provider.value} key is stored on this machine",
            )
        )
    return out

def _endpoint_sources(spec, endpoints, bound, hub_logged_in: bool) -> list[LLMSource]:
    """The hub endpoints this harness could spend.

    Availability is *presumed*: whether a chain ends in a root with a live credential is
    the hub's answer to give, and it gives it at invoke time. Only the bound endpoint is
    ``auto`` -- the others are offers, and choosing between budgets is not a decision to
    make silently on someone's behalf.
    """
    if spec.hub_endpoint_binding is None:
        return []
    bound_typeid = bound.endpoint_typeid if bound else ""
    known: dict[str, _Endpoint] = {
        str(e.typeid): _Endpoint(str(getattr(e, "name", "")), str(getattr(e, "provider", "")), bool(getattr(e, "enabled", True)))
        for e in endpoints
    }
    if bound_typeid and bound_typeid not in known:
        # The push is authoritative even when the listing has not caught up: a freshly
        # bound (or freshly shared) endpoint must work before any cache has heard of it.
        # Projected to the same shape rather than left as a sentinel, so the loop below
        # never has to ask which of two places a field came from.
        known[bound_typeid] = _Endpoint(bound.name if bound else "", bound.provider if bound else "", True)
    out: list[LLMSource] = []
    for typeid, endpoint in known.items():
        name = endpoint.name or "hub endpoint"
        reason = ""
        if not hub_logged_in:
            reason = "this box is not logged in to the hub"
        elif not endpoint.enabled:
            reason = f"endpoint {name} is disabled"
        out.append(
            LLMSource(
                kind=LLMSourceKind.ENDPOINT,
                endpoint_typeid=typeid,
                provider=LMApiProvider.FLOWPAD.value,
                name=name,
                detail=endpoint.provider,
                root_provider=endpoint.provider,
                rank=_RANK_ENDPOINT,
                eligible=not reason,
                auto=(not reason) and typeid == bound_typeid,
                authority=LLMSourceAuthority.PRESUMED,
                reason=reason,
            )
        )
    return out

async def _inventory(worker_type: str) -> list[LLMSource]:
    """Every source that EXISTS for *worker_type*, with what we know about each.

    No context, no ranking decisions beyond the static bands -- and no network calls:
    the endpoint listing is read from the memo (``cached_only``), because this runs in
    the spawn path.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.cli.auth.secrets import get_secrets
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints, get_hub_llm_endpoint

    spec = driver_api_auth_spec(worker_type)
    if spec is None:
        return []

    cap = await Capability.get_by_kind(worker_capability_kind(worker_type))
    bound = get_hub_llm_endpoint()
    # NOT ``hub_auth_available()``: that answers "is there a logged-in USER record", while the
    # question here is "is there a key to sign with" -- a box holding a key without a user
    # record can still spend its endpoint, and must.
    hub_logged_in = _hub_logged_in()
    # ``get_secrets`` rather than ``list_lm_api``: the latter appends a "managed" flowpad row
    # that costs a second sod decrypt to build, and it is the one row this filter discards.
    configured = {
        str(rec.get("name", ""))[len(_LM_PREFIX) :]
        for rec in get_secrets()
        if str(rec.get("name", "")).startswith(_LM_PREFIX)
    }
    endpoints = await fetch_hub_llm_endpoints(cached_only=True)

    sources = [_device_source(worker_type, getattr(cap, "login_state", None), bound is not None)]
    sources += _key_sources(spec, configured)
    sources += _endpoint_sources(spec, endpoints, bound, hub_logged_in)
    return sources

# ── overlay ──────────────────────────────────────────────────────────────────────

def _hub_logged_in() -> bool:
    """Whether a hub request from this box would carry a key.

    NOT ``hub_auth_available()``: that answers "is there a logged-in USER record", while the
    question here is "is there a key to sign with" -- a box holding a key without a user
    record can still spend its endpoint, and must. Imported per call so a monkeypatch on it
    applies (a module-scope binding freezes the function at import time).
    """
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key  # noqa: PLC0415

    return bool(resolve_hub_api_key())


async def _constraint(process) -> tuple[str, LLMSourceOrigin] | None:
    """The endpoint this spawn is REQUIRED to spend, and who required it.

    Process beats project. A process with no project contributes nothing rather than
    failing closed -- ``project_id`` is legitimately ``None`` for embedded and inline
    processes, and those must keep working.
    """
    typeid = str(getattr(process, "llm_endpoint_typeid", "") or "")
    if typeid:
        return typeid, LLMSourceOrigin.PROCESS

    from flow_sdk.builtin.project import Project

    project = None
    project_id = getattr(process, "project_id", None)
    if project_id:
        project = await Project.get_by_id(project_id)
    if project is None:
        # Same fallback the secret resolver uses -- see ``apply_worker_secret_env``.
        try:
            project = await Project.get_ancestor(process.typeid)
        except Exception:  # noqa: BLE001 -- no project is an ordinary state, not an error
            project = None
    typeid = str(getattr(project, "llm_endpoint_typeid", "") or "") if project is not None else ""
    if typeid:
        return typeid, LLMSourceOrigin.PROJECT
    return None

def _preferred(cap) -> str:
    """The provider the user explicitly asked for, or ``""``.

    ``auth_mode == "device"`` is the FIELD DEFAULT and therefore indistinguishable from
    "never touched" -- so it is read as no preference, and the default order applies.
    Only an explicit ``api`` mode names a provider.

    A stated preference is a CONSTRAINT, not a hint: when the named provider has no
    usable credential the spawn fails loudly rather than quietly spending something else.
    Silently substituting another funding source would spend a subscription or a budget
    the user did not choose -- and the fall-through it replaces (the vendor device-login
    picker) hangs the turn rather than failing it.

    Known limitation: there is no way to say "device, explicitly". ``device`` is the
    field's default, so a user who wants it on a box the hub has bound cannot currently
    express that; the box binding wins. Expressing it needs a third state, which the
    picker in the next phase is the right place to introduce.
    """
    if cap is None or getattr(cap, "auth_mode", "device") != "api":
        return ""
    return str(getattr(cap, "api_provider", "") or "")

def _apply_constraint(
    sources: list[LLMSource], typeid: str, origin: LLMSourceOrigin, hub_logged_in: bool
) -> list[LLMSource]:
    """Render the constraint ONTO the list: the named endpoint stays, everything else
    comes back ineligible carrying the sentence that says why.

    This is what makes the list self-explaining -- the failure message and the picker's
    greyed rows are the same data, so they cannot disagree.
    """
    scope = "this process" if origin is LLMSourceOrigin.PROCESS else "this project"
    why = f"{scope} requires hub endpoint {typeid}"
    out: list[LLMSource] = []
    named = False
    for source in sources:
        if source.kind is LLMSourceKind.ENDPOINT and source.endpoint_typeid == typeid:
            named = True
            out.append(source.model_copy(update={"rank": -1, "auto": source.eligible, "origin": origin}))
        else:
            out.append(source.ineligible(why))
    if not named:
        # Not in the inventory is not a refusal: the hub authorizes every invoke against
        # the endpoint in the URL, so a typeid we have not heard of can only earn a
        # 401/403 -- and a freshly shared endpoint must work before any cache knows it.
        # Eligibility still has to be judged here, not left to whoever materializes the
        # binding: a box that cannot sign for the endpoint cannot spend it, however
        # emphatically it was named.
        unusable = "" if hub_logged_in else "this box is not logged in to the hub"
        out.append(
            LLMSource(
                kind=LLMSourceKind.ENDPOINT,
                endpoint_typeid=typeid,
                provider=LMApiProvider.FLOWPAD.value,
                name=typeid,
                rank=-1,
                eligible=not unusable,
                auto=not unusable,
                authority=LLMSourceAuthority.PRESUMED,
                origin=origin,
                reason=unusable,
            )
        )
    return out

async def list_llm_sources(worker_type: str, process=None) -> list[LLMSource]:
    """Every source that could fund *worker_type*, ranked, with reasons — for THIS
    process when one is given, otherwise the box-wide view the picker renders."""
    sources = await _inventory(worker_type)
    if not sources:
        return []

    if process is not None:
        constraint = await _constraint(process)
        if constraint is not None:
            return sorted(
                _apply_constraint(sources, *constraint, _hub_logged_in()), key=lambda s: s.rank
            )

    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    cap = await Capability.get_by_kind(worker_capability_kind(worker_type))
    preferred = _preferred(cap)
    if preferred:
        why = f"{worker_type} is set to use {preferred}"
        sources = [
            source.model_copy(update={"rank": -1, "origin": LLMSourceOrigin.USER})
            if source.provider == preferred
            else source.ineligible(why)
            for source in sources
        ]
    return sorted(sources, key=lambda s: s.rank)

# ── resolution ───────────────────────────────────────────────────────────────────

def pick_llm_source(sources: list[LLMSource]) -> LLMSource | None:
    """The winner of a ranked list: *first eligible AND auto*, else *first eligible*.

    The second pass is not a nicety. It is what keeps an unproven device login usable on
    an unbound box when nothing else is configured -- the state most desktop installs are
    in, and exactly what happened before this resolver existed.

    One function, so the answer a spawn uses and the answer a picker displays cannot
    drift apart. That drift is precisely what made a stale ``login_state`` tell users
    their working harness was signed out.
    """
    for source in sources:
        if source.eligible and source.auto:
            return source
    for source in sources:
        if source.eligible:
            return source
    return None

async def resolve_box_llm_source(worker_type: str) -> LLMSource | None:
    """What would fund *worker_type* with no process in hand — the box-wide answer the
    picker and the box status report."""
    return pick_llm_source(await list_llm_sources(worker_type))

async def resolve_llm_source(process) -> LLMSource:
    """The source that funds this spawn. Raises :class:`LLMSourceError` when none can."""
    worker_type = getattr(getattr(process, "driver", None), "name", None) or getattr(process, "worker_type", "")
    sources = await list_llm_sources(worker_type, process)
    chosen = pick_llm_source(sources)
    if chosen is None:
        raise LLMSourceError(worker_type, sources)
    return chosen
