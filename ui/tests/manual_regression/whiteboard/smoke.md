---
id: 9d2a4c0e-1f8b-4e5a-9c11-110011001100
type: workflow
name: whiteboard_smoke
description: Whiteboard smoke tests S1-S3 — backend reachable, type registered, editor mounts
tags: [whiteboard, smoke]
---

# Whiteboard — Smoke (S1–S3)

## Prerequisites

* Backend running at `${API_URL}` (default `http://localhost:9008`).
* Frontend running at `${APP_URL}` (default `http://localhost:4098`).

## Steps

### S1: Backend reachable
* GET `${API_URL}/api/v1/graph/bootstrap` → expect HTTP 200 with JSON body containing `"status":"SUCCESS"`.

### S2: Whiteboard type registered
* GET `${API_URL}/api/v1/graph/whiteboard` → expect HTTP 200 with `data` array (any length, including zero).
* Response body MUST NOT contain `"Unknown entity type"` — that signals the backend doesn't know `whiteboard`.

### S3: Excalidraw bundle lazy-loads + editor mounts
* POST `${API_URL}/api/v1/graph/whiteboard` with body `{"name":"smoke-s3","description":"smoke s3"}`. Capture the returned `id` (e.g. `2351dedc-…`) and `asset_ref`.
* Navigate to `${APP_URL}/dock/assets/editor/whiteboard/typeid/whiteboard-<id>` (the AssetDocPointer grammar requires an explicit `typeid/` or `vfs/` method segment; a bare `asset_ref` path now renders "Invalid asset pointer").
* Wait up to 5s for `[data-testid="whiteboard-editor"]` to appear.
* Validate `.excalidraw.excalidraw-container` is in the DOM with `clientHeight` > 100 AND < 100000 (the CSS-import-missing regression inflates this to 33,554,432).
* Validate no React error boundary visible (no `heading "Error"` in document).
* Browser console: 0 uncaught errors related to `excalidraw` or `Cannot read properties of undefined`.

## Pass criteria

All three sub-scenarios pass.

## Cleanup

* DELETE `${API_URL}/api/v1/graph/whiteboard/<id-returned-from-S3>` (best-effort; folder will remain on disk).
