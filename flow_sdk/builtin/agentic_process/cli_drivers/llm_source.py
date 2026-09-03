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

``Capability.login_state`` is ``Persist.FALSE`` -- DB-only, never mirrored into
metadata.json. The startup sweep RESOLVES it (``discovery._resolve_login_states``) and
re-probes on every boot, so it is normally a real verdict rather than ``None`` by the time
anything resolves a spawn. ``_mirror_probe_to_login_state`` deliberately never writes a
verdict for a probe that did not decide, so ``None`` still means *"nobody has asked"*, not
*"asked and it failed"* -- it just is no longer the COMMON state.

It used to be. Nothing probed at startup, so ``None`` was what every box had, and the rule
below silently resolved every unbound desktop box to a device login nobody had verified --
a spawn handed no credentials at all when that login did not exist.

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
from typing import TYPE_CHECKING, Any, NamedTuple

from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import driver_api_auth_spec
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.schema.data_spec.llm_source_spec import (
    LLMSource,
    LLMSourceAuthority,
    LLMSourceOrigin,
)

if TYPE_CHECKING:
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

logger = logging.getLogger(__name__)

#: Rank bands. Device sits at the head of the order, and drops to the tail on a bound
#: box when nobody has proven it -- see the module docstring.
_RANK_DEVICE = 0
_RANK_KEY = 10
_RANK_ENDPOINT = 20
_RANK_DEVICE_UNPROVEN = 30


def _hub_stub(typeid: str, *, name: str = "", provider: str = "") -> "LLMEndpoint":
    """A hub endpoint we know only by typeid.

    Used for the two cases where a budget is named before any listing describes it: the
    pushed binding arriving ahead of the cache, and a constraint naming an endpoint this box
    has never seen. The row's own id is incidental — the authoritative string is the
    verdict's ``endpoint_typeid``, which is what every consumer invokes against — so it is
    derived from that string rather than parsed out of it. Derived, never random: two reads
    of the same status must answer the same rows, and a fresh id made every poll look like a
    change.
    """
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint  # noqa: PLC0415

    return LLMEndpoint.projection("hub", typeid, name=name, provider=provider)


class Candidate(NamedTuple):
    """One endpoint and this harness's verdict on it.

    The pair travels together because the verdict names an endpoint and almost every caller
    needs both: the picker renders the row's provider beside the verdict's reason, and a
    spawn reads the row's key and model slugs after the verdict chose it. Returning them
    separately would make every consumer rebuild the join.
    """

    endpoint: "LLMEndpoint"
    source: LLMSource


class LLMSourceError(Exception):
    """No source can fund this spawn. Carries every candidate's reason.

    The message is a rendering of the list, not a separate sentence written here: the
    whole point of ``LLMSource.reason`` is that one explanation serves the picker and
    the failure alike.
    """

    def __init__(self, worker_type: str, sources: list[LLMSource]):
        self.worker_type = worker_type
        self.sources = list(sources)
        lines = [f"  - {s.name or s.endpoint_typeid}: {s.reason or 'unavailable'}" for s in self.sources]
        body = "\n".join(lines) if lines else "  (no source of any kind is configured)"
        super().__init__(f"{worker_type} has no usable LLM source:\n{body}")


# ── inventory ────────────────────────────────────────────────────────────────────


def _device_source(worker_type: str, login_state, box_bound: bool) -> Candidate:
    """The vendor device login for *worker_type*, and what we actually know about it.

    Deliberately says nothing about whether the CLI is INSTALLED. That is a different
    question with an owner already: ``build_worker_spawn_env`` refuses a missing binary
    with ``no_worker_message``, which distinguishes "codex is not installed" from
    "nothing is installed". Answering it here too would only mean an uninstalled harness
    failed earlier, in a different place, with a worse sentence.
    """
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint  # noqa: PLC0415

    name = f"{worker_type} device login"
    endpoint = LLMEndpoint.device_projection(worker_type, name=name)
    typeid = str(endpoint.typeid)
    # ``.value``, never ``str()``: ``DeviceLoginState`` is a plain ``(str, Enum)``, not a
    # ``StrEnum``, so ``str(DeviceLoginState.AUTHENTICATED)`` is the REPR
    # ``"DeviceLoginState.AUTHENTICATED"``. Comparing that to ``"authenticated"`` never
    # matched, so every verdict fell through to "nobody has asked" -- which silently made a
    # harness the probe had positively called SIGNED OUT eligible, and picking it hands the
    # turn to a vendor login picker and hangs it.
    state = getattr(login_state, "value", login_state) or ""
    if state == "authenticated":
        return Candidate(
            endpoint,
            LLMSource(
                endpoint_typeid=typeid,
                name=name,
                rank=_RANK_DEVICE,
                eligible=True,
                auto=True,
                authority=LLMSourceAuthority.CACHED,
                detail="signed in",
            ),
        )
    if state in ("idle", "error"):
        # A probe positively said so. We only assert signed-out when we were told.
        return Candidate(
            endpoint,
            LLMSource(
                endpoint_typeid=typeid,
                name=name,
                rank=_RANK_DEVICE,
                eligible=False,
                reason=f"{worker_type} is signed out",
                authority=LLMSourceAuthority.CACHED,
            ),
        )
    # Nobody has asked (the common case: the field does not survive a restart). Usable, so
    # no ``reason`` -- the caveat is display, and putting it in ``reason`` made a perfectly
    # good device login report it as its status message.
    return Candidate(
        endpoint,
        LLMSource(
            endpoint_typeid=typeid,
            name=name,
            rank=_RANK_DEVICE_UNPROVEN if box_bound else _RANK_DEVICE,
            eligible=True,
            auto=not box_bound,
            authority=LLMSourceAuthority.PRESUMED,
            detail=(
                "sign-in not checked; this box is bound to a hub endpoint" if box_bound else "sign-in state not checked"
            ),
        ),
    )


def _key_sources(spec, rows: dict, stored: set[str]) -> list[Candidate]:
    """One candidate per provider this harness supports, over that provider's endpoint row.

    *rows* is the local ``api_key`` endpoints keyed by secret name and *stored* is the set of
    secret names present in the store — both read ONCE by the caller, because this runs per
    harness and the answers do not vary between them.

    Presence is tested against those NAMES, never by decrypting a value. Reading a secret
    opens, decrypts and re-parses the whole sod blob; asking four harnesses whether a key
    exists would do that four times to learn something the listing already knows.

    A provider with no row yet gets an unsaved projection with a stable id, so the picker can
    offer it greyed and a selection cannot flap between reads.

    Validity is deliberately NOT checked: probing a provider is a network call, and a spawn
    must never wait on a provider's account API to find out whether it may start. A bad key
    fails at the first request, loudly and quickly.
    """
    from flow_sdk.builtin.llm_endpoint import LM_SECRET_PREFIX, LLMEndpoint  # noqa: PLC0415

    out: list[Candidate] = []
    for provider in spec.supported_providers:
        if provider is LMApiProvider.FLOWPAD:
            continue  # the hub endpoint is its own kind, not a "key"
        secret_name = f"{LM_SECRET_PREFIX}{provider.value}"
        endpoint = rows.get(secret_name) or LLMEndpoint.key_projection(provider.value)
        # An ``OPENROUTER_API_KEY`` in the environment is a convenience for in-process calls,
        # not a statement about what this box is configured to spend, so it is not consulted.
        has_key = secret_name in stored
        out.append(
            Candidate(
                endpoint,
                LLMSource(
                    endpoint_typeid=str(endpoint.typeid),
                    name=endpoint.name or f"{provider.value} key",
                    rank=_RANK_KEY,
                    eligible=has_key,
                    auto=has_key,
                    authority=LLMSourceAuthority.PROVEN,
                    reason="" if has_key else f"no {provider.value} key is stored on this machine",
                ),
            )
        )
    return out


def _endpoint_sources(spec, endpoints, bound, hub_logged_in: bool, listing_authoritative: bool) -> list[Candidate]:
    """The hub endpoints this harness could spend.

    Availability is *presumed*: whether a chain ends in a root with a live credential is
    the hub's answer to give, and it gives it at invoke time. Only the bound endpoint is
    ``auto`` -- the others are offers, and choosing between budgets is not a decision to
    make silently on someone's behalf.
    """

    if spec.hub_endpoint_binding is None:
        return []
    bound_typeid = bound.endpoint_typeid if bound else ""
    rows: dict[str, "LLMEndpoint"] = {str(e.typeid): e for e in endpoints}
    if bound_typeid and bound_typeid not in rows and not listing_authoritative:
        # The push is authoritative even when the listing has not caught up: a freshly
        # bound (or freshly shared) endpoint must work before any cache has heard of it.
        #
        # But only while we have not managed to ask. Once a listing has SUCCEEDED and does not
        # contain the bound endpoint, its absence is an answer rather than a gap -- the endpoint
        # was deleted, or the role that made it spendable was revoked -- and synthesising it
        # anyway is what strands a box: the stub is eligible, a bound endpoint outranks an
        # unproven device login, and every spawn then posts to an invoke URL that answers
        # "Entity ... not found" until the harness exhausts its retries. Leaving it out makes
        # the ladder fall through to whatever the box can actually spend.
        rows[bound_typeid] = _hub_stub(
            bound_typeid,
            name=bound.name if bound else "",
            provider=bound.provider if bound else "",
        )
    out: list[Candidate] = []
    for typeid, endpoint in rows.items():
        name = endpoint.name or "hub endpoint"
        reason = ""
        if not hub_logged_in:
            reason = "this box is not logged in to the hub"
        elif not endpoint.enabled:
            reason = f"endpoint {name} is disabled"
        out.append(
            Candidate(
                endpoint,
                LLMSource(
                    endpoint_typeid=typeid,
                    name=name,
                    detail=endpoint.provider,
                    rank=_RANK_ENDPOINT,
                    eligible=not reason,
                    auto=(not reason) and typeid == bound_typeid,
                    authority=LLMSourceAuthority.PRESUMED,
                    reason=reason,
                ),
            )
        )
    return out


async def _inventory(worker_type: str) -> tuple[list[Candidate], Any]:
    """Every endpoint that EXISTS for *worker_type*, with what we know about each, and the
    harness ``Capability`` it was read from.

    The capability comes back because the caller needs it for the preference overlay and it
    is the same row: fetching it twice per harness is four wasted round trips on a status
    the picker polls.

    No context, no ranking decisions beyond the static bands -- and no network calls: the
    endpoint listing is read from the memo (``cached_only``), because this runs in the spawn
    path. Secret NAMES are listed rather than read, so nothing here decrypts the store.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint
    from flow_sdk.cli.auth.secrets import get_secrets
    from flow_sdk.instance_settings.llm_endpoint import (
        fetch_hub_llm_endpoints,
        get_hub_llm_endpoint,
        listing_supersedes_binding,
    )

    spec = driver_api_auth_spec(worker_type)
    if spec is None:
        return [], None

    cap = await Capability.get_by_kind(worker_capability_kind(worker_type))
    bound = get_hub_llm_endpoint()
    # NOT ``hub_auth_available()``: that answers "is there a logged-in USER record", while the
    # question here is "is there a key to sign with" -- a box holding a key without a user
    # record can still spend its endpoint, and must.
    hub_logged_in = _hub_logged_in()
    endpoints = await fetch_hub_llm_endpoints(cached_only=True)
    rows = await LLMEndpoint.key_endpoints()
    # Names only. ``get_secrets`` lists the shadow records and never opens the sod, whereas
    # reading each value would decrypt and re-parse the whole blob once per provider.
    stored = {str(rec.get("name", "")) for rec in get_secrets()}

    candidates = [_device_source(worker_type, getattr(cap, "login_state", None), bound is not None)]
    candidates += _key_sources(spec, rows, stored)
    candidates += _endpoint_sources(spec, endpoints, bound, hub_logged_in, listing_supersedes_binding())
    return candidates, cap


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


def _apply_constraint(
    candidates: list[Candidate], typeid: str, origin: LLMSourceOrigin, hub_logged_in: bool
) -> list[Candidate]:
    """Render the constraint ONTO the list: the named endpoint stays, everything else
    comes back ineligible carrying the sentence that says why.

    This is what makes the list self-explaining -- the failure message and the picker's
    greyed rows are the same data, so they cannot disagree.
    """
    from flow_sdk.builtin.llm_endpoint import LLMEndpointKind  # noqa: PLC0415

    scope = "this process" if origin is LLMSourceOrigin.PROCESS else "this project"
    why = f"{scope} requires hub endpoint {typeid}"
    out: list[Candidate] = []
    named = False
    for endpoint, source in candidates:
        if endpoint.kind == LLMEndpointKind.HUB and source.endpoint_typeid == typeid:
            named = True
            out.append(
                Candidate(endpoint, source.model_copy(update={"rank": -1, "auto": source.eligible, "origin": origin}))
            )
        else:
            out.append(Candidate(endpoint, source.ineligible(why)))
    if not named:
        # Not in the inventory is not a refusal: the hub authorizes every invoke against
        # the endpoint in the URL, so a typeid we have not heard of can only earn a
        # 401/403 -- and a freshly shared endpoint must work before any cache knows it.
        # Eligibility still has to be judged here, not left to whoever materializes the
        # binding: a box that cannot sign for the endpoint cannot spend it, however
        # emphatically it was named.
        unusable = "" if hub_logged_in else "this box is not logged in to the hub"
        stub = _hub_stub(typeid, name=typeid)
        out.append(
            Candidate(
                stub,
                LLMSource(
                    endpoint_typeid=typeid,
                    name=typeid,
                    rank=-1,
                    eligible=not unusable,
                    auto=not unusable,
                    authority=LLMSourceAuthority.PRESUMED,
                    origin=origin,
                    reason=unusable,
                ),
            )
        )
    return out


def _preferred(cap) -> str:
    """The funding source the user explicitly asked for, or ``""``.

    Today that is the legacy ``auth_mode``/``api_provider`` pair, which names a PROVIDER
    rather than an endpoint. Collapsing it to a single preferred endpoint typeid is Phase 3
    and needs the picker to write the new field in the same change; reading a field nothing
    writes yet would be a dead branch under a docstring claiming otherwise.

    ``auth_mode == "device"`` is the FIELD DEFAULT and therefore indistinguishable from
    "never touched" -- so it is read as no preference, and the default order applies. Only an
    explicit ``api`` mode names a provider.

    A stated preference is a CONSTRAINT, not a hint: when the named source has no usable
    credential the spawn fails loudly rather than quietly spending something else. Silently
    substituting would spend a subscription or a budget the user did not choose -- and the
    fall-through it replaces (the vendor device-login picker) hangs the turn rather than
    failing it.

    Known limitation, unchanged: there is no way to say "device, explicitly", because
    ``device`` is the field's default. Expressing it needs a third state, which the Phase 3
    picker is the right place to introduce.
    """
    if cap is None or getattr(cap, "auth_mode", "device") != "api":
        return ""
    return str(getattr(cap, "api_provider", "") or "")


def _matches_preference(endpoint, source: LLMSource, preferred: str) -> bool:
    """Whether this candidate is the one the user asked for.

    ``"flowpad"`` is the legacy ``api_provider`` value meaning "the hub endpoint". It was
    never a provider; it stood in for a KIND, from when a stored key had no row and a hub
    budget had to be modelled as a provider whose key is the hub login. So it matches on
    kind, not on ``endpoint.provider``, which now holds the root's real provider
    (``openrouter``) and would never equal it. Any other value names a stored key's provider.
    """
    from flow_sdk.builtin.llm_endpoint import LLMEndpointKind  # noqa: PLC0415

    if preferred == LMApiProvider.FLOWPAD.value:
        return endpoint.kind == LLMEndpointKind.HUB
    return endpoint.kind == LLMEndpointKind.API_KEY and endpoint.provider == preferred


async def list_llm_candidates(worker_type: str, process=None) -> list[Candidate]:
    """Every endpoint that could fund *worker_type*, ranked, each with its verdict — for
    THIS process when one is given, otherwise the box-wide view the picker renders.

    The endpoint travels with the verdict so a caller never has to re-read a row to learn
    the provider, the key or the model slugs behind an answer this function already chose.
    """
    candidates, cap = await _inventory(worker_type)
    if not candidates:
        return []

    if process is not None:
        constraint = await _constraint(process)
        if constraint is not None:
            return sorted(
                _apply_constraint(candidates, *constraint, _hub_logged_in()),
                key=lambda c: c.source.rank,
            )

    preferred = _preferred(cap)
    if preferred:
        name = next((c.source.name for c in candidates if _matches_preference(*c, preferred)), preferred)
        why = f"{worker_type} is set to use {name}"
        candidates = [
            Candidate(endpoint, source.model_copy(update={"rank": -1, "origin": LLMSourceOrigin.USER}))
            if _matches_preference(endpoint, source, preferred)
            else Candidate(endpoint, source.ineligible(why))
            for endpoint, source in candidates
        ]
    return sorted(candidates, key=lambda c: c.source.rank)


async def list_llm_sources(worker_type: str, process=None) -> list[LLMSource]:
    """The verdicts alone, for callers that render them and never need the row."""
    return [c.source for c in await list_llm_candidates(worker_type, process)]


# ── resolution ───────────────────────────────────────────────────────────────────


def pick_llm_candidate(candidates: list[Candidate]) -> Candidate | None:
    """The winner of a ranked list: *first eligible AND auto*, else *first eligible*.

    The second pass is not a nicety. It is what keeps an unproven device login usable on an
    unbound box when nothing else is configured -- the state most desktop installs are in,
    and exactly what happened before this resolver existed.

    One function, so the answer a spawn uses and the answer a picker displays cannot drift
    apart. That drift is precisely what made a stale ``login_state`` tell users their working
    harness was signed out.
    """
    for candidate in candidates:
        if candidate.source.eligible and candidate.source.auto:
            return candidate
    for candidate in candidates:
        if candidate.source.eligible:
            return candidate
    return None


async def resolve_box_llm_endpoint(worker_type: str) -> Candidate | None:
    """The box-wide answer, with the endpoint behind it."""
    return pick_llm_candidate(await list_llm_candidates(worker_type))


async def resolve_llm_source(process) -> LLMSource:
    """The source that funds this spawn. Raises :class:`LLMSourceError` when none can."""
    return (await resolve_llm_endpoint(process)).source


async def resolve_llm_endpoint(process) -> Candidate:
    """The endpoint that funds this spawn, and the verdict that chose it.

    What a spawn actually wants: the key, the provider and the model slugs all hang off the
    row, so handing back only the verdict would make the caller look the row up again — and
    a second lookup is a second chance to disagree with the answer.
    """
    worker_type = getattr(getattr(process, "driver", None), "name", None) or getattr(process, "worker_type", "")
    candidates = await list_llm_candidates(worker_type, process)
    chosen = pick_llm_candidate(candidates)
    if chosen is None:
        raise LLMSourceError(worker_type, [c.source for c in candidates])
    return chosen
