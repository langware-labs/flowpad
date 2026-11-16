---
id: 0f9cd0c8-b25c-4ea8-ad28-665ca3a6864f
title: The ProjectPage tag lives on the top bar's project pill
tags:
- breadcrumb.test.project_page_tag.rules
description: The getting-started journey's first step highlights the ProjectPage tag
  and waits for a click on it, and the tag tests click [data-tag="ProjectPage"]. The
  tag must be on a control that renders, and after the footer button was removed that
  control is the top bar's project pill (RuntimeChip, top-nav-project).
---
# The ProjectPage tag lives on the top bar's project pill

> Ground truth. Proven by the fix 0757b58e3 (PR #814, 2026-11-10): both bound tests failed without it and pass with it. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.project_page_tag.rules
sites:
  - rel_path: "ui/tests/manual_regression/tags/tag-vocabulary.spec.ts"
    line: 103
    note: "FAILING? read this tag's rules before moving or renaming the ProjectPage tag"
  - rel_path: "ui/tests/manual_regression/tags/tag-vocabulary.spec.ts"
    line: 240
    note: "FAILING? read this tag's rules before moving or renaming the ProjectPage tag"
```

## Expected behavior

With a current project, one visible element carries `data-tag="ProjectPage"`. Clicking
it opens the project's page, highlighting it sets `data-highlighted="true"`, and the
getting-started journey's step 0 advances.

## Internals

* `tagAttrs(target, kind)` (`ui/src/tags/tag-attrs.ts`) stamps `data-tag` /
  `data-tag-kind`. `UiTagEmitter` (`ui/src/tags/ui.onTag.tsx:25`) turns a click on a tagged
  element into `app.ui.<kind>.clicked`, and `highlight.onTag.tsx` sets
  `data-highlighted` for `?highlight=<tag>`.
* The shipped journey
  `flow_sdk/system_projects/flowpad_assistant/agentic-assets/journey/getting-started/graph.json`
  step 0 has `present.highlight: "ProjectPage"` and `waitFor: [{click: "ProjectPage"}]`.
* The footer button that carried the tag was removed in 51c356d71, when the project moved
  to the top bar. After that, nothing rendered the tag.
* **The fix:** `{...tagAttrs('ProjectPage', 'button')}` on the project-name button
  (`data-testid="top-nav-project"`) in `ui/src/components/top-nav-bar/RuntimeChip.tsx:184`.
  The journey's status line now says "in the top bar".

## Invariants

* Exactly the project-page opener carries `ProjectPage`. Moving that control means moving
  the tag with it, and the journey's `status_line` must say where it is.
* The pill renders only when `project` is set, so the tests pin a project into the URL
  (`dismissSetup` returns `scope-mode=project&scope-activeProjectId=…`).

## Failure modes

* **Before the fix:** `page.locator('[data-tag="ProjectPage"]').first()` never became
  visible, which failed both "hard-cut tag vocabulary …" and "tag journey advances …".
* Dropping the scope query makes the pill (and the tag) disappear for the same visible
  reason, even though the tag is still in place.
* A failure after the click (the backend relay, `journey-tray-continue`, progress
  polling) is about the journey engine, not this tag.
