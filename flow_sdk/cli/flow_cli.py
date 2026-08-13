#!/usr/bin/env python3

import os
import threading
from typing import Optional

import requests
import typer
from typing_extensions import Annotated

from flow_sdk._version import __version__
from flow_sdk.cli.auth.hub_login import delete_api_key, is_logged_in, set_api_key
from flow_sdk.cli.cli_command import CLICommand
from flow_sdk.cli.cli_context import ClaudeScope, CLIContext
from flow_sdk.cli.commands.prompt_cmd import run_prompt_command
from flow_sdk.cli.commands.setup_cmd.setup_cmd import run_setup
from flow_sdk.cli.config_manager import (
    list_config,
    remove_config_value,
    set_config_value,
    setup_defaults,
)
from flow_sdk.cli.env_loader import cli_init
from flow_sdk.instance_settings import get_instance_settings

# Initialize CLI - load environment variables as first step
cli_init()

# Create Typer app
app = typer.Typer(name="flow", help="Flow CLI tool for flowpad", add_completion=False)

# Global context (initialized once)
_context: Optional[CLIContext] = None


def get_context() -> CLIContext:
    """Get or initialize the CLI context."""
    global _context
    if _context is None:
        _context = CLIContext()
    return _context


def _discover_port() -> int:
    """Discover the running server port via ~/.flow/server.json, env, or default."""
    from flow_sdk.discovery.flowpad_discovery import read_server_info

    server_info = read_server_info()
    if server_info:
        return server_info.port
    return get_instance_settings().port


@app.callback(invoke_without_command=True)
def main(ctx: typer.Context):
    """
    Flow CLI - Main entry point.

    If no command is provided, prints version.
    """
    # Ensure config defaults are set
    setup_defaults()

    # If no subcommand was invoked, show version
    if ctx.invoked_subcommand is None:
        typer.echo(f"flow {__version__}")


@app.command()
def setup(
    agent_name: Annotated[str, typer.Argument(help="Name of the coding agent (e.g., claude-code)")],
):
    """
    Setup flowpad for a specific coding agent.

    Example: flow setup claude-code
    """
    context = get_context()
    cmd = CLICommand(f"setup {agent_name}", context=context)

    # Set first_time_prompt flag when running setup
    set_config_value("first_time_prompt", "true")

    run_setup(agent_name, cmd)


@app.command()
def prompt(prompt_text: Annotated[Optional[str], typer.Argument(help="Prompt text to process")] = None):
    """
    Process a prompt command.

    Example: flow prompt "analyze this code"
    """
    if prompt_text:
        context = get_context()
        cmd = CLICommand(f"prompt {prompt_text}", context=context)
        run_prompt_command(prompt_text, cmd)


@app.command()
def ping(
    ping_str: Annotated[str, typer.Argument(help="Ping string to send")],
):
    """
    Send a ping to the local server for testing hook integration.

    Example: flow ping hello
    """
    get_context()

    port = _discover_port()

    # Send ping to local server
    try:
        from flow_sdk.cli.commands._common import local_get

        url = f"http://127.0.0.1:{port}/ping"
        response = local_get(url, params={"ping_str": ping_str}, timeout=5)

        if response.status_code == 200:
            typer.echo(f"Ping sent successfully: {ping_str}")
        else:
            typer.echo(f"Ping failed with status {response.status_code}", err=True)
            raise typer.Exit(1)
    except requests.exceptions.RequestException as e:
        typer.echo(f"Error sending ping: {e}", err=True)
        raise typer.Exit(1)


@app.command()
def upgrade(
    info: bool = typer.Option(False, "--info", help="Print upgrade info as JSON and exit"),
):
    """
    Upgrade flowpad to the latest version from PyPI.

    Detects whether flowpad was installed via 'uv tool' or pip and
    uses the appropriate upgrade mechanism.

    Use --info to print version and machine info as JSON (used by the desktop app).

    Example: flow upgrade
    Example: flow upgrade --info
    """
    import json
    import shutil
    import subprocess
    import sys

    if info:
        from flow_sdk.server.launch import get_status
        from flow_sdk.utils.machine_id import get_machine_id

        status = get_status()
        status["version"] = __version__
        status["version_hash"] = get_machine_id()
        typer.echo(json.dumps(status))
        return

    uv = shutil.which("uv")

    if uv:
        # Ask uv where its tools live, then check if this Python lives there
        dir_result = subprocess.run([uv, "tool", "dir"], capture_output=True, text=True)
        if dir_result.returncode != 0:
            typer.echo("Error: 'uv tool dir' failed — cannot determine install method.", err=True)
            raise typer.Exit(1)
        uv_tools_dir = dir_result.stdout.strip()
        use_uv = sys.executable.startswith(uv_tools_dir)
    else:
        use_uv = False

    if use_uv:
        typer.echo("Detected install method: uv tool")
        typer.echo("Upgrading flowpad via uv tool...")
        cmd = [uv, "tool", "upgrade", "flowpad"]
    else:
        typer.echo("Detected install method: pip")
        typer.echo("Upgrading flowpad via pip...")
        cmd = [sys.executable, "-m", "pip", "install", "--upgrade", "flowpad"]

    result = subprocess.run(cmd)
    if result.returncode != 0:
        typer.echo("Upgrade failed.", err=True)
        raise typer.Exit(result.returncode)

    typer.echo("flowpad upgraded successfully.")


def _start_service(port: int) -> None:
    """Start the Flow server and monitor. Shared by `flow start` and `flow start service`."""
    # Run any pending migration for the current version BEFORE the server
    # boots. The migration is itself a headless AgenticProcess, so its
    # stdout streams to this same terminal — the user sees progress.
    # ``run_if_needed`` is a no-op when no recipe exists or the migration
    # already completed, so this is safe on every start.
    from flow_sdk.migrations import runner as migration_runner
    from flow_sdk.server.launch import check_server_health, start_monitor_detached, wait_for_server_health

    migration_exit = migration_runner.run_if_needed()
    if migration_exit != 0:
        typer.echo(
            f"Migration failed (exit={migration_exit}); refusing to start server.",
            err=True,
        )
        raise typer.Exit(migration_exit)

    if check_server_health(port):
        typer.echo(f"Server already running on port {port}")
    else:
        typer.echo(f"Starting Flow server on http://127.0.0.1:{port}")
        start_monitor_detached(port)
        if wait_for_server_health(port, timeout=10.0):
            typer.echo("Server is ready")
        else:
            typer.echo("Server may still be starting...")


start_app = typer.Typer(help="Start the Flow server.", invoke_without_command=True, add_completion=False)
app.add_typer(start_app, name="start")


@start_app.callback(invoke_without_command=True)
def start(ctx: typer.Context):
    """
    Start the Flow server and open the UI in the browser.

    Launches a background monitor that keeps the server alive and
    restarts it if it crashes.  The CLI exits immediately.

    Example: flow start
    """
    if ctx.invoked_subcommand is not None:
        return

    port = get_instance_settings().port
    _start_service(port)

    # Skip browser open when launched from Electron (it has its own BrowserWindow)
    if not os.environ.get("FLOWPAD_NO_BROWSER"):
        import time

        from flow_sdk.server.launch import check_server_health

        healthy = False
        for _ in range(5):
            if check_server_health(port):
                healthy = True
                break
            time.sleep(0.3)

        if not healthy:
            typer.echo(
                f"Server is not responding on port {port}; skipping browser launch. "
                f"Try `flow start` again once it comes up."
            )
            return

        import webbrowser

        webbrowser.open(f"http://127.0.0.1:{port}")


@start_app.command()
def service():
    """
    Start the Flow server in headless mode (no browser).

    Launches a background monitor that keeps the server alive and
    restarts it if it crashes.  The CLI exits immediately.

    Example: flow start service
    """
    port = get_instance_settings().port
    _start_service(port)


@app.command()
def stop():
    """
    Stop the Flow server and monitor.

    Example: flow stop
    """
    from flow_sdk.server.launch import stop_all

    monitor_killed, server_killed = stop_all()
    if monitor_killed:
        typer.echo("Monitor stopped")
    if server_killed:
        typer.echo("Server stopped")
    if not (monitor_killed or server_killed):
        typer.echo("Nothing was running")


@app.command()
def status():
    """
    Show server and monitor status.

    Example: flow status
    """
    import shutil
    import sys
    from pathlib import Path

    import flow_sdk.server as _srv_pkg
    from flow_sdk.server.launch import get_status

    s = get_status()
    port = s["port"]

    cli_path = shutil.which("flow") or sys.argv[0]
    server_path = Path(_srv_pkg.__file__).parent

    typer.echo(f"Port:    {port}")
    typer.echo(f"CLI:     {cli_path}")
    typer.echo(f"Server:  {server_path}")

    if s["monitor_alive"]:
        typer.echo(f"Monitor: running (PID {s['monitor_pid']})")
    else:
        typer.echo("Monitor: not running")

    if s["server_healthy"]:
        typer.echo(f"Health:  healthy (PID {s['server_pid']})")
    elif s["server_alive"]:
        typer.echo(f"Health:  alive but unhealthy (PID {s['server_pid']})")
    else:
        typer.echo("Health:  not running")

    if s["launch_iso_time"]:
        typer.echo(f"Started: {s['launch_iso_time']}")


@app.command()
def trace():
    """
    Start the server and trace hook events in real-time.

    Displays hook events with colored output as they occur.
    Use Ctrl+C to stop.

    Usage:
      Terminal 1: flow trace
      Terminal 2: flow hooks set && claude -p "hello" && flow hooks clear
    """
    import time

    from flow_sdk.server.app import start_server
    from flow_sdk.server.reporters import PrintReporter
    from flow_sdk.server.state import reporter_registry

    port = get_instance_settings().port

    typer.echo(f"Starting Flow trace server on port {port}...")

    # Create and register print reporter
    print_reporter = PrintReporter()
    reporter_registry.add(print_reporter)

    # Start server in background thread
    server_thread = threading.Thread(target=start_server, args=(port,), daemon=True)
    server_thread.start()

    # Give server time to start
    time.sleep(1)

    typer.echo(f"✓ Server started on http://127.0.0.1:{port}")
    typer.echo("\n\033[2mTip: Run 'flow hooks set' in another terminal to enable hooks\033[0m\n")
    typer.echo("Waiting for hook events (Ctrl+C to stop)\n")

    try:
        # Keep main thread alive
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        # Cleanup
        reporter_registry.remove(print_reporter)
        typer.echo("\n\n✓ Trace stopped")
        raise typer.Exit(0)


# Config command group
config_app = typer.Typer(help="Manage configuration")
app.add_typer(config_app, name="config")


@config_app.command("list")
def config_list():
    """List all configuration values."""
    config = list_config()
    if not config:
        typer.echo("No configuration values set.")
    else:
        for key, value in config.items():
            typer.echo(f"{key}={value}")


@config_app.command("set")
def config_set(key_value: Annotated[str, typer.Argument(help="Configuration in format key=value")]):
    """
    Set a configuration value.

    Example: flow config set timeout=30
    """
    if "=" not in key_value:
        typer.echo("Error: Expected format key=value", err=True)
        raise typer.Exit(1)

    key, value = key_value.split("=", 1)
    key = key.strip()
    value = value.strip()

    if not key:
        typer.echo("Error: Key cannot be empty", err=True)
        raise typer.Exit(1)

    set_config_value(key, value)
    typer.echo(f"Set {key}={value}")


@config_app.command("remove")
def config_remove(key: Annotated[str, typer.Argument(help="Configuration key to remove")]):
    """
    Remove a configuration value.

    Example: flow config remove timeout
    """
    if remove_config_value(key):
        typer.echo(f"Removed {key}")
    else:
        typer.echo(f"Key '{key}' not found", err=True)
        raise typer.Exit(1)


# Auth command group
auth_app = typer.Typer(help="Manage authentication")
app.add_typer(auth_app, name="auth")


@auth_app.command("login")
def auth_login(
    api_key: Annotated[
        Optional[str], typer.Argument(help="Your Flowpad API key (optional - opens browser if not provided)")
    ] = None,
):
    """
    Login to Flowpad.

    If API key is provided, stores it directly.
    If no API key is provided, opens browser for authentication.

    Examples:
      flow auth login your-api-key-here
      flow auth login  # Opens browser
    """
    if api_key:
        # Direct API key login
        from flow_sdk.cli.app_config import set_user
        from flow_sdk.cli.auth.hub_login import validate_api_key

        try:
            user_info = validate_api_key(api_key)
            set_api_key(api_key)
            set_user(user_info)
            typer.echo("✓ Successfully logged in to Flowpad")
            typer.echo("✓ API key stored securely in system keyring")
            typer.echo(f"✓ User ID: {user_info.get('id')}")
        except Exception as e:
            typer.echo(f"✗ Login failed: {e}", err=True)
            raise typer.Exit(1)
    else:
        # Cloud login chokepoint — decides env-mode vs browser-mode internally.
        import asyncio

        from flow_sdk.cli.auth.cloud_login import cloud_login
        from flow_sdk.server.app import wait_for_login_callback

        typer.echo("\n🌊 Logging in to Flowpad...")
        try:
            launch = asyncio.run(cloud_login())
        except Exception as e:
            typer.echo(f"\n✗ Login failed: {e}", err=True)
            raise typer.Exit(1)

        if launch["status"] == "logged_in":
            typer.echo("✓ Successfully logged in to Flowpad")
            typer.echo("✓ API key stored securely in system keyring")
            typer.echo(f"✓ User ID: {launch['user'].get('id')}")
        else:
            # Browser-mode: cloud_login opened the system browser; wait for the callback.
            typer.echo(f"Opened browser: {launch['url']}\n")
            result = wait_for_login_callback()
            if result.get("success"):
                typer.echo("\n✓ Successfully logged in to Flowpad")
                typer.echo("✓ API key stored securely in system keyring")
                if "user" in result:
                    typer.echo(f"✓ User ID: {result['user'].get('id')}")
            else:
                typer.echo(f"\n✗ Login failed: {result.get('message', 'Unknown error')}", err=True)
                if "error" in result:
                    typer.echo(f"  Error: {result['error']}", err=True)
                raise typer.Exit(1)


@auth_app.command("logout")
def auth_logout():
    """
    Logout from Flowpad by removing your stored API key.

    Example: flow auth logout
    """
    if is_logged_in():
        from flow_sdk.cli.app_config import clear_user

        delete_api_key()
        clear_user()
        typer.echo("✓ Successfully logged out from Flowpad")
        typer.echo("✓ API key and user info removed")
    else:
        typer.echo("⚠ Not currently logged in")


# --- what the hub configures on a box it launched -------------------------
#
# These three exist so the hub has a channel into a running box that does NOT
# require the box's HTTP server to be up and answering. The loopback
# `/auth/login_callback` curl needs a healthy app to accept anything, which is
# exactly what cannot be relied on while a box is starting, restarting, or
# refusing keyless callers. `run_command` always works.
#
# All three are hub-driven and idempotent. None is meant to be typed by a human,
# which is why they say so in their help rather than pretending otherwise.


@auth_app.command("set-cookie-gate")
def auth_set_cookie_gate(
    value: Annotated[str, typer.Argument(help="The gate secret, minted by the hub for this box")],
):
    """
    Arm this instance's request gate. Hub-driven; not for interactive use.

    Once armed the instance answers NOTHING without the secret — not the UI, not
    the API, not a WebSocket, and not /health/status. That total coverage is the
    point (see docs/cookie-gate.md); it is also why the supervisor in
    server/launch.py has to present the secret on its own probes.

    Example: flow auth set-cookie-gate <secret>
    """
    from flow_sdk.instance_settings.cookie_gate import set_cookie_gate

    try:
        set_cookie_gate(value)
    except ValueError as e:
        # Empty value: arming on "" would store a secret that reads as unset,
        # leaving the instance open while looking locked.
        typer.echo(f"✗ {e}", err=True)
        raise typer.Exit(1)
    typer.echo("✓ Cookie gate armed")


@auth_app.command("clear-cookie-gate")
def auth_clear_cookie_gate():
    """
    Disarm this instance's request gate. Hub-driven; not for interactive use.

    Example: flow auth clear-cookie-gate
    """
    from flow_sdk.instance_settings.cookie_gate import clear_cookie_gate

    if clear_cookie_gate():
        typer.echo("✓ Cookie gate cleared")
    else:
        # Distinguished from success on purpose: "already open" and "I just
        # opened it" are different facts about the machine.
        typer.echo("⚠ Cookie gate was not armed")


@auth_app.command("hub-login")
def auth_hub_login(
    api_key: Annotated[str, typer.Argument(help="The node-bound key the hub minted for this box")],
):
    """
    Sign this instance in with a hub-minted key. Hub-driven; not for interactive use.

    Deliberately NOT `flow auth login`, which is the human path and does
    something materially different: it stores the key and the user and stops
    there. This mirrors what `/auth/login_callback` does, because the box's
    logged-in state is built from more than a stored key —
    ``_finalize_login`` also broadcasts the OAuth SUCCESS that unblocks a
    watching UI, folds the hub-resolved organization id/role into the user, and
    invalidates the bootstrap cache. A box signed in through the shorter path
    looks logged in locally while reporting something different about itself.

    Unlike the HTTP route this needs no in-band credential check before it acts.
    That check exists there because the endpoint is reachable by anyone until
    the gate arms; a command inside the box is already proof of access to the
    box.

    Example: flow auth hub-login fp_live_...
    """
    import asyncio

    from flow_sdk.cli.auth.cloud_login import _finalize_login
    from flow_sdk.cli.auth.hub_login import validate_api_key_async
    from flow_sdk.cloud_client.api.auth import LoginData

    async def _run() -> dict:
        user_info = await validate_api_key_async(api_key)
        await _finalize_login(LoginData(token=api_key, expires=None, refresh_token=None, user=user_info))
        return user_info

    try:
        user_info = asyncio.run(_run())
    except Exception as e:
        typer.echo(f"✗ Login failed: {e}", err=True)
        raise typer.Exit(1)
    typer.echo(f"✓ Signed in as {user_info.get('email') or user_info.get('id') or 'unknown'}")


@auth_app.command("set-runtime")
def auth_set_runtime(
    kind: Annotated[str, typer.Argument(help="What the hub launched this instance as: sandbox | agent")],
):
    """
    Record what this instance was launched AS. Hub-driven; not for interactive use.

    The box cannot work this out for itself: a sandbox a human opens and a box an
    agent was deployed into are byte-for-byte identical from inside. The value
    only exists because the hub says so.

    Example: flow auth set-runtime sandbox
    """
    from flow_sdk.instance_settings.runtime import set_assigned_runtime

    try:
        assigned = set_assigned_runtime(kind)
    except ValueError as e:
        typer.echo(f"✗ {e}", err=True)
        raise typer.Exit(1)
    typer.echo(f"✓ Runtime set to {assigned.value if hasattr(assigned, 'value') else assigned}")


@auth_app.command("test")
def auth_test(delay: Annotated[int, typer.Option(help="Delay in seconds before allowing login")] = 5):
    """
    Test the login flow using a local test page with countdown timer.

    This command opens a test login page that simulates the Flowpad login flow.
    Use the --delay option to test the countdown timer functionality.

    Examples:
      flow auth test          # 5 second delay (default)
      flow auth test --delay 10  # 10 second delay
    """
    import webbrowser

    from flow_sdk.server.app import wait_for_login_callback

    port = _discover_port()

    # Build the test login URL with callback and delay
    callback_url = f"http://127.0.0.1:{port}/auth/login_callback"
    test_login_url = f"http://127.0.0.1:{port}/api/v1/cloud/test_login?callback={callback_url}&delay={delay}"

    typer.echo(f"\n🧪 Opening test login page with {delay} second delay...")
    typer.echo(f"Test URL: {test_login_url}\n")

    # Open browser
    webbrowser.open(test_login_url)

    # Wait for the login callback
    result = wait_for_login_callback()

    if result.get("success"):
        typer.echo("\n✓ Test login successful!")
        typer.echo("✓ API key stored securely in system keyring")
        if "user" in result:
            typer.echo(f"✓ User ID: {result['user'].get('id')}")
    else:
        typer.echo(f"\n✗ Test login failed: {result.get('message', 'Unknown error')}", err=True)
        if "error" in result:
            typer.echo(f"  Error: {result['error']}", err=True)
        raise typer.Exit(1)


# Hooks command group
hooks_app = typer.Typer(help="Manage Claude Code hooks")
app.add_typer(hooks_app, name="hooks")


def _parse_scope(scope_str: str) -> ClaudeScope:
    """Convert scope string to ClaudeScope enum."""
    scope_map = {
        "user": ClaudeScope.USER,
        "project": ClaudeScope.PROJECT,
        "local": ClaudeScope.LOCAL,
    }
    scope_lower = scope_str.lower()
    if scope_lower not in scope_map:
        raise typer.BadParameter(f"Invalid scope '{scope_str}'. Must be one of: user, project, local")
    return scope_map[scope_lower]


@hooks_app.command("set")
def hooks_set(
    scope: Annotated[str, typer.Option(help="Scope for hooks: user, project, or local")] = "user",
):
    """
    Set all Flow hooks in Claude Code settings.

    Configures hooks for all Claude Code events to report to flow trace.
    Default scope is 'user' (applies globally to all projects).

    Events configured:
    - UserPromptSubmit: User sends a prompt
    - PreToolUse: Before a tool is executed
    - PostToolUse: After a tool is executed
    - Notification: Claude sends a notification
    - Stop: Session stops
    - SubagentStop: Subagent stops

    Examples:
      flow hooks set
      flow hooks set --scope project
      flow hooks set --scope local
    """
    from flow_sdk.builtin.flowpad_runner_wrapper import wrap_command
    from flow_sdk.cli.commands.setup_cmd.claude_code_setup.claude_hooks import setHook
    from flow_sdk.cli.commands.setup_cmd.claude_code_setup.flow_metadata import FlowHookMetadata
    from flow_sdk.cli.commands.setup_cmd.claude_code_setup.hook_events import EVENTS_NO_MATCHER, EVENTS_WITH_MATCHER

    try:
        claude_scope = _parse_scope(scope)
    except typer.BadParameter as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(1)

    context = get_context()

    # Validate scope is available
    if claude_scope in [ClaudeScope.PROJECT, ClaudeScope.LOCAL] and not context.is_in_repo():
        typer.echo(f"Error: Cannot use '{scope}' scope - not in a git repository", err=True)
        raise typer.Exit(1)

    typer.echo(f"Setting Flow hooks (scope: {scope})...")

    success_count = 0

    # Set hooks for events without matchers
    for event_name in EVENTS_NO_MATCHER:
        flow_metadata = FlowHookMetadata.create(name=event_name.lower())
        cmd = wrap_command(f"hooks report --name={event_name.lower()}")
        success = setHook(
            scope=claude_scope,
            event_name=event_name,
            matcher=None,
            cmd=cmd,
            context=context,
            flow_metadata=flow_metadata,
        )
        if success:
            typer.echo(f"✓ {event_name}")
            success_count += 1
        else:
            typer.echo(f"✗ {event_name} (failed)", err=True)

    # Set hooks for events with matchers (match all tools)
    for event_name in EVENTS_WITH_MATCHER:
        flow_metadata = FlowHookMetadata.create(name=event_name.lower())
        cmd = wrap_command(f"hooks report --name={event_name.lower()}")
        success = setHook(
            scope=claude_scope,
            event_name=event_name,
            matcher="*",  # Match all tools
            cmd=cmd,
            context=context,
            flow_metadata=flow_metadata,
        )
        if success:
            typer.echo(f"✓ {event_name} (matcher: *)")
            success_count += 1
        else:
            typer.echo(f"✗ {event_name} (failed)", err=True)

    typer.echo(f"\n✓ {success_count} hooks configured")
    typer.echo(f"✓ Settings file: {context.get_claude_settings_path(claude_scope)}")


@hooks_app.command("clear")
def hooks_clear(
    scope: Annotated[str, typer.Option(help="Scope for hooks: user, project, or local")] = "user",
):
    """
    Clear all Flow hooks from Claude Code settings.

    Only removes hooks that are Flow commands (safe for other hooks).
    Default scope is 'user'.

    Examples:
      flow hooks clear
      flow hooks clear --scope project
    """
    from flow_sdk.cli.commands.setup_cmd.claude_code_setup.claude_hooks import removeHook
    from flow_sdk.cli.commands.setup_cmd.claude_code_setup.hook_events import ALL_HOOK_EVENTS

    try:
        claude_scope = _parse_scope(scope)
    except typer.BadParameter as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(1)

    context = get_context()

    # Validate scope is available
    if claude_scope in [ClaudeScope.PROJECT, ClaudeScope.LOCAL] and not context.is_in_repo():
        typer.echo(f"Error: Cannot use '{scope}' scope - not in a git repository", err=True)
        raise typer.Exit(1)

    typer.echo(f"Clearing Flow hooks (scope: {scope})...")

    # Remove all flow-managed hooks
    removed_count = 0
    for event_name in ALL_HOOK_EVENTS:
        success = removeHook(scope=claude_scope, event_name=event_name, matcher=None, context=context)
        if success:
            typer.echo(f"✓ {event_name}")
            removed_count += 1

    if removed_count > 0:
        typer.echo(f"\n✓ {removed_count} hooks cleared from {context.get_claude_settings_path(claude_scope)}")
    else:
        typer.echo("No Flow hooks found to remove.")


@hooks_app.command("report")
def hooks_report(
    hook_entry_id: Annotated[
        Optional[str], typer.Option("--hook-entry-id", help="Hook entry ID for metadata lookup")
    ] = None,
    name: Annotated[Optional[str], typer.Option("--name", help="Hook name (e.g. flowpad_sniffer)")] = None,
    wait_for_response: Annotated[
        bool, typer.Option("--wait-for-response", help="Wait synchronously for response (for PermissionRequest)")
    ] = False,
):
    """
    Report hook event data to the Flow server.

    This command is called BY hook scripts to report event data.
    Reads JSON from stdin and POSTs to AGENT_HOOKS_REPORT_URL (or local server).

    Normally exits with code 0 to avoid blocking Claude (fire-and-forget).
    With --wait-for-response, waits for response and returns exit code based on
    permissionDecision (for PermissionRequest hooks).
    """
    import json
    import sys
    from pathlib import Path

    def find_hook_metadata(
        entry_id: Optional[str], hook_name: Optional[str] = None
    ) -> tuple[Optional[dict], Optional[str]]:
        """Build hook metadata from CLI args (--hook-entry-id, --name).

        Hook identity is carried in the command string, so no need to
        scan settings files for flow_metadata (which gets stripped by
        Claude Code's additionalProperties: false anyway).
        """
        metadata = {}
        if hook_name:
            metadata["name"] = hook_name

        # Check project-level settings first, then user-level
        project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
        if project_dir:
            project_settings = Path(project_dir) / ".claude" / "settings.json"
            if project_settings.exists():
                return (metadata or None), str(project_settings)

        fallback_path = get_instance_settings().claude_settings_json_path
        settings_path = str(fallback_path) if fallback_path.exists() else None
        return (metadata or None), settings_path

    verbose = sys.stdin.isatty()
    input_data = None
    last_resp = None  # Capture response for --wait-for-response reuse

    try:
        # Read JSON from stdin (hook event data), or use test payload if interactive
        if verbose:
            input_data = {"hook_event_name": "test_ping", "source": "manual_cli"}
            typer.echo("No stdin detected (TTY), using test payload")
        else:
            input_data = json.load(sys.stdin)

        hook_metadata, hook_file_path = find_hook_metadata(hook_entry_id, hook_name=name)
        report_payload = {
            **input_data,
            "hook_entry_id": hook_entry_id,
            "hook_metadata": hook_metadata,
            "hook_file_path": hook_file_path,
        }

        # Parse execution_scope from env (identifies which entity this hook belongs to)
        from flow_sdk.cli.commands._common import local_post
        from flow_sdk.utils.environment import get_execution_scope

        _exec_scope = get_execution_scope()

        # Prefer dedicated webhook/listen route when configured by AgentHook command.
        report_url = os.environ.get("AGENT_HOOKS_REPORT_URL")
        if report_url:
            flow_data_payload = {
                "webhook_type": "agent_hook",
                "webhook_payload": {
                    "agent_hook_id": hook_entry_id,
                    "hook_data": {
                        "hook_event_name": input_data.get("hook_event_name", input_data.get("event")),
                        "session_id": input_data.get("session_id"),
                        "terminal_id": os.environ.get("FLOWPAD_TERMINAL_ID"),
                        "tool_name": input_data.get("tool_name"),
                        "tool_input": input_data.get("tool_input"),
                        "tool_response": input_data.get("tool_response"),
                        "output": input_data.get("output"),
                        "prompt": input_data.get("prompt"),
                        "message": input_data.get("message"),
                        "usage": input_data.get("usage"),
                        "cwd": input_data.get("cwd"),
                        "transcript_path": input_data.get("transcript_path"),
                        "execution_scope": _exec_scope,
                        "raw_hook_data": input_data,
                    },
                    "hook_entry_id": hook_entry_id,
                    "hook_metadata": hook_metadata,
                    "hook_file_path": hook_file_path,
                },
            }
            if verbose:
                typer.echo(f"\nTarget: POST {report_url}")
                typer.echo(f"\nPayload:\n{json.dumps(flow_data_payload, indent=2)}")
            try:
                last_resp = local_post(report_url, json=flow_data_payload, timeout=5)
                if verbose:
                    typer.echo(f"\nResponse: {last_resp.status_code} {last_resp.text[:200]}")
            except requests.exceptions.RequestException as e:
                if verbose:
                    typer.echo(f"\nRequest failed: {e}")
        else:
            # Broadcast to all running servers (prod + dev) via server JSON files
            from flow_sdk.discovery.flowpad_discovery import read_all_server_infos

            servers = read_all_server_infos()
            fallback_payload = {
                "webhook_type": "agent_hook",
                "webhook_payload": {
                    "agent_hook_id": hook_entry_id,
                    "hook_data": {
                        "hook_event_name": input_data.get("hook_event_name", input_data.get("event")),
                        "session_id": input_data.get("session_id"),
                        "prompt": input_data.get("prompt"),
                        "tool_name": input_data.get("tool_name"),
                        "tool_input": input_data.get("tool_input"),
                        "execution_scope": _exec_scope,
                        "raw_hook_data": input_data,
                    },
                    "hook_entry_id": hook_entry_id,
                    "hook_metadata": hook_metadata,
                    "hook_file_path": hook_file_path,
                },
            }
            if servers:
                for s in servers:
                    if verbose:
                        typer.echo(f"\nReporting to server at port {s.port}")
                    try:
                        # Broadcast: `s.url` may be ANOTHER instance, whose gate
                        # secret differs from this one's. Attaching ours is
                        # harmless — that instance refuses it exactly as it
                        # refuses a keyless call today — and it is what makes
                        # the report land on the gated instance that is ours.
                        last_resp = local_post(s.url, json=fallback_payload, timeout=5)
                        if verbose:
                            typer.echo(f"  Response: {last_resp.status_code} {last_resp.text[:200]}")
                    except requests.exceptions.RequestException as e:
                        if verbose:
                            typer.echo(f"  Request failed: {e}")
            else:
                port = get_instance_settings().port
                fallback_url = f"http://127.0.0.1:{port}/api/hooks/report"
                if verbose:
                    typer.echo(f"\nNo server.json found, using legacy fallback (port {port})")
                try:
                    last_resp = local_post(fallback_url, json=report_payload, timeout=5)
                    if verbose:
                        typer.echo(f"\nResponse: {last_resp.status_code} {last_resp.text[:200]}")
                except requests.exceptions.RequestException as e:
                    if verbose:
                        typer.echo(f"\nRequest failed: {e}")

    except json.JSONDecodeError:
        pass
    except Exception as e:
        if verbose:
            typer.echo(f"Error: {e}")

    # Handle response based on wait_for_response flag
    if not wait_for_response:
        # Normal fire-and-forget mode
        raise typer.Exit(0)

    # Echo server's data field to stdout (Claude Code reads hookSpecificOutput from it).
    data = (last_resp.json().get("data") or {}) if last_resp and last_resp.text else {}
    if data:
        typer.echo(json.dumps(data))
    raise typer.Exit(0)


@hooks_app.command("list")
def hooks_list(
    scope: Annotated[str, typer.Option(help="Scope for hooks: user, project, or local")] = "user",
):
    """
    List all configured hooks in Claude Code settings.

    Shows events, matchers, and hook commands for the specified scope.
    Default scope is 'user'.

    Examples:
      flow hooks list
      flow hooks list --scope project
    """
    from flow_sdk.cli.commands.setup_cmd.claude_code_setup.hook_parser import HookParser

    try:
        claude_scope = _parse_scope(scope)
    except typer.BadParameter as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(1)

    context = get_context()

    # Validate scope is available
    if claude_scope in [ClaudeScope.PROJECT, ClaudeScope.LOCAL] and not context.is_in_repo():
        typer.echo(f"Error: Cannot use '{scope}' scope - not in a git repository", err=True)
        raise typer.Exit(1)

    settings_path = context.get_claude_settings_path(claude_scope)
    typer.echo(f"Hooks for scope '{scope}': {settings_path}")
    typer.echo("-" * 60)

    # Initialize HookParser for the specified scope
    hook_parser = HookParser(context=context, scope=claude_scope)

    events = hook_parser.list_events()

    if not events:
        typer.echo("No hooks configured.")
        return

    for event in events:
        typer.echo(f"\nEvent: {event}")
        event_hooks = hook_parser.get_event_hooks(event)

        # Handle null/None values in hooks
        if event_hooks is None:
            typer.echo("  (disabled/null)")
            continue

        for entry in event_hooks:
            matcher = entry.get("matcher")
            if matcher:
                typer.echo(f"  Matcher: {matcher}")
            else:
                typer.echo("  Matcher: (none)")

            hooks = entry.get("hooks", [])
            for hook in hooks:
                hook_type = hook.get("type", "unknown")
                command = hook.get("command", "")
                typer.echo(f"    [{hook_type}] {command}")


# ---------------------------------------------------------------------------
# Log command group
# ---------------------------------------------------------------------------

log_app = typer.Typer(help="View and replay CLI invocation logs")
app.add_typer(log_app, name="log")

from flow_sdk.cli.commands.compute_cmd import compute_app

app.add_typer(compute_app, name="compute")

from flow_sdk.cli.commands.navigate_cmd import navigate_app

app.add_typer(navigate_app, name="navigate")

from flow_sdk.cli.commands.artifact_cmd import artifact_app

app.add_typer(artifact_app, name="artifact")

from flow_sdk.cli.commands.show_cmd import show_app

app.add_typer(show_app, name="show")

from flow_sdk.cli.commands.terminal_cmd import terminal_app

app.add_typer(terminal_app, name="terminal")

from flow_sdk.cli.commands.tag_cmd import tag_app

app.add_typer(tag_app, name="tag")

from flow_sdk.cli.commands.app_cmd import app_app

app.add_typer(app_app, name="app")

from flow_sdk.cli.commands.context_cmd import context_app

app.add_typer(context_app, name="context")

from flow_sdk.cli.commands.schema_cmd import schema_app

app.add_typer(schema_app, name="schema")

from flow_sdk.cli.commands.record_cmd import record_app

app.add_typer(record_app, name="record")

from flow_sdk.cli.commands.conversation_cmd import conversation_app

app.add_typer(conversation_app, name="conversation")


from flow_sdk.cli.commands.process_cmd import process_app

app.add_typer(process_app, name="process")

from flow_sdk.cli.commands.wizard_cmd import wizard_command

app.command(
    "wizard",
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True},
)(wizard_command)

from flow_sdk.cli.commands.migrate_cmd import migrate_app

app.add_typer(migrate_app, name="migrate")

from flow_sdk.cli.commands.instance_cmd import instance_app

app.add_typer(instance_app, name="instance")

from flow_sdk.cli.commands.diagnose_cmd import diagnose_command

# No positional MESSAGE arg — the issue is read at a prompt. allow_extra_args so
# stray words (e.g. `flow diagnose backend down`) are ignored, not errors.
app.command(
    "diagnose",
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True},
)(diagnose_command)


@log_app.callback(invoke_without_command=True)
def log_show(
    ctx: typer.Context,
    limit: Annotated[int, typer.Option(help="Max entries to show")] = 20,
    level: Annotated[str, typer.Option(help="Filter by level: all, info, debug")] = "all",
):
    """Show recent CLI invocations (default when no subcommand given)."""
    if ctx.invoked_subcommand is not None:
        return

    from flow_sdk.cli.cli_log import read_entries

    entries = read_entries(limit=limit)
    if level != "all":
        entries = [e for e in entries if e.level == level]

    if not entries:
        typer.echo("No log entries found.")
        return

    # Header
    typer.echo(f"{'#':<5} {'Time':<20} {'Exit':<6} {'Dur':>7} {'Level':<6} Command")
    typer.echo("-" * 90)

    for i, rec in enumerate(entries):
        created = rec.created_at
        if hasattr(created, "strftime"):
            time_str = created.strftime("%Y-%m-%d %H:%M:%S")
        else:
            time_str = str(created)[:19]

        cmd = rec.command if isinstance(rec.command, list) else [str(rec.command)]
        cmd_str = " ".join(cmd)
        if len(cmd_str) > 50:
            cmd_str = cmd_str[:47] + "..."

        exit_code = rec.exit_code if rec.exit_code is not None else "?"
        duration = rec.duration_ms if rec.duration_ms is not None else 0
        entry_level = rec.level or "info"

        exit_display = str(exit_code)
        if exit_code == 0:
            exit_display = "0"

        typer.echo(f"{i:<5} {time_str:<20} {exit_display:<6} {duration:>6}ms {entry_level:<6} {cmd_str}")


@log_app.command("replay")
def log_replay(
    ref: Annotated[str, typer.Argument(help="Entry index (0-based, newest first) or ISO timestamp prefix")],
):
    """Replay a logged CLI invocation exactly as it was.

    Examples:
      flow log replay 0          # replay most recent entry
      flow log replay 5          # replay 6th most recent
      flow log replay 2026-03-04T10:30
    """
    import subprocess

    from flow_sdk.cli.cli_log import read_entries

    entries = read_entries()
    if not entries:
        typer.echo("No log entries found.", err=True)
        raise typer.Exit(1)

    record = _resolve_entry(entries, ref)
    if record is None:
        typer.echo(f"No entry matching '{ref}'.", err=True)
        raise typer.Exit(1)

    cmd = record.command if isinstance(record.command, list) else [str(record.command)]
    workdir = record.workdir or "."
    stdin_data = record.stdin

    typer.echo(f"Replaying: {' '.join(cmd)}")
    typer.echo(f"  workdir: {workdir}")
    if stdin_data:
        typer.echo(f"  stdin:   {len(stdin_data)} bytes")

    result = subprocess.run(
        cmd,
        cwd=workdir,
        input=stdin_data,
        text=True,
    )
    raise typer.Exit(result.returncode)


@log_app.command("settings")
def log_settings(
    level: Annotated[Optional[str], typer.Option(help="Set log level: info or debug")] = None,
):
    """View or change CLI log settings."""
    from flow_sdk.cli.cli_log import load_settings, save_settings

    current = load_settings()

    if level is None:
        typer.echo(f"level={current.level}")
        return

    if level not in ("info", "debug"):
        typer.echo(f"Invalid level '{level}'. Must be 'info' or 'debug'.", err=True)
        raise typer.Exit(1)

    save_settings(level)
    typer.echo(f"level={level}")


@log_app.command("clear")
def log_clear():
    """Delete all CLI log entries."""
    from flow_sdk.cli.cli_log import clear_log

    count = clear_log()
    typer.echo(f"Cleared {count} log entries.")


def _resolve_entry(entries, ref: str):
    """Resolve a ref to a CliLogRecord: integer index or timestamp prefix."""
    # Try integer index first
    try:
        idx = int(ref)
        if 0 <= idx < len(entries):
            return entries[idx]
        return None
    except ValueError:
        pass

    # Try timestamp prefix match
    for entry in entries:
        created = entry.created_at
        if hasattr(created, "isoformat"):
            ts = created.isoformat()
        else:
            ts = str(created)
        if ts.startswith(ref):
            return entry
    return None


@app.command()
def uninstall():
    """
    Uninstall flowpad by removing all sniffer hooks from Claude Code settings.

    Scans user, project, and local Claude Code settings files and removes
    any hook entries that belong to the flowpad sniffer.

    Example: flow uninstall
    """
    import json
    from pathlib import Path

    def _remove_sniffer_from_file(settings_path: Path) -> int:
        """Remove sniffer hooks from a settings file. Returns count of removed hooks."""
        if not settings_path.exists():
            return 0

        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
        except (json.JSONDecodeError, IOError):
            return 0

        if "hooks" not in settings or not isinstance(settings["hooks"], dict):
            return 0

        removed = 0
        events_to_delete = []

        for event_name, hook_entries in settings["hooks"].items():
            if not isinstance(hook_entries, list):
                continue
            new_entries = []
            for entry in hook_entries:
                hooks_list = entry.get("hooks", [])
                filtered = [h for h in hooks_list if "--name=flowpad_sniffer" not in h.get("command", "")]
                removed += len(hooks_list) - len(filtered)
                if filtered:
                    entry["hooks"] = filtered
                    new_entries.append(entry)
            if new_entries:
                settings["hooks"][event_name] = new_entries
            else:
                events_to_delete.append(event_name)

        if removed == 0:
            return 0

        for event_name in events_to_delete:
            del settings["hooks"][event_name]

        # Clean up empty hooks dict
        if not settings["hooks"]:
            del settings["hooks"]

        settings_path.parent.mkdir(parents=True, exist_ok=True)
        with open(settings_path, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)

        return removed

    total_removed = 0

    # User-level settings
    user_settings = Path.home() / ".claude" / "settings.json"
    count = _remove_sniffer_from_file(user_settings)
    if count:
        typer.echo(f"Removed {count} sniffer hook(s) from {user_settings}")
        total_removed += count

    # Project-level settings (if in a git repo)
    context = get_context()
    if context.is_in_repo():
        for filename in ("settings.json", "settings.local.json"):
            project_settings = Path(context.repo_root) / ".claude" / filename
            count = _remove_sniffer_from_file(project_settings)
            if count:
                typer.echo(f"Removed {count} sniffer hook(s) from {project_settings}")
                total_removed += count

    if total_removed > 0:
        typer.echo(f"\nRemoved {total_removed} sniffer hook(s) total.")
    else:
        typer.echo("No sniffer hooks found.")


def cli_main():
    """Entry point that can be used with CLICommand.

    Wraps app() with tee streams to capture stdout/stderr and log each
    CLI invocation to ~/.flow/logs/cli.log.jsonl.
    """
    import os
    import sys
    import time
    from io import StringIO

    argv = list(sys.argv)
    workdir = os.getcwd()
    start = time.monotonic()

    # Determine entry level: hooks report commands are "debug"
    entry_level = "info"
    if len(argv) >= 3 and argv[1] == "hooks" and argv[2] == "report":
        entry_level = "debug"

    # Fast-path: if entry is debug and settings say info-only, skip logging
    should_log = True
    try:
        from flow_sdk.cli.cli_log import load_settings

        settings = load_settings()
        if settings.level == "info" and entry_level == "debug":
            should_log = False
    except Exception:
        should_log = False

    if not should_log:
        app()
        return

    # Capture stdin if piped
    stdin_data = None
    original_stdin = sys.stdin
    try:
        import select

        if not sys.stdin.isatty() and select.select([sys.stdin], [], [], 0.0)[0]:
            from io import StringIO

            stdin_data = sys.stdin.read()
            sys.stdin = StringIO(stdin_data)
    except Exception:
        pass

    # Install tee streams
    from flow_sdk.cli.tee_stream import TeeStream

    original_stdout = sys.stdout
    original_stderr = sys.stderr
    tee_out = TeeStream(original_stdout)
    tee_err = TeeStream(original_stderr)
    sys.stdout = tee_out
    sys.stderr = tee_err

    exit_code = 0
    try:
        app()
    except SystemExit as e:
        exit_code = e.code if isinstance(e.code, int) else (1 if e.code else 0)
    finally:
        # Restore streams
        sys.stdout = original_stdout
        sys.stderr = original_stderr
        sys.stdin = original_stdin

        # Write log entry
        try:
            from flow_sdk.cli.cli_log import MAX_OUTPUT_SIZE, CliLogRecord, write_entry

            duration_ms = int((time.monotonic() - start) * 1000)
            stdout_val = tee_out.getvalue()[:MAX_OUTPUT_SIZE]
            stderr_val = tee_err.getvalue()[:MAX_OUTPUT_SIZE]

            record = CliLogRecord(
                workdir=workdir,
                command=argv,
                exit_code=exit_code,
                stdout=stdout_val,
                stderr=stderr_val,
                stdin=stdin_data[:MAX_OUTPUT_SIZE] if stdin_data else None,
                level=entry_level,
                duration_ms=duration_ms,
            )
            write_entry(record)
        except Exception:
            pass

    sys.exit(exit_code)


if __name__ == "__main__":
    app()
