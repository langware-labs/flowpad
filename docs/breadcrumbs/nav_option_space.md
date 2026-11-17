---
id: 67a68737-2540-4c49-a30a-45f0c2ca42b8
title: Smart navigator — option space and acting rules
tags: [breadcrumb.test.nav_option_space.rules]
description: What the magic line's navigator offers the decision API (screens, matches, names) and when it acts — each rule proven live on Jev in QA i19.
---
# Smart navigator — option space and acting rules

> Ground truth. Proven by RCA on 2026-11-11 (QA cycle qa-20261109-230009, i19, live Jev via the local hub). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.nav_option_space.rules
sites:
  - rel_path: "tests/unit/test_navigator.py"
    line: 225
    note: "FAILING? read this tag's rules before changing the navigator's options, rules or thresholds"
  - rel_path: "tests/unit/test_navigator.py"
    line: 251
    note: "FAILING? read this tag's rules before changing the navigator's options, rules or thresholds"
  - rel_path: "tests/unit/test_navigator.py"
    line: 269
    note: "FAILING? read this tag's rules before changing the navigator's options, rules or thresholds"
  - rel_path: "tests/unit/test_navigator.py"
    line: 292
    note: "FAILING? read this tag's rules before changing the navigator's options, rules or thresholds"
  - rel_path: "tests/unit/test_navigator.py"
    line: 306
    note: "FAILING? read this tag's rules before changing the navigator's options, rules or thresholds"
  - rel_path: "tests/unit/test_navigator.py"
    line: 319
    note: "FAILING? read this tag's rules before changing the navigator's options, rules or thresholds"
  - rel_path: "tests/unit/test_navigator.py"
    line: 332
    note: "FAILING? read this tag's rules before changing the navigator's options, rules or thresholds"
  - rel_path: "tests/unit/test_navigator.py"
    line: 369
    note: "FAILING? read this tag's rules before changing the navigator's options, rules or thresholds"
  - rel_path: "tests/unit/test_navigator.py"
    line: 383
    note: "FAILING? read this tag's rules before changing the navigator's options, rules or thresholds"
  - rel_path: "tests/unit/test_navigation_sentences_rules.py"
    line: 32
    note: "FAILING? read this tag's rules before changing the navigator's options, rules or thresholds"
```

## Expected behavior

A sentence typed in the magic line is answered by a local **rule** (no model) when it exactly names
a place, else by **one decision** over the map's options, acted on only when sure. Every option must
be one place, described as what it is, and openable.

## Internals

* `flow_sdk/core/navigator.py`
  * `_static_options` — screens, sub-places, retired slugs (`RETIRED_DOCK_VIEWS`), type-list names.
  * `_screen_named` / `rule_hit` — exact-name rules; `_FILLER` = the, my, our.
  * `context_rule` / `_project_screen_named` — a name that needs the current project.
  * `_candidates` / `_about` / `_entity_options` — search matches.
  * `_acted_on` / `_match_keys` — `MIN_CONFIDENCE`, `CLEAR_LEAD`, `PLAIN_LEAD`.
  * `INSTRUCTIONS` and `SCOPE` — the two questions.
* `flow_sdk/core/navigation.py`
  * `asset_list_names` — the type-list names.
* `flow_sdk/core/dock_address.py`
  * `VIEW_META` — labels, aliases, `subplaces`, `default_tab`.

## Invariants (each proven with an on/off lever, live)

1. **A shared display name belongs to the type with a section of its own.** markdown and
   document_file are both "Documents"; `browseable_by=None` types yield (53).
2. **A retired screen's slug names its forward target**, as its address does ("signals" → `automations/bus`) (145).
3. **Every list the UI opens is a place on the map**: `assets/list/all` (48: 0.45 tree → 0.94 list).
4. **A search match is offered as what it is**: its label as title, plus `about` (the first sentence of its description).
   A slug alone reads as the request ("wizard 'llm-setup-opencode'" for "connect an LLM") (146, 119).
5. **"the" / "my" inside a name do not change it; "a" / "an" do** ("open a terminal" is a new one) (118).
6. **A screen that opens on a project, named with a project in context, opens on it**: "the help desk" → `helpdesk/<project>` (185).
7. **PLAIN_LEAD acts on map places, never on a bare full-text match** (78: no README → asks).
8. **The target question and SCOPE agree.** A change made on a screen, or a question a screen answers,
   names that screen. Use examples that are NOT in the 200-sentence suite (103, 116, 171, 172).
9. **A screen's default tab is one place with the screen**: offered once, "…, open on <tab>" (164).
   Keep `navigation_scoring.ts` `DEFAULT_TAB` in step with `VIEW_META.default_tab`.
10. **A rule never disagrees with `docs/navigation/navigation-sentences.md`**: `test_navigation_sentences_rules.py`.
    The open owner decision (58, "workflows") is an xfail.

## Failure modes

* Two option keys for one place split the probability, and neither clears the bar (164 at 0.33 / 0.33).
* An option the app cannot open, or one described only by its slug, wins the decision, and the UI asks or opens the wrong thing (185, 146).
* Instruction examples copied from the suite inflate the score without fixing the cause. Do not do that.
