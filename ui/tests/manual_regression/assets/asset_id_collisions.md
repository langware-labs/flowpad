---
id: d4dc962b-4f76-4ea5-9c90-42c7c30e9dd1
---

test 1: File collision state, URL panel, and removal lifecycle
- [setup] create an isolated temporary project and a project-scoped agent
- [setup] copy the agent bytes to two sibling paths without changing its identity capsule
- [browser] index the project agent assets and open the agent by TypeId
- [browser] validate the warning badge shows 2 conflicts (primary excluded)
- [browser] click the warning badge
- [browser] validate the URL carries the collision side-window id
- [browser] validate the panel lists one Primary path followed by two duplicate paths
- [browser] go Back and validate the panel closes; go Forward and validate it restores
- [setup] remove one copy and reindex
- [browser] validate the badge changes from 2 to 1 and the panel lists one duplicate
- [setup] remove the final copy and reindex
- [browser] validate the warning badge and panel disappear

test 2: Git precedence and folder-backed collision parity
- [setup] create an isolated temporary Git project
- [setup] create and commit a folder-backed skill whose name sorts after its future copy
- [setup] copy the whole skill folder byte-for-byte to a lexically earlier path and commit it later
- [browser] index skills and validate the entity's primary asset_ref remains the earliest Git introduction
- [browser] open the skill by TypeId and validate the warning badge shows 1
- [browser] open the URL-first collision panel
- [browser] validate the original folder is Primary and the copied folder is the duplicate
- [browser] validate the folder-backed editor uses the same warning/panel behavior as file assets

