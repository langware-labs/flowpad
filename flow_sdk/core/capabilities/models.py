from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

from flow_sdk._compat import StrEnum
from flow_sdk.tags.grammar import tag_is_within


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class CapabilityKind(StrEnum):
    """Static capability kinds.

    Kind grammar — the ontology rule every capability (static OR the dynamic
    ``<service>.mcp.<worker_type>`` MCP kinds) obeys:

      **segment-1 is the intent handle** a consumer asks for; deeper segments
      are the concrete provider/variant.

    ``useCapability('harness')`` / ``useCapability('gmail')`` /
    ``useCapability('browsing')`` all resolve their leaves via
    ``capability_kind_matches`` (segment-1 prefix). So the first segment is the
    *role you want* (a harness, gmail, browsing), and the tail names the
    provider. The tail ORDER is intentionally not unified across families
    (``harness.<tool>.cli`` puts the tool second; ``<service>.mcp.<worker>``
    puts the worker last) — that asymmetry is cosmetic because resolution only
    ever keys on segment-1. Kinds are persisted (entity ids are
    ``mint_uuid(kind)``, plus user-set ``reference_kind``), so do NOT rename
    them without a migration.
    """

    HARNESS = "harness"
    CLAUDE_CLI = "harness.claude.cli"
    CODEX_CLI = "harness.codex.cli"
    COPILOT_CLI = "harness.copilot.cli"
    CHROME_AUTHENTICATED = "browsing.chrome.authenticated"
    # Source control: parent = "a GitHub connection FlowPad can use" (OAuth
    # token OR gh); child = the gh CLI specifically (installed + authenticated).
    GITHUB = "source_control.git.github"
    GITHUB_GH = "source_control.git.github.gh"


class CapabilityState(StrEnum):
    """Four-state capability readiness, persisted on the Capability row.

    AVAILABLE     — ready to use.
    NOT_AVAILABLE — probed/attempted and definitively not ready (and the user
                    has engaged with it: an explicit check/install/login, or a
                    prior non-NONE state). Background discovery alone never
                    produces this — see ``Capability.derive_state``.
    NONE          — the user never tried; nothing is known or intended.
    ERROR         — the probe itself failed (retryable; distinct from a clean
                    "not available" verdict).
    """

    AVAILABLE = "available"
    NOT_AVAILABLE = "not_available"
    NONE = "none"
    ERROR = "error"


def capability_kind_matches(query_kind: str, capability_kind: str) -> bool:
    # Delegates to the shared dot-taxonomy grammar (lenient prefix semantics —
    # never raises, matching this function's historical contract).
    return tag_is_within(capability_kind, query_kind)


# Infix segment for MCP-server capabilities: ``<service>.mcp.<worker_type>``
# (e.g. ``gmail.mcp.claude_code``). Service-first so a prefix query on the
# service (``gmail`` / ``gmail.mcp``) resolves via ``capability_kind_matches``.
MCP_CAPABILITY_INFIX = "mcp"


def is_mcp_capability_kind(kind: str) -> bool:
    """True for ``<service>.mcp.<worker_type>`` kinds (second segment == ``mcp``)."""
    parts = kind.strip().lower().split(".")
    return len(parts) >= 3 and parts[1] == MCP_CAPABILITY_INFIX


class CapabilitySpec(BaseModel):
    name: str
    kind: str
    description: str = ""
    icon: str = "BadgeCheck"
    homepage_url: str | None = None
    # Static type of this capability's discovered ``value`` — a RecordType
    # value (e.g. "folder" for CLI harnesses, whose value is the bin dir
    # serialized as an FSRef dict). None → no typed value (pure status).
    value_type: str | None = None
    dependent_capability_kinds: list[str] = Field(default_factory=list)
    # Whether FlowPad can actually USE this capability once available. True for
    # everything FlowPad runs (harness CLIs, browsing, MCP for executor worker
    # types). False for MCP servers configured for agents FlowPad never spawns
    # (cursor/windsurf/vscode/claude_desktop) — they stay visible/honest in the
    # summary but never claim FlowPad can launch them.
    runnable: bool = True
    # CapabilityReference: this capability is a pointer — check/install/test
    # resolve the referenced kind in turn. Seed default only; the live value
    # is the entity row's ``reference_kind`` (user-switchable in the UI).
    reference_kind: str | None = None
    # Prompt the install agentic process runs with. None → the registry's
    # DEFAULT_INSTALL_PROMPT.
    install_prompt: str | None = None

    def matches(self, query_kind: str) -> bool:
        return capability_kind_matches(query_kind, self.kind)


class CapabilityResult(BaseModel):
    ok: bool
    available: bool
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
    process_id: str | None = None
    checked_at: str = Field(default_factory=now_iso)
    # Four-state verdict this result implies (see CapabilityState). Kept
    # alongside ok/available (which stay authoritative for existing callers);
    # the persisted row state is derived via ``Capability.derive_state`` so
    # NONE ("never tried") survives passive discovery.
    state: str = CapabilityState.NONE.value


class CapabilityScope(BaseModel):
    """Optional entity scope for a capability test/setup."""

    scope_type: str | None = None
    scope_id: str | None = None


class CapabilityCheck(BaseModel):
    kind: str
    result: CapabilityResult
    dependencies: dict[str, CapabilityResult] = Field(default_factory=dict)


class CapabilityValue(BaseModel):
    """A capability's discovered, typed value.

    ``value is None`` ⇔ the capability is absent. ``value_type`` is the
    spec's static RecordType (e.g. "folder" → ``value`` is an FSRef dict of
    the CLI's bin directory). Produced by ``discover()`` sweeps, held in the
    discovery module's global dict, and mirrored onto the Capability entity
    row so the capabilities window shows exactly what workers consume.
    """

    kind: str
    value: Any | None = None
    value_type: str | None = None
    message: str = ""
    discovered_at: str = Field(default_factory=now_iso)
