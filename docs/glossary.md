# Glossary — our nouns vs. the ecosystem's

Written once so it isn't re-litigated. The axis that matters here is **who owns the
concept**: some of our entities *mirror a provider's* on-disk format, and some are ours.
Names should make that obvious.

## Cross-walk

| Flowpad | Claude Code | OpenClaw |
|---|---|---|
| `Agent` (a `.md` prompt asset) | agent / subagent | — |
| `AgentOptions` | options | — |
| `Agent` + `AgentOptions` together | — | **`agent`** |
| `AgenticProcess` (one run) | session | session |
| `ClaudeSession` / `CodexSession` / `CopilotSession` | transcript | — |
| `Skill` (`SKILL.md`) | skill | skill |
| `MCPServer` + `Command` | **tool** | **tool** |
| `DynamicWorkflow` + `WorkflowRun` | workflow (script) | — |
| `GraphWorkflow` + `GraphWorkflowRun` | — | — (ours) |
| backend instance | — | gateway |

## The three rows that are not clean matches

**OpenClaw's `agent` is not our `Agent`.** Theirs is a persistent tenant —
`agents.entries.*` with `id`, `workspace`, `model`, `identity`, skill visibility, its own
auth profile and session store, with channel bindings routing to it; many live in one
Gateway process, and it has no subagent concept. Ours is a prompt asset. The real
equivalent is our **`Agent` + `AgentOptions` pair**: `workspace`↔`workdir`,
`model`↔`model`, `skills`↔`skill_names`/`agents_json`, session store↔`session_id`, auth
profile↔`env_vars` + `cli_drivers/api_auth.py`.

We keep our spelling because `.claude/agents/` is a **provider-owned path** — Claude Code
reads it directly, so renaming the class would only make the entity and its directory
disagree. And the mismatch is structural rather than lexical: OpenClaw fuses definition and
launch config into one persistent noun; we split them and bind them only at spawn.

**We have no `Tool` noun.** `EntityType` has no `TOOL` member — the concept is split across
`MCP_SERVER` and `COMMAND`. Both Claude Code and OpenClaw make `tool` first-class.

**We have nine `*SESSION` types** where the ecosystem has one: `claude_session`,
`codex_session`, `copilot_session`, `skillit_session`, `remote_worker_session`,
`active_session`, `active_sessions`, `session_analysis`, `session_classification`. Ours are
provider *transcripts*; the thing that actually runs is `AgenticProcess`.

## Provider mirrors vs. ours

Keep these apart when naming anything new:

| Mirrors a provider | Ours |
|---|---|
| `DynamicWorkflow` (`.claude/workflows/*.js`) | `GraphWorkflow` (`agentic-assets/graph_workflow/`) |
| `WorkflowRun` (`wf_<runId>.json`, read-only) | `GraphWorkflowRun` |
| `ClaudeSession` / `CodexSession` / `CopilotSession` | `AgenticProcess` |
| `Agent` (`.claude/agents/`), `Skill`, `Command`, `ClaudeMd` | `Project`, `Task`, `Spec`, `Journey`, `Deck` |

A provider mirror is read-only-ish and its format is not ours to change. A native asset is
a `AssetClass.REPO` folder under `agentic-assets/<family>/`.

## Naming rules this implies

- **`GraphWorkflow` always carries the full prefix.** Bare `Graph*` collides with
  `GRAPH_CONTEXT`, `ui/src/components/graph-view/`, the entity graph, and the hub org
  graph. Bare `Workflow*` collides with the two Claude Code mirrors.
- **`Flow` is still ambiguous** and should not be used for anything new. It survives in
  `FlowMessage` (a chat message), `FlowEvent` (the bus envelope), `FlowFile`,
  `flow_sdk/core/flow/`, and `ui/src/pages/flow-page/` — all unrelated to workflows.
  Renaming `AgenticFlow` removed most of the *workflow* sense, but one spelling is
  deliberately kept: the `flow_id` field on `GraphWorkflowRun` and `GraphWorkflowNode`, which
  is a stored JSON key (renaming it needs a migration — see Phase 2).
- **`tag` means three unrelated things — say which.** A bus event name
  (`FlowEvent.tag`), a taxonomy `Tag` entity + its `tag` capsule carrier, and
  toplog's runtime *trace* tags (`toplog.log([...])` against
  `.claude/skills/toplog/tags.md`). A **breadcrumb** is the second sense: a `tag`
  capsule on a failing test pointing at its rules doc (`breadcrumb.test.*`),
  written by the `tagit` skill and read by `tag-context`. It is not a trace tag
  and never belongs in the toplog catalog.
- **`harness` and `worker` are two names for one axis.** `HarnessType`
  (`fs_store/placement.py`) picks the dot-directory; `WorkerType` is the runtime driver.
  They're deliberately distinct and bridged by `_WORKER_NAME_TO_TYPE`, but the industry word
  for both is *provider*.

## Known gap: no profile

We have no persistent, named binding of *"this prompt + this model + these skills + these
dirs."* That pairing exists only for the lifetime of a run, inside an `AgenticProcess`.
OpenClaw's `agent`, OpenAI's Assistant, and Claude Code's `.claude/agents/*.md` frontmatter
(`model:`, `tools:`) all have it. The ecosystem calls it a **profile**.

Not built — it's a feature, and should be decided on its own merits rather than smuggled in
with a rename.

<!-- flowpad:capsule identity
version: 1
data:
  id: ab1f9726-eb39-41cb-86f0-6d57214c24ff
flowpad:endcapsule identity -->
