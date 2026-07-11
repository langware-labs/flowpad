---
id: d215fd9c-7e72-484c-821f-459b976c1928
title: Global Display Capabilities — Survey & Open Questions
status: open-question
---

# Global Display Capabilities — Survey & Open Questions

A full-codebase enumeration of every way Flowpad displays content — files by
type, assets/entities, webapps, artifacts, and foreign HTML — plus the open
design questions it surfaces. Snapshot as of 0.2.94-fixes.

## 1. The model at a glance

Everything displayable flows through one of **two address systems** that meet
in the same viewer components:

1. **URL-first dock pointers** (user clicks): `click → navigation.openDock →
   /dock/<viewType>/<pointer> → route loader → ContentPanel switch → viewer`.
   Grammar owned by `DockPointer` (`ui/src/navigation/DockPointer.ts`);
   master render switch `content-panel.tsx:230-402`.
2. **Agent show targets** (`flow show`): `show entity|file|webapp →
   resolve_display_target (typeid | path | port) → AgenticProcess.on_show →
   display_stack/last_shown → VibeWorkspace routing → viewer`.
   Resolver `flow_sdk/core/display_target.py:43-98`; FSM
   `agentic_process.py:2084-2146`; frontend routing
   `vibe-workspace.tsx:369-524`.

Viewer **dispatch is purely frontend**. The backend `TypeInfo` registry
carries icon (`TypeInfo.icon`, consumed by `iconForType`), `browseable_by`
view-mode, and filesystem-shape hints (`main_layout`/`main_file`/`main_ext`)
— but **no viewer/editor hint**.

## 2. Files by extension

The extension→viewer rule is deliberately minimal and lives in ONE place —
`ts_sdk/src/models/asset-editor.ts:68` `editorForPath`:

| Extension | Viewer (normal open) | Viewer (vibe `flow show file`) |
|---|---|---|
| `.md` / `.markdown` | `PlainMarkdownAssetEditor` (markdown editor) | same |
| `.mcp.html` | *(no special case — code editor)* | `McpAppPreview` (MCP-app sandbox, agent bridge) — `vibe-workspace.tsx:93` |
| `.html` / `.htm` | **CodeEditor (source view)** | **`HtmlPreview` (live, sandboxed srcDoc)** |
| images (`isImagePath`) | ad-hoc `<img>` inside CodeEditor (`EditorPane.tsx:102`) | **no branch — falls to CodeEditor as text** |
| everything else | `CodeEditor` | `CodeEditor` via `editorForPath` |

Notes: `.jsonl` transcripts are never opened by extension — they route through
the Lens (`/dock/lens/<worker>/transcript/<ref>` → `TranscriptViewer`).
Whiteboards have **no** `.excalidraw` extension handling — they are
folder-backed entities opened by TypeId. Folders are browsed
(`ViewType.ASSETS` folder/fs pointers), never "opened".

## 3. Assets / entities

Three registries decide how an entity opens, kept in agreement **manually**:

1. **`EDITOR_TYPES` / `TYPE_TO_EDITOR`** (`ts_sdk/src/models/asset-editor.ts:24-47`)
   — record type → AssetEditor. Editors: code, markdown (markdown, claude_md,
   claude_memory, claude_rules, command, plan, prompt), agent, skill, task,
   workflow, whiteboard, agent_trace, dynamic_workflow, usage_report,
   asset_cleanup_report. Rendered by `AssetEditorRouter.tsx:153`.
2. **Per-entity `dockPointer` getters** (SDK) — `APIEntity.dockPointer`
   default is `ViewType.HOME` (`APIEntity.ts:481`); asset types override via
   `assetEditorPointer` (`:503`); process/shell/conversation/etc. have bespoke
   overrides (`agentic-process.ts:805-881`, `shell.ts:107`, …).
3. **`RECORD_TYPE_NAV`** (`ui/src/navigation/record-type-nav.ts:93-299`) —
   search-tile/favorites navigation per record type, including async
   resolutions (worker sessions → owning process).

Addressing grammar: `editor/<AssetEditor>/<vfs|typeid>/<value>`
(`AssetDocPointer`), plus browser-only pointers `list/<type>`,
`folder/<type>/<typeid>/<relPath>`, `fs/<relPath>`, `wiki/<space>/<name>`,
`project-home` (`AssetsPage.tsx:82-124`). Read/write channel: entity
`asset_ref` → `FSRef` (+`useEntityByPath`), never raw fsManager calls.

Full dock-route inventory (ContentPanel switch): shell, editor, web_app, diff
(+asset-compare), markdown, survey, system_profile, environment, connections,
api_keys, ai_config, hooks, artifacts, docs, plan, assistance, machine,
explorer, triggers/cron, capabilities, execute_flow, **show**, **apps**,
graph, k-browser, **lens** (9 sub-lenses), tasks (redirect), settings,
preferences, desktop, search, workflows, agentic_process, **display** (vibe
layout only), assets, project, inbox, conversation, spec, graph_context,
diagnosis, home. Every route has a chrome-less `/win/` twin (same tabHash).

## 4. Webapps & artifacts

- `flow show webapp --port N` → `{kind: webapp, port}` → `PersistentIframe`
  (src via `get-host` action redirect; global iframe registry keyed by src;
  liveness = client-side fetch probe only).
- `flow app open` → discovers/starts a dev server → `register-webapp-artifact`
  action (creates/updates a project-scoped WEBAPP `Artifact`, `show:true` by
  default) — artifacts drive `WebappViewer`'s selector/restart chrome.
- HTML deliverables (`.html` via show) are display-only; they are NOT
  artifacts and have no registration/restart story.

## 5. Foreign HTML — the four trust tiers

| Tier | Surface | Origin model | Powers |
|---|---|---|---|
| 1 (most locked) | `HtmlPreview` — shown `.html` | `srcDoc` + `sandbox="allow-scripts"` only → **opaque origin** | scripts only; no network to API (no CORS), no storage, no bridge |
| 2 | MCP sandbox — `McpAppPreview` (vibe), `ShowView` (`/dock/show`, skill `ui/<component>.html`), `AppHost` (`/dock/apps/<uname>`) | backend-origin `sandbox_proxy.html`, per-request CSP (`_sandbox_csp`, default `connect-src 'none'`) | JSON-RPC bridge; only the vibe `.mcp.html` path routes `ui/message` back to the agent; guest tool calls stubbed everywhere |
| 3 | `PersistentIframe` — webapp by port | real origin, `allow-same-origin allow-scripts allow-forms allow-popups …` + broad `allow=` list | full browser powers on its own origin |
| 4 (full) | Bespoke asset editors / native views | app origin, no iframe | full app access |

No host currently passes `csp`/`connectDomains` to the sandbox proxy, so tier
2's network is always fully closed in practice.

## 6. Backend serving surfaces

- SPA index + deep-link fallback with `__FLOWPAD_API_URL__` injection
  (`ui.py:49-74`, `app.py:601`).
- `/assets/*` hashed bundle; explicit public root files (favicon/logo/ws-test).
- `/mcp-sandbox/sandbox_proxy.html` — the only CSP-bearing surface.
- **`MicroApp.view`** (`faas/micro_app.py:145`) — the ONLY raw-bytes/MIME
  path in the backend (ETag/304, streaming, `<base>` injection for HTML,
  traversal-guarded). `view_external_domain` + `WebDomain` host routing are a
  cloud seam with **no OSS caller**.
- `/sdk` mount (`app.py:582`) — **dead**: `server/static/sdk/` is empty; no
  build step populates it (intended `/sdk/flowpad-sdk.js`).
- Everything else (fs-records, assets.py, transcripts, docs-graph) serves
  JSON envelopes, not displayable bytes.

## 7. Gaps & inconsistencies (consolidated)

1. **`.html` split-brain**: source view on normal open, live preview only in
   vibe. Same file, two behaviors by entry path.
2. **No image display in the show path** — `flow show file chart.png` renders
   binary as text in CodeEditor; the only image handling is ad-hoc inside the
   code editor.
3. **Sandbox tiers are implicit** — nothing in the address (pointer/target)
   states the trust tier; it's an emergent property of extension + surface.
   The webapp iframe (tier 3) is the most privileged and hosts arbitrary
   agent-started servers, while a static `.html` (strictly less dangerous)
   gets tier 1.
4. **Entity-with-no-editor dead ends**: `dataset` is creatable+browseable but
   has no editor and no `dockPointer` override → opens to HOME. A shown
   entity with no editor and no path silently falls through to the webapp
   fallback (`vibe-workspace.tsx:487`).
5. **Registry drift risk**: type↔editor mapping exists in `TYPE_TO_EDITOR`
   (SDK) and `RECORD_TYPE_NAV` (UI); entity icons come from backend
   `TypeInfo.icon` but viewer/tab icons from a separate hardcoded
   `VIEWER_REGISTRY` — parallel systems kept aligned by hand.
6. **No unified refresh contract**: webapp iframe reloads on
   `showNonce+refreshStamp`; Html/McpApp previews only on React key remount;
   asset editors on turn-edge remount.
7. **`show` is fire-and-forget**: exit 0 ≠ presented (documented), no
   feedback channel to the agent; port targets are never liveness-checked at
   resolve time.
8. **Dead ViewType members** (`SKILLS`, `SESSION`, `TASKS`, `ANALYSIS`, …)
   retained for persisted-pointer back-compat.
9. **MCP host duplication**: ShowView and AppHost share near-identical
   AppRenderer scaffolding; both stub `onCallTool`.
10. **`/sdk` mount dead**; `view_external_domain` vestigial in OSS.

## 8. Open questions

1. **Trust tiers as a first-class concept?** Should the display address carry
   an explicit trust/serving tier (preview | sandboxed-app | served-app |
   native) instead of inferring it from extension+surface? Concretely: a
   `flow show file <x.html> --serve` (or `served-html` DisplayTargetKind)
   that mounts the file on the backend origin (ephemeral MicroApp) and
   renders via the tier-3 iframe — enabling SDK-powered HTML apps — while
   plain `show file *.html` stays tier 1. (Origin discussion: SDK-in-HTML
   demo analysis, 2026-07.)
2. **Should tier 2 ever get network?** The `csp`/`connectDomains` lever
   exists end-to-end but is never used. Is a scoped grant (backend origin
   only, token-limited API) the sanctioned way for MCP apps to read data, or
   do we keep tier 2 permanently offline and push data through the bridge?
3. **Who owns viewer dispatch?** Today it's three frontend registries +
   per-entity getters. Should `TypeInfo` grow a display hint (viewer/editor
   name) so backend-registered types can't become unopenable (the `dataset`
   hole), mirroring how icons already work?
4. **Extension registry**: do we want a single extension→viewer table
   (images, html, mcp.html, jsonl, md, code) shared by openFile, vibe show,
   and explorer — replacing today's scattered special cases?
5. **HTML deliverables as artifacts?** Webapps get registration, restart, and
   history via WEBAPP artifacts; shown `.html` files get nothing. Should
   there be an HTML/report artifact kind with the same lifecycle?
6. **`/sdk` publishing**: build+ship `flowpad-sdk.js` into `server/static/sdk`
   (plus a slim non-React entry), or delete the mount?
7. **Show feedback**: should `on_show` report back whether a display actually
   mounted (watcher count), so agents can tell a deliverable was presented?
