---
id: 96c0ed52-60d5-451f-a9c0-efcca574ae53
---
# `agent.json` — the agent's definition

An agent is a folder: `<scope>/agentic-assets/agent/<name>/` holding `agent.json`,
`system_prompt.md` (the prompt body) and optionally an avatar image. The folder name
IS the agent's name — there is no `name` key to keep in sync. `<scope>` is the
project folder for a project's agent, or the user's home for one that follows them
everywhere.

Every key is optional; write only the ones the agent needs. Leave out `id`, `type` and
`name`: indexing mints the id into the file (one minter, so ids stay valid), and the
folder is the name. The schema is
`AgentSpec` in `flow_sdk/schema/data_spec/agent_spec.py` — read it when a field
below is not enough.

## Fields

"Enforced" means the launch actually applies it. A **declared** field is saved and
shown on the agent's card but reaches nothing, so never rely on it for a boundary —
put the boundary in the prompt (and `permission_mode`) instead.

| Field | What it does | Enforced | Kind |
| --- | --- | --- | --- |
| `title` | Display name on the card and in chat | yes | all |
| `description` | One line on the card: what the agent is for | yes | all |
| `avatar` | An emoji or an image file name in the folder | yes | all |
| `color` | Avatar background, a hex from the palette | yes | all |
| `worker_type` | `claude`, `codex` or `copilot` — set it here; in the app it is changed per deployment (`references/screens.md` → *Change its worker*) | yes | all |
| `model` | `sm` / `md` / `lg`, or a concrete model id | yes | all |
| `permission_mode` | Leave it out. A chat worker runs headless: anything but the default (`bypassPermissions`) denies every tool call, `flow show` included, because nobody can approve it | yes | all |
| `effort` | Reasoning effort for the worker | yes | all |
| `enabled` | `false` refuses every launch — a kill switch | yes | all |
| `mcp_servers` | MCP servers to attach, copied into the agent's folder at launch | yes | all |
| `additional_dirs` | Extra folders the worker may read (`--add-dir`) | yes | all |
| `load_flowpad_assistant` | Give the worker the Flowpad Assistant's skills | yes | all |
| `cli_options` | Vendor CLI keys passed through as-is | yes | all |
| `intro` | Welcome text shown at the top of the chat — **the model never sees it** | yes | chat |
| `auto_launch` | Start this agent when its project is opened (once per project, per machine) | yes | chat |
| `auto_launch_prompt` | The **auto prompt**: the first user message of every new chat with the agent (tile, home page, auto-launch), sent on the user's behalf. Independent of `auto_launch`. SDK callers opt in with `use(auto_prompt=True)` and start it with `submit()` before their own prompt | yes | chat |
| `chief_of_staff` | The agent delegates long work to `subagents` through the task ledger | yes | chat |
| `subagents` | Names of the SubAgents a chief of staff may hand work to | yes | chat |
| `input` | The shape the caller must pass in (a shape form, below) | yes | typed |
| `output` | The shape the agent must write back (a shape form, below) | yes | typed |
| `places` | Per-deployment overrides (below) | yes | deployed |
| `email_place` | The one deployment id that answers the agent's email | yes | deployed |
| `phone` | The agent's own phone number, for its WhatsApp channel | declared | deployed |
| `requirements` | Credentials, permissions and variables it needs — names only, never values | yes | deployed |
| `machine_size` | `sm` / `md` / `lg` — sizes a hub cloud machine; a local launch ignores it | yes | deployed |
| `max_turns` | Turn cap | declared | — |
| `tools` | Allowed tools | declared | — |
| `disallowed_tools` | Forbidden tools | declared | — |
| `skills` | Skills to load | declared | — |

## Minimal definition

```json
{
  "title": "Study buddy",
  "description": "Guides a student through the exercise with hints, never answers.",
  "avatar": "🧑‍🏫",
  "worker_type": "claude",
  "model": "md",
  "intro": "Hi, I'm your study buddy. Ask me anything about the exercise.",
  "auto_launch": true,
  "auto_launch_prompt": "Hi, I'm starting the exercise. Open it for me please."
}
```

## Shape forms (`input` / `output`)

A shape is written in one of three forms: a primitive name (`"string"`, `"int"`,
`"float"`, `"bool"` or a registered kind), an object `{field: shape}`, or a list
`[shape]`. There is no map form.

```json
{
  "input":  { "city": "string", "days": "int" },
  "output": { "summary": "string", "temperatures": ["float"] }
}
```

## Places

A place is one deployment the agent is placed on. An entry overrides launch settings
for that deployment only; anything it leaves out is inherited from the definition.
Only `worker_type`, `model`, `permission_mode`, `effort` and `mcp_servers` can be
overridden, plus `enabled` to switch the agent off on that place.

```json
{
  "places": [
    { "deployment_id": "0b6f0c3e-5a1d-4a8e-9a55-2f1f5d7c9e11", "model": "lg" },
    { "deployment_id": "7d3a9e42-1c6b-4f0e-8d27-6b9c0a4e5f33", "enabled": false }
  ]
}
```

Deployment ids come from the app, not from you: the user creates the deployment in
the agent editor (`references/screens.md`), and the editor writes the place.
