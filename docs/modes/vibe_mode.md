---
id: 697610b8-0605-4836-b448-d137e239d0c7
title: Vibe Mode
---

# Vibe Mode — the creator-first workspace mode

Vibe is the lowest tier of the **View mode** skin system (`Vibe ⊂ Standard ⊂
Advanced ⊂ Dev`, see [View Modes](../viewmodes.md)). It is a **Lovable-style
creator surface**: a centered "what do you want to build?" prompt that opens a
persistent **side chat next to a live "display"** — a web browser showing the app
the agent builds.

Vibe is a workspace presentation over the existing app, not a parallel asset
system. It reuses the standard URL, loaders, tabs, chat, viewers, and process
lifecycle. An asset or file can transition in place from Standard into a
target-specific Vibe chat while keeping the same content surface mounted.

> **Read the non-negotiable architecture below before touching Vibe.** The whole
> point is that Vibe drags no baggage into the shared surfaces.

## Architecture (non-negotiable)

1. **The URL is the standard agentic-process dock URL + the view mode.** A Vibe
   session rides the normal `/dock/shell/agentic_process-<id>` URL, with the mode
   carried by the `?viewMode` search param and reflected as `data-view="vibe"` on
   `<html>`. Vibe invents no route, no loader, no URL grammar — one process is ONE
   `Tab` identity in every mode. (A per-mode URL family was tried and collapsed;
   see [Vibe Display surface](../tabs/display.md) §3.)
2. **Navigation stays URL-first.** Entering Vibe changes only the current dock's
   `viewMode` option. A `flow show` target pins the Display pane — local process
   state, no URL change. When it is opened as a child dock instead, that goes
   through `navigation.openDock` and its loader is the only context writer.
3. **No baggage.** The display resolves its data through the **existing**
   structured channels — project-scoped artifacts + `focus.metadata.port` fed into
   `useViewerStore.currentContext` (the exact channel `WebappViewer` already
   reads). No prose port-sniffing, no viewer-specific override props.
4. **MCP UI is a shown file target, not a Vibe URL.** A `.mcp.html` file shown
   with `flow show file` is restored from `context_data.last_shown`, rendered by
   `McpAppPreview`, read through a `ui://flowpad-local/...` MCP resource URI, and
   hosted in the backend sandbox proxy. See [MCP UI Architecture](../mcp-ui.md).
5. **One stable asset host.** Asset/file docks render through
   `AssetVibeWorkspace` in both modes. Standard collapses the chat panel; Vibe
   expands it beside the unchanged `ContentPanel`. This preserves editor
   identity and dirty buffers across the transition.

## What Vibe changes

Everything Vibe touches lives in the UI layer. Concretely:

1. **Theme** — the `[data-view='vibe']` token block in `index.css` (hub palette,
   blue accent, hero glow, Plus Jakarta Sans).
2. **Layout / chrome** — a centered VibeHome empty state, the process
   chat↔Display split, and the asset chat↔content split. The shared left rail
   retains its reserved footprint in every mode.
3. **Chrome-less creator surfaces** — on the curated `VIBE_CREATOR_SURFACES`
   ViewTypes (`content-panel.tsx`), Vibe strips the tab strip + navigator. Any
   *other* surface keeps normal Standard chrome even in Vibe.
4. **Assets tabs keep their Standard structure** — opening an Assets tab in Vibe
   renders the same Standard asset catalog and navigator, so a deep-linked asset
   can expand its type and select its row. The Vibe skin may change the surrounding
   chrome, but it does not remove rows from an already-open Assets tab. Advanced-
   and Dev-only types remain gated at their normal tiers.

That is the whole surface area. See below for what it explicitly does not touch.

## Entering Vibe

- **Vibe is the default.** `preferences.ui.view_mode` defaults to `vibe`
  (`ts_sdk/src/preferences/prefRegistry.ts` — the ONE place the default lives);
  users opt *up* to Chat/Terminal/Dev. The footer control is a segmented **mode
  selector**, labelled by the surface each mode shows rather than by rank — Vibe,
  Chat (`standard`), Terminal (`advanced`), Dev
  (`ui/src/components/view-toggle/view-toggle.tsx`). `window.setView('vibe')` works too.
  Selection is URL-first: on a dock route the click only
  `openDock(currentDock.withViewMode(next))`; pointerless routes write the
  preference directly.
- **VibeHome** is the empty state: a centered hero ("Build something **amazing**")
  + the `SessionInput` prompt as the focal CTA. It is the `vibe` branch of a
  `VibeSwap` in `HomeLanding.tsx` — the full Standard 3-column home is the fallback
  and stays mounted-agnostic.
- **Asset entry is local and explicit.** Every single asset/file content dock
  shows a MessageSquare **Discuss** action. It calls only
  `navigation.openDock(currentDock.withViewMode(ViewMode.Vibe))`.

## Asset/file → Vibe

Asset-origin Vibe is target-specific:

1. The normal asset URL loader materializes or reuses its tab.
2. The cold-parent resolver derives the exact target (resolved entity TypeId,
   otherwise compute-node VFS path), finds the newest Chat with the same
   `project_id + target_typeid_str`, or creates a headless Chat.
3. The asset tab adopts that process tab as `parent_tab_id`.
4. `FlowPage` keeps `AssetVibeWorkspace` mounted and expands the chat panel over
   280 ms (`prefers-reduced-motion` disables the transition).
5. The first prompt carries a one-shot context naming the exact active
   TypeId/path. Update/refactor requests therefore apply to the original asset.
6. `flow show` of a created or related asset materializes and focuses another
   child tab while the parent Chat remains authoritative.

Backend transcript flushes emit `file.write` for every file type and schedule a
deduplicated reindex batch immediately. The workspace bridges that event into
the canonical FS cache invalidation channel. Clean Markdown/source/HTML/media/
PDF viewers refresh while the turn is running; dirty local editor buffers are
not overwritten.

## The build flow

1. On VibeHome submit, `handleVibeSubmit` (`HomeLanding.tsx`) creates a **headless
   chat** `AgenticProcess` (`ComputeNode.createProcess({ processType: Chat,
   loadFlowpadAssistant: true, outputFormat: 'stream-json', targetVfsPath:
   project-<id> })`), sends the message **verbatim**, and navigates via the
   standard `navigation.openShellProcess(id)`.
   - `loadFlowpadAssistant` mounts the **web-app-builder** skill (via `--add-dir`)
     so "build me a web app" scaffolds a running dev server.
   - The message is sent verbatim — no forced build nudge — so "hi" is just a chat.
   - `embedVibeAgent` embeds the persona that carries the `flow show` contract:
     the **SubAgent** `vibe` (`.claude/agents/vibe.md`, `scope: system`) — NOT the
     launchable **Agent** of the same name (`agentic-assets/agent/vibe/agent.md`),
     a ~20-line haiku front in the internal-agents family. Two assets, one word;
     resolving by bare name picked the wrong one and every session ran a generic
     "you are the project assistant" prompt, presenting deliverables with
     `open <file>` into the user's browser instead of `flow show`. Verify a
     session by its materialized `CLAUDE.md`: it must read *"You are the 'vibe'
     agent"*, not *"the 'agent' agent"*.
2. `flow-page.tsx` sees `isVibe` + an active agentic-process dock and renders the
   **VibeWorkspace** split instead of the single content panel.

## The workspace (side chat + display)

`ui/src/pages/flow-page/vibe-workspace.tsx` — a `ResizablePanelGroup`:

```
[ EntityExecutionPanel (chat, ~36%) | Display (~64%) ]
```

- **Chat** is the existing agentic-process chat UI. Process-home sessions use
  their existing target; asset-origin sessions are keyed by the exact
  `target_typeid_str`. The standard New/Recent session controls remain present.
- **Display** is a preview-first viewer switch that **reuses the existing viewer
  components** (`WebappViewer` / `CodeEditor` / `DiffViewer`) plus the MCP App
  preview host for `.mcp.html` files. It defaults to the web preview.
- **Display selection:** explicit `flow show` targets pin the display and are
  restored from `context_data.last_shown`; stream focus is only the secondary
  signal for code/diff/write noise. The web preview is the fallback when neither
  exists.
- **Focus → display wiring:** `useVibeFocus` reads the most-recent `FlowData.focus`
  off the `AgenticProcess` stream (`focus` + `data.path` + `data.metadata.port` —
  the same fields the shared `useActiveViewer.focusFromStream` reads) and writes
  the port into `useViewerStore.setCurrentContext({ viewerOptions: { port } })`
  when no shown webapp target overrides it. `WebappViewer` reads that port (its
  existing `currentContext` priority), builds the `get-host` iframe URL, and
  renders the running app. **No URL change.**

### The live preview plumbing (all pre-existing, reused)

`WebappViewer → PersistentIframe → get-host?port=<n> → localhost:<port>`:

- The web-app-builder skill reports its running service as a `<flow-result
  type="webapp" port=… focus="web-app"/>`, which becomes a **project-scoped WEBAPP
  artifact** (`useCurrentArtifacts`) carrying `metadata.port`.
- `useProcessWebApp` builds the iframe URL via the backend **`get-host`** action.
  That action was ported to the `AgenticProcess` entity
  (`flow_sdk/builtin/agentic_process/agentic_process.py`) because the legacy `Flow`
  entity was removed — `useProcessWebApp` targets `AgenticProcess.type`.
- When a WEBAPP artifact is received through a git-backed share, the artifact row
  is a declaration plus `GitOrigin`, not a copied sender path. Opening it first
  resolves the checkout via `resolve-git-location`; if the repo is missing, the
  generic git setup wizard opens and returns the local checkout/project before
  the preview proceeds.

### MCP UI plumbing (shown `.mcp.html` files)

MCP UI uses the same `flow show` pin as other display targets, but it renders
through a dedicated MCP Apps host instead of the webapp preview:

`flow show file <path.mcp.html> → context_data.last_shown → VibeWorkspace →
McpAppPreview → @mcp-ui/client → backend sandbox proxy`

The process dock URL stays the workspace URL. The shown file path becomes an
internal `ui://flowpad-local/...` resource URI; that URI is resolved through
`onReadResource` and `FSRef`, not through browser navigation. The iframe itself
loads `/mcp-sandbox/sandbox_proxy.html` from the backend origin and receives the
guest HTML through MCP Apps JSON-RPC. Submissions come back as `ui/message` and
are delivered to the same `AgenticProcess` as a prompt once the process is idle.

## Theme (hub palette)

`[data-view='vibe']` in `ui/src/styles/index.css` re-skins every shadcn primitive
via CSS tokens with zero component edits. It matches the **hub micro-app**, not
Lovable:

- **Neutral near-black canvas** (no warm tint).
- **Hub brand blue** (`#0f52d7`/`#3474fa`) as the only accent (`--primary`,
  `--ring`).
- **Subtle blue radial hero glow** (`.vibe-hero-gradient`, mirroring the hub's
  `ParallaxBackground`) — not a multi-hue Lovable wash.
- Display font **Plus Jakarta Sans**, lazy-injected only on first Vibe activation
  (`ensureVibeFont` in `view-mode-context.tsx`) so non-Vibe users pay no
  render-blocking font fetch.

## Reused primitives (no forks)

`EntityExecutionPanel` (chat + image paste + session history), `WebappViewer` /
`CodeEditor` / `DiffViewer` (display), `useViewerStore` / `useCurrentArtifacts` /
`useProcessWebApp` (viewer wiring), `SessionInput` (home prompt), `VibeSwap` (the
Vibe-tier analog of `ViewSwap`/`AdvancedOnly`), the `get-host` action, and the
`ViewToggle`. Image paste is wired at the `EntityExecutionPanel` layer, so it
works in the Vibe chat and every other `EntityExecutionPanel` consumer.

## Process semantics are unchanged (verified)

Vibe does **not** leak below the UI layer. The build session VibeHome seeds is an
ordinary headless chat process:

- `handleVibeSubmit` (`HomeLanding.tsx`) calls the **standard**
  `ComputeNode.createProcess({ processType: Chat, loadFlowpadAssistant: true,
  outputFormat: 'stream-json', targetVfsPath: project-<id> })`. Every argument is a
  general `createProcess` option used elsewhere in the app — none is Vibe-specific,
  and none is read off the view mode. It then sends the message verbatim and
  navigates via the shared `navigation.openShellProcess(id)`.
- The backend has **no** concept of Vibe. A repo-wide search finds exactly one
  backend mention of "Vibe": a comment on the `get-host` action in
  `flow_sdk/builtin/agentic_process/agentic_process.py:3933` explaining that the
  in-app preview / Vibe display consumes it. No spawn path, default, or lifecycle
  branch keys off view mode; the backend `ViewMode` enum doesn't even contain
  `vibe`.
- Headless↔PTY toggling, resume, session history, and process lifecycle are the
  shared `EntityExecutionPanel` / agentic-process machinery, identical to Standard.
  The **only** Vibe-specific wiring is `useVibeFocus` reading the agent's `focus`
  stream to pick which *viewer* the display shows — and that never touches the URL
  or the process (principle #2).

**Conclusion:** Vibe is still built from shared primitives, but asset-origin
workspaces intentionally add target-specific process grouping and live
invalidation below the visual skin. They do not fork asset viewers or loaders.

## What Vibe deliberately does NOT do (scoped-out / follow-ups)

Concurrent manual and agent edits to the same dirty buffer do not yet have merge
or conflict UX. Live invalidation deliberately preserves the dirty buffer.
Projectless asset entry also requires a project before a Chat can be created.

## Key files

| Concern | File |
| --- | --- |
| View-mode tier + `data-view` + lazy font | `ui/src/contexts/view-mode-context.tsx` |
| Layout swap primitive | `ui/src/components/view-mode/VibeSwap.tsx` |
| Footer toggle | `ui/src/components/view-toggle/view-toggle.tsx` |
| Theme (hub palette + gradients) | `ui/src/styles/index.css` (`[data-view='vibe']`) |
| VibeHome + build submit | `ui/src/pages/home-landing/HomeLanding.tsx` |
| Overlay shell (no rail, split vs home) | `ui/src/pages/flow-page/flow-page.tsx` |
| The chat↔display split + focus reader | `ui/src/pages/flow-page/vibe-workspace.tsx` |
| Stable asset chat↔content host | `ui/src/pages/flow-page/asset-vibe-workspace.tsx` |
| Asset classification and process target | `ui/src/navigation/content-asset-dock.ts` |
| Cold parent/process reuse | `ui/src/tabs/vibe-parent.ts`, `ui/src/pages/flow-page/vibe-process-resolver.ts` |
| Live file revisions | `ts_sdk/src/stores/fsStore.ts`, `ui/src/hooks/useFS.ts` |
| MCP UI host for `.mcp.html` display targets | `ui/src/components/mcp-app-preview/McpAppPreview.tsx` |
| MCP UI resource and sandbox helpers | `ui/src/lib/mcp-app-resources.ts`, `ui/src/lib/mcp-sandbox.ts` |
| Curated chrome-less surfaces | `ui/src/pages/flow-page/content-panel/content-panel.tsx` (`VIBE_CREATOR_SURFACES`) |
| Chat (leadingSlot, image paste) | `ui/src/components/entity-execution-panel/EntityExecutionPanel.tsx` |
| Display / web preview | `ui/src/components/webapp-viewer.tsx` |
| Port → host resolution | `ui/src/hooks/flow-hooks/useProcessWebApp.ts` |
| `get-host` backend action | `flow_sdk/builtin/agentic_process/agentic_process.py` |
| web-app-builder skill | `flow_sdk/system_projects/flowpad_assistant/.claude/skills/web-app-builder/` |

## Gotchas

- **Chat targets must match the entry surface.** VibeHome uses the id-based
  Project TypeId. Asset-origin Vibe uses the resolved asset TypeId or canonical
  compute-node VFS path. Do not substitute `project-@local` for either.
- **Preview reliability depends on the agent emitting the `flow-result` artifact.**
  The prose port-sniffer was deliberately removed; if the preview stays empty, the
  fix is skill/prompt compliance, not re-adding a sniffer.
- **The `h-9` aligned header is scoped to `leadingSlot`**, so other
  `EntityExecutionPanel` consumers keep their content-sized header.
</content>
