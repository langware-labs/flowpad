---
id: ab1f9726-eb39-41cb-86f0-6d57214c24ff
---

# Glossary — our nouns vs. the ecosystem's

Written once so it isn't re-litigated. The axis that matters here is **who owns the
concept**: some of our entities *mirror a provider's* on-disk format, and some are ours.
Names should make that obvious.

## Cross-walk

| Flowpad | Claude Code | OpenClaw |
|---|---|---|
| `SubAgent` (a `.md` prompt asset) | **subagent** | — |
| `AgentOptions` | options | — |
| `SubAgent` + `AgentOptions` together | — | **`agent`** |
| `Agent` (launchable identity + bundle) | — | closest analogue: `agent` |
| `AgenticProcess` (one run) | session | session |
| `ClaudeSession` / `CodexSession` / `CopilotSession` | transcript | — |
| `Skill` (`SKILL.md`) | skill | skill |
| `MCPServer` + `Command` | **tool** | **tool** |
| `DynamicWorkflow` + `WorkflowRun` | workflow (script) | — |
| `GraphWorkflow` + `GraphWorkflowRun` | — | — (ours) |
| backend instance | — | gateway |

## The three rows that are not clean matches

**OpenClaw's `agent` is not our `SubAgent`.** Theirs is a persistent tenant —
`agents.entries.*` with `id`, workspace, model, identity, skill visibility, its own auth
profile and session store, with channel bindings routing to it; many live in one Gateway
process, and it has no subagent concept. Our `SubAgent` is only a provider-owned prompt
asset. The closest Flowpad analogue is `Agent`: a native, launchable identity plus bundle
stored at `agentic-assets/agent/<name>/agent.md`. A `Deployment` (kind `runtime.agent`) places it, and
each launch becomes an `AgenticProcess`. Unlike OpenClaw's tenant, Flowpad keeps deployment
placement and each run as separate entities.

That is why the provider prompt entity is spelled `SubAgent`: Claude Code calls these
subagents, and our entity is a thin wrapper over its `.claude/agents/*.md` contract.
`Agent` names Flowpad's launchable principal instead; it may reference SubAgents without
absorbing their provider-owned format.

**The verbs, pinned.** **load/embed a SubAgent** = write its persona into
`cli_config.agents_json` (Claude Code `--agents`) — prompt text only; **use/run an Agent** =
`Deployment.build/launch` — the whole launch bundle (worker, model, permissions, system
prompt via `context_data.instructions`, dirs, `deployment_id`). "Load an agent" means the
Agent entity; the persona embed is always "sub-agent".

**The type renamed; the directory did not.** `.claude/agents/` is a **provider-owned path**
— Claude Code reads it directly — so `family` stays `"agents"` and the frontmatter spec
(`AGENTS_SPEC_FIELDS`) still mirrors its `--agents` JSON verbatim. Entity `subagent`,
directory `agents`: that disagreement is deliberate, and the code says so at both ends.

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
| `SubAgent` (`.claude/agents/`), `Skill`, `Command`, `ClaudeMd` | `Agent` (`agentic-assets/agent/`), `Project`, `Task`, `Spec`, `Journey`, `Deck` |

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
- **`DataSource` is the ingestion entity, not the trace enum.** `DataSource`
  (`flow_sdk/builtin/data_source.py`) is a configured remote system of record we sync from —
  a feed, later a mailbox. It is unrelated to `FlowDataSource`, the History/Stream/Sniffer
  enum in `docs/trace-gutter.md`, and to `Connector`
  (`flow_sdk/core/capabilities/connectors.py`), which is an intent→install-prompt catalog
  entry, not a configured feed. The record a DataSource produces is a `SourceItem`, generic
  and discriminated by `kind` (`content.feed.item`), deliberately not one entity type per
  provider. Provider-specific knowledge lives only in `flow_sdk/ingest/drivers/`.

## Agent capability fields

`Agent` is the persistent, named binding of identity, system prompt, worker/model choices,
and launch configuration. A `Deployment` (kind `runtime.agent`) places it; `AgenticProcess` records one run.
Some capability fields are currently declaration-only: `max_turns`, tool allow/deny lists,
skills, MCP servers, and SubAgent references round-trip through `agent.md` but are not yet
projected into the worker. They must not be presented as enforced controls until that
projection exists.


* **`SourceItemSpec`** — ours. The ingestion envelope a data-source driver emits and the `asset_spec` of `SourceItem` (the row): the fields the DB medium persists. Not an entity; a `DataSpec`.
* **`sent_at` / event time** — ours. A message's EVENT time (when the human sent it on its channel) as opposed to the PROCESSING clocks (`created_date`/`updated_date` — when our row was written). Projection-owned on `FlowMessage`; read everywhere through the one rule `event_time = sent_at or updated_date or created_date`; never render a message's processing clocks directly. See `docs/data-management/inbox-projection.md`.
* **`MessageSpec`** — ours. The channel-generic OUTBOUND message value (`flow_sdk/builtin/source_item.py`): what a script hands `blocks.Inbox.send`. Subclasses add what their channel needs and own their `reply_to` constructor, because channels disagree on who a reply targets — `EmailMessageSpec` adds `subject` and replies to the AUTHOR's address; `TelegramMessageSpec` replies to the CHAT. Inbound stays `SourceItemSpec`.
* **`ManifestSpec`** — ours. The shape of a data source's `data_source.json` and the `asset_spec` of the `DataSourceSpec` folder asset; every authoring rule is a validator on it.
* **`KindRegistry`** — ours. The one register-by-kind table (`flow_sdk/utils/kind_registry.py`) behind the FSOrigin, SecretOrigin, email-inbox, serializer, ingest-provider and reflect-mode registries.

## Consolidation seams (2026-08-29, Phase 1)

| Ours | One place | Notes |
|---|---|---|
| WS frames | `flow_sdk/api/api_types/messages.py` | The single definition site (shared with the hub's vocabulary). `flow_sdk/api/messages.py` re-exports it and adds only app-only frames. |
| `credential_for(provider, user=None)` / `token_for(...)` | `flow_sdk/core/oauth/provider_registry.py` | The one credential-precedence policy: explicit user → request user → local user → hub. `_get_github_token_for_current_user`, `get_anthropic_token_for_current_user`, `get_github_token` are thin envelopes over it. |
| `report_type_metadata(...)` | `flow_sdk/schema/type_info/_report.py` | The shared shape of the flat-JSON report families (agent trace, usage report, asset-cleanup report). |
| `useJsonDoc<T>(fsRef)` | `ui/src/hooks/use-json-doc.ts` | The one read-once JSON document hook behind `useAgentTraceDoc` / `useUsageReportDoc` / the cleanup-report editor. |
| `CapabilityRegistry` | `flow_sdk/core/capabilities/registry.py` | A `KindRegistry[CapabilityRunner]` (kinds keep registration order). |

## Consolidation seams (2026-08-30, Phase 2)

| Ours | One place | Notes |
|---|---|---|
| `VENDORS` / `Vendor` | `flow_sdk/flowpad_types/vendors.py` | The one table of facts about the four CLI harness vendors (key, persisted `worker_type`, aliases, placement harness, capability kind, dot-dir, session entity type, pricing prefixes). Stdlib-only so `placement.py` and `transcript_analyzer` can import it; classes are reached by the dotted `package`. `vendor_for` / `vendor_or_none` / `default_vendor` / `vendor_by` / `vendor_for_path`. |
| `JsonlTeeStreamWorker` | `flow_sdk/builtin/agentic_process/cli_drivers/jsonl_tee_worker.py` | The one non-interactive JSONL turn loop for vendors whose CLI records no turn terminal (copilot, opencode); a vendor supplies its session-key spelling, terminal types, stdin mode, converter and gate. Claude and codex stay on their own workers. |
| `GitOriginDriver.materialize(origin, *, preferred_root, preferred_project_id, token)` | `flow_sdk/builtin/drivers/git_driver.py` | THE clone/reuse/pull policy — bundle receive, `Project.setup_from_git_origin`, `setup_from_bootstrap_git`, `Folder.resolve_location` and `create-project-from-git` all route through it. An absent/empty `preferred_root` means *clone here*. The driver is anonymous; callers pass their own `token`. |
| `GitOrigin.next_clone_target()` / `fresh_clone_slot(leaf, reuse_empty=)` | `flow_sdk/fs_store/origin/git_origin.py` | The two workspace placement policies: reuse a matching checkout vs. never reuse (suffix past a collision; an empty dir is not one unless `reuse_empty=False`). |
| Header-carried bundle entries | `flow_sdk/builtin/flow_message_bundle.py` `_HEADER_UNPACKERS` + `_unpack_*_entry` | Conversation / flow_message / remote_worker_session unpack through named inverses of their packers (an `_UnpackCtx` carries the unpack-time state) instead of inline branches in `unpack_bundle`. |
| Hub merge deny-set | `_hub_reflect._merge_skip_fields(entity)`; `wiki_cache._cache_payload` | Derived from the `Sharing` declarations (`fields_not_accepted_from_hub()` + hub wire aliases from `APIField(hub_name=…)`; `fields_not_in_bundle()`), not hand lists. The three ALLOW lists (`_FM_FIELDS`, `hub_bridge._LOCAL_FIELDS`, `membership_sync._MIRRORED_FIELDS`) are wire-format subsets and stay declared. |

| `data-integrations` | ours | The `kind: vibe` persona that guides connect → sample → define; mechanics in `connect-data-source` |
| `promote` / `annotate` | ours | `Dataset` actions: a `SourceItem` becomes an example row; a gold label is written against the dataset's output shape |
| asset editor | ours | Not a mechanism of its own: a **webapp asset nested inside the asset it edits** (`<asset>/agentic-assets/webapp/<name>/`), marked `kind: application.web.editor`. Discovered by the ordinary repo walker, served by `MicroApp.view`, addressed at `/dock/app/micro_app-<id>` — so its breadcrumb reads `Project / <parent> / <name>`. Finding one is a containment query (`useAssetApps`), never a registry. |
| `micro_app` (family `webapp`) | ours | The delivery plane of an app, and a REPO folder asset when the app IS a folder on disk: `webapp.json` declares `kind` / `build`, `asset_ref` is the app folder, and `serving_root()` is `<asset_ref>/<build>` — we start the app folder, we serve the build. A row registered by `flow app serve` stays DB-only (`location_type: Artifact`, no `asset_ref`). |

## Identity carriers (2026-08-30)

| Ours | One place | Notes |
|---|---|---|
| `identity_carrier` (`FrontmatterCarrier`, `FolderMdCarrier`, `FolderJsonCarrier`, `NativeJsonCarrier`, `DerivedCarrier`) | `flow_sdk/fs_store/identity_carrier.py` | WHERE a type's id lives. A markdown main document: `id:` first in its frontmatter. `read` / `write_if_absent` / `convert` — validation and minting stay in `TypeInfo`. |
| `TypeInfo.mint_entity_id` / `TypeInfo.read_id` / `carrier_path_for` | `flow_sdk/fs_store/schema_registry.py` | Read the carrier → owning row → mint and write. `read_id` never writes. No `observe`/`derive`/`overwrite` vocabulary. |
| "capsule" | `flow_sdk/capsules/` | The generic named-block carrier. For markdown identity it is **legacy**: read, stripped from bodies, converted in place. Still the live carrier for `tag` blocks in source files and for folder-json identity. |
