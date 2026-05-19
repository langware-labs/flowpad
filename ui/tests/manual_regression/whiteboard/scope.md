---
id: 9d2a4c0e-1f8b-4e5a-9c11-660066006600
type: workflow
name: whiteboard_scope
description: Whiteboard scope Sc1-Sc2 — project-scoped creation + user-vs-project coexistence
tags: [whiteboard, scope]
---

# Whiteboard — Scope (Sc1–Sc2)

## Prerequisites

* The current active project's id is available (GET `${API_URL}/api/v1/graph/project` and pick one — preferably the current cwd project).
* Project's `fs_storage_mount_path` is on disk (typically `/Users/<u>/Documents/dev/<project>`).

## Steps

### Sc1: Project-scoped board creation
* POST `${API_URL}/api/v1/graph/project/<projectId>/whiteboard` with body `{"name":"sc1-proj-<random>"}`.
* Expect HTTP 200 with `asset_ref` starting with the project's `fs_storage_mount_path` (typically `<project>/.claude/whiteboards/sc1-proj-...`), NOT `~/.claude/whiteboards/`.
* Validate the folder exists at the project path on disk via `ls`.
* Navigate to the dock editor URL; editor mounts.

### Sc2: User + project scopes coexist with the same name
* POST `${API_URL}/api/v1/graph/whiteboard` with body `{"name":"sc2-shared-<random>"}` (user scope).
* POST `${API_URL}/api/v1/graph/project/<projectId>/whiteboard` with body `{"name":"sc2-shared-<random>"}` (project scope) — same name.
* GET `${API_URL}/api/v1/wiki/resolve?name=sc2-shared-<random>` → expect HTTP 200 with one of the two ids returned (alphabetical precedence).
* GET `${API_URL}/api/v1/wiki/resolve?name=sc2-shared-<random>&prefer_type=whiteboard` → expect a whiteboard hit (one specific one).
* Both folders exist on disk at their respective scopes.
* In the UI asset list (filtered by Whiteboard), both rows appear.

## Pass criteria

Sc1, Sc2 both pass.

## Cleanup

* Remove all created whiteboards from both scopes.
