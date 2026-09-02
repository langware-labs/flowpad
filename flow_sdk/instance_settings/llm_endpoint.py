"""Per-instance binding to a hub ``LLMEndpoint`` — pushed by the hub, read at spawn.

After a sandbox logs in, the hub tells it (over the same loopback channel it
already uses for every box action) which hub ``LLMEndpoint`` its coding-CLI
harnesses should route through:

    POST /api/v1/graph/compute_node/@local/llm-endpoint
    {"endpoint_typeid": "llm_endpoint:<id>", "invoke_path": "/api/v1/graph/llm_endpoint/<id>/invoke", ...}

The box stores exactly that — an identity and a hub-RELATIVE path — and nothing
else: no URL (the hub origin is whatever ``FLOWPAD_HUB_URL`` says at call time,
so a hub that moves does not strand the binding) and no credential (the "key"
for this provider IS the hub login key the box already holds; see
``cli/auth/lm_api_keys.get_lm_api``).

Stored via ``app_config`` (``<instance_dir>/config.json``), same as
``runtime.py`` and for the same reason: not a secret. Which endpoint a box was
told to use is not sensitive; the login key that makes it usable lives in the
sod. Memoized per instance NAME like ``runtime.py``.
"""

from __future__ import annotations

import logging
import time
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING

from flow_sdk.cli import app_config
from flow_sdk.instance_settings import get_instance_settings

if TYPE_CHECKING:
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

logger = logging.getLogger(__name__)

_CONFIG_KEY = "hub_llm_endpoint"
#: The listing is a read-through of hub state, and the harness modal polls the status action it
#: rides on. A short memo keeps that polling off the hub without ever holding a stale answer for
#: long enough to matter.
_LIST_TTL_SECONDS = 30.0


@dataclass(frozen=True)
class HubLLMEndpoint:
    """What the hub told this instance. ``invoke_path`` is the FULL hub path
    (``/api/v1/graph/llm_endpoint/<id>/invoke``), joined onto the hub ORIGIN."""

    endpoint_typeid: str
    invoke_path: str
    provider: str = ""
    name: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# ``None`` (unbound -- every desktop install) is a real cached value, hence ``in``.
_cache: dict[str, HubLLMEndpoint | None] = {}


def _validated(endpoint_typeid, invoke_path, provider="", name="") -> HubLLMEndpoint:
    """The ONE rule for a usable binding: a non-empty id and a hub-relative path.
    Raises ``ValueError`` -- callers decide whether that is a 400 or "unbound"."""
    endpoint_typeid = str(endpoint_typeid or "").strip()
    invoke_path = str(invoke_path or "").strip()
    if not endpoint_typeid:
        raise ValueError("endpoint_typeid is required")
    if not invoke_path.startswith("/") or "://" in invoke_path:
        raise ValueError("invoke_path must be a hub-relative path")
    return HubLLMEndpoint(
        endpoint_typeid=endpoint_typeid,
        invoke_path=invoke_path.rstrip("/"),
        provider=str(provider or ""),
        name=str(name or ""),
    )


def _parse(raw) -> HubLLMEndpoint | None:
    if not isinstance(raw, dict):
        return None
    try:
        return _validated(raw.get("endpoint_typeid"), raw.get("invoke_path"), raw.get("provider"), raw.get("name"))
    except ValueError:
        # A record written by a newer/older build must not brick spawn: unbound.
        return None


def get_hub_llm_endpoint() -> HubLLMEndpoint | None:
    """The endpoint the hub bound this instance to, or ``None`` when unbound."""
    key = get_instance_settings().instance_name
    if key in _cache:
        return _cache[key]
    bound = _parse(app_config.get_config(_CONFIG_KEY))
    _cache[key] = bound
    return bound


def set_hub_llm_endpoint(
    endpoint_typeid: str, invoke_path: str, *, provider: str = "", name: str = ""
) -> HubLLMEndpoint:
    """Persist the hub's binding for this instance and return it.

    Raises ``ValueError`` on an empty id or a path that is not hub-relative. The
    sole writer is the ``llm-endpoint`` box action, which only the hub calls.
    """
    bound = _validated(endpoint_typeid, invoke_path, provider, name)
    app_config.set_config(_CONFIG_KEY, bound.to_dict())
    _cache[get_instance_settings().instance_name] = bound
    return bound


def clear_hub_llm_endpoint() -> bool:
    """Drop the binding. Returns whether one was set."""
    was_bound = get_hub_llm_endpoint() is not None
    app_config.set_config(_CONFIG_KEY, None)
    _cache[get_instance_settings().instance_name] = None
    return was_bound


def reset_cache() -> None:
    """Drop the memos. For tests, which move instance dirs under the module's feet."""
    _cache.clear()
    _list_cache.clear()


def hub_origin() -> str:
    """The hub ORIGIN (``FLOWPAD_HUB_URL`` without the ``/api/v1`` prefix), read at
    call time so a re-pointed hub is honoured without re-binding."""
    from flow_sdk.cloud_client.client import ApiConfig  # noqa: PLC0415

    return ApiConfig.from_env().app_base_url or ""


def hub_llm_endpoint_invoke_url() -> str | None:
    """The absolute invoke URL a harness points at (no trailing slash), or ``None``
    when unbound. Computed, never stored."""
    bound = get_hub_llm_endpoint()
    if bound is None:
        return None
    return f"{hub_origin()}{bound.invoke_path}"


# ── what this user may spend ──────────────────────────────────────────────────
#
# The binding above is what the hub PUSHED. This is everything the signed-in user could be given
# instead: their own allocations plus anything shared with them.

#: instance name -> (fetched_at, endpoints)
_list_cache: dict[str, tuple[float, list["LLMEndpoint"]]] = {}


async def fetch_hub_llm_endpoints(*, cached_only: bool = False) -> list["LLMEndpoint"]:
    """Every ``LLMEndpoint`` the signed-in hub user may spend, as the hub serializes them.

    The hub scopes a type listing to the caller (the principal is the query's source entity), so this
    returns exactly what that user holds a role on -- their own allocations and anything shared with
    them -- and nothing about the pools they merely draw THROUGH.

    Answers ``[]`` when logged out or when the hub is unreachable, rather than raising: a signed-out
    box is an ordinary state here, the same way ``get_lm_api(FLOWPAD)`` answers ``None``. A picker
    that cannot reach the hub should show nothing, not fail the screen it sits on -- and a failed
    refresh keeps the last good list rather than emptying it.

    ``cached_only`` answers from the memo and never calls out. It is for paths the HUB itself
    initiates -- binding an endpoint, for one -- where reaching back to the hub mid-request buys
    nothing and makes a hub-side call depend on a second hub-side call completing.
    """
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint, LLMEndpointKind  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

    name = get_instance_settings().instance_name
    cached = _list_cache.get(name)
    stale = cached[1] if cached is not None else []
    # The memo is consulted before anything else: resolving the hub key is a config read plus a
    # keychain round-trip, and a cache hit should cost neither.
    if cached is not None and (time.monotonic() - cached[0]) < _LIST_TTL_SECONDS:
        return stale
    if cached_only:
        return stale

    # ``hub_get`` rather than a hand-built client: it is the one chokepoint that honours Local
    # privacy mode (nothing may leave the box) and it reuses the pooled client. It answers None on
    # any failure, including logged-out.
    # TWO reads, unioned, because the hub answers "what may I spend" in two places and neither is
    # complete alone. The ordinary type listing is ACCESS-SCOPED: it returns rows this user holds a
    # role edge on. The seeded global root holds no role edge for anybody -- it is stamped
    # ``authenticated_role: reader`` -- so it appears only in ``catalog``, the deliberately
    # un-scoped discovery listing. Reading just the first silently omits the one endpoint EVERY
    # signed-in user can always spend, which is the difference between a picker that offers a
    # fallback and one that tells a logged-in user they have nothing. ``use-llm-endpoints.ts``
    # already unions both; this is the box catching up.
    def _rows(body) -> list | None:
        """Rows out of a ``hub_get`` answer, or ``None`` when the CALL failed.

        Three shapes, all real, all observed against a live hub: the type listing answers
        the envelope dict; the ``catalog`` ACTION answers a bare list; and a successful but
        EMPTY listing answers ``{}`` with no ``data`` key at all. Only ``hub_get``'s own
        ``None`` means failure -- an empty answer means zero rows, and conflating the two
        made the union return early and never read the catalog, which is exactly the row
        this function exists to add."""
        if body is None:
            return None
        if isinstance(body, list):
            return body
        data = body.get("data") if isinstance(body, dict) else None
        return data if isinstance(data, list) else []

    rows = _rows(await hub_get("llm_endpoint"))
    if rows is None:
        return stale
    # A failed catalog read costs only the fallback: answering with the scoped rows beats
    # answering with nothing.
    rows = list(rows) + list(_rows(await hub_get("llm_endpoint", action="catalog")) or [])

    fields = set(LLMEndpoint.model_fields)
    endpoints: list[LLMEndpoint] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_id = str(row.get("id") or "")
        if row_id and row_id in seen:
            continue  # an endpoint this user holds a role on is ALSO in the catalog
        try:
            # The hub serializes more than this projection declares (expansions, attribution). Take
            # only what we mirror, so a hub that grows a field cannot break the picker.
            payload = {k: v for k, v in row.items() if k in fields}
            # ``kind`` is OURS, not the hub's: everything this call returns is by definition a hub
            # budget. Forcing it means a hub that one day ships a field of the same name with a
            # different meaning cannot turn a hub endpoint into a local one.
            payload["kind"] = LLMEndpointKind.HUB
            endpoints.append(LLMEndpoint(**payload))
            if row_id:
                seen.add(row_id)
        except Exception as exc:  # noqa: BLE001 -- one malformed row must not lose the rest
            logger.warning("fetch_hub_llm_endpoints: skipped a row: %s: %s", type(exc).__name__, exc)
    _list_cache[name] = (time.monotonic(), endpoints)
    return endpoints
