"""Intent → setup-agent management ("I want email").

A user names an intent in plain language ("email", "slack", "my calendar");
this resolves it to a target capability and launches the existing headless
install agentic process with a **real** setup prompt — the single home for the
curated per-connector instructions (MCP capability specs are minted dynamically
from indexed records, so the prompts can't live on the specs themselves).

Flow: ``run_capability_install_for_intent(text)`` → match a connector by its
aliases → resolve the target capability spec (an already-registered
``<service>.mcp.<worker>`` leaf when one exists, else a synthetic spec carrying
the connector's prompt) → override ``install_prompt`` → hand off to the
unchanged ``run_capability_install_process``.
"""

from __future__ import annotations

from pydantic import BaseModel

from flow_sdk.core.capabilities.mcp import normalize_service
from flow_sdk.core.capabilities.models import (
    CapabilityResult,
    CapabilitySpec,
    is_mcp_capability_kind,
)
from flow_sdk.core.capabilities.registry import (
    get_capability_registry,
    run_capability_install_process,
)

# The harness worker the setup agent runs under by default (also the worker
# whose MCP leaf we prefer when one is already configured).
_DEFAULT_WORKER = "claude_code"


class Connector(BaseModel):
    """A well-known integration a user can ask to set up."""

    intent: str  # canonical service token, e.g. "gmail"
    label: str  # human label, e.g. "Email (Gmail)"
    aliases: list[str]  # phrases that resolve to this connector
    install_prompt: str  # the curated setup instruction the agent runs


# Curated catalog. Prompts are deliberately concrete: tell the agent to set up
# the MCP server / connector and verify it, autonomously.
CONNECTORS: list[Connector] = [
    Connector(
        intent="gmail",
        label="Email (Gmail)",
        aliases=["email", "gmail", "mail", "google mail"],
        install_prompt=(
            "Set up email (Gmail) access for this agent via MCP. Check whether a "
            "Gmail / Google Workspace MCP server is already configured for the "
            "Claude Code harness; if not, install and configure one and walk "
            "through the OAuth/authentication so sending and reading mail works. "
            "Verify the connection, then summarise how to use it. Proceed "
            "autonomously without asking for confirmation."
        ),
    ),
    Connector(
        intent="slack",
        label="Slack",
        aliases=["slack"],
        install_prompt=(
            "Set up Slack access for this agent via MCP. Check for an existing "
            "Slack MCP server for the Claude Code harness; if absent, install and "
            "configure one and complete authentication so the agent can read and "
            "post messages. Verify the connection and report how to use it. "
            "Proceed autonomously."
        ),
    ),
    Connector(
        intent="googlecalendar",
        label="Calendar (Google Calendar)",
        aliases=["calendar", "google calendar", "gcal", "my calendar"],
        install_prompt=(
            "Set up Google Calendar access for this agent via MCP. Check for an "
            "existing calendar MCP server for the Claude Code harness; if absent, "
            "install and configure one and complete authentication so the agent "
            "can read and create events. Verify the connection and report how to "
            "use it. Proceed autonomously."
        ),
    ),
    Connector(
        intent="googledrive",
        label="Google Drive",
        aliases=["drive", "google drive", "gdrive", "files"],
        install_prompt=(
            "Set up Google Drive access for this agent via MCP. Check for an "
            "existing Drive MCP server for the Claude Code harness; if absent, "
            "install and configure one and complete authentication so the agent "
            "can list, read and create files. Verify the connection and report "
            "how to use it. Proceed autonomously."
        ),
    ),
    Connector(
        intent="atlassian",
        label="Atlassian (Jira / Confluence)",
        aliases=["atlassian", "jira", "confluence", "rovo"],
        install_prompt=(
            "Set up Atlassian (Jira / Confluence) access for this agent via MCP. "
            "Check for an existing Atlassian MCP server for the Claude Code "
            "harness; if absent, install and configure one and complete "
            "authentication so the agent can work with issues and pages. Verify "
            "the connection and report how to use it. Proceed autonomously."
        ),
    ),
]


def resolve_connector(text: str) -> Connector | None:
    """Best-effort match of free text to a known connector.

    Matches an alias as a whole word/substring of the normalized request, or
    the request against the connector's normalized intent token.
    """
    raw = (text or "").strip().lower()
    if not raw:
        return None
    token = normalize_service(raw)
    for connector in CONNECTORS:
        if token and (token == connector.intent or token in connector.intent or connector.intent in token):
            return connector
        for alias in connector.aliases:
            if alias in raw:
                return connector
    return None


def _generic_prompt(text: str) -> str:
    return (
        f"Set up access to '{text.strip()}' for this agent. If this is an "
        "external service, prefer configuring it as an MCP server for the "
        "Claude Code harness and complete any authentication needed. Verify it "
        "works and report how to use it. Proceed autonomously without asking "
        "for confirmation."
    )


def _registered_target_spec(intent: str) -> CapabilitySpec | None:
    """An already-registered MCP leaf for this intent, preferring the default worker."""
    registry = get_capability_registry()
    candidates = [
        registry.get(kind).spec
        for kind in registry.kinds()
        if is_mcp_capability_kind(kind) and kind.split(".")[0] == intent
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda s: (s.kind.split(".")[-1] != _DEFAULT_WORKER, s.kind))
    return candidates[0]


def _target_spec_for(text: str) -> CapabilitySpec:
    """Resolve free text to the spec we run the setup agent against.

    A curated connector wins (registered leaf if present, else a synthetic spec
    carrying the connector's prompt); otherwise a generic synthetic spec.
    """
    connector = resolve_connector(text)
    if connector is not None:
        registered = _registered_target_spec(connector.intent)
        base = registered or CapabilitySpec(
            name=connector.label,
            kind=f"{connector.intent}.mcp.{_DEFAULT_WORKER}",
            description=f"{connector.label} connector.",
            icon="Plug",
        )
        return base.model_copy(update={"install_prompt": connector.install_prompt})

    token = normalize_service(text) or "connector"
    return CapabilitySpec(
        name=f"Set up {text.strip()}",
        kind=f"{token}.mcp.{_DEFAULT_WORKER}",
        description=f"Set up {text.strip()} access.",
        icon="Plug",
        install_prompt=_generic_prompt(text),
    )


async def run_capability_install_for_intent(text: str) -> CapabilityResult:
    """Launch a setup agent for a plain-language capability request.

    Returns a ``CapabilityResult`` carrying the spawned process id immediately
    (the worker runs detached; a monitor refreshes the capability afterwards).
    """
    spec = _target_spec_for(text)
    return await run_capability_install_process(spec)
