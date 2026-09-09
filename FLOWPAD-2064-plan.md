---
id: 7cc75e41-6ba0-4405-aff7-ff8589fcf0d3
---

# FLOWPAD-2064 — Agent-editor resource pane (Zone B)

## Context

Today, opening an agent for editing (`AgentProfileEditor`, the `agent` type) leaves the left
navigator showing the generic assets tree — Project home, asset-type roots, Files, Context
folders. None of that helps the task at hand, which is deciding **what resources this agent
gets**. Meanwhile the only way to attach skills or MCP servers is a comma-separated text box
buried in the Advanced tab.

This replaces the navigator, **only while an agent is being created or edited**, with a pane of
four independently collapsible sections — Data sources, MCP servers, Skills, Docs — where rows
wire resources into the agent. Everywhere else the navigator is untouched.

### Decisions (confirmed with the user — do not re-litigate)

| # | Decision |
|---|---|
| 1 | Surface = the **navigator slot** (`NavigatorSlot` / `NAVIGATOR_REGISTRY`), not a popover or side tab |
| 2 | Applies **only** to `AssetEditor.AGENT` (the `agent` type). Not `subagent`, not other editors, not plain Assets/Project views |
| 3 | In that context the pane **fully replaces** the tree — Project home, type roots, Files, Context folders all gone |
| 4 | Purpose is **wiring** resources to the agent, not browsing — rows carry a selection affordance |
| 5 | Sections default to **expanded iff non-empty** |
| 6 | **No count badges** on section headers |
| 7 | MCP servers is blank: empty state exactly `No MCP servers found`; ordinary collapsible section, built so a real list drops in later |
| 8 | Docs are **project-scoped** |
| 9 | Data sources and Docs selections are **NOT persisted** — no `data_sources`/`docs` fields on Agent. Out of scope |
| 10 | **Skills wires to `agent.skills`** (real persistence); MCP wires `agent.mcp_servers` when it has content |
| 11 | The Advanced tab's Skills and MCP servers rows are **removed** — the pane is the only editor for those two |

## Two findings that shape the build (verified on disk)

1. **`agent.skills` holds serialized TypeIds, not names.** `agentic-assets/agent/q/agent.md:6-7`
   is `skills:\n- skill-ae32bd1d-2fca-50c2-bf33-fa24a06aad61`. Python resolves it via
   `flow_sdk/fs_store/type_id.py:56-59` → `args[0].split("-", 1)`, so a bare name raises
   `ValueError` inside pydantic validation of the Agent record. **The checkbox writes
   `skill.typeId.toString()`.** Never `skill.name`.
2. **These fields are declared-only.** `flow_sdk/builtin/agent.py:90-94`: *"DECLARED ONLY, not yet
   enforced … nothing reaches the worker. Do not present them in a UI as if they gated anything."*
   Checking a skill changes nothing at runtime today. The Advanced tab says so in words
   (`AgentProfileEditor.tsx:317-319`); **the pane must carry the same sentence.**

Also corrected: `/search?record_type=skill` + `projectScope(pid)` does **not** include system
skills — `flow_sdk/server/routes/search.py:185-188` applies the scope filter *before* the system
filter, and system skills carry the system project's id. Use the `/graph/skill?include_system=true`
idiom instead.

## Detecting the agent-editor context

The registry is keyed by ViewType alone, and an agent editor is `ViewType.ASSETS` — or
`ViewType.PROJECT` after `DockPointer.rebaseAssetsOntoProject` — so ViewType cannot discriminate.
The `<editor>` segment **is** in the URL for both routing methods (`editor/agent/vfs/…` and
`editor/agent/typeid/agent-<uuid>`), so no entity resolution is needed. `AssetEditor.AGENT` maps
to exactly `[RecordType.AGENT]` (`ts_sdk/src/models/asset-editor.ts:49`), with `SUBAGENT` separate
at :48 — so subagents are excluded for free.

Chosen: a **wrapper component registered for both view types**, matching the pattern
`navigatorRegistry.tsx:13-16` documents ("component-per-view … keeps hooks unconditional").
Branching inside `AssetsNavigator` is not viable — it calls `useAssetsModel()` unconditionally at
line 17, so a branch would require a conditional hook.

## File-by-file changes

### New

| Path | What |
|---|---|
| `ui/src/components/assets/AssetsNavigatorSwitch.tsx` | Registry entry. Reads `currentDock`, returns `AgentResourcesNavigator` when `assetEditor === AssetEditor.AGENT`, else `AssetsNavigator`. No other hooks |
| `ui/src/components/navigator-panel/NavigatorSection.tsx` | The shared collapsible section (below). Lives with the panel — it is generic Zone-B chrome |
| `ui/src/components/agent-resources/AgentResourcesNavigator.tsx` | Builds the `NavigatorDescriptor` with `customBody`; renders `NavigatorPanel`. Direct analogue of `TriggersNavigator.tsx` |
| `ui/src/components/agent-resources/AgentResourcesBody.tsx` | The four sections; owns local (non-persisted) selection sets for Data sources and Docs |
| `ui/src/components/agent-resources/useDockAgent.ts` | Resolves the `Agent` from the URL |
| `ui/src/components/agent-resources/useWirableSkills.ts` | Skills listing |
| `ui/src/components/agent-resources/useAgentSkillsWiring.ts` | Read/write of `agent.skills` |
| `ui/src/components/agent-resources/useProjectDocs.ts` | Project-scoped markdown listing |

### Edited

| Path | Change |
|---|---|
| `ui/src/navigation/asset-doc-pointer-grammar.ts` | Add pure `assetEditorOf(pointer)` beside `assetEditorValue` (:65) — parses via existing `parseAssetDocPointer`, returns the editor for `AssetMode.EDITOR`, else `null` |
| `ui/src/navigation/DockPointer.ts` | Add `get assetEditor()` beside `wikiRef` (:2239), delegating through the existing private `assetSubPointer` (:2161) so the project-rebased form works |
| `ui/src/navigation/navigatorRegistry.tsx` | Lines 22-23: point `ASSETS` and `PROJECT` at `AssetsNavigatorSwitch` |
| `ui/src/components/assets/editor/agent-profile/AgentProfileEditor.tsx` | Delete lines **342-351** (the Skills and MCP servers `AgentListField`s) |
| `ui/src/components/assets/editor/agent-profile/AgentProfileFields.tsx` | Update the `AgentListField` docstring (:52-61) to stop naming `skills`/`mcp_servers` |
| `ui/src/components/data-sources/use-source-specs.ts` | Also return `isLoading` from `useEntitiesQuery` (one field; no behaviour change for the dialog) |

`NavigatorSlot.tsx` and `AssetsNavigator.tsx` are **unchanged** — the slot stays dumb, and the
assets navigator must be byte-identical everywhere else.

## The section component

```ts
interface NavigatorSectionProps {
  id: string;              // data-testid="navigator-section-<id>"
  label: string;           // already translated by the caller
  isLoading?: boolean;     // the default-open rule waits for this to clear
  itemCount: number;       // drives default-open ONLY — never rendered
  emptyState?: ReactNode;
  children: ReactNode;
}
```

- **No badge.** There is deliberately no count render path; leave `NavigatorHeader.countBadge` unset.
- **Default open iff non-empty, once.** Internal `settled` ref; the first time `!isLoading`, set
  `open = itemCount > 0`. Must fire on *settle*, not first render, or every section starts
  collapsed on a cold cache. A later emptying never re-collapses; a user toggle is never overridden.
- **RTL caret** — copy `CapabilitiesView.tsx:430-432` verbatim: only the **collapsed** caret gets
  `rtl:-scale-x-100`.
- Header markup mirrors `IntentSection` (`CapabilitiesView.tsx:422-446`) minus the badge; empty
  state uses the `SkillsAgentsPanel.tsx:195-197` idiom.
- Not built on `ui/collapsible.tsx` (animation container for no benefit) or `ui/accordion.tsx`
  (enforces single-open, contradicting "independently collapsible").

## Data flow per section

**1. Data sources** — consume `useSourceSpecs()`
(`ui/src/components/data-sources/use-source-specs.ts`) directly. It is the module-scope global
(`scope: []`) query whose docstring says it "replaced the hardcoded provider catalog" — this is the
ticket's single source of truth. Do not fork or re-scope it. Nine specs ship. Per-provider glyph via
`lucideByName(spec.icon_name)`; **never `spec.icon`** — it is a getter with no setter and assigning
it throws during hydration, blanking the whole query. Connected `DataSource` instances are out of
scope. Selection is a local `Set<string>` of `spec.name`, not persisted.

**2. MCP servers** — `itemCount={0}`, children `null`, empty state exactly `No MCP servers found`
via `<Trans>`. Starts collapsed, still expandable. When a real list lands, only `itemCount` and
`children` change; the write path mirrors Skills against `agent.mcp_servers`.

**3. Skills** — list via the `SkillsAgentsPanel.tsx:21-34` idiom
(`apiClient.get('/graph/skill?include_system=true')` + `dataManager.updateEntityFromJson`), which
exists precisely because the entity query drops SDK-shipped system skills. Pair with
`useEntityOps(['skill'], invalidate)` for liveness — no polling, no `refetchInterval`.

- Read: `checked = new Set(agent.skills).has(skill.typeId.toString())` — derived from the entity,
  never from a click.
- Write: mutate `agent.skills` and `await agent.save()`. That is the sanctioned writer for an
  `owns_main_ref` type — the backend re-renders `agent.md` from the entity fields. The pane cannot
  use `patchAgentDocument`: it has no `mainRef`, which is derived in `AssetEditorRouter.tsx:143-171`
  and must not be duplicated.
- **Entity-driven, not optimistic.** `useEntity(..., { watch: true })` flips the checkbox when the
  save lands; a per-row in-flight id `disabled`s just that checkbox meanwhile. A local mirror of
  `agent.skills` is how a failed write becomes a lie.
- **Unresolved entries** (a value matching no listed skill) render as a disabled, checked row
  showing the raw string. With the Advanced free-text box gone, this is the only way to see and
  remove a stale entry.
- Carry the declared-only sentence under the header.

**4. Docs** — `Markdown` carries `project_id`, so a live entity query works. Follow
`use-project-tasks.ts:34-52`: `QueryRequest({ type: Markdown.type, scope: [], name:
'agentResources:docs:<pid>', query: new QueryFilter({ match: { project_id }, order_by: { title:
'asc' }, limit: 500 }) })`. `order_by`/`limit` go **inside** `QueryFilter` — a top-level key becomes
a field predicate matching nothing. Project from the reactive `useProject()`, not `dataContext`.
Gate with `enabled: !!projectId`. Selection is a local `Set<string>` of `markdown.id`, not persisted.

Row icons for skills and docs come from `iconForType(type)` — never a hardcoded glyph.

**Resolving the agent** — the navigator is a *sibling* of the body, so no editor context reaches
it; resolve from the URL (which is the URL-first answer anyway). Un-rebase the project pointer the
way `useAssetsModel.tsx:125-130` does, parse it, then `useEntity` for the typeid form or
`useEntityByPath(..., { autoDiscover: false })` for the vfs form — with the `FSRef` **memoized**
(`AssetEditorRouter.tsx:136-140` documents what an unstable one costs). While the agent is null the
three read-only sections render normally and Skills renders with every checkbox disabled — the pane
never goes blank.

## Advanced-tab removal

Delete `AgentProfileEditor.tsx:342-351`. Keep Max turns, Tools, Disallowed tools, Sub-agents,
Additional directories — and keep the "Declared on the agent's card…" line at :317-319, still true
of the remaining fields. `AgentListField` stays (four call sites); `AgentDocumentPatch`'s
`skills`/`mcp_servers` keys stay (the type mirrors the Python model).

## Risks

- **Concurrent writes to `agent.md`.** `AgentProfileEditor.save` writes the file via `mainRef.write`
  and serializes only its own writes; the pane writes via `agent.save()`. A blur-commit racing a
  checkbox can lose an update. Mitigating: the editor's `Object.assign(agentRef.current, patch)`
  targets the same dataManager-cached instance the pane resolves. **Verify that instance identity
  holds for both routing methods before shipping**; if not, route the pane's write through the editor.
- **`Agent.save()` is lossier than `patchAgentDocument`** — `agent_default_body` renders only the
  spec fields plus the identity capsule, so YAML comments and unknown keys in a hand-authored
  `agent.md` are dropped on a toggle. Deliberate trade for not duplicating the router's `mainRef`
  derivation; lifting that into a shared hook is a separate ticket.
- Skills' `project_id` is unreliable for assets inside an attached checkout — which is why Skills
  does not use a `project_id` match and Docs may.
- Never raise a timeout/retry/debounce to settle anything. `staleTime: 30_000` matches the existing
  `SkillsAgentsPanel` precedent.

## Verification

Backend `uv run -m flow_sdk.server.run`; frontend `cd ui && npm run dev` (ports from `.env.local`).

1. Open Assets → Agents → `q`. Zone B shows the four sections; the tree is gone.
2. Data sources expands by default with 9 rows and per-provider glyphs. Rendering empty means the
   `spec.icon` trap.
3. MCP servers starts collapsed; expanding shows exactly `No MCP servers found`.
4. Skills expands by default with `q`'s existing `skill-ae32bd1d-…` checked. Toggle one on →
   `agentic-assets/agent/q/agent.md` gains `- skill-<uuid>` in **TypeId form**. Toggle off → removed.
5. Advanced tab has no Skills / MCP servers rows.
6. Visit a **subagent** editor, a skill editor, `/dock/assets/list/skill`, a wiki route, and project
   home — `AssetsNavigator` must be unchanged in all five.
7. Collapse the pane, reload → stays collapsed; the assets tree's own collapse state is untouched.
8. In an RTL locale, only the collapsed caret mirrors.

Tests: `npm run test:vitest:unit`, `test:vitest:react`, plus `type-check`, `lint`, and
`i18n:extract`. Extend `ui/tests/unit/navigation/AssetDocPointer.test.ts` (`assetEditorOf` cases),
`ui/tests/unit/dock-pointer-split-project.test.ts` (`assetEditor` for ASSETS and rebased PROJECT,
agent vs subagent), and `ui/tests/react/agent-profile-avatar.test.tsx` (assert Skills/MCP labels are
absent from Advanced). New: a `NavigatorSection` react test (default-open fires on settle, no badge,
user toggle survives a data change) and one asserting the checkbox writes `skill-<uuid>`.
No Playwright spec covers this area.

