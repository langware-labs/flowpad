---
title: A spec turns on the switches it relies on
tags: [breadcrumb.test.dev_only_types.rules]
description: Dev is the person's switch (not ?viewMode=dev) and the SmartNavigationLog is off by default;
  a manual-regression spec that needs either turns it on itself instead of inheriting it from earlier specs.
---
# A spec turns on the switches it relies on

> Ground truth. Proven by RCA on 2026-11-12. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.dev_only_types.rules
sites:
  - rel_path: "ui/tests/manual_regression/tags/tag-vocabulary.spec.ts"
    line: 103
    note: "FAILING at the Tag root? Dev is a switch, not a URL param - read this tag's rules"
  - rel_path: "ui/tests/manual_regression/smart-navigation/navigation_sentences.md.ts"
    line: 64
    note: "FAILING with NO LOG ROW? the SmartNavigationLog preference is off by default - read this tag's rules"
```

## Expected behavior

A spec on a shared instance gets the state it needs by setting it, the way a person does, never from what
an earlier spec happened to leave.

## Internals

| switch | where |
| --- | --- |
| Dev (lifts dev-only types such as `tag` into the asset catalog) | `useIsDev` / `useTierMode` (`ui/src/contexts/view-mode-context.tsx`), `PrefKey.DEV_MODE`; flipped by `window.setDev` |
| `tag` is dev-only | `flow_sdk/schema/type_info/tag_type_info.py` (`dev_only=True`), filtered in `staticAssetTypes` (`ui/src/hooks/use-asset-types.ts`) |
| SmartNavigationLog | `preferences.advanced.smart_navigation_log` (`flow_sdk/preferences.py`, default `False`); rows written by `flow_sdk/core/navigation_log.py` |

## Invariants

* `?viewMode=dev` does nothing since 05a812c87 ("Dev is a switch"): use `window.setDev(true)`.
* `navigation-decision` answers either way; only the preference decides whether a log row follows.

## Failure modes

* **Tag root missing** (`browseable-chevron-asset-type:tag` not found) while the list shows tags: Dev off.
  Proven 2026-11-12 on qw-71: 3 of 3 failed with Dev off; with `setDev(true)` 2 of 2 passed. i01 called it
  flaky because it passed whenever an earlier spec had left Dev on.
* **"the decision left a SmartNavigationLog row" → null** on the first sentence: the preference is off
  (the request answered 200, no row). With the switch turned on in `beforeAll`, "1. go home" passes.
