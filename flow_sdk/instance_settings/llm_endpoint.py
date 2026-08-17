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

from dataclasses import asdict, dataclass

from flow_sdk.cli import app_config
from flow_sdk.instance_settings import get_instance_settings

_CONFIG_KEY = "hub_llm_endpoint"


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
    """Drop the memo. For tests, which move instance dirs under the module's feet."""
    _cache.clear()


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
