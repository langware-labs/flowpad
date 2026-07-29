---
id: 6daf0ca3-5f0c-415f-8722-ed3dd14af945
type: workflow
name: whiteboard_scope
description: Whiteboard scope Sc1-Sc2 — project-scoped creation + user-vs-project
  coexistence
tags:
- whiteboard
- scope
---

# Whiteboard — Scope (Sc1–Sc2)

## Prerequisites

* The current active project's id is available (GET `${API_URL}/api/v1/graph/project` and pick one with a `fs_storage_mount_path`, e.g. my_first_project).

## Steps

### Sc1: Project-scoped board creation
* POST `${API_URL}/api/v1/graph/project/<projectId>/whiteboard` with body `{"name":"sc1-proj-<random>"}`.
* Expect HTTP 200 with `asset_ref` under the project's `fs_storage_mount_path` (e.g. `<project>/agentic-assets/whiteboard/sc1-proj-...`), NOT the user-scoped `~/agentic-assets/whiteboard/`.
* Navigate to the editor URL for that asset_ref (the folder + board.json materialize lazily on first editor mount/save, not on POST).
* The folder + board.json exist at the project path on disk after the editor mounts.

### Sc2: User + project scopes coexist
* POST `${API_URL}/api/v1/graph/whiteboard` with body `{"name":"sc2-user-<random>"}` (user scope) → asset_ref under `~/agentic-assets/whiteboard/`.
* Both ids distinct; navigate each editor to materialize; both folders exist at their respective scopes.

## Pass criteria

Sc1, Sc2 both pass.

## Cleanup

* Remove created whiteboards from both scopes.
