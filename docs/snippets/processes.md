# Processes and agents — snippets

An `Agent` is the launchable persona (`agent.md` plus what sits in its
folder). An `AgenticProcess` is one running session of a harness worker. An MCP
server is an `McpSpec` value; attaching it to a process or an agent is one
verb, and every harness renders it its own way (`--mcp-config` for claude,
`-c mcp_servers.*` for codex, `--additional-mcp-config` for copilot, the
generated config's `mcp` key for opencode).

Pinned by `tests/long_tests/test_process_mcp_multi_vendor.py`, which makes a
real worker on each of the four harnesses call a tool that exists nowhere else
on the machine.

## 1. Give one process an MCP server

```python
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
from flow_sdk.schema.data_spec.mcp_spec import McpSpec

process = AgenticProcess(worker_type=WorkerType.CLAUDE_CODE, pty_mode=False, visible=False)
await process.save()

spec = McpSpec(name="playwright", command="npx", args=["-y", "@playwright/mcp"])
assert await process.add_mcp(spec) is True
assert await process.add_mcp(spec) is False      # identical spec: a no-op

await process.prompt("Open https://example.com and tell me the page title.")
```

MCP resolves at worker boot. Headless processes re-exec each turn so the next
prompt sees the server; a claude PTY session needs the restart action
(`await process.http_restart()`), which is refused mid-turn.

```python
await process.remove_mcp("playwright")
process.resolved_mcp_servers()      # agent's servers ∪ the process's own, by name
```

## 2. Give an agent an MCP server, inherited by every process it spawns

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.schema.data_spec.mcp_spec import McpSpec

agent = await Agent.get_one({"name": "researcher"})

await agent.add_mcp(McpSpec(name="linear", transport="http", url="https://mcp.linear.app/sse"))
await agent.add_mcp(McpSpec(name="docs", command="fastmcp", args=["run", "server.py"]))

proc = await agent.launch("Find the open Linear issues assigned to me.", wait=True)
```

`add_mcp` writes an asset, not a list entry: `agentic-assets/mcp/<name>/mcp.json`
nested under the agent's folder, indexed, visible in the asset list, and
carried along when the agent is shared. The folder is the list, so an
`mcp.json` dropped there by hand and reindexed reaches the process the same way:

```python
[m.name for m in await agent.mcp_assets()]                 # ["linear", "docs"]
process = await agent.create_process("", pty_mode=False)   # not saved, not started
[s.name for s in process.resolved_mcp_servers()]           # ["linear", "docs"]
```

`add_mcp` renders the spec through the agent's harness driver first, so a
name the harness cannot express (a dotted name under codex) is refused at
author time, not at spawn.

## 3. Launch an agent and read the answer

```python
agent = await Agent.get_one({"name": "researcher"})

proc = await agent.launch("Summarize today's inbox in three bullets.", wait=True)
```

* `agent.create_process(prompt, **options)` is the primitive: the process is
  built from everything the agent declares (worker, model, permissions, system
  prompt, dirs, MCP servers). Not saved, not started.
* `agent.launch(prompt, wait=...)` is `create_process` + save + first turn,
  routed through `dispatch_agent_run` so run lifecycle events fire and a
  remotely placed agent is refused rather than silently run here.
* `agent.use()` opens a visible session as the agent with no first turn.

`prompt()` returning is not the turn finishing, and `wait()` blocks for a
terminal worker status a conversational process never reaches. Read the
outcome instead: the transcript, or the artifact the run declared.

```python
from flow_sdk.builtin.artifact import Artifact

produced = await Artifact.get_all({"generated_by": str(proc.typeid)})
```

Always release the worker; a leaked one outlives its caller and holds a slot.

```python
try:
    ...
finally:
    await proc.exit()
```

## The spec

```python
class McpSpec(DataSpec):                 # flow_sdk/schema/data_spec/mcp_spec.py
    spec_kind = "mcp.server"
    name: NonBlank
    transport: str = "stdio"             # stdio | http | sse
    command: str = ""
    args: list[str] = []
    env: dict[str, str] = {}
    url: str = ""
```

Frozen, `extra="forbid"`: a misspelled key raises. `McpSpec.from_record(row)`
projects an indexed `MCP_SERVER` row (a vendor config file the indexer found)
into the same shape, so "attach the one I already have configured in Cursor"
is one call.
