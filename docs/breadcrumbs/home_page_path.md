---
id: 6e0cdac8-6fad-4baf-8595-a717d5ba6e07
title: A ./path home page resolves on the backend, never in new TypeId()
tags:
- breadcrumb.test.home_page_path.rules
description: A project's home_page is a TypeId OR a ./path. Only Project.resolve_home_page_typeid
  turns a path into a TypeId (relative to this checkout, contained in it). The UI
  passed the raw value to new TypeId(), which threw Invalid typeId during render and
  took down the whole Customize screen (FLOWPAD-2300).
---
# A ./path home page resolves on the backend, never in new TypeId()

> Ground truth. Proven by RCA on 2026-11-03. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.home_page_path.rules
sites:
  - rel_path: "ui/tests/react/home-customization-path-home-page.test.tsx"
    line: 62
    note: "FAILING? home_page may be a ./path - never pass it to new TypeId(); resolve it through Project.resolveHomePageTypeId. Read this tag's rules before touching useHomePageTypeId or resolve_home_page_typeid."
```

## Expected behavior

The project page's **Customize** tab always renders. When the manifest declares a home
page, the card names that asset, whether the declaration is a TypeId or a `./path`.
A declaration that names no asset in this checkout shows "Missing asset (…)". Nothing
about the declaration may throw during render.

## Internals

* **Two declaration forms.** `home_page` in `project_manifest.json` is an asset TypeId
  or a project-relative `./path` (docs/navigation/project-home-page.md). The reader
  normalizes it in `ProjectManifestSpec._home_page_typeid`
  (`flow_sdk/schema/data_spec/project_manifest_spec.py:207`): a malformed value declares
  nothing (None). `set-home-page` accepts both forms.
* **One owner of the path rule.** `Project.resolve_home_page_typeid`
  (`flow_sdk/builtin/project.py:664`) joins a `./path` onto THIS checkout's root, resolves
  symlinks, refuses a result outside the root (`is_relative_to`), and classifies it with
  `resolve_asset(..., write=False)`. A TypeId passes through unchanged.
* **Display route.** `GET project/<id>/home-page-typeid?reference=`
  (`home_page_typeid_action`, `flow_sdk/builtin/project.py:881`) runs only that resolver
  plus `_index_home_page` (so the row exists for the card to read). It never calls
  `load_project`. TS client: `Project.resolveHomePageTypeId`
  (`ts_sdk/src/entities/project.ts:1258`).
* **Open route.** `GET project/<id>/home-page` (`open_home_page`,
  `flow_sdk/builtin/project.py:843`) is for the Home click: resolve, index, the
  own-asset check, and `load_project`. Too heavy for a card that only shows a name.
* **UI.** `useHomePageTypeId` (`ui/src/project-home-page/use-project-home-page.ts:43`)
  uses a value that passes `isTypeId` as is and sends anything else to
  `Project.resolveHomePageTypeId` (react-query). `HomeCustomizationCard`
  (`ui/src/components/project-home/HomeCustomizationCard.tsx:68`) reads the asset with
  the returned TypeId.

## Invariants

* Never pass a raw `home_page` value to `new TypeId()`. Check `isTypeId` first, or
  resolve it.
* The client never joins a `./path` onto a project root. The backend does, with the
  containment check.
* Showing the home page never loads the project.

## Failure modes

* **FLOWPAD-2300.** `HomeCustomizationCard` called `new TypeId(homePage)` on the
  manifest's raw value. On a `./path` the constructor threw `Invalid typeId` during
  render, and the route-level `RenderErrorBoundary` replaced the whole screen. On/off:
  restoring `new TypeId(declaration)` in `useHomePageTypeId` makes the bound test throw
  `Invalid typeId` again.
