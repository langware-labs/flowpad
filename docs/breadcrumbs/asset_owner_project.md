---
id: 167a29e9-d2fa-42ee-bd92-d0b6ef1ce731
title: An asset is rebased only onto a project that exists
tags:
- breadcrumb.test.asset_owner_project.rules
description: assetDocumentAtOwner rebases an unscoped Assets document URL onto its
  owner project. An asset indexed from a folder that is not a project carries that
  folder's derived id as its project_id, so the owner id is used only if a Project
  with that id loads; otherwise the dock stays global.
---
# An asset is rebased only onto a project that exists

> Ground truth. Proven by the fix 8c6d59b1b (PR #814, 2026-11-10): the bound test failed without it and passes with it. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.asset_owner_project.rules
sites:
  - rel_path: "ui/tests/e2e/llm-funding-setup/global_default.spec.ts"
    line: 68
    note: "FAILING? read this tag's rules before touching assetDocumentAtOwner's owner check"
```

## Expected behavior

`/dock/assets/editor/wizard/typeid/wizard-<id>` for a wizard indexed from a test-only
folder (not a project) opens the wizard viewer. It must not show "Project not found".

## Internals

* `main-loader.ts:270` (and `NavigationActions.ts:856`) call
  `assetDocumentAtOwner(dock)` (`ui/src/navigation/asset-document-owner.ts`) for an
  unscoped Assets **document** dock, and redirect to the rebased URL when it answers.
* The owner comes from `tabOwnerProject()` (`ts_sdk/src/entities/tab.ts:278`): a Project
  target, else the target's `project_id` / `effective_project_id`, else the deepest
  project mount holding its path. That step-5 stamp is taken as is.
* An asset indexed from a folder that is not a project carries that folder's derived id
  in `project_id`. No Project row has that id.
* **The fix** (`asset-document-owner.ts:36-40`): after `if (!owner) return null`, it
  loads `new TypeId(Project.type, owner)` through `dataManager.getByTypeId`. If that
  fails or comes back empty, it returns `null` (no redirect, so the dock stays global).
  Only a project that loads gets `DockPointer.rebaseAssetsOntoProject`.

## Invariants

* The loader never redirects to `/dock/project/<P>/…` unless P is a project this backend
  can load.
* "No owner" and "owner that is not a project" end the same way: the document opens
  unscoped.

## Failure modes

* **Before the fix:** the loader redirected onto the derived id, the page rendered
  "Project not found", and `wizard-viewer`'s heading never appeared. The test failed
  before `wizard-run`.
* The same fix covers `ui/tests/e2e/llm-funding-setup/hub_endpoint.spec.ts`.
* The test needs the scenario backend (`start_backend.py --scenario global-default`,
  `LLM_GLOBAL_EXPECTED_MODEL` / `LLM_GLOBAL_BE_PORT`) and runs `apt-get` as a root runner
  would. Missing env or a failed install is an environment problem, not this rule.
