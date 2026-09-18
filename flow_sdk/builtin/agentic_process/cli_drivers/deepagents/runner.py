"""The Deep Agents runner — ``python -m flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner``.

``deepagents`` (LangChain) is a harness that ships as a Python package, not a CLI. This module
is the CLI FlowPad spawns around it, so the vendor is a subprocess like every other worker:
cancel is a process-tree kill, the spawn env carries the funding, and the ~4 s import of the
LangChain stack stays out of the backend.

One turn per invocation. The prompt arrives on stdin; every stdout line is one JSON event of
OUR protocol (the engine is a provider mirror, the wire is ours):

    init         model, cwd, resumed, tools[], subagents[], skills[], mcp_servers[], versions
    user         text                                   — the user's own turn
    text         message_id, text, agent                — one whole block per AI message
    reasoning    message_id, text, agent
    tool_call    tool_call_id, name, input, message_id, agent
    tool_result  tool_call_id, name, output, is_error, agent
    usage        message_id, model, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens
    error        message, kind                          — non-terminal; a ``result`` follows
    result       subtype, is_error, num_turns, duration_ms, usage   — terminal

Every line also carries ``type``, ``session_id`` and an ISO-8601 UTC ``timestamp``. ``agent`` is
``None`` for the main agent and a label for a subagent's subgraph. The terminal event is spelled
``result`` because the shared ``TranscriptDurabilityGate`` locks on that literal.

Sessions are LangGraph threads checkpointed to ONE SQLite file per session id, so two processes
never share a database and "is this session resumable" is a file check.

Stdlib-only at import: ``--version`` must answer inside the capability probe's budget, so the
LangChain stack is imported inside :func:`run_turn`, never at module scope.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

RUNNER_VERSION = "1"
MODULE = "flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner"
DEFAULT_MODEL_FACTORY = "flow_sdk.builtin.agentic_process.cli_drivers.deepagents.models:openai_wire_model"

BASE_URL_ENV = "FLOWPAD_DEEPAGENTS_BASE_URL"
API_KEY_ENV = "FLOWPAD_DEEPAGENTS_API_KEY"

#: The one permission mode this harness can honour: its ``execute`` tool sits outside
#: deepagents' filesystem permission model, so anything narrower would be a pretence.
SUPPORTED_PERMISSION_MODES = frozenset({"bypassPermissions"})

#: Tool output kept in an event; the full output already reached the model.
MAX_TOOL_OUTPUT_CHARS = 20_000

#: Label for events from a subagent's subgraph (``task`` tool). The subgraph namespace carries
#: a LangGraph task id, not the subagent's name, so the label is generic.
SUBAGENT_LABEL = "subagent"


def deepagents_version() -> str | None:
    """The installed engine's version from package metadata — never imports the engine."""
    from importlib import metadata

    try:
        return metadata.version("deepagents")
    except metadata.PackageNotFoundError:
        return None


class Emitter:
    """Writes protocol events to stdout, one JSON object per line, flushed per event."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id

    def emit(self, type_: str, **fields: Any) -> None:
        event = {
            "type": type_,
            "session_id": self.session_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **fields,
        }
        sys.stdout.write(json.dumps(event, separators=(",", ":"), default=str) + "\n")
        sys.stdout.flush()


def load_factory(spec: str):
    module_name, _, attr = spec.partition(":")
    if not module_name or not attr:
        raise ValueError(f"--model-factory must be 'module:callable', got {spec!r}")
    return getattr(importlib.import_module(module_name), attr)


def subagents_from_agents_json(agents_json: dict[str, Any]) -> list[dict[str, Any]]:
    """Claude's ``--agents`` JSON → deepagents ``SubAgent`` dicts.

    ``{name: {description, prompt, ...}}`` maps 1:1 (``prompt`` → ``system_prompt``). ``tools``
    and ``model`` are dropped on purpose: they name Claude tools and Claude model aliases, which
    mean nothing to this harness — a subagent inherits the main agent's tools and model.
    """
    subagents = []
    for name, entry in (agents_json or {}).items():
        if not isinstance(entry, dict):
            continue
        subagents.append(
            {
                "name": name,
                "description": str(entry.get("description") or name),
                "system_prompt": str(entry.get("prompt") or ""),
            }
        )
    return subagents


def mcp_connections(mcp_config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The ``mcpServers`` fragment → ``langchain-mcp-adapters`` connection dicts."""
    servers = mcp_config.get("mcpServers") if "mcpServers" in mcp_config else mcp_config
    connections: dict[str, dict[str, Any]] = {}
    for name, cfg in (servers or {}).items():
        if not isinstance(cfg, dict):
            continue
        if cfg.get("url"):
            transport = "sse" if cfg.get("type") == "sse" else "streamable_http"
            connection: dict[str, Any] = {"transport": transport, "url": cfg["url"]}
            if cfg.get("headers"):
                connection["headers"] = dict(cfg["headers"])
        else:
            connection = {"transport": "stdio", "command": cfg.get("command"), "args": list(cfg.get("args") or [])}
            if cfg.get("env"):
                connection["env"] = dict(cfg["env"])
        connections[name] = connection
    return connections


def _json_arg(value: str) -> dict[str, Any]:
    """A JSON argument given inline (``{...}``) or as a path to a JSON file."""
    text = value if value.lstrip().startswith("{") else Path(value).read_text(encoding="utf-8")
    parsed = json.loads(text)
    return parsed if isinstance(parsed, dict) else {}


def _text_of(content: Any) -> tuple[str, str]:
    """``(text, reasoning)`` from a message's content (a string, or a list of content blocks)."""
    if isinstance(content, str):
        return content, ""
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    for block in content or []:
        if isinstance(block, str):
            text_parts.append(block)
        elif isinstance(block, dict):
            if block.get("type") == "text":
                text_parts.append(str(block.get("text") or ""))
            elif block.get("type") in ("reasoning", "thinking"):
                reasoning_parts.append(str(block.get("reasoning") or block.get("thinking") or block.get("text") or ""))
    return "".join(text_parts), "".join(reasoning_parts)


def _usage_fields(usage: dict[str, Any]) -> dict[str, int]:
    return {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "cache_read_tokens": int((usage.get("input_token_details") or {}).get("cache_read") or 0),
        "reasoning_tokens": int((usage.get("output_token_details") or {}).get("reasoning") or 0),
    }


class TurnTranslator:
    """LangGraph ``updates`` → protocol events. Holds the turn's running totals."""

    def __init__(self, emitter: Emitter, model: str) -> None:
        self._emit = emitter.emit
        self._model = model
        self._tool_names: dict[str, str] = {}
        self.num_turns = 0
        self.totals = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "reasoning_tokens": 0}

    def feed(self, namespace: tuple, update: Any) -> None:
        agent = SUBAGENT_LABEL if namespace else None
        if not isinstance(update, dict):
            return
        for node_update in update.values():
            if not isinstance(node_update, dict):
                continue
            messages = node_update.get("messages")
            # A reducer-wrapped update (``Overwrite``) carries its list on ``.value``.
            messages = getattr(messages, "value", messages)
            for message in messages or []:
                self._message(message, agent)

    def _message(self, message: Any, agent: str | None) -> None:
        kind = type(message).__name__
        if kind in ("AIMessage", "AIMessageChunk"):
            self._ai_message(message, agent)
        elif kind == "ToolMessage":
            self._tool_message(message, agent)

    def _ai_message(self, message: Any, agent: str | None) -> None:
        message_id = getattr(message, "id", None)
        text, reasoning = _text_of(getattr(message, "content", ""))
        if agent is None:
            self.num_turns += 1
        if reasoning.strip():
            self._emit("reasoning", message_id=message_id, text=reasoning, agent=agent)
        for call in getattr(message, "tool_calls", None) or []:
            call_id = call.get("id")
            self._tool_names[str(call_id)] = str(call.get("name") or "")
            self._emit(
                "tool_call",
                tool_call_id=call_id,
                name=call.get("name"),
                input=call.get("args") or {},
                message_id=message_id,
                agent=agent,
            )
        if text.strip():
            self._emit("text", message_id=message_id, text=text, agent=agent)
        usage = getattr(message, "usage_metadata", None)
        if usage:
            fields = _usage_fields(dict(usage))
            for key, value in fields.items():
                self.totals[key] += value
            self._emit("usage", message_id=message_id, model=self._model, **fields)

    def _tool_message(self, message: Any, agent: str | None) -> None:
        call_id = str(getattr(message, "tool_call_id", "") or "")
        output, _ = _text_of(getattr(message, "content", ""))
        self._emit(
            "tool_result",
            tool_call_id=call_id,
            name=getattr(message, "name", None) or self._tool_names.get(call_id),
            output=output[:MAX_TOOL_OUTPUT_CHARS],
            is_error=getattr(message, "status", "success") == "error",
            agent=agent,
        )


def system_prompt_for(workdir: Path, instructions: str) -> str:
    """The cwd has to be said: with real host paths the model otherwise starts at ``/``."""
    base = (
        f"Your working directory is {workdir}. File tools take absolute paths — create and edit "
        f"files under that directory unless told otherwise. Shell commands already run there."
    )
    return f"{base}\n\n{instructions.strip()}" if instructions.strip() else base


async def run_turn(args: argparse.Namespace, prompt: str, emitter: Emitter) -> int:
    started = time.monotonic()
    # A user's shell may have tracing switched on; this worker never phones home.
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"

    from deepagents import create_deep_agent
    from deepagents.backends.local_shell import LocalShellBackend
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    workdir = Path(args.workdir).resolve()
    model = load_factory(args.model_factory)(args.model)
    # The funding token is the MODEL's, not the shell's: what the agent executes must not see it.
    os.environ.pop(API_KEY_ENV, None)

    instructions = "\n\n".join(
        part.strip()
        for part in (
            Path(args.system_prompt_file).read_text(encoding="utf-8") if args.system_prompt_file else "",
            args.system_prompt or "",
        )
        if part.strip()
    )
    agents_json = _json_arg(args.agents_json) if args.agents_json else {}
    subagents = subagents_from_agents_json(agents_json)
    skills = [str(Path(p)) for p in args.skills_dir if Path(p).is_dir()]
    memory = [str(Path(p)) for p in args.memory_file if Path(p).is_file()]

    tools: list[Any] = []
    mcp_names: list[str] = []
    if args.mcp_config:
        connections = mcp_connections(_json_arg(args.mcp_config))
        if connections:
            from langchain_mcp_adapters.client import MultiServerMCPClient

            tools = list(await MultiServerMCPClient(connections).get_tools())
            mcp_names = sorted(connections)

    # inherit_env: the spawn env (incl. the FLOWPAD_CLI_RUN_ID stamp the cancel sweep looks for)
    # reaches what the agent executes; commands run in their own session, so the stamp is the
    # only thing tying them back to this turn.
    backend = LocalShellBackend(root_dir=str(workdir), virtual_mode=False, inherit_env=True)
    checkpoint_db = Path(args.checkpoint_db)
    resumed = checkpoint_db.is_file()
    checkpoint_db.parent.mkdir(parents=True, exist_ok=True)

    async with AsyncSqliteSaver.from_conn_string(str(checkpoint_db)) as saver:
        agent = create_deep_agent(
            model,
            tools=tools or None,
            system_prompt=system_prompt_for(workdir, instructions),
            subagents=subagents or None,
            skills=skills or None,
            memory=memory or None,
            backend=backend,
            checkpointer=saver,
        )
        emitter.emit(
            "init",
            model=args.model,
            cwd=str(workdir),
            resumed=resumed,
            tools=[getattr(t, "name", str(t)) for t in tools],
            subagents=[s["name"] for s in subagents],
            skills=skills,
            mcp_servers=mcp_names,
            runner_version=RUNNER_VERSION,
            deepagents_version=deepagents_version(),
        )
        emitter.emit("user", text=prompt)

        translator = TurnTranslator(emitter, args.model)
        config = {"configurable": {"thread_id": args.session_id}}
        is_error = False
        try:
            async for namespace, update in agent.astream(
                {"messages": [{"role": "user", "content": prompt}]},
                config,
                stream_mode="updates",
                subgraphs=True,
            ):
                translator.feed(namespace, update)
        except Exception as exc:  # noqa: BLE001 — ANY failure must still end the turn with a ``result``
            is_error = True
            emitter.emit("error", message=f"{type(exc).__name__}: {exc}", kind=_error_kind(exc))

    emitter.emit(
        "result",
        subtype="error" if is_error else "success",
        is_error=is_error,
        num_turns=translator.num_turns,
        duration_ms=int((time.monotonic() - started) * 1000),
        usage=translator.totals,
    )
    return 1 if is_error else 0


def _error_kind(exc: Exception) -> str:
    name = type(exc).__name__.lower()
    if "auth" in name or "permission" in name:
        return "auth"
    # The gateway refused the REQUEST (an unknown model slug, a bad parameter, a quota): that is
    # a fact about the model configuration, not a bug in this worker.
    if any(marker in name for marker in ("notfound", "badrequest", "invalidrequest", "ratelimit", "unprocessable")):
        return "model"
    return "internal"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deepagents-runner", description=__doc__.splitlines()[0])
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--session-id")
    parser.add_argument("--workdir")
    parser.add_argument("--model")
    parser.add_argument("--checkpoint-db")
    parser.add_argument("--system-prompt-file")
    parser.add_argument("--system-prompt")
    parser.add_argument("--agents-json", help="Claude-shaped --agents JSON: inline or a file path")
    parser.add_argument("--mcp-config", help="an mcpServers JSON body: inline or a file path")
    parser.add_argument("--skills-dir", action="append", default=[])
    parser.add_argument("--memory-file", action="append", default=[])
    parser.add_argument("--permission-mode", default="bypassPermissions")
    parser.add_argument("--model-factory", default=DEFAULT_MODEL_FACTORY)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.version:
        engine = deepagents_version()
        if engine is None:
            print("deepagents is not installed", file=sys.stderr)  # noqa: T201 — CLI output
            return 1
        print(f"deepagents {engine} (flowpad runner {RUNNER_VERSION})")  # noqa: T201 — CLI output
        return 0

    missing = [flag for flag in ("session_id", "workdir", "model", "checkpoint_db") if not getattr(args, flag)]
    if missing:
        print(f"missing required arguments: {', '.join('--' + m.replace('_', '-') for m in missing)}", file=sys.stderr)  # noqa: T201 — CLI output
        return 2
    emitter = Emitter(args.session_id)
    if args.permission_mode not in SUPPORTED_PERMISSION_MODES:
        emitter.emit(
            "error",
            kind="internal",
            message=f"permission mode {args.permission_mode!r} is not supported by the deepagents worker "
            f"(supported: {', '.join(sorted(SUPPORTED_PERMISSION_MODES))})",
        )
        emitter.emit("result", subtype="error", is_error=True, num_turns=0, duration_ms=0, usage={})
        return 1
    prompt = sys.stdin.read().strip()
    if not prompt:
        emitter.emit("error", kind="internal", message="empty prompt on stdin")
        emitter.emit("result", subtype="error", is_error=True, num_turns=0, duration_ms=0, usage={})
        return 1
    return asyncio.run(run_turn(args, prompt, emitter))


if __name__ == "__main__":
    sys.exit(main())
