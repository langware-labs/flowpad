"""Bind / unbind this box to a hub ``LLMEndpoint``, and report what funds each harness.

The hub, after it has logged the box in, pushes ONE thing over the box's own loopback API
(``llm-endpoint`` action on ``compute_node/@local``): the identity and hub-relative invoke
path of the endpoint this box may spend. This module persists that binding and reports the
box's funding picture back.

**A binding is an offer, not an order.** It used to be an order: binding rewrote every
hub-capable harness to ``auth_mode="api"`` / ``api_provider="flowpad"``, and unbinding
rewrote them to ``device``. That ran on every workspace open, kept no record of what it
replaced, and so silently discarded a user's device or OpenRouter choice -- while
``Capability`` itself documents that seeding must never clobber those very fields. It was
not a design requirement either: it existed only because ``resolve_worker_api_auth``
refused to consider any provider unless ``auth_mode == "api"``. With that gate gone,
``resolve_llm_source`` reaches the endpoint on its own -- and on a bound box an unproven
device login yields to it -- so the write has no reason to exist.

Which means ``active_for`` now means what it says: the harnesses whose RESOLVED source is
the bound endpoint, asked of the same resolver a spawn uses, rather than a proxy field
this module had just written itself.
"""

from __future__ import annotations

import logging

from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _SPECS
from flow_sdk.instance_settings.llm_endpoint import (
    HubLLMEndpoint,
    clear_hub_llm_endpoint,
    fetch_hub_llm_endpoints,
    get_hub_llm_endpoint,
    hub_llm_endpoint_invoke_url,
    listing_supersedes_binding,
    set_hub_llm_endpoint,
)

logger = logging.getLogger(__name__)

#: The harnesses whose ``ApiAuthSpec`` carries a hub binding -- derived, so a
#: driver that gains/loses one is picked up here without a second list.
HUB_ENDPOINT_HARNESSES: tuple[str, ...] = tuple(
    worker for worker, spec in _SPECS.items() if spec.hub_endpoint_binding is not None
)


class HubEndpointBindError(Exception):
    """A bind that cannot be honoured; ``status_code`` maps onto the HTTP answer."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


async def _sources_by_kind() -> tuple[dict, dict, dict, dict]:
    """``(sources, resolved, blocked, endpoints)`` for every hub-capable harness.

    ``sources``, ``resolved`` and ``blocked`` are keyed by capability kind; ``endpoints`` is
    keyed by endpoint typeid and is the union across harnesses. A verdict names an endpoint and
    mirrors none of its fields, so the client needs the rows to render a row's provider or
    model beside its reason — and sending them once, deduplicated, beats repeating an
    endpoint inside every harness's list.

    ``sources`` is the OFFER list (``llm_picker_view``), not the resolver's overlaid one. The
    screen this feeds is where a user changes their funding choice, and the overlay rules out
    every source except the one already chosen — so feeding it the overlay greys out the very
    rows that would undo a choice, which is how a box pinned to a deleted endpoint ends up with
    nothing to click. ``resolved`` still carries the overlay's answer, so what the page says is
    in use and what a spawn does still come from one producer.

    Reads only what is already local (including the endpoint memo), so this adds no
    round-trip to a status the harness picker polls.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import llm_picker_view

    sources: dict[str, list] = {}
    resolved: dict[str, dict | None] = {}
    blocked: dict[str, str] = {}
    endpoints: dict[str, dict] = {}
    for worker in HUB_ENDPOINT_HARNESSES:
        kind = worker_capability_kind(worker)
        view = await llm_picker_view(worker)
        sources[kind] = [c.source.model_dump(mode="json") for c in view.offers]
        resolved[kind] = view.chosen.source.model_dump(mode="json") if view.chosen else None
        blocked[kind] = view.blocked
        for candidate in view.offers:
            endpoints.setdefault(candidate.source.endpoint_typeid, candidate.endpoint.to_wire())
    return sources, resolved, blocked, endpoints


def _hub_user_typeid() -> str | None:
    """The hub identity this box is signed in as, in the same spelling an endpoint's
    ``principal_typeid`` uses (``user-<uuid>``), or ``None`` when signed out.

    The box's LOCAL user is a different person as far as ids go -- the bootstrap ``user`` is
    ``uname: local`` with a v5 id minted here -- so a screen cannot ask "is this budget mine"
    without being told which hub user the box is. Reported rather than filtered on: the picker
    and the resolver legitimately spend a pool that belongs to an org, and taking those rows
    out of the listing would break a spawn to tidy up a screen.
    """
    try:
        from flow_sdk.cli.app_config import get_user  # noqa: PLC0415

        user_id = str((get_user() or {}).get("id") or "")
    except Exception:  # noqa: BLE001
        return None
    return f"user-{user_id}" if user_id else None


async def _status(hub_logged_in: bool, *, refresh: bool = False) -> dict:
    bound: HubLLMEndpoint | None = get_hub_llm_endpoint()
    # Read the endpoint listing FIRST, then build the sources from the now-warm memo.
    # ``_inventory`` is memo-only by design (it runs in the spawn path and must not call
    # out), so computing sources before this ran left every endpoint out of the FIRST
    # answer and put it in the second -- a picker that fills in on its own second poll.
    available = await fetch_hub_llm_endpoints(cached_only=not refresh)
    if refresh and bound is not None and listing_supersedes_binding():
        # Drop a binding the hub has just told us it will not honour. ``_endpoint_sources``
        # already stops OFFERING it, so routing is correct either way -- but the record itself
        # is read as "this box was given a budget" (``box_bound`` demotes an unproven device
        # login), so leaving a dead id in place keeps that claim alive and makes every status
        # answer name an endpoint that no longer exists.
        #
        # Only on an explicit refresh: ``bind`` answers through here too, and it has just been
        # handed an endpoint the listing may not have heard of yet.
        if not any(str(e.typeid) == bound.endpoint_typeid for e in available):
            logger.info(f"[llm-endpoint] dropping binding {bound.endpoint_typeid}: the hub no longer lists it")
            clear_hub_llm_endpoint()
            bound = None
    sources, resolved, blocked, endpoints = await _sources_by_kind()
    bound_typeid = bound.endpoint_typeid if bound else ""
    return {
        # Every endpoint this user could be pointed at, not just the one the hub pushed -- the
        # picker needs the alternatives, and a process may name any of them. Empty when logged out
        # or when the hub is unreachable; never an error, because this rides the status the harness
        # modal polls. Only the READ path refreshes: bind/unbind are called BY the hub, and calling
        # back into it mid-request would make its call wait on its own second call.
        "available": [endpoint.to_wire() for endpoint in available],
        "endpoint_typeid": bound.endpoint_typeid if bound else None,
        "invoke_path": bound.invoke_path if bound else None,
        "invoke_url": hub_llm_endpoint_invoke_url(),
        "provider": bound.provider if bound else None,
        "name": bound.name if bound else None,
        "hub_logged_in": hub_logged_in,
        # Who the hub thinks this box is. Lets a caller tell a budget allocated TO this person
        # from one they merely administer -- both are listed, and only this says which is which.
        "hub_user_typeid": _hub_user_typeid(),
        # Every source each harness could be funded by, and which one actually wins. One
        # producer for the resolver and the picker, so what a spawn does and what the UI
        # claims cannot disagree.
        "sources": sources,
        "resolved": resolved,
        # Why a harness has no funded source, when it has none -- the top-ranked refusal from
        # the OVERLAID list. ``sources`` is now the un-overlaid offer list, so a pin that
        # nothing can satisfy no longer shows up on the rows; without this the screen could
        # only say "nothing eligible" and never why.
        "blocked": blocked,
        # The rows the verdicts above name, deduplicated across harnesses. The verdict
        # carries only an ``endpoint_typeid``; everything renderable (provider, kind, model
        # slugs) lives here.
        "endpoints": endpoints,
        # Harnesses whose resolved source IS the bound endpoint. This used to mean "whose
        # Capability was flipped to (api, flowpad)" -- a proxy for the answer rather than the
        # answer. Now that binding no longer rewrites the user's preference, the honest
        # reading is the resolver's own.
        "active_for": [
            kind
            for kind, pick in resolved.items()
            # A typeid match is the whole test now: only a hub endpoint can carry the bound
            # typeid, so the kind check this used to make was already implied.
            if pick and bound_typeid and pick.get("endpoint_typeid") == bound_typeid
        ],
    }


async def hub_llm_endpoint_status() -> dict:
    """What the box is bound to and which harnesses actually route through it."""
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    return await _status(bool(resolve_hub_api_key()), refresh=True)


async def bind_hub_llm_endpoint(payload: dict) -> dict:
    """Persist the hub's binding and return the status.

    Raises ``HubEndpointBindError(400)`` on a malformed payload and ``(409)`` when the box
    holds no hub login key -- a binding the box cannot sign for is not a binding, and the
    hub calls this only after login, so 409 means "wrong order".

    **This no longer rewrites any ``Capability``.** It used to force every hub-capable
    harness to ``auth_mode="api"`` / ``api_provider="flowpad"``, on every workspace open,
    with no memory of what it replaced -- silently discarding a user's device or
    OpenRouter choice while ``Capability`` itself documents that seeding must never
    clobber that field. That write was a workaround for a resolver gate that no longer
    exists: ``resolve_llm_source`` reaches the endpoint on its own, and on a bound box an
    unproven device login yields to it. A binding is now an OFFER, and the box picks.
    """
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    if not resolve_hub_api_key():
        raise HubEndpointBindError("box is not logged in to the hub; log it in before binding an LLM endpoint", 409)
    try:
        bound = set_hub_llm_endpoint(
            payload.get("endpoint_typeid"),
            payload.get("invoke_path"),
            provider=payload.get("provider"),
            name=payload.get("name"),
        )
    except ValueError as exc:
        raise HubEndpointBindError(str(exc), 400) from exc

    logger.info(f"[llm-endpoint] box bound to hub endpoint {bound.endpoint_typeid}")
    return await _status(hub_logged_in=True)


async def unbind_hub_llm_endpoint() -> dict:
    """Drop the binding and return the status.

    Nothing to revert any more: binding stopped writing to ``Capability``, so unbinding
    simply removes the offer and the resolver falls back down the ladder on its own.
    """
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    was_bound = clear_hub_llm_endpoint()
    status = await _status(bool(resolve_hub_api_key()))
    return {**status, "was_bound": was_bound}


async def select_llm_source(payload: dict) -> dict:
    """Choose which ``LLMSource`` funds one harness, and return the refreshed status.

    This is the ONE write behind the picker, and it writes a PREFERENCE -- the same
    ``Capability.auth_mode`` / ``api_provider`` pair the resolver reads on rung 3. The mapping
    from a source kind to those two fields lives here rather than in a component, so a screen
    never has to know that "the hub endpoint" is spelled ``(api, flowpad)``.

    Choosing an endpoint OTHER than the bound one also moves the box binding, because that
    binding is what "which budget this box spends by default" means. It is an offer, not an
    order, so the box may change it -- but the hub re-pushes its own answer on the next
    workspace-ready, which is the honest contract: the hub decides what this box is entitled
    to, the box decides whether to spend it.

    Deliberately a sub-action rather than the bare ``POST``: that one means "the hub is binding
    this box" and answers 409 without a hub login key, so a user picking their own OpenRouter key
    would be told the box is not logged in to the hub. (Canonical statement; the callers point
    here rather than restating it.)
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key
    from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
    from flow_sdk.schema.data_spec.llm_source_spec import LLMSourceKind

    hub_key = bool(resolve_hub_api_key())
    harness = str(payload.get("harness") or "").strip()
    if not harness:
        raise HubEndpointBindError("harness is required", 400)
    # Accept either spelling -- a worker type ("claude") or the capability kind it maps to.
    kind_key = harness if harness.startswith("harness.") else worker_capability_kind(harness)
    cap = await Capability.get_by_kind(kind_key)
    if cap is None:
        raise HubEndpointBindError(f"unknown harness {harness!r}", 404)

    try:
        source_kind = LLMSourceKind(str(payload.get("kind") or ""))
    except ValueError as exc:
        raise HubEndpointBindError(f"unknown source kind {payload.get('kind')!r}", 400) from exc

    if source_kind is LLMSourceKind.DEVICE:
        cap.auth_mode, cap.api_provider = "device", None
    elif source_kind is LLMSourceKind.API_KEY:
        provider = str(payload.get("provider") or "")
        try:
            LMApiProvider(provider)
        except ValueError as exc:
            raise HubEndpointBindError(f"unknown provider {provider!r}", 400) from exc
        cap.auth_mode, cap.api_provider = "api", provider
    else:
        if not hub_key:
            raise HubEndpointBindError("this box is not logged in to the hub", 409)
        typeid = str(payload.get("endpoint_typeid") or "")
        bound = get_hub_llm_endpoint()
        if not typeid and bound is None:
            raise HubEndpointBindError("no hub endpoint is available to this box", 400)
        if typeid and (bound is None or bound.endpoint_typeid != typeid):
            from flow_sdk.builtin.llm_endpoint import hub_invoke_path  # noqa: PLC0415
            from flow_sdk.db.drivers.db_base_record import TypeId  # noqa: PLC0415

            try:
                parsed = TypeId(typeid)
            except (TypeError, ValueError) as exc:
                raise HubEndpointBindError(f"{typeid!r} is not an endpoint id", 400) from exc
            set_hub_llm_endpoint(
                typeid,
                hub_invoke_path(parsed),
                provider=str(payload.get("provider") or ""),
                name=str(payload.get("name") or ""),
            )
        cap.auth_mode, cap.api_provider = "api", LMApiProvider.FLOWPAD.value

    await cap.save(notify=True)
    logger.info(f"[llm-endpoint] {kind_key}: user chose {source_kind.value}")
    return await _status(hub_key)


def _endpoint_id(raw: str) -> str:
    """The bare uuid out of any spelling of an endpoint id the hub hands out.

    Three reach here, all the hub's own: the row's bare ``id``, the typeid form ``sources``
    and the chain hops carry, and the colon form the bind payload uses. Strip the prefix
    rather than parse a ``TypeId`` -- this only needs the suffix to build a path, and whether
    that suffix names a real endpoint is the hub's answer to give, not ours.
    """
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    raw = str(raw or "").strip()
    if not raw:
        raise HubEndpointBindError("endpoint_typeid is required", 400)
    prefix = EntityType.LLM_ENDPOINT.value
    endpoint_id = raw[len(prefix) + 1 :].strip() if raw.startswith((f"{prefix}-", f"{prefix}:")) else raw
    if not endpoint_id:
        raise HubEndpointBindError(f"{raw!r} is not an endpoint id", 400)
    return endpoint_id


def _require_hub_login() -> None:
    """A box with no hub key cannot ask the hub anything; say so rather than 502 later."""
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key  # noqa: PLC0415

    if not resolve_hub_api_key():
        raise HubEndpointBindError("this box is not logged in to the hub", 409)


async def test_hub_llm_endpoint(payload: dict) -> dict:
    """Send ONE minimal completion down an endpoint's chain and report the verdict.

    A pass-through to the hub's own ``test`` action, and deliberately nothing more: the
    verdict covers the credential, every hop's filters and budget, the routing and the
    provider, and none of that is knowable from here. The box has no ``llm_endpoint`` rows
    (the type is a read-only projection), so the desktop UI cannot reach that action the way
    the hub UI does -- ``dataManager`` would call this box, which 404s. This is the same
    channel the listing already rides.

    **What the test spends is never this machine's credentials.** The call is made BY THE HUB,
    down the endpoint's own resolved chain, with the provider key attached to whichever root
    that chain ends at (``test_action`` -> ``_forward``, the same code path as ``invoke``). A
    vendor CLI's OAuth session and a key stored in this box's sod store are not reachable from
    there, so a green verdict cannot be one of those wearing the endpoint's name. When the
    chain ends at no root with a key, the hub answers 503 "no usable source" rather than
    falling back to anything.

    Returns the hub's answer verbatim. A REFUSED call is a verdict, not an error, and comes
    back inside the success envelope with ``ok: false``; only a transport/auth failure raises.
    """
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

    endpoint_id = _endpoint_id(str(payload.get("endpoint_typeid") or payload.get("id") or ""))
    _require_hub_login()

    try:
        verdict = await hub_post("llm_endpoint", {}, endpoint_id, "test")
    except HubError as exc:
        raise HubEndpointBindError(f"hub refused the test: {exc}", 502) from exc
    if verdict is None:
        raise HubEndpointBindError("no hub is configured for this box", 409)
    return verdict


async def chain_hub_llm_endpoint(endpoint_ref: str) -> dict:
    """The hub's resolved chain for one endpoint: which hops a call travels and which root's
    key it ends up spending.

    The companion of ``test``. The verdict alone says a call SUCCEEDED; it does not say what
    paid for it, and "it worked" is exactly the answer a person cannot check. This report
    names the root, whether that root holds a credential, and which root this caller is stuck
    to -- so a screen can state the funding rather than imply it.

    Same reason for living here as ``test``: the hub's ``chain`` action addresses an entity
    this box has no row for.
    """
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

    endpoint_id = _endpoint_id(endpoint_ref)
    _require_hub_login()

    try:
        body = await hub_get("llm_endpoint", endpoint_id, action="chain")
    except HubError as exc:
        raise HubEndpointBindError(f"hub refused the chain read: {exc}", 502) from exc
    if body is None:
        raise HubEndpointBindError("no hub is configured for this box", 409)
    # ``hub_get`` answers the envelope for a type listing and the bare payload for an action;
    # both shapes are real (see ``fetch_hub_llm_endpoints._rows``), so unwrap defensively.
    data = body.get("data") if isinstance(body, dict) and "data" in body else body
    return data if isinstance(data, dict) else {}
