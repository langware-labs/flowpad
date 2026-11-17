---
id: b08fedfb-acd3-4b31-830f-a2661214e5e1
title: 'Warm tab and project switches: zero-fetch commit, per-key subscriptions, and
  layout-free chrome'
tags:
- breadcrumb.test.warm_tab_switch_perf.rules
description: A warm tab or project switch must not re-fetch local entities, re-render
  dock chrome on unrelated context keys, or force synchronous layout during commit.
---
# Warm tab and project switches: zero-fetch commit, per-key subscriptions, and layout-free chrome

> Ground truth. Proven by RCA on 2026-11-16. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.warm_tab_switch_perf.rules
sites:
  - rel_path: "ui/tests/manual_regression/navigation/tab_switch_perf.md.ts"
    line: 350
    note: "FAILING? warm switch re-fetches local entities, re-renders chrome on unrelated context keys, or forces layout - read this tag's rules first"
  - rel_path: "ui/tests/manual_regression/navigation/tab_switch_perf.md.ts"
    line: 425
    note: "FAILING? warm switch re-fetches local entities, re-renders chrome on unrelated context keys, or forces layout - read this tag's rules first"
```

## Expected behavior

Switching between already-visited tabs in a project completes within 150 ms p90 (terminal, markdown document, and plain shell), and switching between already-visited projects completes within 300 ms p90 (`ui/tests/manual_regression/navigation/tab_switch_perf.md.ts`, production build, `ADJUSTABLE_PERF_FACTOR=1`), measured from `start` to `ready` (`painted` for document tabs) on the `tab_switch` toplog trail.

## Internals

* **Local entity cache expansion (`ts_sdk/src/FlowSync/store.ts`)**: `DBEntity.get_all` (`flow_sdk/db/db_entity.py:865`) returns every column of local SQLite rows on list queries (`GET /api/v1/graph/<type>`) and action payloads (`POST /open`), only without an `expand.expansions` wrapper (`expand=permissions,auth_scopes` is a cloud/hub ACL concept). `DataManager._query`, `DataManager.applyCreate`, and `DataManager.updateEntityFromJson` call `entity.markAsExpanded()` on local (`entity.remote !== true`) entities whose schema has no unexpanded blobs. Without this, `DataContext._onAddedToContext`, `loadProject`, and `adoptOpenPayload` treated cached local entities as unexpanded (`saved === false`) and issued blocking `GET /api/v1/graph/<type>/<id>?expand=permissions,auth_scopes` requests during route loaders and switches.
* **Batched MobX + `CONTEXT_CHANGED` updates (`ts_sdk/src/FlowSync/context.ts`, `ui/src/routes/loaders/load-process.ts`, `ui/src/routes/loaders/load-shell.ts`)**: `dataContext.batch(fn)` wraps multi-field context mutations in a single MobX `runInAction` and coalesces `ContextEventType.CONTEXT_CHANGED` emissions to at most one notification at the end of the outermost batch. `setupTabAndAdopt` (`load-process.ts`, `load-shell.ts`) runs inside `dataContext.batch` and skips `refreshProject` when the target project is already active.
* **Per-property `useContext` tracking (`ts_sdk/src/react/hooks/useContext.ts`)**: `useContext()` wraps the returned `ContextSnapshot` in a `Proxy` that records which snapshot keys a component reads during render and compares only those keys inside its `useSyncExternalStore` selector. Chrome components reading `project` or `workspace` do not re-render when `activeTab`, `activeShellId`, or `contextEntityTypeId` changes on a warm tab switch.
* **Narrow hook selectors & transition-free router (`ui/src/router.tsx`, `ui/src/contexts/view-mode-context.tsx`, `ts_sdk/src/react/primary-content.tsx`, `ts_sdk/src/tabs/tab-lifecycle-registry.ts`, `ui/src/navigation/use-history-nav.ts`)**: `<RouterProvider router={router} unstable_useTransitions={false} />` commits synchronous loader completions immediately without double-rendering through a transition state. `useViewMode`, `usePrimaryContentReady`, `useTabLifecycles` (`getShownSnapshot`), and `useHistoryNav` subscribe only to the slice they render, and `useShell` (`ui/src/hooks/useShell.ts`) seeds its initial state synchronously from `dataManager.getByTypeIdFromCache`.
* **Layout-free commit path (`ui/src/components/tabs/TabStrip.tsx`, `ui/src/components/top-nav-bar/AddressField.tsx`, `ui/src/contexts/view-mode-context.tsx`, `ui/src/styles/index.css`)**: `TabStrip` defers `scrollActiveIntoView` and overflow measurement to `requestAnimationFrame` instead of reading `offsetWidth` / `scrollWidth` / `getBoundingClientRect` inside `useLayoutEffect` or commit effects; `AddressField` avoids synchronous `input.setSelectionRange` layout reads on blur; `view-mode-context` drops synchronous `void document.body.offsetHeight` reflow.

## Invariants

* A warm switch to an already-visited tab or project makes **zero** blocking entity fetches (`GET /api/v1/graph/<type>/<id>`) in the route loader before commit.
* Multi-setter `dataContext` updates in route loaders execute inside `dataContext.batch(...)` so MobX reactions and `CONTEXT_CHANGED` subscribers fire at most once per navigation commit.
* `useContext()` subscribers re-render only when a `ContextSnapshot` property they actually read changes (`Object.is`).
* No dock chrome component reads layout geometry (`offsetWidth`, `scrollWidth`, `offsetHeight`, `getBoundingClientRect`) synchronously inside `useLayoutEffect` or commit-phase effects during a tab switch.

## Failure modes

* Baseline (`i04` before fix, `ADJUSTABLE_PERF_FACTOR=1`): warm switch p90 was `274 ms` (terminal), `274 ms` (document), `431 ms` (plain shell) vs `150 ms` budget; project switch p90 was `393 ms` vs `300 ms` budget.
* Trail Breakdown before fix: loader + React Router transition commit took `55-120 ms` (dominated by unbatched `dataContext` setters firing 6+ synchronous cascades across 56 `useContext` chrome subscribers and redundant `GET /api/v1/graph/<type>/<id>?expand=permissions,auth_scopes` requests), followed by `80-150 ms` of synchronous forced reflows in `TabStrip` (`useLayoutEffect` reading `offsetWidth` / `scrollWidth` after DOM mutation) before `requestAnimationFrame` could fire `painted` / `ready`.
* After fix (verified across 4 full 5/5 production runs `green1`, `green2`, `green5`, `green7`): warm switch p90 is `108-115 ms` (terminal), `118-130 ms` (document), `93-104 ms` (plain shell); project switch p90 is `132-163 ms`; cold open from checkpoint is `874-953 ms`.
