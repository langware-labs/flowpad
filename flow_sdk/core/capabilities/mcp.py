"""MCP-server capabilities — the dynamic half of the capability system.

Every indexed ``MCP_SERVER`` record is exposed as a capability under the kind
``<service>.mcp.<worker_type>`` (e.g. ``gmail.mcp.claude_code``). Service-first
so an agent querying ``gmail`` or ``gmail.mcp`` resolves the leaf via the
registry's prefix matching, exactly like ``harness`` resolves
``harness.claude.cli``.

The static capability system (registry + specs + entity seeding) is fixed at
import; MCP capabilities are derived at runtime from indexed records, so
``reconcile_mcp_capabilities`` is the single mutation seam — it (re)registers a
runner + upserts a system ``Capability`` row per ``(service, worker_type)`` and
prunes the ones whose backing config disappeared. Because the frontend
``CapabilityManager`` already aggregates rows by dotted prefix, this makes
``useCapability('gmail')`` work with no frontend changes.

Kept deliberately minimal per product direction: ``check`` = configured (a
record exists), ``test`` = validation hook (mirrors check for now), ``install``
= no-op (MCP servers are configured, not installed). The runner/probe machinery
is not reworked here.
"""

from __future__ import annotations

import asyncio
import re

from flow_sdk.core.capabilities.models import (
    MCP_CAPABILITY_INFIX,
    CapabilityResult,
    CapabilitySpec,
    CapabilityValue,
    is_mcp_capability_kind,
)
from flow_sdk.core.capabilities.registry import CapabilityRunner, get_capability_registry

# Vendor/source prefixes stripped from a server name to get the service token.
_VENDOR_PREFIXES = ("claude.ai ", "claude_ai_", "claude ")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")

_RECONCILE_LOCK = asyncio.Lock()


def normalize_service(name: str) -> str:
    """Best-effort ``<service>`` token from an MCP server's display name.

    Lowercase, strip a known vendor prefix, drop non-alphanumerics (the service
    segment can't contain dots — those delimit the kind). e.g.
    ``"claude.ai Gmail"`` → ``gmail``, ``"Google_Calendar"`` → ``googlecalendar``,
    ``"debugMcp"`` → ``debugmcp``. The precise ontology is intentionally
    best-effort; exact prefix queries resolve against this normalized token.
    """
    s = name.strip().lower()
    for prefix in _VENDOR_PREFIXES:
        if s.startswith(prefix):
            s = s[len(prefix):]
            break
    return _NON_ALNUM.sub("", s)


def mcp_capability_kind(service: str, worker_type: str) -> str:
    """``<service>.mcp.<worker_type>`` (service-first; worker_type canonical)."""
    return f"{service}.{MCP_CAPABILITY_INFIX}.{worker_type}"


class McpServerCapabilityRunner(CapabilityRunner):
    """Capability backed by one or more indexed MCP_SERVER records.

    Availability = "configured": a record exists for this (service, worker_type)
    by construction (the reconcile only builds runners for present records).
    """

    def __init__(self, spec: CapabilitySpec, *, service: str, worker_type: str,
                 record_ids: list[str]) -> None:
        self.spec = spec
        self.service = service
        self.worker_type = worker_type
        self.record_ids = record_ids

    def _details(self) -> dict:
        return {
            "service": self.service,
            "worker_type": self.worker_type,
            "record_ids": self.record_ids,
        }

    async def discover(self, probe: dict) -> CapabilityValue:
        # Status-only — availability is the signal, not a typed value.
        return CapabilityValue(
            kind=self.spec.kind,
            value=None,
            value_type=self.spec.value_type,
            message=f"{self.service} MCP configured for {self.worker_type}.",
        )

    async def check(self) -> CapabilityResult:
        available = bool(self.record_ids)
        return CapabilityResult(
            ok=available,
            available=available,
            message=(
                f"{self.service} MCP is configured for {self.worker_type}."
                if available
                else f"No {self.service} MCP configured for {self.worker_type}."
            ),
            details=self._details(),
        )

    async def install(self) -> CapabilityResult:
        # MCP servers are configured (in agent config files / cloud), not
        # installed — don't spawn the default install agentic process.
        result = await self.check()
        return result.model_copy(
            update={"message": "MCP capabilities are configured, not installed."}
        )

    async def test(self) -> CapabilityResult:
        # Validation hook — mirrors check() for now (no live MCP handshake yet).
        return await self.check()


def discover_mcp_capability_specs() -> dict[str, dict]:
    """Desired MCP capabilities, keyed by kind.

    Walks the indexed MCP_SERVER records, groups + dedupes by
    ``(service, worker_type)`` (records that normalize the same merge into one
    capability), and returns ``{kind: {service, worker_type, record_ids, names}}``.
    Pure sync (callers wrap in ``to_thread``).
    """
    from flow_sdk.fs_store.record_list import RecordList

    desired: dict[str, dict] = {}
    for rec in RecordList(type_name="mcp_server"):
        name = getattr(rec, "name", "") or ""
        worker_type = getattr(rec, "worker_type", "") or ""
        if not name or not worker_type:
            continue
        service = normalize_service(name)
        if not service:
            continue
        kind = mcp_capability_kind(service, worker_type)
        entry = desired.setdefault(
            kind,
            {"service": service, "worker_type": worker_type, "record_ids": [], "names": []},
        )
        rid = getattr(rec, "id", None)
        if rid and rid not in entry["record_ids"]:
            entry["record_ids"].append(rid)
        if name not in entry["names"]:
            entry["names"].append(name)
    return desired


def _spec_for(kind: str, entry: dict) -> CapabilitySpec:
    label = ", ".join(entry["names"][:3]) or entry["service"]
    return CapabilitySpec(
        name=f"{label} (MCP / {entry['worker_type']})",
        kind=kind,
        description=f"{entry['service']} MCP server configured for {entry['worker_type']}.",
        icon="Plug",
    )


async def reconcile_mcp_capabilities() -> dict:
    """Sync registered MCP runners + Capability rows with indexed records.

    Registers/updates a runner + system ``Capability`` row per desired
    ``(service, worker_type)`` kind, prunes MCP kinds whose backing config is
    gone, then runs discovery to mirror ``last_check`` onto the rows. Returns a
    small summary. Serialized by a module lock; safe to call repeatedly.
    """
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.core.capabilities.discovery import run_discovery

    async with _RECONCILE_LOCK:
        desired = await asyncio.to_thread(discover_mcp_capability_specs)
        registry = get_capability_registry()

        registered_mcp = {k for k in registry.kinds() if is_mcp_capability_kind(k)}
        desired_kinds = set(desired)

        # Register/refresh desired runners + upsert their rows.
        for kind, entry in desired.items():
            spec = _spec_for(kind, entry)
            registry.register(
                McpServerCapabilityRunner(
                    spec,
                    service=entry["service"],
                    worker_type=entry["worker_type"],
                    record_ids=entry["record_ids"],
                )
            )
            existing = await Capability.get_by_kind(kind)
            if existing is None:
                await Capability.from_spec(spec).save(notify=False)
            elif existing.name != spec.name or existing.description != spec.description:
                existing.name = spec.name
                existing.description = spec.description
                await existing.save(notify=False)

        # Prune MCP kinds whose backing config disappeared.
        pruned = registered_mcp - desired_kinds
        for kind in pruned:
            registry.unregister(kind)
            row = await Capability.get_by_kind(kind)
            if row is not None:
                await row.delete()

        if desired_kinds:
            await run_discovery(sorted(desired_kinds))

        return {
            "desired": sorted(desired_kinds),
            "registered": len(desired_kinds),
            "pruned": sorted(pruned),
        }
