---
id: 697610b8-0605-4836-b448-d137e239d0c7
title: Vibe Mode
---

# Vibe Mode — the simplest, creator-first "overlay" view mode

Vibe is the lowest tier of the **View mode** skin system (`Vibe ⊂ Standard ⊂
Advanced ⊂ Dev`, see [View Modes](../viewmodes.md)). It is a **Lovable-style
creator surface**: a centered "what do you want to build?" prompt that opens a
persistent **side chat next to a live "display"** — a web browser showing the app
the agent builds.

Vibe is deliberately built as a **pure overlay / lens** over the existing app,
not a fork. Turning Vibe on changes only **theme + layout + chrome** (see
[What Vibe changes](#what-vibe-changes)); turning
it off leaves no special machinery behind. It reuses the existing chat, viewer,
and navigation primitives wholesale, and — critically — changes **nothing** below
the UI layer: the agentic-process / PTY / session lifecycle is byte-for-byte
identical to Standard (see [Process semantics are unchanged](#process-semantics-are-unchanged-verified)).

> **Read the non-negotiable architecture below before touching Vibe.** The whole
> point is that Vibe drags no baggage into the shared surfaces.

## Architecture (non-negotiable)

1. **The URL is the standard agentic-process dock URL + the view mode.** A Vibe
   session rides the normal `/dock/shell/agentic_process-<id>` URL with
   `data-view="vibe"` on `<html>`. Vibe invents no route, no loader, no URL grammar.
2. **The viewer shown in the display NEVER touches the URL.** Display selection
   is local workspace state: an explicit `flow show` target (`on_show`, restored
   from `context_data.last_shown`) wins first, the agent's `FlowData.focus`
   stream is second, and the webapp preview is the fallback. None of these call
   `navigation.openDock`, so the URL is stable while the display switches viewers.
3. **No baggage.** The display resolves its data through the **existing**
   structured channels — project-scoped artifacts + `focus.metadata.port` fed into
   `useViewerStore.currentContext` (the exact channel `WebappViewer` already
   reads). No prose port-sniffing, no viewer-specific override props.
4. **MCP UI is a shown file target, not a Vibe URL.** A `.mcp.html` file shown
   with `flow show file` is restored from `context_data.last_shown`, rendered by
   `McpAppPreview`, read through a `ui://flowpad-local/...` MCP resource URI, and
   hosted in the backend sandbox proxy. See [MCP UI Architecture](../mcp-ui.md).
5. **Skin-layer rule** (from [View Modes](../viewmodes.md)): Vibe only changes
   *where/whether* things render + the theme — never data, hooks, or entity
   behavior. Layout differences use `VibeSwap` (slot-builder + two arrangements).

## What Vibe changes

Everything Vibe touches lives in the UI layer. Concretely:

1. **Theme** — the `[data-view='vibe']` token block in `index.css` (hub palette,
   blue accent, hero glow, Plus Jakarta Sans). Zero component edits.
2. **Layout / chrome** — no left rail (`flow-page.tsx`), a centered VibeHome empty
   state, and the chat↔display split (`VibeWorkspace`) on an active process. Layout
   forks go through `VibeSwap`, never through data/hooks.
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

- **Default is Standard; Vibe is opt-in.** `preferences.ui.view_mode` defaults to
  `standard` (`ts_sdk/src/preferences/prefRegistry.ts`). Users cycle into Vibe via
  the footer **View toggle** pill (`Vibe → Standard → Advanced → Vibe`;
  `ui/src/components/view-toggle/view-toggle.tsx`). `window.setView('vibe')` works too.
- **VibeHome** is the empty state: a centered hero ("Build something **amazing**")
  + the `SessionInput` prompt as the focal CTA. It is the `vibe` branch of a
  `VibeSwap` in `HomeLanding.tsx` — the full Standard 3-column home is the fallback
  and stays mounted-agnostic.
- **No left rail.** In Vibe, `flow-page.tsx` drops the `CollapsedSidebar`; the
  chat panel's header carries a "New" (back-to-VibeHome) affordance instead.

## The build flow

1. On VibeHome submit, `handleVibeSubmit` (`HomeLanding.tsx`) creates a **headless
   chat** `AgenticProcess` (`ComputeNode.createProcess({ processType: Chat,
   loadFlowpadAssistant: true, outputFormat: 'stream-json', targetVfsPath:
   project-<id> })`), sends the message **verbatim**, and navigates via the
   standard `navigation.openShellProcess(id)`.
   - `loadFlowpadAssistant` mounts the **web-app-builder** skill (via `--add-dir`)
     so "build me a web app" scaffolds a running dev server.
   - The message is sent verbatim — no forced build nudge — so "hi" is just a chat.
2. `flow-page.tsx` sees `isVibe` + an active agentic-process dock and renders the
   **VibeWorkspace** split instead of the single content panel.

## The workspace (side chat + display)

`ui/src/pages/flow-page/vibe-workspace.tsx` — a `ResizablePanelGroup`:

```
[ EntityExecutionPanel (chat, ~36%) | Display (~64%) ]
```

- **Chat** is the existing agentic-process chat UI — `EntityExecutionPanel` keyed
  by the project TypeId `target` (so it attaches to the process the home submit
  created). The "New" button rides its header via the additive `leadingSlot` prop.
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

**Conclusion:** the "pure overlay" hypothesis holds. Vibe changes theme, layout,
and chrome — and nothing about Assets-tab structure or process/session behavior.

## What Vibe deliberately does NOT do (scoped-out / follow-ups)

Matching the hub micro-app's **full** display (a tab dock + all ~17 viewer types +
deep-linkable view state) is gated behind a **URL dock-sync** change: it requires
the active `AgenticProcess` to stay anchored while the URL viewType changes, which
means touching the shared loaders / `agent-layout` / `useActiveViewer` — core
navigation infra used app-wide. That is intentionally **out of scope**; Vibe uses
the local focus-driven store instead (principle #2). Also deferred: extracting a
shared `useImagePasteUploader` hook + `inputDirReferenceLine` formatter (the
paste-to-input-dir logic is currently duplicated with the interactive terminal),
and pushing paste into `CompactExecutionInput` itself.

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
| MCP UI host for `.mcp.html` display targets | `ui/src/components/mcp-app-preview/McpAppPreview.tsx` |
| MCP UI resource and sandbox helpers | `ui/src/lib/mcp-app-resources.ts`, `ui/src/lib/mcp-sandbox.ts` |
| Curated chrome-less surfaces | `ui/src/pages/flow-page/content-panel/content-panel.tsx` (`VIBE_CREATOR_SURFACES`) |
| Chat (leadingSlot, image paste) | `ui/src/components/entity-execution-panel/EntityExecutionPanel.tsx` |
| Display / web preview | `ui/src/components/webapp-viewer.tsx` |
| Port → host resolution | `ui/src/hooks/flow-hooks/useProcessWebApp.ts` |
| `get-host` backend action | `flow_sdk/builtin/agentic_process/agentic_process.py` |
| web-app-builder skill | `flow_sdk/system_projects/flowpad_assistant/.claude/skills/web-app-builder/` |

## Gotchas

- **Chat target is the id-based TypeId.** Use `new TypeId(Project.type,
  project.id)`, **not** `project.typeId` (which is the uname form
  `project-@local`) — VibeHome's created process and VibeWorkspace's chat must key
  off the same string or the chat won't attach.
- **Preview reliability depends on the agent emitting the `flow-result` artifact.**
  The prose port-sniffer was deliberately removed; if the preview stays empty, the
  fix is skill/prompt compliance, not re-adding a sniffer.
- **The `h-9` aligned header is scoped to `leadingSlot`**, so other
  `EntityExecutionPanel` consumers keep their content-sized header.
</content>
