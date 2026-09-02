# Data Sources UI (Frontend)

The Data Sources screen (`ViewType.DATA_SOURCES`, rail entry in
`collapsed-sidebar.tsx`, mounted lazily by `content-panel.tsx`) lists the
configured `DataSource` entities, lets the user add/edit/pause/replay/delete
one, and shows whether each is actually alive. Everything lives under
`ui/src/components/data-sources/`. The backend model it renders is described in
`data-sources.md`; this page covers only the frontend surface.

## Components

| File | Role |
|------|------|
| `DataSourcesView.tsx` | The grid. Owns the one instance each of the add/edit dialog, the replay dialog and the delete confirm ("list holds a nullable pending target, rows hold no dialog"). Deliberately does **not** query cursors. |
| `DataSourceCard.tsx` | One source: lifecycle chip, health, `synced …` / `next …` countdown, the parked warning, the setup panel with **Verify**, the **Pull changes** button, and an expandable stream list. |
| `DataSourceDialog.tsx` | Add/edit form driven entirely by the installed `DataSourceSpec`s. Writes `name`, `provider`, `account_key`, `config`, `status`, `poll_interval_seconds`, `window_days`; never `kind` or `channel` (the driver sets those on first poll). |
| `SourceMenu.tsx` | The "more" menu: pause/resume, edit, replay, open a spec-shipped editor app, Events, Runs, delete. |
| `SourceStreams.tsx` | Rows for the source's `DataSourceCursor`s (segment label, health, failure count, last sync). |
| `ReplayDialog.tsx` | Optional `since` date, then `source.replay(since)`. |
| `use-source-specs.ts` | `sourcesQuery` (shared with the inbox) and `useSourceSpecs()` → `{ specs, specFor(provider) }`. |
| `source-form.ts` | Pure draft/validation helpers (`emptyDraft`, `specFields`, `validateDraft`, `buildConfig`, `accountKeyFor`); unit-tested in `ui/tests/unit/data-source-form.test.ts`. |
| `status-style.ts`, `health-style.ts` | Chip label/colour tables keyed by `SourceStatus` and `SourceHealth`. |
| `useAttentionPolling.ts` | Used by `ConversationView`, not by this screen: while a conversation bound to a source is the selected dock, calls `source.requestPoll()` every 25 s. |

## Entities, queries and actions (all through `dataManager`)

No file in this folder touches a backend URL, `fetch`, or `__API_URL__`; every
call is an entity query or an entity action.

**Queries** (`useEntitiesQuery` over a `QueryRequest`, all `scope: []` because a
source is a property of the instance, not of a project):

- `data-sources:list` — `DataSource.type` (in `use-source-specs.ts`, shared with the inbox's channel attribution).
- `data-sources:specs` — `DataSourceSpec.type`, the installed definitions. This replaced a hardcoded provider catalog: a spec added as an asset appears with no frontend release.
- `data-sources:cursors:<id>` — `DataSourceCursor.type` filtered by `data_source_id`, created per card but `enabled` only while the card is expanded, so a collapsed grid watches nothing.

**Writes** are entity saves: `new DataSource({...}).save()` (create, with
`status: 'new'` so the backend resolves `setup` vs `active`), `editing.save()`
followed by `markEdit()` when something changed, and `source.delete()` (the
backend `delete_by_id` override cascades streams and items; the view then
`refetch()`es because a delete is the one mutation the live query does not see).

**Actions** are `DataSource` methods in `ts_sdk/src/entities/data-source.ts`,
each `this.post('<action>')` → `dataManager.callAction(ActionInfo)` →
`POST /api/v1/graph/data_source/<id>/<action>`, matching the
`@core_action.post` handlers in `flow_sdk/builtin/data_source.py`:

| TS method | Backend action | Called from |
|-----------|----------------|-------------|
| `pollNow()` | `poll_now` | card **Pull changes** |
| `verify()` | `verify` | card **Verify** (setup panel) |
| `replay(since?)` | `replay` | `ReplayDialog` |
| `requestPoll()` | `request_poll` | `useAttentionPolling` |
| `resetCursors()`, `purgeItems()` | `reset_cursors`, `purge_items` | not wired to this screen |

Pause/resume is not an action: the card sets `status` to `'disabled'` or back to
`'new'` and saves. "Connect" is the dialog's save; the config form is the
spec's `config` map (`specFields(spec)` → `Object.entries(spec.config)`). There is no reflect verb in the UI — `reflect` is a
`DataSourceSpec` property (`ReflectMode`, `flow_sdk/ingest/reflect.py`) consumed
by the ingest pipeline, not something the user triggers here.

## URL-first navigation

The screen never writes `dataContext` before navigating. The only navigation it
performs is in `SourceMenu`, and each item is a single
`navigation.openDock(DockPointer…)` call:

- `DockPointer.forAppEntity(app.typeId, { source: source.id })` for each editor app shipped as a child asset of the spec (`useAssetApps(spec?.typeId)`); the app reads the source id off its own query string.
- `DockPointer.forEvents(undefined, { target: 'data_source:<id>' })` — the Events view narrowed to this source.
- `DockPointer.forProcessRuns({ data_source_id })` — the Runs view.

`useAttentionPolling` reads the URL the same way (`DockPointer.fromUrl(location)`)
to decide whether its conversation is the selected one.

## How status and health are rendered

Two axes, shown together because they disagree in the interesting cases:

- `status` (`new` / `setup` / `active` / `disabled`) is "should this run"; `health` (`never_synced` / `ok` / `transient_error` / `config_error`) is "does it work".
- The chip and the card's left border use `healthStyle(source.health)` when the source `isActive`, else `statusStyle(source.status)` — health on a source that is not running describes the last time it ran and is stale by construction.
- `needsSetup` (`status === 'setup'`) opens the amber setup panel with `setup_detail`, a `WikiButton` to the spec's `setup_wiki`, and **Verify**; **Pull changes** is disabled until verified.
- `parked` (`isActive && health === 'config_error'`) shows a red note: the scheduler skips a `config_error` source, and **Pull changes** clears the latch.
- The card icon is the spec's `channel_icon_names[channel]`, else the spec's `icon_name` (both via `lucideByName`), else `iconForType(DataSource.type)` from the registry. The view header and the `ViewType` tab chip use the registry glyph (`Antenna`, matching the backend `TypeInfo.icon`).
- Every verb reports through `notify` toasts; a not-ready `verify()` is an info toast, not an error.
