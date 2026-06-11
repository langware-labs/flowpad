# Slick — codebase anchor index

Exact paths and symbols to model after (or grep for) when applying each
principle. Open this when you need the real seam, not the idea.

## 1. Headless / reflection round trip

| Step | File | Symbol |
| --- | --- | --- |
| Backend emits change | `flow_sdk/db/db_entity.py` | `notify_updated()` → `DataOpMessage(op=UPDATE)` |
| Server-side derived state (don't recompute in FE) | `flow_sdk/core/entity/entity_model.py` | `Entity.private_context_entities` (computed_field) |
| FE receives | `ts_sdk/src/FlowSync/store.ts` | `onDataOp(typeIdStr, op, data)` |
| FE merges wire → cache | `ts_sdk/src/FlowSync/store.ts` | `deepAssign` / `castAndDeepAssign` |
| FE re-render hook | `ts_sdk/src/APIEntity.ts` | `handleFlowData()`, `notifyPropertyChanged` |

URL-first corollary: `CLAUDE.md` "URL-first navigation" section — click →
`navigation.openDock(...)` → loader writes context (single writer).

## 2. Layering & dependencies

- Stdlib-only model citizen: `flow_sdk/transcript_analyzer/` (no parser
  framework; `entry.py`, `parsers/`, `formats.py`).
- Dep list (the bar a new package must clear): `pyproject.toml` `dependencies`.

## 3. Entity FE/BE pairing

| Side | File | Symbol |
| --- | --- | --- |
| Backend base | `flow_sdk/core/entity/entity_model.py` | `Entity` (→ `DBEntity`) |
| Backend type registry | `flow_sdk/schema/types.py` | `EntityType` (StrEnum, canonical) |
| Compat shim (migration) | `flow_sdk/fs_store/record_types.py` | `RecordType = EntityType` |
| Frontend base | `ts_sdk/src/APIEntity.ts` | `APIEntity`, `@registerEntity` |
| FE type→ctor map | `ts_sdk/src/...` | `EntityFactory.registerEntity` |

Pairing rule: project memory `project_entity_record_pairing` — every type needs
a paired backend `Entity` or `uname` stays `None`.

## 4. Action plumbing

| Side | File | Symbol |
| --- | --- | --- |
| FE action descriptor | `ts_sdk/src/models/ActionInfo.ts` | `ActionInfo(name, type, id, method)` |
| FE dispatch | `ts_sdk/src/FlowSync/store.ts` | `dataManager.callAction` |
| BE decorator | `flow_sdk/actions/action_registry.py` | `action.post/get(action_name=, types=)` |

Clean round-trip examples:
- `AgenticProcess.prompt()` (`ts_sdk/src/process/agentic-process.ts`) →
  `@action.post(action_name="prompt")` (`flow_sdk/builtin/agentic_process/agentic_process.py`).
- Generic-on-base: `APIEntity.fetchMembers()` →
  `@action.get(action_name="members", types="all")`
  (`flow_sdk/app/actions/members_action.py`).

"Branch, don't fork" example: the `prompt` action routes by `self.visible`
(print-mode vs PTY-transcript) instead of a separate `prompt-pty` action.

## 5. Enums & TypeInfo

| Anchor | File | Symbol |
| --- | --- | --- |
| Canonical enum | `flow_sdk/schema/types.py` | `EntityType(StrEnum)` |
| StrEnum backport | `flow_sdk/_compat.py` | `StrEnum` (`.value` is the persisted string) |
| TypeInfo class | `flow_sdk/fs_store/schema_registry.py` | `TypeInfo` (icon, meta_model, post_sync_fn, …) |
| Auto-registration | `flow_sdk/schema/type_info/__init__.py` | `register_all()` (imports `*_info.py`) |
| Per-type example | `flow_sdk/schema/type_info/project_type_info.py` | `PROJECT = TypeMetadata(type=EntityType.PROJECT, icon=…)` |
| FE icon resolve | `ui/src/components/graph-view/icons/iconRegistry.ts` | `iconForType(type)` (bootstrap map, no hardcode) |
| FE id codec | `ts_sdk/src/models/TypeId.ts` | `TypeId`, `IdentifierType` (v4/v5 regex) |

Anti-pattern anchors (don't add more): bare `ref.type == "agent"` /
`"skill"` in `agentic_process.py` `_materialize_entity` (~L2623+);
`record_type == "skill"` in `flow_sdk/app/actions/listen.py`.

## 6. Workers / drivers

| Anchor | File | Symbol |
| --- | --- | --- |
| Protocol | `flow_sdk/builtin/agentic_process/cli_drivers/cli_worker_base_driver.py` | `WorkerDriver` (`name`, `pty_submits_on_paste`, `transcript_descriptor`, `tail_status`, `compose_prompt`) |
| Per-vendor drivers | `.../cli_drivers/{claude,codex,copilot}/driver.py` | `ClaudeDriver`, `CodexDriver`, `CopilotDriver` |
| Generic status | `flow_sdk/builtin/worker_status.py` | `WorkerStatus` |
| Generic transcript | `flow_sdk/transcript_analyzer/transcript.py` | `AgentTranscriptFile`, `TranscriptDescriptor`, `parse_delta` |
| Entry→FlowData mapper | `.../cli_drivers/claude/session_history.py` | `entry_to_flowdata(entry, observation_kind)` |

Worked example: `pty_submits_on_paste` declared as a driver trait replaced a
`self.driver.name == "claude"` literal at the call site.

## 7. Testing / console

| Anchor | File | Note |
| --- | --- | --- |
| Pytest config | `pytest.ini` | global `--timeout=30`; `unit` ≤5s; `integration` no-mocks; `long_tests/` for >30s |
| Short unit test | `tests/unit/test_entity.py` | `TypeId` equality in ~6 lines |
| Clean integration | `tests/api/test_health_check.py` | real HTTP, 17 LOC |
| Real-entity CRUD | `tests/api/test_basic_crud.py` | `Team(name=…)` → POST `/graph/team` |
| Test fixtures | `tests/conftest.py` | `_TestHome` sandbox, `_InMemoryKeyring`, per-run DB isolation |
| Vitest config | `ui/vitest.config.ts`, `ui/tests/unit/vitest.config.ts` | unit tests <50 LOC |
| Short vitest | `ui/tests/unit/action_info.test.ts` | `actionUrl` in ~13 LOC |
| CLI harness | `flow_sdk/cli/flow_cli.py` | `flow record/navigate/context/schema`; exit codes encode semantics |
| Short fn exemplars | `flow_sdk/fs_store/type_id.py`, `flow_sdk/utils/hashing.py` | `type_id_str`, `file_hash` |
| God-object counter-examples | `agentic_process.py`, `flow_message_action.py`, `sqlite_driver.py` | 3k–4k LOC; what NOT to grow |
