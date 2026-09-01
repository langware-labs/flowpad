"""Rendering one ``McpSpec`` list into each vendor's per-process MCP channel.

Four harnesses, four shapes, one table. Measured against the installed CLIs on
2026-09-01 (claude 2.1.252, codex 0.149.0, copilot 1.0.81, opencode), each with
a real tool call through a dummy stdio server:

* **claude**  ``--mcp-config '<json>'`` (+ ``--strict-mcp-config``).
  ``--mcp-config`` takes a JSON **string**, not only a file path, so nothing is
  written to disk.
* **copilot** ``--additional-mcp-config '<json>'`` — same JSON body as claude.
  Undocumented on docs.github.com; it is in ``copilot --help``.
* **codex**   ``-c mcp_servers.<name>.<key>=<toml>``. Undocumented for MCP —
  OpenAI documents ``-c`` only generically — but it works and codex logs
  ``mcp: <name>/<tool> started``.
* **opencode** an ``mcp`` key in the generated per-process config. The ONLY
  vendor whose shape genuinely differs: ``command`` is an ARRAY (command and
  args fused), the env key is ``environment``, and the discriminator is
  ``local``/``remote`` rather than ``stdio``/``http``.

Keeping the four renderers here rather than in each driver means the shape
differences are visible side by side, which is the only way the opencode one
stays correct.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Iterable, Sequence

if TYPE_CHECKING:
    from flow_sdk.schema.data_spec.mcp_spec import McpSpec


def _body(spec: "McpSpec") -> dict[str, Any]:
    """The claude/copilot server body — the ``mcpServers`` value."""
    if spec.is_remote:
        body: dict[str, Any] = {"type": spec.transport or "http", "url": spec.url}
    else:
        body = {"type": "stdio", "command": spec.command}
        if spec.args:
            body["args"] = list(spec.args)
    if spec.env:
        body["env"] = dict(spec.env)
    return body


def to_mcp_servers_json(specs: Sequence["McpSpec"]) -> dict[str, Any]:
    """``{"mcpServers": {...}}`` — the body claude and copilot both accept."""
    return {"mcpServers": {spec.name: _body(spec) for spec in specs}}


def to_mcp_config_json(specs: Sequence["McpSpec"]) -> str:
    """The serialized ``--mcp-config`` / ``--additional-mcp-config`` argument.

    Claude and copilot take the same JSON body on the command line, so the
    body-plus-serialize rule lives here rather than in each driver.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_serialization import (
        serialize_json_cli_value,
    )

    return serialize_json_cli_value(to_mcp_servers_json(specs))


def dedupe_by_name(specs: Iterable["McpSpec"]) -> list["McpSpec"]:
    """Order-preserving, first-wins dedupe. The tie-break rule for a server
    declared in two places (an agent's and its process's) lives here only."""
    seen: dict[str, "McpSpec"] = {}
    for spec in specs:
        seen.setdefault(spec.name, spec)
    return list(seen.values())


def to_codex_overrides(specs: Sequence["McpSpec"]) -> tuple[tuple[str, Any], ...]:
    """``-c`` pairs, one per leaf under ``mcp_servers.<name>``.

    Per-leaf rather than one whole-table override so the process's servers MERGE
    with whatever ``$CODEX_HOME/config.toml`` already defines, matching how the
    hook integration writes ``hooks.<Event>``.

    Codex splits a ``-c`` key literally on dots, so a server whose NAME contains
    a dot cannot be addressed this way. That is refused here — loudly, before a
    launch — rather than emitted as a config that would silently nest under the
    wrong table.
    """
    out: list[tuple[str, Any]] = []
    for spec in specs:
        if "." in spec.name:
            raise ValueError(
                f"codex cannot address an MCP server whose name contains '.': {spec.name!r} "
                "(codex splits -c keys on dots, so the entry would nest under the wrong table)"
            )
        base = f"mcp_servers.{spec.name}"
        if spec.is_remote:
            out.append((f"{base}.url", spec.url))
        else:
            out.append((f"{base}.command", spec.command))
            if spec.args:
                out.append((f"{base}.args", list(spec.args)))
        if spec.env:
            out.append((f"{base}.env", dict(spec.env)))
    return tuple(out)


def to_opencode_mcp(specs: Sequence["McpSpec"]) -> dict[str, Any]:
    """opencode's ``mcp`` block — its own shape, not the mcpServers one."""
    block: dict[str, Any] = {}
    for spec in specs:
        if spec.is_remote:
            # No env for a remote server: opencode's nearest channel is
            # ``headers``, and inventing that mapping here would be a guess.
            entry: dict[str, Any] = {"type": "remote", "url": spec.url, "enabled": True}
        else:
            entry = {
                "type": "local",
                "command": [spec.command, *spec.args],
                "enabled": True,
            }
            if spec.env:
                entry["environment"] = dict(spec.env)
        block[spec.name] = entry
    return block


def mcp_snapshot(specs: Sequence["McpSpec"]) -> dict[str, Any]:
    """The SEMANTIC snapshot that feeds the restart hash.

    Vendor-neutral and rendering-independent on purpose: attaching or detaching
    a server must move ``restart_required`` (MCP resolves at worker boot, so a
    live process genuinely does not have the new server yet), while changing how
    a flag is spelled must not.
    """
    return {"mcp": [spec.model_dump(mode="json") for spec in specs]}
