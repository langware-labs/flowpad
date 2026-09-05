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
| `Mcp` + `McpServer` + `Command` | **tool** | **tool** |
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
`Deployment.create_process/launch` — the whole launch bundle (worker, model, permissions, system
prompt via `context_data.instructions`, dirs, `deployment_id`). "Load an agent" means the
Agent entity; the persona embed is always "sub-agent".

**The type renamed; the directory did not.** `.claude/agents/` is a **provider-owned path**
— Claude Code reads it directly — so `family` stays `"agents"` and the frontmatter spec
(`AGENTS_SPEC_FIELDS`) still mirrors its `--agents` JSON verbatim. Entity `subagent`,
directory `agents`: that disagreement is deliberate, and the code says so at both ends.

**We have no `Tool` noun.** `EntityType` has no `TOOL` member — the concept is split across
`MCP`, `MCP_SERVER` and `COMMAND`. Both Claude Code and OpenClaw make `tool` first-class.

**`MCP` is ours; `MCP_SERVER` is theirs.** Two types, one word apart, and the difference is who
owns the file. `MCP` is a flowpad-native REPO asset at `agentic-assets/mcp/<name>/mcp.json` (an
`McpSpec`) that we author, index with a v4 id in its own identity capsule, attach to an Agent, and
render onto a worker's command line. It may also OWN the server's code: an `entrypoint` (default
`server.py`) names a file inside the asset folder that `fastmcp run` executes, kept relative
because the folder travels with its agent. `MCP_SERVER` is the READ-ONLY inventory of servers already
configured in a vendor's own files (`~/.claude.json`, `.codex/config.toml`, `~/.copilot/mcp-config.json`,
…); it records a *definition site* we cannot write, which is why its id stays path-derived. Discovery
reads `MCP_SERVER`; attaching writes `MCP`.

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
skills, and SubAgent references round-trip through `agent.md` but are not yet projected into the
worker. They must not be presented as enforced controls until that projection exists.

MCP servers are **not** in that set. They are not a frontmatter list at all: an agent's servers are
`MCP` assets nested in its own folder (`agentic-assets/mcp/<name>/`), so the folder IS the list and
a shared agent carries them with it. `Agent.resolved_mcp_specs()` reads them, `Deployment.create_process`
copies them onto the process, and each harness renders them onto its own launch channel
(`cli_drivers/mcp_projection.py`) — claude `--mcp-config`, codex `-c mcp_servers.*`, copilot
`--additional-mcp-config`, opencode the `mcp` key of its generated config. They are resolved once at
worker boot, so attaching to a running process flips `restart_required` rather than taking effect.


* **`SourceItemSpec`** — ours. The ingestion envelope a data-source driver emits and the `asset_spec` of `SourceItem` (the row): the fields the DB medium persists. Not an entity; a `DataSpec`.
* **`sent_at` / event time** — ours. A message's EVENT time (when the human sent it on its channel) as opposed to the PROCESSING clocks (`created_date`/`updated_date` — when our row was written). Projection-owned on `FlowMessage`; read everywhere through the one rule `event_time = sent_at or updated_date or created_date`; never render a message's processing clocks directly. See `docs/data-management/inbox-projection.md`.
* **`MessageSpec`** — ours. The channel-generic OUTBOUND message value (`flow_sdk/builtin/source_item.py`): what a script hands `blocks.Inbox.send`. Subclasses add what their channel needs and own their `reply_to` constructor, because channels disagree on who a reply targets — `EmailMessageSpec` adds `subject` and replies to the AUTHOR's address; `TelegramMessageSpec` replies to the CHAT. Inbound stays `SourceItemSpec`.
* **`MessageBlock`** — ours. The process-local prompt/reply block (`flow_sdk/blocks/message_block.py`): `send(prompt)` waits while one `listen()` consumer handles the corresponding `MessageRequest` DataSpec and calls `reply(text)`; the source owns the one-shot correlation. `Agent.respond_to(source)` owns that loop and the private per-thread process runner. It has no address or rows and is not a `DataSource`, inbox, provider connection, `MessageSpec`, or `FlowMessage`. It briefly carried the name `MessageSource`; `flow_sdk/blocks/message_source.py` is now a shim.
* **`MessageSource`** — ours. A bidirectional `DataSource`: one with `channel` set whose driver declares `sends=True` and carries an identity (`account_identities`) on that channel — Slack, Telegram, a mailbox. It ingests like any data source and can reply, and it belongs to one owner (the local user or an Agent). Not the block above, not a `MessageSpec`, not a connection.
* **`Inbox`** — ours. The per-owner projection of a `MessageSource`'s threads into `Conversation`s (`flow_sdk/inbox/projection.py`): `/dock/inbox` is the local user's, `/dock/agent/<id>/inbox` an Agent's. `blocks.Inbox` is the SDK handle for one address of one `MessageSource`, not the projection. The **attached-channels line** on each inbox is the owner's `MessageSource`s — `DataSource.find_owned(owner)` ∩ spec `sends` — as round marks with a status dot; a mark filters the list to that channel, the details popover holds the pause/resume switch (`status`) and delete, `+` creates a source born with that `owner`.
* **`owner`** — ours. Whose row it is: a user or Agent `TypeId` on `DataSource`, `MessageThread` and `Conversation`, defaulting to the local user. THE key the inbox partitions by — an Agent's inbox is `owner == agent`, a filter, not a walk from one provider. Read only through `inbox.projection.owner_of`, which also resolves rows written before the field existed (`config.agent_id` → that agent). Not `created_by` (the hub's creator mirror) and not the roster's `owner` role (hub-side authz).
* **`ManifestSpec`** — ours. The shape of a data source's `data_source.json` and the `asset_spec` of the `DataSourceSpec` folder asset; every authoring rule is a validator on it.
* **`LLMSource`** — ours, and the FIFTH thing this tree calls a "source", so read it precisely.
  It is *where a worker's tokens come from* (`flow_sdk/schema/data_spec/llm_source_spec.py`): one
  frozen `DataSpec` covering all three funding paths — a vendor **device login**, a stored
  **api_key**, or a hub **endpoint**. It is NOT `DataSource` (a system of record we ingest from),
  NOT `MessageSource` (a `DataSource` that can also reply), NOT `SourceItem` (a record one produces), and — the collision that actually bites — NOT the hub's
  `source_llmendpoint` relationship, which is the fallback chain an `LLMEndpoint` allocation draws
  *from*, one layer down and unrelated. An `LLMSource` names a way to pay; a `source_llmendpoint`
  names a budget upstream of another budget. `resolve_llm_source` picks one per spawn, and its
  `reason` field is what both the picker and the spawn error render.
* **`KindRegistry`** — ours. The one register-by-kind table (`flow_sdk/utils/kind_registry.py`) behind the FSOrigin, SecretOrigin, email-inbox, serializer, ingest-provider and reflect-mode registries.

## Consolidation seams (2026-08-29, Phase 1)

| Ours | One place | Notes |
|---|---|---|
| WS frames | `flow_sdk/api/api_types/messages.py` | The single definition site (shared with the hub's vocabulary). `flow_sdk/api/messages.py` re-exports it and adds only app-only frames. |
| `credential_for(provider, user=None)` / `token_for(...)` | `flow_sdk/core/oauth/provider_registry.py` | The one credential-precedence policy: explicit user → request user → local user → hub. `_get_github_token_for_current_user`, `get_anthropic_token_for_current_user`, `get_github_token` are thin envelopes over it. |
| `report_type_info(...)` | `flow_sdk/schema/type_info/_report.py` | The shared shape of the flat-JSON report families (agent trace, usage report, asset-cleanup report). |
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

## Help desk (2026-09-02)

`Helpdesk` is one word for two halves that are configured separately and either
of which may be absent. Say which one you mean.

| Ours | One place | Notes |
|---|---|---|
| **ticket queue** | a **hub** Project, named by `desk_project_id` in the manifest | Where a support request is delivered (`start_guest_conversation`, `kind=helpdesk`). Hub-backed; nothing local. |
| **portal** | a **git repo** cloned locally | The help content: guides, `.flow/customization` branding, optionally a `support` SubAgent. Local; needs no hub. |
| `Helpdesk` (the entity) | `flow_sdk/builtin/helpdesk.py` | The portal folder as an indexed asset. Fields read THROUGH to `helpdesk.json`, so a `git pull` takes effect with no re-index. |
| **adopt** (the verb) | `Project.adopt_helpdesk_from_git`, `resolve_adopted_helpdesk` | A project takes on a desk by attaching its repo as a context folder. Not "create" — `HelpdeskTypeInfo` is `creatable=False`; a desk is authored in a repo, never in the app. The user-facing tile still reads **Add help desk**, because "adopt" is our word for the mechanism, not theirs for the act. |
| **serving desk** vs. **a desk that is present** | `resolve_adopted_helpdesk` | Resolution stops at the FIRST desk in `direct_context_roots()` order. A second desk under a later root is present but serves nothing — the `shadowed` outcome. Never conflate the two. |
| **portal slot** | `helpdesk_project_dir(desk_id)` | `<workspace>/.flow/helpdesk/project-<id>` — the app-managed checkout for the desk the HUB advertises. Distinct from an adopted desk's context folder, which lives in the visible workspace. |

## Identity carriers (2026-08-30)

| Ours | One place | Notes |
|---|---|---|
| `identity_carrier` (`FrontmatterCarrier`, `FolderMdCarrier`, `FolderJsonCarrier`, `NativeJsonCarrier`, `DerivedCarrier`) | `flow_sdk/fs_store/identity_carrier.py` | WHERE a type's id lives. A markdown main document: `id:` first in its frontmatter. `read` / `write_if_absent` / `convert` — validation and minting stay in `TypeInfo`. |
| `TypeInfo.mint_entity_id` / `TypeInfo.read_id` / `carrier_path_for` | `flow_sdk/fs_store/schema_registry.py` | Read the carrier → owning row → mint and write. `read_id` never writes. No `observe`/`derive`/`overwrite` vocabulary. |
| "capsule" | `flow_sdk/capsules/` | The generic named-block carrier. For markdown identity it is **legacy**: read, stripped from bodies, converted in place. Still the live carrier for `tag` blocks in source files and for folder-json identity. |

## Activity (2026-09-03)

**`Activity` is ours, not a provider mirror.** It is the one mechanism any long-running
work reports progress through — an index, a walk, a RAG pass, a QA cycle, a running
agentic process — from Python, TypeScript, the REST API, the CLI or an agent.

The noun was free where the near ones were not: `Job` is the FaaS entity, `Task` is a
folder asset, `Flow` means a chat message and a bus envelope, `Graph` and `Workflow` are
both already ambiguous. `Activity` collides only with the `InProcessActivity` holder it is
built to replace in phase 2.

| Ours | One place | Notes |
|---|---|---|
| `ActivityProgressSpec` | `flow_sdk/schema/data_spec/activity_spec.py` | The value that travels. A registered `DataSpec` (`activity.progress`), frozen, recursive. `total=None` means UNKNOWN — never 0. `errors_count` is the truth, `errors` a capped sample. |
| `Activity` (the handle) | `flow_sdk/activity/activity.py` | The mutable node, addressed by `(scope, path)` and found-or-created at every level. `Activity.get("a/b")` and `Activity.get("a").child("b")` are the same node, so code deep in a walk needs no handle threaded to it. |
| `inc` vs `set_counter` | `flow_sdk/activity/activity.py` | Two counter verbs for two producer shapes: `inc` adds a DELTA (events seen), `set_counter` takes an ABSOLUTE total (a running count, a re-parsed transcript) and never moves backwards. The monotonicity policy lives on the verb so every producer inherits one answer. |
| `ActivityProgressMonitor` | `flow_sdk/activity/progress_monitor.py` | The in-memory registry — it IS find-or-create. Holds LIVE work only: a root's terminal untracks its whole tree, so a later `get` yields a FRESH node. "Is it running" is its question; "when did it last finish" is the receipt's (phase 2). |
| **path** vs. **scope** | — | `path` addresses within a scope (`index`, `index/pdf`); `scope` is the TypeId the work belongs to, absent for instance-wide work. Scope is also the WS routing key: unscoped broadcasts, scoped goes to that entity's watchers. |
| **tick** vs. **transition** | `flow_sdk/activity/emit.py` | A tick is a coalesced snapshot on the `progress_report` envelope and touches nothing else. A transition (started / blocked / completed / failed) publishes on the event bus immediately and is never coalesced away. |
| `interrupted` | `ActivityState.INTERRUPTED` | Assigned by the system, never a producer: work that STOPPED rather than finished — a child still running when its root ended. The state the old tracker could not express, which is why a restart made the footer indicator vanish silently. |

Verb casing is deliberately per-language: `inc_success` in Python, `incSuccess` in
TypeScript, `inc-success` from a shell. The route accepts all three, so it stays one
vocabulary rather than three APIs.
