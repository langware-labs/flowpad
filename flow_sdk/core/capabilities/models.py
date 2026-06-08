from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

from flow_sdk._compat import StrEnum


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class CapabilityKind(StrEnum):
    HARNESS = "harness"
    CLAUDE_CLI = "harness.claude.cli"
    CODEX_CLI = "harness.codex.cli"
    CHROME_AUTHENTICATED = "browsing.chrome.authenticated"


def capability_kind_matches(query_kind: str, capability_kind: str) -> bool:
    query = query_kind.strip().lower()
    candidate = capability_kind.strip().lower()
    return candidate == query or candidate.startswith(f"{query}.")


class CapabilitySpec(BaseModel):
    name: str
    kind: str
    description: str = ""
    icon: str = "BadgeCheck"
    homepage_url: str | None = None
    dependent_capability_kinds: list[str] = Field(default_factory=list)
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


class CapabilityCheck(BaseModel):
    kind: str
    result: CapabilityResult
    dependencies: dict[str, CapabilityResult] = Field(default_factory=dict)
