---
id: 9d2a4c0e-1f8b-4e5a-9c11-880088008800
type: workflow
name: whiteboard_multi_tab
description: Whiteboard X1 — concurrent edit in two browser tabs (documented limitation)
tags: [whiteboard, multi-tab, skip-harness]
skip: harness
---

# Whiteboard — Multi-tab (X1)

## Steps

### X1: Concurrent edit in two tabs

> **[skip:harness]** — MCP debugMcp shares a single Chrome session across all testers and tasks. Driving two genuinely independent browser windows to test simultaneous edits is unsafe in the harness. Document this scenario but record `skip:harness` in the result; manual one-time verification only.

* Open the same whiteboard in two separate browser windows (tab A, tab B).
* In tab A, inject 1 rectangle + trigger save (wait past debounce).
* Observe in tab B: the canvas does NOT auto-update with tab A's element. Excalidraw OSS lib is single-user; there is no WS sync.
* In tab B, inject a DIFFERENT rectangle + trigger save (wait past debounce).
* Reload tab A: only tab B's element is visible. Tab B was the last-writer.

## Documented limitation

Excalidraw v0.18.x ships as single-user. Multi-user real-time sync would require a separate WS bridge (collaboration room infra exists in Flowpad but is not wired to whiteboards). Last-write-wins is the expected v1 behaviour.

## Pass criteria

`skip:harness` — record as confirmed skip with this scenario file as evidence.
