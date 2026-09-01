"""``VENDORS`` — the one table of facts about the four CLI harness vendors.

Fifteen sites used to each carry their own vendor→something mapping (driver
aliases, options factory, capability kinds, placement harness, dot-dirs,
pricing predicates, allow-lists in the scan routes), and they drifted: one
still listed three vendors, one comment said "can only be claude/codex/copilot".
Every consumer now reads this table.

Stdlib-only ON PURPOSE. ``fs_store/placement.py`` and ``transcript_analyzer``
must import it at module level and neither may import ``builtin``; so the table
holds strings, and classes (drivers, options, parsers) are reached by the
dotted ``package`` path from the consumer that needs them.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import PurePath

from flow_sdk.utils.kind_registry import KindRegistry


@dataclass(frozen=True)
class Vendor:
    key: str                          # driver short-id: what an agent.md writes, the cli_config key, the executable
    worker_type: str                  # the persisted ``AgenticProcess.worker_type`` value
    aliases: tuple[str, ...]          # every other spelling ``vendor_for`` accepts
    harness: str                      # ``fs_store.placement.HarnessType`` value
    capability_kind: str              # ``CapabilityKind.<X>_CLI`` value
    dot_dir: str | None               # the vendor's home dot-dir (``vendor_for_path``); None when it has none
    session_entity_type: str | None   # entity type of a per-session file; None when sessions live in a store
    model_prefixes: tuple[str, ...]   # a model id with one of these prefixes is priced by this vendor

    @property
    def package(self) -> str:
        return f"flow_sdk.builtin.agentic_process.cli_drivers.{self.key}"


VENDORS: tuple[Vendor, ...] = (
    Vendor(
        key="claude",
        worker_type="claude_code",
        aliases=("claude_code_cli", "unsecured_claude"),
        harness="claude",
        capability_kind="harness.claude.cli",
        dot_dir=".claude",
        session_entity_type="claude_session",
        model_prefixes=("claude",),
    ),
    Vendor(
        key="codex",
        worker_type="codex",
        aliases=(),
        harness="agents",
        capability_kind="harness.codex.cli",
        dot_dir=".codex",
        session_entity_type="codex_session",
        model_prefixes=("gpt",),
    ),
    Vendor(
        key="copilot",
        worker_type="copilot",
        aliases=(),
        harness="copilot",
        capability_kind="harness.copilot.cli",
        dot_dir=".copilot",
        session_entity_type="copilot_session",
        model_prefixes=(),  # no price table of its own: priced by the claude table (the documented fallback)
    ),
    Vendor(
        key="opencode",
        worker_type="opencode",
        aliases=(),
        harness="agents",
        capability_kind="harness.opencode.cli",
        dot_dir=None,  # sessions live in a SQLite store; the streamer watches a FlowPad-written file
        session_entity_type=None,
        model_prefixes=("openrouter/",),
    ),
)

_REGISTRY: KindRegistry[Vendor] = KindRegistry(
    "worker vendor",
    aliases={alias: v.key for v in VENDORS for alias in (v.worker_type, *v.aliases)},
)
for _v in VENDORS:
    _REGISTRY.register(_v, _v.key)

VENDOR_KEYS: frozenset[str] = frozenset(_REGISTRY.kinds())

#: Files FlowPad itself writes for a vendor with no dot-dir (opencode) — the
#: streamer keys on the stem because there is no vendor path to sniff.
_OPENCODE_STEMS = ("opencode_transcript", "session_ses_")


def vendor_or_none(name: object) -> Vendor | None:
    """The vendor for any spelling (key, worker_type, alias, enum member), else None."""
    return _REGISTRY.get_or_none(name) if name is not None else None


def vendor_for(name: object) -> Vendor:
    """``vendor_or_none`` that raises ``ValueError`` — the contract every
    dispatcher (``get_driver``, ``factory``, ``driver_key``) always had."""
    try:
        return _REGISTRY.get(name)
    except KeyError as exc:
        raise ValueError(f"Unknown worker vendor: {name!r} (known: {sorted(VENDOR_KEYS)})") from exc


def default_vendor() -> Vendor:
    """The project default — ``FLOWPAD_DEFAULT_WORKER`` (any spelling), else claude.
    The env hook lets the UI vitest run the same suite under both backends."""
    return vendor_for(os.environ.get("FLOWPAD_DEFAULT_WORKER") or "claude")


def vendor_by(attr: str, value: object) -> Vendor | None:
    """Reverse lookup on one table column (``capability_kind``, ``worker_type``, …)."""
    return next((v for v in VENDORS if getattr(v, attr) == value), None)


def vendor_for_path(path: PurePath) -> Vendor | None:
    """The vendor a transcript file belongs to: the dot-dir it sits under, else
    the FlowPad-written opencode stem."""
    for v in VENDORS:
        if v.dot_dir and v.dot_dir in path.parts:
            return v
    return _REGISTRY.get("opencode") if path.name.startswith(_OPENCODE_STEMS) else None


__all__ = ["VENDORS", "VENDOR_KEYS", "Vendor", "default_vendor", "vendor_by", "vendor_for", "vendor_for_path", "vendor_or_none"]
