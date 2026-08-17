---
id: "10c7d57b-09db-5a20-9ffd-b5475f2edff4"
---

# System Agents

> **Note (current shape):** this page describes an older `AgentRecord`/`AgentExecution`
> design. The current shape is Agent → Deployment → AgenticProcess (see
> `flow_sdk/builtin/agent.py`), and the "system agents" described here are **SubAgent**
> personas (`.claude/agents/*.md`), not launchable `Agent` entities.

System agents are pre-built Claude Code sub-agents bundled with the SDK. They execute specialized tasks (session analysis, skill creation, error fixing) through an isolated project environment and produce typed artifacts.

## Architecture

### Overview

```
AgentRecord.load_system_agent("session-analyzer")
        |
        v
  AgentRecord                     # Agent definition (prompt + config)
        |
        |  agent.run(env, instruction)
        v
  AgentExecution                  # Lifecycle: task, process, relationships
        |
        |  await execution.wait_for_completion()
        v
  ClaudeCLIWorker                 # Subprocess: claude -p ... --agents ...
        |
        v
  execution.artifacts             # Scans output_dir for SkillRecords, files
```

### Components

#### AgentRecord

Stores the agent definition: system prompt, model, permissions, and tool configuration.

**File:** `flow_sdk/fs_records/agent_record.py`

Each agent is a directory with a markdown file containing YAML frontmatter:

```
flow_sdk/system_assets/agents/session-analyzer/
    session-analyzer.md           # YAML frontmatter + system prompt
    .flow_record/record.json      # Optional metadata (auto-bootstraps from .md)
```

The markdown file defines everything:

```markdown
---
description: What this agent does (shown in agent listings)
model: sonnet
permission_mode: bypassPermissions
max_turns: 30
---

# Agent Name

System prompt body goes here...
```

**Frontmatter fields** (all optional except `description`):

| Field              | Type | Default             | Maps to CLI                          |
| ------------------ | ---- | ------------------- | ------------------------------------ |
| `description`      | str  | —                   | `--agents` JSON                      |
| `model`            | str  | —                   | `--model`                            |
| `permission_mode`  | str  | `bypassPermissions` | `--dangerously-skip-permissions`     |
| `max_turns`        | int  | —                   | `maxTurns` in `--agents` JSON        |
| `tools`            | list | —                   | `tools` in `--agents` JSON           |
| `disallowed_tools` | list | —                   | `disallowedTools` in `--agents` JSON |
| `skills`           | list | —                   | `skills` in `--agents` JSON          |
| `mcp_servers`      | dict | —                   | `mcpServers` in `--agents` JSON      |
| `hooks`            | dict | —                   | `hooks` in `--agents` JSON           |
| `memory`           | dict | —                   | `memory` in `--agents` JSON          |

**Loading priority** (`load_subagent(name, project_dir)` — `flow_sdk/fs_store/operations/subagent.py`):

1. **Project agents:** `{project_dir}/.claude/agents/{name}/`
2. **User agents:** `~/.claude/agents/{name}/`
3. **System agents:** `flow_sdk/system_assets/agents/{name}/`

**Key methods:**

```python
# Load from system assets
agent = AgentRecord.load_system_agent("session-analyzer")

# Load with priority resolution (project > user > system)
agent = load_subagent("session-analyzer", project_dir="/my/project")

# Load from a standalone .md file
agent = AgentRecord.from_file("/path/to/my-agent.md")

# Load from a markdown string
agent = AgentRecord.from_markdown(text, name="my-agent")

# Serialize for Claude CLI --agents flag
agents_json = agent.to_agents_cli_json()
# → {"session-analyzer": {"description": "...", "prompt": "...", "model": "sonnet"}}
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

env.load_subagent(agent)                 # Copy subagent .md into .claude/agents/
env.set_system_prompt("You are...")      # Write CLAUDE.md
env.append_system_prompt("\n## Extra")   # Append to CLAUDE.md
env.set_mcp_config({"servers": {...}})   # Write mcp.json
env.env_set("KEY", "value")             # Set env var for subprocess
env.build_env()                          # Build sanitized env dict
env.cleanup()                            # Remove the root directory
```

`build_env()` strips all `CLAUDECODE*` variables from the environment, sets `CLAUDE_PROJECT_DIR`, and overlays any custom env vars.

#### AgentExecution

Manages the full execution lifecycle: creates tracking records, runs the agent, and collects artifacts.

**File:** `flow_sdk/fs_records/agent_execution.py`

Created by `agent.run()`:

```python
agent = AgentRecord.load_system_agent("session-analyzer")
env = ClaudeProjectEnvManager(root=workdir)

execution = agent.run(env, "Analyze session abc-123")
```

`agent.run(env, instruction)` does three things:

1. Appends the output directory path to `CLAUDE.md`
2. Copies the agent `.md` into the env's `.claude/agents/`
3. Calls `execution.prepare()` which creates `TaskResource`, `AgenticProcess`, and `RelationshipRecord`

Then execute:

```python
await execution.wait_for_completion()   # Runs ClaudeCLIWorker subprocess
```

And collect results:

```python
execution.output_dir    # Path where agent wrote its output
execution.artifacts     # List of SkillRecords found in output_dir
execution.process       # The AgenticProcess record (tracks state)
execution.task          # The TaskResource record
```

**Artifact scanning:** `execution.artifacts` iterates over `output_dir` and loads any subdirectory containing `SKILL.md` as a `SkillRecord`.

**Lifecycle methods:**

```python
execution.mark_complete()        # Task → DONE, Process → COMPLETE
execution.mark_error("reason")   # Process → ERROR
execution.sync_to_flowpad()      # Notify FlowPad of record changes
execution.install_output_skills(output_dir, scope="project", project_dir=dir)
```

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

There is also `ClaudeCodeAgenticWorker` (`flow_sdk/builtin/agentic_process/cli_drivers/claude/code_agentic_worker.py`) which uses the `claude_agent_sdk` Python package directly instead of subprocess. It supports multi-turn sessions, pause/resume, and streaming input injection. It requires `claude_agent_sdk` as an optional dependency.

### Artifacts

After execution, agents write output to `execution.output_dir`. Currently the `artifacts` property recognizes:

* **SkillRecords** — subdirectories containing `SKILL.md` with YAML frontmatter

```
output/
    greeting-skill/
        SKILL.md          # ← detected as SkillRecord artifact
        greeting.py
    analysis.md           # ← plain file (not currently collected by artifacts)
```

Skills can be installed after collection:

```python
execution.install_output_skills(
    execution.output_dir,
    scope="project",           # "project" or "user"
    project_dir="/my/project"
)
# Copies skill dirs to <project>/.claude/skills/ or ~/.claude/skills/
```

***

## Existing System Agents

### session-analyzer

**Location:** `flow_sdk/system_assets/agents/session-analyzer/`

**Purpose:** Reviews agentic session transcripts for quality improvement.

**Configuration:**

* Model: `sonnet`

* Permission mode: `bypassPermissions`

* Max turns: 30

**What it does:**

1. Identifies automation opportunities (repeatable tasks that could be scripted)
2. Finds preventable errors (mistakes and how to prevent recurrence)
3. Flags behavior corrections (inefficiencies and suggested guardrails)

**Output:** Writes `analysis.md` — a structured markdown report with Summary, Automation Opportunities, Preventable Errors, and Behavior Corrections sections.

***

## Adding a New System Agent

### Step 1: Create the agent directory

```bash
mkdir -p flow_sdk/system_assets/agents/my-agent
```

### Step 2: Write the markdown file

Create `flow_sdk/system_assets/agents/my-agent/my-agent.md`:

```markdown
---
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

Describe the expected output format and where to write it.
Write results to the output directory specified in CLAUDE.md.
```

The filename must match the directory name (e.g., `my-agent/my-agent.md`).

### Step 3 (optional): Add record.json

Create `flow_sdk/system_assets/agents/my-agent/.flow_record/record.json`:

```json
{
  "id": "my-agent",
  "name": "my-agent",
  "status": "active",
  "description": "One-line description of what this agent does.",
  "model": "sonnet",
  "permission_mode": "bypassPermissions",
  "max_turns": 20
}
```

This is optional. If omitted, `AgentRecord` auto-bootstraps all fields from the `.md` frontmatter.

### Step 4: Test the agent loads

Add to `tests/unit/test_agent_record.py`:

```python
def test_load_my_agent_from_package(self):
    agent = load_system_subagent("my-agent")
    assert agent is not None
    assert agent.name == "my-agent"
    assert agent.data.get("model") == "sonnet"
    assert "My Agent" in agent.prompt
```

### Step 5: Test the full execution pipeline

Add to `tests/unit/test_agent_run.py`:

```python
@pytest.mark.asyncio
async def test_my_agent_run(tmp_path):
    agent = load_system_subagent("my-agent")
    env = ClaudeProjectEnvManager(root=tmp_path / "project")

    execution = agent.run(env, "Do the task")

    # Verify setup
    assert (env.agents_dir / "my-agent.md").exists()
    assert str(env.output_dir) in env.claude_md_path.read_text()

    # Simulate agent output (in production, wait_for_completion does this)
    (execution.output_dir / "result.md").write_text("# Result\n\nDone.")

    # If your agent produces skills:
    skill_dir = execution.output_dir / "my-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: my-skill\ndescription: Created by my-agent\n---\n\nSkill body."
    )
    artifacts = execution.artifacts
    skill_records = [a for a in artifacts if a.type == RecordType.SKILL]
    assert len(skill_records) == 1
```

### Step 6: Use the agent from application code

```python
from flow_sdk.fs_records import AgentRecord
from flow_sdk.claude_env import ClaudeProjectEnvManager

agent = load_system_subagent("my-agent")
env = ClaudeProjectEnvManager(root=workdir)

execution = agent.run(env, "Fix this error: ...")
await execution.wait_for_completion()

# Check artifacts
for artifact in execution.artifacts:
    print(f"Found: {artifact.name} (type={artifact.type})")

# Or install skills
execution.install_output_skills(execution.output_dir, scope="user")

# Cleanup
env.cleanup()
```

### Checklist

* [ ] Agent `.md` file with YAML frontmatter in `flow_sdk/system_assets/agents/<name>/`

* [ ] Filename matches directory name

* [ ] `description` field in frontmatter (required for agent listings)

* [ ] Unit test: agent loads via `load_system_agent()`

* [ ] Pipeline test: `agent.run()` sets up env correctly

* [ ] Output section in prompt tells agent where to write results

