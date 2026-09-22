---
id: "10c7d57b-09db-5a20-9ffd-b5475f2edff4"
---

# System Agents

> **Naming:** the "system agents" on this page are **SubAgent** assets — Claude Code's
> `.claude/agents/<name>.md` prompt files (entity type `subagent`). They are not the
> launchable `Agent` entity (`flow_sdk/builtin/agent.py`, Agent → Deployment →
> AgenticProcess); an Agent may *reference* SubAgents.

System agents are pre-built Claude Code sub-agents shipped inside the package. A SubAgent is a
file, not a runner: it is loaded as an `FSRecord`, serialized into Claude's `--agents` JSON, and
embedded into an `AgenticProcess`, whose worker passes it to the CLI.

## Architecture

### Overview

```
load_system_subagent("task-analyze") / load_subagent(name, project_dir)
        |
        v
  FSRecord(type="subagent")       # frontmatter (SubAgentSpec) + prompt body
        |
        |  process.load_embedded_subagent(name_or_record)
        v
  AgenticProcess                  # embedded_subagent_ids; get_agents_json()
        |
        |  driver build: cmd.agents_json = process.get_agents_json()
        v
  claude CLI                      # claude ... --agents '{"task-analyze": {...}}'
```

### Components

#### SubAgent

Stores the sub-agent definition: system prompt, model, permissions, and tool configuration.

**Files:** `flow_sdk/assets/types/subagent.py` (parse + `--agents` serialization),
`flow_sdk/assets/types/subagent_spec.py` (`SubAgentSpec`, the frontmatter field list),
`flow_sdk/builtin/subagent_loading.py` (the loader priority chain),
`flow_sdk/builtin/subagent.py` (the `SubAgent` entity / HTTP surface).

Each sub-agent is one markdown file with YAML frontmatter (a folder is also accepted; its first
`*.md` is used). The shipped ones live in the Flowpad Assistant system project:

```
flow_sdk/system_projects/flowpad_assistant/.claude/agents/
    task-analyze.md               # YAML frontmatter + system prompt
    vibe.md
    ...
```

The markdown file defines everything:

```markdown
---
name: agent-name
description: What this agent does (shown in agent listings)
model: sonnet
permission_mode: bypassPermissions
max_turns: 30
---

# Agent Name

System prompt body goes here...
```

**Frontmatter fields** (`SubAgentSpec`; all optional). Every key except `name` and `kind` is
copied into the sub-agent's `--agents` JSON entry, under its camelCase name where Claude's
schema uses one (`KEY_TO_JSON`); the body becomes `prompt`:

| Field              | Type | In `--agents` JSON |
| ------------------ | ---- | ------------------ |
| `name`             | str  | the entry's key (falls back to the record id) |
| `description`      | str  | `description`      |
| `model`            | str  | `model`            |
| `permission_mode`  | str  | `permissionMode`   |
| `max_turns`        | int  | `maxTurns`         |
| `tools`            | list | `tools`            |
| `disallowed_tools` | list | `disallowedTools`  |
| `skills`           | list | `skills`           |
| `mcp_servers`      | dict | `mcpServers`       |
| `hooks`            | dict | `hooks`            |
| `memory`           | dict | `memory`           |
| `color`, `background`, `isolation` | — | same name |
| `kind`             | str  | not emitted — Flowpad routing (`harness` / `vibe`) |

The CLI-level permission flag (`--dangerously-skip-permissions`) comes from the process's
`AgenticContext.permission_mode`, not from a sub-agent's frontmatter.

**Loading priority** (`load_subagent(name, project_dir)` — `flow_sdk/builtin/subagent_loading.py`).
Each root is probed for `<name>/` (first `*.md`) then `<name>.md`:

1. **Project agents:** `{project_dir}/.claude/agents/`
2. **User agents:** `get_instance_settings().claude_agents_dir` (`~/.claude/agents/`)
3. **System agents** (`load_system_subagent`): `flow_sdk/system_projects/flowpad_assistant/.claude/agents/`,
   then `~/Flowpad workspace/.flow/system_assets/agents/`

**Key functions:**

```python
from flow_sdk.schema.type_info import register_all
from flow_sdk.builtin.subagent_loading import load_system_subagent, load_subagent
from flow_sdk.assets.types.subagent import (
    extract_subagent_from_path,
    render_subagent_markdown,
    subagent_to_cli_json,
)

register_all()  # the server does this at startup; a bare script must (unregistered → loaders return None)

# Load from the shipped system agents
agent = load_system_subagent("task-analyze")

# Load with priority resolution (project > user > system)
agent = load_subagent("task-analyze", project_dir="/my/project")

# Load from a standalone .md file
agent = extract_subagent_from_path(agent.asset_ref.path)

# The record: an FSRecord; frontmatter + body live on .data
agent.name, agent.data["description"], agent.data["prompt"]

# Serialize for Claude CLI --agents flag
agents_json = subagent_to_cli_json(agent)
# → {"task-analyze": {"prompt": "...", "description": "...", "tools": "Bash, Read, Glob, Grep"}}

# Render back to markdown (frontmatter + body)
text = render_subagent_markdown(agent)
```

#### ClaudeProjectEnvManager

Creates an isolated project folder for agent execution.

**File:** `flow_sdk/claude_env.py`

```
<root>/
    CLAUDE.md                     # System prompt (context injected here)
    .claude/agents/<name>.md      # Agent definitions copied here
    .claude/settings.json         # Project settings
    output/                       # Where agents write their results
```

**Key properties and methods:**

```python
env = ClaudeProjectEnvManager(root=tmp_path / "project")

env.path                # Root directory
env.output_dir          # <root>/output/
env.agents_dir          # <root>/.claude/agents/
env.claude_md_path      # <root>/CLAUDE.md

from pathlib import Path
from flow_sdk.assets import Asset
from flow_sdk.assets.directory import AssetDir

Asset.from_path(agent.asset_ref).install(Path(project_dir) / ".claude/agents/agent.md")
AssetDir(project_dir).load_asset("CLAUDE.md", content="You are...")
env.env_set("KEY", "value")             # Set env var for subprocess
env.build_env()                          # Build sanitized env dict
env.cleanup()                            # Remove the root directory
```

`build_env()` strips all `CLAUDECODE*` variables from the environment, sets `CLAUDE_PROJECT_DIR`, and overlays any custom env vars.

#### Embedding a SubAgent into an AgenticProcess

There is no per-agent execution object. A sub-agent reaches a run by being embedded into an
`AgenticProcess` (`flow_sdk/builtin/agentic_process/process_assets.py`,
`load_embedded_subagent` / `get_agents_json`). A name string is resolved through
`load_subagent` (user > system); a record is taken as-is. The process records the name in
`embedded_subagent_ids`, and at launch the worker driver sets
`cmd.agents_json = process.get_agents_json()` (e.g. `cli_drivers/claude/driver.py:156`), which
becomes the CLI's `--agents` flag.

```python
from flow_sdk.schema.type_info import register_all
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

register_all()

proc = AgenticProcess(workdir="/tmp")          # unsaved, never started
proc.load_embedded_subagent("task-analyze")
proc.embedded_subagent_ids                     # → ["task-analyze"]
agents_json = proc.get_agents_json()           # → {"task-analyze": {"prompt": ..., ...}}
```

Process lifecycle (status, turns, completion) is the `AgenticProcess`'s own — see
`docs/agentic-process.md` rather than anything sub-agent specific.

#### ClaudeCLIWorker

Subprocess-based worker that implements the `AgenticWorker` interface.

**File:** `flow_sdk/builtin/agentic_process/cli_drivers/claude/cli_worker.py`

Has two pure, unit-testable static methods:

```python
# Build the CLI argument list
args = ClaudeCLIWorker.build_args(
    claude_bin="/usr/bin/claude",
    prompt="Do stuff",
    session_id="sess-1",
    context=AgenticContext(workdir="/tmp", model="sonnet"),
    agents_json={"my-agent": {"description": "...", "prompt": "..."}}
)
# → ["/usr/bin/claude", "--dangerously-skip-permissions", "--session-id", "sess-1",
#    "--model", "sonnet", "--agents", '{"my-agent": {...}}', "-p", "Do stuff"]

# Build sanitized environment
env = ClaudeCLIWorker.build_env(context)
```

The `execute()` method launches `claude` via `asyncio.create_subprocess_exec` and yields `FlowData` chunks:

* `STATUS` — session started

* `CHAT` — stdout output (complete response)

* `ERROR` — if subprocess fails or claude binary not found

There is also `ClaudeCodeAgenticWorker` (`flow_sdk/builtin/agentic_process/cli_drivers/claude/code_agentic_worker.py`), written against the `claude_agent_sdk` Python package. **It is not wired:** no driver instantiates it, and `claude_agent_sdk` is not a declared dependency (its wheel bundles a ~215 MB CLI binary, which is why it was not adopted). The worker that needs no vendor CLI is the hidden `deepagents` vendor (`cli_drivers/deepagents/`) — see `worker_spec/AgenticWorkerSpec.md` §0.

### Results

There is no artifact collector. A caller that needs a sub-agent's output reads the finished
process. The shipped example is the asset-cleanup scan, which launches through the named
`asset-cleanup` Agent's local deployment, uses the `asset_cleanup` SubAgent's body as its task
instructions, and reads the reply off the process (excerpts of `flow_sdk/asset_cleanup/run.py:124-125`
and `:186-192`):

```python
    deployment = await get_agent_local_deployment("asset-cleanup")
    task = load_subagent("asset_cleanup")
```

```python
    proc = await deployment.launch(
        instruction,
        wait=True,
        name="Asset cleanup scan",
        workdir=workdir or root_strs[0],
    )
    result = _build_run_result(proc)
```

***

## Existing System Agents

The shipped sub-agents are the `.md` files in the system project's agents dir:

```bash
ls flow_sdk/system_projects/flowpad_assistant/.claude/agents/
```

Their frontmatter `description` states each one's purpose (e.g. `task-analyze.md`: analyzes a
task's status and progress and fills in missing fields).

***

## Adding a New System Agent

### Step 1: Pick the location

Shipped sub-agents are single files in `flow_sdk/system_projects/flowpad_assistant/.claude/agents/`
(no per-agent directory needed).

### Step 2: Write the markdown file

Create `flow_sdk/system_projects/flowpad_assistant/.claude/agents/my-agent.md`:

```markdown
---
name: my-agent
description: One-line description of what this agent does.
model: sonnet
permission_mode: bypassPermissions
max_turns: 20
---

# My Agent

System prompt body. Describe:
- What the agent is specialized at
- What input it expects
- What it should produce

## Output

Describe the expected output format.
```

The file stem is the lookup name (`load_system_subagent("my-agent")` probes `my-agent/` then
`my-agent.md`); keep `name:` equal to it, since `name` is the `--agents` key. Identity is the
frontmatter `id:` (UUID) — the shipped files carry it as the first key, as in `task-analyze.md`.

### Step 3: Test the agent loads

Add to `tests/unit/test_subagent_loaders.py`:

```python
from flow_sdk.builtin.subagent_loading import load_system_subagent


def test_load_my_agent_from_package():
    agent = load_system_subagent("my-agent")
    assert agent is not None
    assert agent.name == "my-agent"
    assert agent.data.get("model") == "sonnet"
    assert "My Agent" in agent.data["prompt"]
```

### Step 4: Test it reaches the CLI

Embed it into an unsaved process and build the CLI args — no worker is spawned:

```python
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli_worker import ClaudeCLIWorker
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext


def test_my_agent_reaches_agents_flag():
    proc = AgenticProcess(workdir="/tmp")
    proc.load_embedded_subagent("my-agent")
    assert proc.embedded_subagent_ids == ["my-agent"]

    agents_json = proc.get_agents_json()
    assert agents_json["my-agent"]["model"] == "sonnet"
    assert agents_json["my-agent"]["maxTurns"] == 20

    args = ClaudeCLIWorker.build_args(
        claude_bin="claude",
        prompt="Do the task",
        session_id="sess-1",
        context=AgenticContext(workdir="/tmp"),
        agents_json=agents_json,
    )
    assert args[args.index("--agents") + 1].startswith('{"my-agent"')
```

### Step 5: Use the agent from application code

Embed it into the process you launch (`proc.load_embedded_subagent("my-agent")` before the first
turn), or — as the asset-cleanup scan does — load it with `load_subagent("my-agent")` and use
`agent.data["prompt"]` as the instruction for a named Agent's deployment (see **Results** above).

### Checklist

* [ ] `my-agent.md` with YAML frontmatter in `flow_sdk/system_projects/flowpad_assistant/.claude/agents/`

* [ ] `name:` matches the file stem

* [ ] `description` field in frontmatter (shown in agent listings)

* [ ] Unit test: agent loads via `load_system_subagent()`

* [ ] Unit test: `load_embedded_subagent()` puts it into `--agents`

