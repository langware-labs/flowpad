---
id: 39950f99-b2ed-4882-a025-f77c3e70e2d4
title: Only the latest locale activation applies
tags:
- breadcrumb.test.locale_activation_order.rules
description: loadAndActivate takes a ticket per call, and only the latest may i18n.activate
  and set <html lang/dir>. Without it, an earlier switch whose first catalog import
  was slow (en-US) finished after a later one (he) and put the app back to ltr in
  the language the user just left.
---
# Only the latest locale activation applies

> Ground truth. Proven by the fix 537fc68e6 (PR #814, 2026-11-10) after QA saw the bound test fail on "and back into Hebrew …" (p05). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.locale_activation_order.rules
sites:
  - rel_path: "ui/tests/react/vibe-switch-project-locale.test.ts"
    line: 51
    note: "FAILING? read this tag's rules before touching loadAndActivate's activation ticket"
```

## Expected behavior

Switching from the vibe home to a Hebrew project ends in Hebrew with
`<html dir="rtl">`, even if an earlier switch (to en-US) is still loading its catalog.

## Internals

All of this is in `ui/src/contexts/locale-context.tsx`:

* `loadAndActivate(code)` (`:177`) imports `../locales/<code>/messages.po` the first time
  a locale is used (`_loaded`, `:165`), and that import is slow. Later calls skip it.
* `applyProjectLocale` (`:362`) fires `activateLocale` without awaiting it, so two
  switches can overlap.
* **The fix:** `_activationSeq` (`:171`). Each `loadAndActivate` call takes
  `seq = ++_activationSeq`. After the (possibly slow) import, if `seq !== _activationSeq`,
  it returns `false` without calling `i18n.activate`. The callers `activateLocale` (`:278`)
  and `onPrefLocaleChanged` (`:433`) call `applyLocaleAttributes` (`<html lang/dir>`) only
  when it returns `true`.

## Invariants

* The last activation requested is the one that ends up active, whatever order the
  imports finish in.
* `i18n.activate` and `applyLocaleAttributes` move together: a superseded call does
  neither.

## Failure modes

* **Before the fix:** en-US (cold import) started, then he (already loaded) activated,
  and then en-US's import finished and activated en-US and `dir=ltr`. The test's
  `waitFor(… dir).toBe('rtl')` failed.
* **The bound test no longer exercises the race on its own.** Its `beforeAll` now
  imports both catalogs up front (the #754 edit), so every later call skips the import and
  activates without waiting. It pins the loader path (`loadHomePage` →
  `applyProjectLocale`). A regression in the ticket shows up in the app as a cold first
  switch reverting a later one, and may not show up here.
* `resolveAndApply` (`:386`, the boot path) sets attributes before it activates and
  ignores the return value. It runs once at boot, not on a switch.
