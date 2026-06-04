---
id: 9d2a4c0e-1f8b-4e5a-9c11-880088008800
type: workflow
name: whiteboard_multi_tab
description: Whiteboard X1 — concurrent edit in two browser tabs (documented single-user / last-write-wins limitation)
tags: [whiteboard, multi-tab]
---

# Whiteboard — Multi-tab (X1)

## Steps

### X1: Concurrent edit in two tabs

> NOTE: this IS automatable in headless Playwright — `context.newPage()` opens a
> second tab sharing the same browser context/session, which is exactly "the
> same board open in two tabs". (The earlier `skip:harness` was MCP-era, when a
> single shared Chrome made independent tabs unsafe; it does not apply here.)

* Open the same whiteboard in two tabs (tab A, tab B) via `context.newPage()`.
* In tab A, inject 1 rectangle "A" + trigger save (wait past debounce; board.json holds "A").
* Observe in tab B: the canvas does NOT auto-update with tab A's element. Excalidraw OSS lib is single-user; there is no WS sync.
* In tab B, inject a DIFFERENT rectangle "B" + trigger save (wait past debounce; board.json holds "B" — B is the last writer).
* Reload tab A: it re-reads board.json and shows tab B's "B", NOT its own "A" (last-write-wins).

## Documented limitation

Excalidraw v0.18.x ships as single-user. Multi-user real-time sync would require a separate WS bridge (collaboration room infra exists in Flowpad but is not wired to whiteboards). Last-write-wins is the expected v1 behaviour, and this scenario asserts exactly that.

## Pass criteria

Tab B never receives tab A's element live (no sync), and the reloaded tab A shows the last writer's scene (B), not its own earlier write (A).
