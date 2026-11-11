---
id: a3562bea-5f63-4aae-bf2e-0fd5610dbb60
title: Navigation sentence scoring — what counts as landed
tags:
- breadcrumb.test.nav_sentence_scoring.rules
description: The navigation_sentences scorer must accept every route the app really
  opens a target on — /dock/project/<id>/editor/…, the base64url web view, /win/ popups
  — or right answers score 2.
---
# Navigation sentence scoring — what counts as landed

> Ground truth. Proven by RCA on 2026-11-11. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.nav_sentence_scoring.rules
sites:
  - rel_path: "ui/tests/unit/navigation-sentences-scoring.test.ts"
    line: 8
    note: "FAILING? read this tag's rules before editing the scorer or its routes"
```

## Expected behavior

`ui/tests/manual_regression/smart-navigation/navigation_sentences.md.ts` types each sentence of
`docs/navigation/navigation-sentences.md` into the magic line and scores it: 1 works, 2 can work,
3 impossible. A sentence whose decision opened the right thing scores **1**, whatever route the app
uses to show it. The score is a judgement of the product, so a stale scorer is a false product
report: in i18 of qa-20261109-230009 it scored "open the agent-builder skill", "open the google
credential", "open flowpad cloud" and "pop out the assistant" as 2, though each opened the right thing.

## Internals

- The scoring lives in `ui/tests/manual_regression/smart-navigation/navigation_scoring.ts`
  (`landedLike`, `score`). There is no Playwright in it, so `tests/unit` can test it. The spec only
  collects `url`, `asked`, the `SmartNavigationLog` row and `popup`.
- **Entity targets** (`entity:<type>`): the UI opens an asset through `dockForTarget` →
  `AssetDocPointer.forTypeId(editorForType(type), …)` (`ui/src/navigation/navigation-decision.ts`).
  That is rebased onto the project, so the URL is `/dock/project/<projectId>/editor/<type>/typeid/<type>-<uuid>`.
  The older `/dock/assets/editor/…` form still counts.
- **External `url:` targets** open in the in-app web view: `DockPointer.forWebUrl` →
  `pointerForWebUrl` (`ts_sdk/src/models/web-url-pointer.ts:13`). That gives
  `/dock/web-app/url/<base64url(encodeURIComponent(new URL(u).href))>`, which is `+`→`-`, `/`→`_`,
  with no `=` padding, and `href` normalizes the trailing slash. `webViewOf` must encode exactly the same way.
- **`/win/…` app paths** do not move the tab. `openAppPath` (navigation-decision.ts) calls
  `window.open(path, '_blank', 'popup')`, so the main page's URL stays where it was. The spec listens
  for `page.on('popup')`, waits for the popup's http URL, records its pathname as `popup` (also in the
  jsonl, so `afterAll` re-scores with it), and closes it.

## Invariants

- Every route a target can really open on is accepted by `landedLike`. When the app moves a route
  (as with the project-rebased editor), the scorer and its unit test move with it, in the same change.
- `asked` (the decision's `data.prompt` is set) is never landing, whatever the URL.
- A changed rule re-scores old rows: `afterAll` re-runs `score` on the last jsonl row of each sentence.

## Failure modes

- A new or renamed editor/view route that the scorer does not know: right decisions show as 2 with
  reason `opened <right place>`. Lever (proven): put `inEditor` back to `/assets/editor/` only and
  "an asset opened in its project editor is the entity landed on" goes red; with the project route it is green.
- Web-view encoding drift: hand-rolling base64 without the base64url swaps or the `href`
  normalization misses `url:` targets.
- Popups: score from `page.url()` alone and every `/win/` target looks like it stayed on Home.
- This is not where decision quality is judged. A 2 whose `decision` names the wrong target is the
  navigator's miss (`flow_sdk/core/navigator.py`), not the scorer's.
