from __future__ import annotations

import sys
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec import SpecType, to_authoring_form
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
    OPENCODE_CLI = "harness.opencode.cli"
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


def _spec_kind(spec: SpecType | None) -> str | None:
    """The registered kind of a named value spec; object forms have no kind."""
    form = to_authoring_form(spec) if spec is not None else None
    return form if isinstance(form, str) else None


class CapabilitySpec(BaseModel):
    name: str
    kind: str
    description: str = ""
    icon: str = "BadgeCheck"
    homepage_url: str | None = None
    # The shape of this capability's discovered ``value`` — a ``DataSpec``
    # (``DataSpec.parse("fs_ref")`` for CLI harnesses, whose value is the bin
    # dir as an FSRef dict). None → no typed value (pure status).
    value_spec: SpecType | None = None

    @property
    def value_type(self) -> str | None:
        """The spec's kind — what the persisted row and the UI call ``value_type``.
        A shape with no name (an object form) has no type string."""
        return _spec_kind(self.value_spec)

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
    # One-liner that installs this capability from nothing, keyed by
    # ``sys.platform`` ("darwin" / "linux" / "win32"). TYPED INTO a Flowpad
    # terminal for the user to press Enter on — never run on their behalf, which
    # is why it is a display string and not an argv. Assume a bare machine: no
    # node, no npm, no package manager. Empty for capabilities with no
    # unattended installer, and the UI's "try auto install" affordance is absent
    # exactly then.
    #
    # The ``win32`` entry is POWERSHELL, because that is what the built-in
    # terminal spawns there (``compute/providers/desktop/provider.py`` tries
    # pwsh, then powershell, and only reaches cmd.exe when neither exists).
    install_commands: dict[str, str] = Field(default_factory=dict)

    @property
    def install_command(self) -> str | None:
        """The install one-liner for THIS machine, or None if there isn't one."""
        return self.install_commands.get(sys.platform)

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

    ``value is None`` ⇔ the capability is absent. ``spec`` describes the
    value's shape (``fs_ref`` → ``value`` is an FSRef dict of the CLI's bin
    directory); ``value_type`` is its kind, kept as the name the persisted row
    and the UI read. Produced by ``discover()`` sweeps, held in the discovery
    module's global dict, and mirrored onto the Capability entity row so the
    capabilities window shows exactly what workers consume.
    """

    kind: str
    value: Any | None = None
    spec: SpecType | None = None

    @property
    def value_type(self) -> str | None:
        return _spec_kind(self.spec)

    message: str = ""
    discovered_at: str = Field(default_factory=now_iso)
