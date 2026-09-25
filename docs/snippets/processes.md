---
id: aebe1592-762b-4b1a-a217-90de8b06a2f0
---

# Processes and agents — snippets

An `Agent` is the launchable persona (`agent.json` and `system_prompt.md`, plus
what sits in its folder). An `AgenticProcess` is one running session of a harness
worker — on the harness you selected when none is named. An MCP
server is an `McpSpec` value; attaching it to a process or an agent is one
verb, and every harness renders it its own way (`--mcp-config` for claude,
`-c mcp_servers.*` for codex, `--additional-mcp-config` for copilot, the
generated config's `mcp` key for opencode).

Every section runs as written on the mock worker in `tests/unit/test_processes_snippets.py`
(its file actions read the run's input folder and write its output folder); the MCP legs are
also pinned for real by `tests/long_tests/test_process_mcp_multi_vendor.py`, which makes a
real worker on each of the four harnesses call a tool that exists nowhere else on the machine,
and §4 by `tests/long_tests/test_process_typed_io_live.py` on the selected harness.

## 1. Give one process an MCP server

```python
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.schema.data_spec.mcp_spec import McpSpec

process = AgenticProcess(pty_mode=False, visible=False)   # the selected harness
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

answer = await agent.launch("Find the open Linear issues assigned to me.", wait=True)
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
from flow_sdk.builtin.agentic_process import AgenticProcess

agent = await Agent.get_one({"name": "researcher"})

answer = await agent.launch("Summarize today's stream inbox in three bullets.", wait=True)
answer.ok, answer.text                                  # the run's verdict, and its reply
proc = await AgenticProcess.get_by_typeid(answer.executor)
```

* `agent.create_process(prompt, **options)` is the primitive: the process is
  built from everything the agent declares (worker, model, permissions, system
  prompt, dirs, MCP servers). Not saved, not started.
* `agent.launch(prompt, wait=...)` is `create_process` + save + first turn,
  routed through `dispatch_agent_run` so run lifecycle events fire. It answers a
  `PromptResult` whose `executor` names the process — with `wait`, the run's own
  verdict (an errored worker is `NOT_YET`); a remotely placed agent answers
  `NOT_APPLICABLE` rather than being silently run here.
* `agent.use()` opens a visible session as the agent with no first turn.

`prompt()` returning is not the turn finishing. `launch(..., wait=True)` and
`AgenticProcess.run` wait for the turn; beyond the reply, read the outcome the
run declared — its output folder (§4) or the artifacts it registered:

```python
from flow_sdk.builtin.artifact import Artifact

produced = await Artifact.get_all({"generated_by": str(proc.typeid)})
```

To read the ANSWER of a print-mode turn, wait until the turn is no longer busy and take the
last thing the assistant said — its `chat` element, not its reasoning. The whole script is
[llm-endpoints §7](llm-endpoints.md), pinned by `tests/long_tests/test_loginless_in_docker.py`:

```python
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy

fresh = await AgenticProcess.get_by_id(proc.id)
if not is_turn_busy(fresh, fresh.fetch_worker_status()):
    said = [
        item.flow_value
        for item in fresh.driver.load_history(fresh)
        if item.attributes.get("role") == "assistant" and item.attributes.get("element-type") == "chat"
    ]
```

Always release the worker; a leaked one outlives its caller and holds a slot.

```python
try:
    ...
finally:
    await proc.exit()
```

## 4. Typed folder in, typed folder out

By default a process works on top of its `workdir`. Declare an output and it works as a
function instead: a DataSpec in, a DataSpec out. `input` is saved into the run's input folder
(`<record>/execution/input`) and mounted for the worker; `output_spec` is the DataSpec it must
write into its output folder, and the agent is told that exact layout. After the turn the folder
is loaded back into `value` — the same `save`/`load` a DataSpec always uses.

```python
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io import Text

class CVSpec(DataSpec):
    name: str
    email: str
    skills: list[str] = []
    body: Text = ""                              # the CV itself, as markdown -> body.md

cv = CVSpec(name="Dana Levi", email="dana@x.io", body=CV_TEXT)

cv_reviewed = await AgenticProcess.run("Review and convert the input CV", input=cv, output_spec=CVSpec)

cv_reviewed.exit_code                            # ExitCode.OK
cv_reviewed.text                                 # "Your CV was reviewed" — the agent's last message
cv_reviewed.value                                # CVSpec — the reviewed CV, loaded from the output folder
cv_reviewed.files                                # ['body.md', 'cvspec.json']
```

* `output_spec` takes the class or its registered kind name (`output_spec="hr.cv"`); an unknown
  name is refused before anything starts.
* A run that writes no output, the wrong file, or a field of the wrong type answers `NOT_YET`
  with the reason in `detail` — the reply stays in `text`, the files in `files`.
* A valid output's files are registered as the run's Artifacts, and a record holding recent output
  is kept by the startup clean-up for 30 days. `cv_reviewed.value.save(path)` is the durable copy.
* `agent.launch(prompt, input=..., output_spec=..., wait=True)` is the same contract for an Agent;
  without `output_spec` the agent's declared `output` applies.

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
    entrypoint: str = ""                 # bundled server: path relative to the asset folder
```

Frozen, `extra="forbid"`: a misspelled key raises. `McpSpec.from_record(row)`
projects an indexed `MCP_SERVER` row (a vendor config file the indexer found)
into the same shape, so "attach the one I already have configured in Cursor"
is one call.
