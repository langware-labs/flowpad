"""Device-login endpoint rows, and the one-time move of ``Capability.model_map`` onto endpoints.

Model sizes live on the LLM endpoint. A vendor device login (a Claude / Codex / Copilot
subscription) is an endpoint like any other, so its sizes and custom named models are stored on
its own ``LLMEndpoint`` row (``kind=device``), edited in the same endpoint editor.

``Capability.model_map`` was a parallel per-(harness, provider) table holding the same facts.
:func:`migrate_capability_model_maps` moves what it holds onto endpoints once and empties it:

* ``model_map['device']``  -> the harness's device row (``tiers``, custom names included);
* ``model_map[<provider>]`` for a provider whose key is stored here -> that key row's ``tiers``
  (the overrides used to win over the row, so they win here too);
* anything else (``flowpad`` -- a hub budget, whose sizes only the hub may change -- or a provider
  with no stored key) has nowhere local to go and is dropped with a warning.

Idempotent: a migrated map is emptied, so a re-run finds nothing. It runs lazily on the first read
that needs device sizes (spawn binding, the device-row listing), once per process.
"""

from __future__ import annotations

import logging

from flow_sdk.builtin.agentic_process.model_tiers import is_model_tier

logger = logging.getLogger(__name__)

_migrated = False


def device_login_harnesses() -> list[str]:
    """Every harness whose vendor CLI has a device login of its own."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _SPECS  # noqa: PLC0415

    return [worker for worker, spec in _SPECS.items() if spec.has_device_login]


def _entries(raw) -> dict[str, str]:
    return {str(k): str(v) for k, v in (raw or {}).items() if isinstance(v, str) and v.strip()}


async def migrate_capability_model_maps(*, force: bool = False) -> None:
    """Move every harness's legacy ``Capability.model_map`` onto endpoint rows. See the module note."""
    global _migrated
    if _migrated and not force:
        return
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _SPECS  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        worker_capability_kind,
    )
    from flow_sdk.builtin.capability import Capability  # noqa: PLC0415
    from flow_sdk.builtin.llm_endpoint import LM_SECRET_PREFIX, LLMEndpoint  # noqa: PLC0415
    from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider  # noqa: PLC0415

    for worker, spec in _SPECS.items():
        cap = await Capability.get_by_kind(worker_capability_kind(worker))
        legacy = dict(getattr(cap, "model_map", None) or {}) if cap is not None else {}
        if not legacy:
            continue
        for provider, raw in legacy.items():
            entries = _entries(raw)
            if not entries:
                continue
            if provider == "device":
                if not spec.has_device_login:
                    logger.warning("model_map migration: %s has no device login; dropped %s", worker, entries)
                    continue
                row = await LLMEndpoint.ensure_device(worker)
            else:
                row = None
                try:
                    known = LMApiProvider(provider)
                except ValueError:
                    known = None
                if known is not None and known is not LMApiProvider.FLOWPAD:
                    row = await LLMEndpoint.find_by_secret(f"{LM_SECRET_PREFIX}{known.value}")
                    if row is None and LLMEndpoint.key_projection(known.value).resolve_api_key(
                        allow_environment=False
                    ):
                        row = await LLMEndpoint.ensure_for_secret(known.value)
                if row is None:
                    logger.warning(
                        "model_map migration: no local endpoint for %s/%s; dropped %s "
                        "(set these sizes on the endpoint itself)",
                        worker,
                        provider,
                        entries,
                    )
                    continue
            row.tiers = {**(row.tiers or {}), **entries}
            await row.save(notify=False)
            logger.info(
                "model_map migration: %s/%s -> endpoint %s (%d sizes, %d custom)",
                worker,
                provider,
                row.id,
                sum(1 for k in entries if is_model_tier(k)),
                sum(1 for k in entries if not is_model_tier(k)),
            )
        cap.model_map = {}
        await cap.save(notify=False)
    _migrated = True


async def device_endpoint_rows() -> list:
    """One device row per device-login harness, created on first read (migration first)."""
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint  # noqa: PLC0415

    await migrate_capability_model_maps()
    return [await LLMEndpoint.ensure_device(worker) for worker in device_login_harnesses()]


async def device_tiers(worker_type: str) -> dict[str, str]:
    """The sizes and custom names the user set on *worker_type*'s device login; ``{}`` when none."""
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint  # noqa: PLC0415

    await migrate_capability_model_maps()
    row = await LLMEndpoint.find_device(worker_type)
    return dict(row.tiers or {}) if row is not None else {}


async def configure_device(harness: str, tiers: dict[str, str | None], *, name: str | None = None):
    """Replace *harness*'s device sizes/custom names with *tiers* (empty/None values are cleared)."""
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint  # noqa: PLC0415

    if harness not in device_login_harnesses():
        raise ValueError(f"{harness!r} has no device login")
    await migrate_capability_model_maps()
    row = await LLMEndpoint.ensure_device(harness)
    row.tiers = _entries(tiers)
    if name:
        row.name = name
    await row.save()
    return row
