#!/usr/bin/env python3

from enum import Enum

import requests

from flow_sdk.cli.cli_command import CLICommand
from flow_sdk.cli.commands._common import local_get as _local_get
from flow_sdk.cli.commands.setup_cmd.claude_code_setup.setup_claude import setup_claude_code
from flow_sdk.cli.config_manager import get_config_value, setup_defaults


class AgentType(Enum):
    """Enum for supported coding agents"""

    CLAUDE_CODE = "claude-code"
    GITHUB_COPILOT = "github-copilot"
    CURSOR = "cursor"


# Mapping of agent keywords to AgentType enum
AGENT_KEYWORD_MAP = {
    # Claude Code variations
    "claude-code": AgentType.CLAUDE_CODE,
    "claude_code": AgentType.CLAUDE_CODE,
    "claudecode": AgentType.CLAUDE_CODE,
    "claude code": AgentType.CLAUDE_CODE,
    "claude": AgentType.CLAUDE_CODE,
    # GitHub Copilot variations
    "github-copilot": AgentType.GITHUB_COPILOT,
    "github_copilot": AgentType.GITHUB_COPILOT,
    "githubcopilot": AgentType.GITHUB_COPILOT,
    "github copilot": AgentType.GITHUB_COPILOT,
    "copilot": AgentType.GITHUB_COPILOT,
    # Cursor variations
    "cursor": AgentType.CURSOR,
}


def normalize_agent_name(agent_name):
    """
    Normalize the agent name to a standard AgentType enum.

    Args:
        agent_name: The agent name as provided by the user or LLM

    Returns:
        AgentType: The normalized agent type, or None if not recognized
    """
    if not agent_name:
        return None

    # Convert to lowercase and strip whitespace for comparison
    normalized = agent_name.lower().strip()

    return AGENT_KEYWORD_MAP.get(normalized)


def healthcheck_api_server():
    """
    Perform a healthcheck on the API server.

    Returns:
        tuple: (status_code, success) where success is True if status_code is 200
    """
    # Ensure defaults are set
    setup_defaults()

    api_host = get_config_value("flowpad_api_server_host")
    if not api_host:
        return None, False

    # Ensure the URL has a scheme
    if not api_host.startswith(("http://", "https://")):
        api_url = f"http://{api_host}"
    else:
        api_url = api_host

    try:
        # ``local_get`` and not a bare ``requests.get``: ``api_url`` is usually
        # this machine's own server, which refuses keyless callers when gated.
        # It can also be a configured remote host, and the header is attached to
        # loopback URLs only — so this stays correct in both cases.
        response = _local_get(api_url, timeout=5)
        return response.status_code, response.status_code == 200
    except requests.exceptions.RequestException as e:
        print(f"Error connecting to API server: {e}")
        return None, False


def run_setup(agent_name, cmd: CLICommand):
    """
    Run the setup command for the specified coding agent.

    Args:
        agent_name: The name of the coding agent (e.g., 'claude-code', 'github-copilot', 'cursor')
        cmd: CLICommand with context and command details

    Returns:
        str: Setup instructions or result message
    """
    if not agent_name:
        agent_name = "unknown"

    # Normalize the agent name
    agent_type = normalize_agent_name(agent_name)

    result = f"Setting up flowpad for {agent_name}..."
    print(result)
    print(f"Agent: {agent_name}")

    # Call agent-specific setup based on the normalized type
    if agent_type == AgentType.CLAUDE_CODE:
        print(f"\nRecognized as: {agent_type.value}")
        setup_claude_code(cmd)
    elif agent_type == AgentType.GITHUB_COPILOT:
        print(f"\nRecognized as: {agent_type.value}")
        print("GitHub Copilot setup not yet implemented")
    elif agent_type == AgentType.CURSOR:
        print(f"\nRecognized as: {agent_type.value}")
        print("Cursor setup not yet implemented")
    else:
        print(f"\n⚠ Unknown agent type: {agent_name}")
        print("Proceeding with generic setup...")

    # Perform healthcheck
    print("\nPerforming API server healthcheck...")
    status_code, success = healthcheck_api_server()

    if status_code is None:
        print("❌ API server healthcheck failed: Unable to connect")
    elif success:
        print(f"✓ API server healthcheck passed (Status: {status_code})")
    else:
        print(f"⚠ API server responded with status: {status_code} (expected 200)")

    print("\nSetup complete!")

    return result
