---
id: c3cfca41-7fd0-42d5-ab33-d459b39c399f
title: Project delete must remove a git checkout's read-only files
tags:
- breadcrumb.test.delete_readonly_checkout.rules
description: Project._delete_with_children removed the folder with a bare shutil.rmtree;
  git writes its pack files and commit-graph read-only, Windows refuses to unlink
  them (WinError 5), so the project row went but the folder stayed — and the clone
  dialog, which only checks that the folder exists, kept refusing the name and offering
  <name>-2.
version: 2
---
# Project delete must remove a git checkout's read-only files

> Ground truth. Proven by RCA on 2026-10-28. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.delete_readonly_checkout.rules
sites:
  - rel_path: "tests/unit/test_project_delete_readonly_git.py"
    line: 28
    note: "FAILING? Windows-only. Read this tag's rules before editing; do not swap _rmtree_safe back to shutil.rmtree, and do not expect it to fail on macOS."
```

## Expected behavior

Deleting a project with `folder="rmtree"` (the default, what the assets-page delete does) leaves **no folder** at `fs_storage_mount_path`, including when it is a git checkout. Afterwards cloning the same repo again under the same name is accepted, not answered with `409 'X' already exists in workspace` plus a `X-2` suggestion.

## Internals

* **The delete.** `Project._delete_with_children` (`flow_sdk/builtin/project.py:3635`) removes the source folder at `project.py:3769` with `_rmtree_safe(mount)`. It used to be `shutil.rmtree(mount)`.

* **Why a bare** **`rmtree`** **fails.** git creates `.git/objects/pack/*.{idx,pack,rev}` and `.git/objects/info/commit-graph` read-only. Windows will not unlink a read-only file, so `shutil.rmtree` raises `PermissionError [WinError 5] Access is denied` part-way and stops. macOS and Linux do not enforce this, which is why the bug cannot be seen there.

* **What swallows it.** The failure is an `OSError`, which `project.py:3771` catches and only logs: `[project-delete] source folder rmtree failed <mount>: [WinError 5] ...`. The cascade carries on and the project row and its children are destroyed. Nothing tells the user the folder is still there.

* **The helper.** `_rmtree_safe` (`flow_sdk/claude_env.py:90`) passes `_rmtree_onexc` (`claude_env.py:78`) as the error handler: on an `OSError` it `chmod`s the path writable, waits 0.1 s and retries the failed call.

* **Why the stale folder blocks a clone.** The clone dialog's 409 comes from `compute_node.py:1212-1220` (`create-project-from-git`). It calls `_next_free_leaf` (`compute_node.py:1269`) → `fresh_clone_slot(..., reuse_empty=False)` (`flow_sdk/fs_store/origin/git_origin.py:214`), which asks only whether `<workspace>/<leaf>` **exists on disk**. It never looks at Project rows. A leftover folder therefore blocks the name even though the project is gone.

* **Not the same check as** **`Project._project_named`** (`project.py:2494`, with `free_name` at `project.py:2512`). That one is row-based and guards project create/rename and a received install (`_refuse_duplicate_name`, `project.py:2474`). The first diagnosis of this bug blamed it; it is not what the clone dialog uses.

## Proof (the on/off switch)

The lever is the call that removes the folder: `shutil.rmtree` vs `_rmtree_safe`.

* On the reporter's Windows machine (win32, Python 3.11), same repo shape, in a temp dir, both directions in one run:

  * `shutil.rmtree` → `PermissionError [WinError 5] ... .git\objects\info\commit-graph`, folder still exists.

  * `_rmtree_safe` → OK, folder gone.

* The test fails on a Windows runner with the bare `rmtree` (`AssertionError: project delete left its checkout behind`, with the same `[project-delete] source folder rmtree failed ... [WinError 5]` warning in the log) and passes with `_rmtree_safe`: run 40722253869 (red) and 40726634526 (88 passed).

## Invariants

1. A project delete that reports success must not leave the project's own checkout on disk.
2. Any folder removal on the project-delete path goes through `_rmtree_safe`, never a bare `shutil.rmtree` — git checkouts always contain read-only files.
3. The test is meaningful **only on Windows**. It is in the Windows CI subset (`.github/workflows/test.yml`, the `backend-unit-windows` job) for that reason. Green on macOS proves nothing about this bug.

## Failure modes

* **Test fails on Windows with** **`project delete left its checkout behind`**: something on the delete path went back to a bare `rmtree`, or `_rmtree_safe` changed. Read the `[project-delete] source folder rmtree failed` line in the captured log for the path that refused.

* **Test passes on macOS but users still report "already exists"**: expected — the bug is Windows-only. Reproduce on Windows or in the CI Windows job, not locally.

* **A folder held open by another process** (an editor, a terminal `cd`'d into it, antivirus) is not fixed by this. Read from `_rmtree_onexc`, not exercised: it swallows the second failure (`except OSError: pass`), so such a folder would again be left behind with no warning from `_rmtree_safe` itself. The delete would then look like it succeeded. This is unproven.

