---
id: 513693e3-cfa6-43d6-bf0f-7d86f158367b
---

# HANDOFF — FLOWPAD-2064 agent-resources pane

Branch `FLOWPAD-2064`. Last commit `6e3a7dcdd`. Working tree has uncommitted work (see **State on disk**).

Previous headline finding — *"`ui/src/components/asset-manager/` already implements the `+`, the
scope chip, and the props pattern this ticket needs"* — **has been acted on and is now landed
(uncommitted)**: the Skills section renders the shared `AssetRow` + `assetScope`, fed by
`useProcessAssets(null, { projectId, types: ['skill'] })`.

The new headline finding, and the point of this rewrite: **the skill lifecycle — create, discover,
copy — is fully mapped, and the last link is missing on the BACKEND, not the UI.** `agent.skills`
is declared-only; nothing reads it at launch. Section **"The skill pipeline"** below is the map.

---

## Goal

Replace the assets tree in the navigator (Zone B) with an agent-resources pane while an agent is
being created or edited. Four sections: Data sources, MCP servers, Skills, Docs.

Confirmed scope decisions:

| # | Decision |
|---|---|
| 1 | Surface = the navigator slot, only for `AssetEditor.AGENT` |
| 2 | Rows are **read-only** — everything listed is already available at global/context scope, so a checkbox is a checked box you cannot uncheck |
| 3 | Next feature: skills from **context folders** with a `+` to import, copied via the existing embedding logic |
| 4 | The `+` **flips once imported** (not additive-only) |
| 5 | Name collisions between a context-folder skill and a global one: **out of scope** |
| 6 | Data sources / Docs selections are not persisted; no new Agent fields |

---

## Current progress

Committed and pushed: navigator slot + switch, `NavigatorSection`, MCP servers via the capability
manager, and the discover-route path fix (`6e3a7dcdd`).

Uncommitted, and **done since the last handoff**:

- `useWirableSkills` rewritten on `useProcessAssets(null, { projectId, types: ['skill'] })`. The
  broken `useEntity<ComputeNode>` draft is gone. `useProcessAssets` gained a server-side `types`
  narrowing, keyed on the joined string so an inline `['skill']` doesn't re-fetch every render.
- `AssetRow` / `assetScope` / `displayLabelForDescriptor` / `descriptorKey` / `basename` exported
  from the asset-manager barrel; the Skills section renders `AssetRow` with `selected={false}` and
  no `onPick`/`onUnpick` (read-only board, per decision 2). Dedupe-by-name deleted.
- `labelForAsset` fallback in `AgentResourcesBody`: `displayLabelForDescriptor` gives up to the raw
  typeid for an indexed skill this pane never loads into the dataManager cache, so the folder
  basename is used — which is a skill's real on-disk identity (`resolve_skill_name`).
- `useEditedAgentWorker` (new): reads `worker_type:` from the agent's own file via the URL pointer,
  refetches on `useEntityOps('agent')`. Scopes the MCP list to the worker the agent is set to.
- `AgentChoiceField` (new, `AgentProfileFields.tsx`) + `toDriverKey` (`agent-vocabularies.ts`):
  `worker_type` is now a closed dropdown, and the two worker vocabularies (`claude` vs
  `claude_code`) fold before comparison.

---

## The skill pipeline (this session's research)

Answers "how are skills created for an agent, and where are they specified and copied from".

### A skill on disk

A folder containing `SKILL.md` (or `skill.yaml`/`skill.yml`) —
`flow_sdk/fs_store/indexer/functions/skill.py:37` (`SKILL_INNER_FILES`, `folder_is_skill`).
Everything else is placement and discovery around that one fact.

### 1. Creation — where a new skill lands

`flow_sdk/schema/type_info/skill_type_info.py` declares `creatable=True`, `asset_class="shared"`,
`family="skills"`, `main_layout="folder"`, `main_file="SKILL.md"`. The path falls out of that
declaration alone:

| Step | Where |
|---|---|
| Subdir | `LayoutClass.mount()` — `flow_sdk/fs_store/placement.py:162`. SHARED is `harness_scoped` → `<WORKER_PREFIX>/skills`, i.e. `.claude/skills` (`.agents/skills` for other harnesses). `fan_out=True` → syncmd mirrors it across harnesses |
| Scope root | `root_for_scope` — `placement.py:221`. USER → `get_instance_settings().user_home`; PROJECT → the project's mount path |
| Composed | `<user home \| project mount>/.claude/skills/<name>/SKILL.md` |
| Stamped on the row | `Entity._resolve_create_target` → `FSRecord.compute_asset_ref` — `flow_sdk/core/entity/entity_model.py:2641-2660` |

The pane's **New skill** button (`AgentResourcesBody.tsx:203`) calls
`useQuickCreatePick().panelProps.onPick(Skill.type)` — the same name/scope dialog project home uses,
so the scope chip in that dialog is what picks user vs project root above.

### 2. Discovery — where the pane's list comes from

`useWirableSkills` → `useProcessAssets(null, { projectId, types: ['skill'] })` →
`GET project/{id}/get-assets` (`flow_sdk/builtin/project.py:1228`).

Roots come from `collect_base_source_dirs` (`flow_sdk/builtin/agentic_process/agentic_process.py:394`)
— deliberately the same function `AgenticProcess._collect_source_dirs` uses, so the staging list
cannot drift from what a real process would see:

| `AssetSource` | Root |
|---|---|
| `USER_DIR` | `get_instance_settings().user_home` |
| `PROJECT_DIR` | `project.fs_storage_mount_path` |
| `CONTEXT_DIR` | each of `project.include_dirs` |

`scan_path_asset_descriptors` then merges indexed rows with `disk_asset_descriptors`
(`agentic_process.py:419`), which delegates to the indexer's own walkers rather than re-deriving
locations:

- `skill_fn` (`skill.py:73`) — **only** `<root>/.claude/skills/*`. This is the sole home-dir
  discovery, on purpose: no content-walk of `~`.
- `skill_in_folder_fn` (`skill.py:89`) — inside a project, any gitignore-surviving folder holding a
  `SKILL.md`, anywhere.

Each descriptor's `source` is what `assetScope` renders as the scope chip.

### 3. Copy — how a skill actually reaches a worker

Per **process**, never per agent asset. Two seams with different semantics:

| Seam | Mechanism | Where |
|---|---|---|
| `attach-embedded-asset` (`entity_ref` = `skill-<uuid>`) | `_materialize_entity` → `copy_skill_to(skill, self._skills_root(assets_dir))` — a real `copytree`, excluding `.flow_record`/`record.json`, overwriting same-named | `agentic_process.py:5651-5686`; `flow_sdk/fs_store/operations/skill.py:36` |
| `load-embedded-skill` (`asset_ref` = the folder path) | **symlinks** the live source folder in, so edits to the original `SKILL.md` reach the next chat with no re-materialization | `agentic_process.py:5184-5222` |

Destination is vendor-dependent via `WorkerDriver.skills_root`:

- Claude / Copilot → `<assets_dir>/.claude/skills` (`claude/driver.py:467`)
- Codex → `$CODEX_HOME/skills` — **global, not process-isolated** (`codex/driver.py:324`)
- OpenCode → `<assets>/.opencode/skills` plus a generated `skills.paths` (`opencode/config_gen.py`)

`assets_dir` is the process's `<exe_folder>/assets/`, handed to the CLI via `--add-dir`. Which is
also why any `.claude/skills` under the workdir or an `additional_dirs` entry is discovered with
**no copy at all**.

### 4. The gap

`agent.skills` is `list[TypeId]`, persisted to `agent.md` frontmatter as `skills:\n- skill-<uuid>` —
serialized TypeIds, never bare names (`TypeId` parsing raises on a name; `flow_sdk/fs_store/type_id.py:56-59`).
But it is **declared-only**:

- `flow_sdk/builtin/agent.py:112-121` says so in words ("nothing reaches the worker. Do not present
  them in a UI as if they gated anything").
- `to_agent_options` (`agent.py:505`) projects only `model` / `permission_mode` / `effort` /
  `cli_options`.
- `Deployment.build` (`flow_sdk/builtin/deployment.py:372-437`) never reads `skills` at all.

So nothing copies a skill because an agent declared it. The pane currently states this to the user:
*"Discoverable by an agent run in this project — not selected per agent."*

**Where the missing link goes:** `Deployment.build`, looping `agent.skills` into
`process._materialize_entity(ref, assets_dir)` / `embedded_asset_refs` after the process is
constructed. Hard constraint from the docstrings: it must go through the process's asset dir and
**not** into `cli_config` — `last_started_hash` is an md5 over `to_agent_options().to_json()`, so a
new key there flips `restart_required` on every running process. Same reason `system_prompt`
travels via `context_data.instructions` instead.

---

## Prior integration research (still valid)

### `ui/src/components/asset-manager/` — 7 files, ~2050 lines

| File | Lines | Role |
|---|---|---|
| `AssetManagerPopover.tsx` | 1045 | Presentational list. **Exports `AssetRow`**, `AssetManagerPopoverProps`, `RUNNABLE_ASSETS` |
| `AssetManagerButton.tsx` | 525 | The process-backed host that wires actions |
| `asset-scope.tsx` | 188 | `assetScope()`, `AssetScopeChip`, `AssetScopeKind` |
| `EntityTypeBar.tsx` | 119 | Per-type filter bar |
| `asset-row-helpers.ts` | 95 | `normalizePath`, `descriptorKey`, `isOpenableTypeid` |
| `useProcessAssets.ts` | 71 | Data hook — **handles `process === null`** |

**The `+` with the flip already exists.** `AssetRow` (`AssetManagerPopover.tsx:866`) renders `+` and
flips to `X` when `selected && !!onUnpick`. `selectedTypeIds` is keyed by **typeid**, which
`agent.skills` already is — no adapter. Omit both callbacks → read-only board; omit only `onUnpick`
→ one-shot; **both supplied = the flip** (decision 4). The select control is deliberately *not*
gated on read-only — "read-only describes whether the asset FILE can be edited, not whether the
user's own selection can be undone" — which is load-bearing here, since every global/context skill
is a read-only source.

**Scope rendering, two traps.** `assetScope(descriptor)` → `{ kind, label, revealPath, tooltip }`,
rendered by `<AssetScopeChip>`. (1) It is **not** the entity's `scope` column — feed it
`descriptor.source`, never `Skill.scope`. (2) The chip is `display: contents` and spans two cells of
the parent grid: `AssetRow` requires
`grid-cols-[minmax(0,1fr)_1.25rem_4.5rem_1.5rem_1.5rem_1.5rem]` (line 82) and cannot sit in a plain
flex container.

**Props pattern: capability-by-callback.** ~20 optional props, all default-off; an affordance renders
iff the callback implementing it was supplied. Copy the `const NONE: readonly string[] = []`
stable-identity default for optional array props.

---

## What worked

- **Baselining every test run against clean HEAD** (`git stash push -- <file>`, run, `stash pop`,
  `comm` the sorted FAILED lists). This repo has ~1740 pre-existing type errors and many pre-existing
  Windows test failures; raw counts are meaningless. It caught a real regression.
- **Single-process A/B** of old vs new logic before/after a fix, rather than trusting a green run.
- Reading `asset-scope.tsx`'s docstrings before designing anything — they had already reasoned
  through the exact `scope`-column confusion this ticket hit.
- **Following the type-registry declaration rather than grepping for paths.** `asset_class` +
  `family` + `LAYOUT_REGISTRY` gave the whole placement rule in one read; hunting for hardcoded
  `.claude/skills` strings would have found the call sites but not the policy.

## What didn't work

- **`/graph/skill?include_system=true` as the pane's skill list.** No location filter at all: 77 rows,
  of which only 10 are genuinely global. The rest are ten unrelated checkouts plus flowpad-hub test
  fixtures, because `default_roots()` walks the whole user home. The asset-manager had already
  documented this as a mistake.
- **Filtering by `Skill.scope`.** `classify_path` only returns system/user/project/None, derived from
  path-vs-home — so `cloudnsite-core-demo\.claude\skills\jira-ticketes` is labelled `user`, identical
  to a real global skill. Proven with a real row.
- **Hand-rolling the folder set** (`compute_node.home_dir` + `project.context_roots` →
  `assets/by-path`). Works, but reinvents `project/{id}/get-assets`. Abandoned.
- **Keying the `assets_by_path` lex range on `os.sep` alone.** Fixed 9 tests, broke 6 — both separator
  forms are in the data (the indexer writes backslashes via pathlib; other producers write
  `canonical_posix_path`). The landed fix emits a range per form and OR's them: 10 failed → 1, zero
  regressions.
- **Trusting `~/.flow/instances/*/server.json`.** dev-4's entry is stale; **port 6004 is the `oss`
  instance** (PID 5316), which CLAUDE.md states is this checkout. Several verifications ran against
  the wrong DB before this was caught. `6e3a7dcdd`'s commit message still says "dev-4" — the A/B was
  valid, the label is wrong.
- **Assuming `agent.skills` gated anything at runtime.** It does not, and the UI must not imply it
  does until `Deployment.build` reads it. See **The gap**.

## Known-broken / needs attention

- `agentic-assets/agent/personal-assistant/agent.md` declares two skills that are invisible in the UI
  (the pane is read-only and the Advanced tab's fields were removed). Consistent with decision 2, but
  worth knowing.
- The `agent.skills` write path was deleted in the reframe (`useAgentDocument.ts`,
  `useAgentListWiring.ts` are `D`). The `+` import step needs a write seam again — recoverable from
  branch history. `patchAgentDocument` (`agent-document.ts`) is the lossless frontmatter writer it
  should go through.
- `docs/test-document.md` and `agentic-assets/agent/personal-assistant/` are untracked scratch from
  testing — decide whether they belong in the commit.

---

## State on disk (uncommitted)

```
M  flow_sdk/core/entity/entity_model.py                            # assets_by_path: range per separator form
M  flow_sdk/server/routes/assets.py                                # by-path projection gains `description`
M  ui/src/components/agent-resources/AgentResourcesBody.tsx        # AssetRow integration, labelForAsset, worker-scoped MCP
M  ui/src/components/agent-resources/AgentResourcesNavigator.tsx   # no longer resolves an agent
M  ui/src/components/agent-resources/useWirableSkills.ts           # rewritten on useProcessAssets
M  ui/src/components/agent-resources/useWirableMcpServers.ts       # scoped to the edited agent's worker
M  ui/src/components/asset-manager/index.ts                        # barrel: AssetRow, assetScope, label helpers
M  ui/src/components/asset-manager/useProcessAssets.ts             # server-side `types` narrowing
M  ui/src/components/assets/editor/agent-profile/AgentProfileEditor.tsx
M  ui/src/components/assets/editor/agent-profile/AgentProfileFields.tsx    # AgentChoiceField (closed worker dropdown)
M  ui/src/components/assets/editor/agent-profile/agent-vocabularies.ts     # toDriverKey
M  ui/src/components/assets/editor/agent-profile/agent-document.ts         # dropped dead list helpers
M  ui/src/components/navigator-panel/NavigatorSection.tsx
D  ui/src/components/agent-resources/useAgentDocument.ts
D  ui/src/components/agent-resources/useAgentListWiring.ts
?? ui/src/components/agent-resources/useEditedAgentWorker.ts
?? FLOWPAD-2064-plan.md, MCP_AGENT_WIRING.md, HANDOFF.md
?? agentic-assets/agent/personal-assistant/, docs/test-document.md
```

The read-only reframe was verified clean: eslint exit 0; type-check set-diff vs HEAD = 1 error
removed, 0 added; 17 unit tests pass. **The `AssetRow` integration and `useEditedAgentWorker` have
not been re-verified since** — re-run eslint + the type-check set-diff before committing.

---

## Next steps

1. **Re-verify the uncommitted UI work.** eslint, then the type-check set-diff vs HEAD (never raw
   counts), then the unit tests. Nothing here has been checked since the `AssetRow` swap.
2. **Verify `project/{id}/get-assets` on Windows.** It walks the filesystem
   (`scan_path_asset_descriptors`) rather than a DB lex range, so it probably sidesteps the separator
   bug — but that assumption is exactly what went wrong twice already. Check against `oss`
   (`FLOW_INSTANCE=oss`, port 6004).
3. **Commit the two backend fixes** (`entity_model.py`, `assets.py`) — they stand on their own: the
   POSIX fix repaired 9 pre-existing test failures and the project asset menu.
4. **Then the import feature, backend half first.** Teach `Deployment.build` to materialize
   `agent.skills` into the process's asset dir (`_materialize_entity` / `embedded_asset_refs`),
   keeping it out of `cli_config` for the `last_started_hash` reason above. Decide copy
   (`copy_skill_to`) vs symlink (`load-embedded-skill`) — symlink keeps the agent following edits to
   the source skill, copy freezes it; for codex note that `skills_root` is the **global**
   `$CODEX_HOME/skills`, so a per-agent selection there leaks across processes.
5. **Then the UI half:** restore a write seam through `patchAgentDocument`, pass
   `selectedTypeIds={agent.skills}` + `onPick`/`onUnpick` to `AssetRow`, and drop the "not selected
   per agent" note once the wiring is real.

### Related tickets

- **FLOWPAD-2067** — a missed fs-records discover triggers an unbounded re-index across 128 project
  roots (42 of them leftover pytest temp dirs). Same index-pollution family as the 77-skill problem.
  `agentic-assets/agent/q/agent.md` failing to resolve on `oss` belongs there too: ten checkouts hold
  the same agent and another won the primary path.

