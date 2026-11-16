---
id: c049be22-bcf1-4b6d-9d0f-c757763ef682
title: Hub project Setup and Deployments are Project Home pages
tags:
- breadcrumb.test.hub_project_pages.rules
description: On /dock/hub/project/<id>/project-setup and /project-deployments, HubProjectPage
  must hand the page to ProjectHome as setupPage/deploymentsPage, not to the asset
  editor router ("Invalid asset pointer"), and ProjectHome must render those pages
  before its cloudMode asset list.
---
# Hub project Setup and Deployments are Project Home pages

> Ground truth. Proven by the fix fff1872c8 (PR #814, 2026-11-10): the bound test failed without it and passes with it. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.hub_project_pages.rules
sites:
  - rel_path: "ui/tests/e2e/deployment-funding/deployment_funding.spec.ts"
    line: 116
    note: "FAILING? read this tag's rules before touching HubProjectPage's sub-pointer routing or ProjectHome's page order"
```

## Expected behavior

On the hub, clicking a deployment row opens
`/dock/hub/project/<id>/project-deployments?deployment=<id>`, and the deployment's own
page renders, with its funding card (`deployment-funding`). The same applies to
`project-setup`.

## Internals

* `HubProjectPage` (`ui/src/pages/hub-project/HubProjectPage.tsx`) splits the dock pointer
  with `DockPointer.splitProjectPointer` into `projectId` and `assetSubPointer`.
* `project-setup` and `project-deployments` are `AssetMode.PROJECT_SETUP` /
  `AssetMode.PROJECT_DEPLOYMENTS` (`ui/src/navigation/asset-doc-types.ts:56,59`). They are
  pages of Project Home, not assets. The desk's `AssetsPage` already passed them as
  `deploymentsPage` (`ui/src/components/assets/AssetsPage.tsx:694`).
* **Fix, part 1** (`HubProjectPage.tsx:99-101`): `setupPage` / `deploymentsPage` are
  derived from the sub-pointer, and only any other sub-pointer goes to
  `<AssetEditorRouter pointer=… hubReflect />`. The two flags are passed to `ProjectHome`.
* **Fix, part 2** (`ui/src/components/project-home/ProjectHome.tsx:263-267`): the render
  chain checks `deploymentsPage && resolvedProject`, then `setupPage && projectId`,
  **before** `cloudMode ? cloudContent`. `cloudMode` means `cloudContent !== undefined`,
  and that is always true on the hub page.

## Invariants

* A project's own page modes are never handed to `AssetEditorRouter`. Any new
  `underProjectDock` page mode needs the same exclusion on the hub.
* In `ProjectHome`, the project's own pages win over `cloudMode`. The hub asset list
  (`HubProjectAssets`) is the fallback, not the first branch.

## Failure modes

* **Before part 1:** the sub-pointer reached the editor router and the page read
  "Invalid asset pointer". The URL wait in the test passes, and then
  `deployment-funding` never becomes visible.
* **With part 1 but not part 2:** `deploymentsPage` arrives, but `cloudMode` wins and
  the hub asset list renders instead, so the result is the same timeout on
  `deployment-funding`.
* Failures later in the test (allocation editor, token plan, funding API) are about
  funding, not routing. Look there before you change these files.
