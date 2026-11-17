---
id: 8c89179b-3dd4-49aa-8db9-2806f0e5b06f
title: 'Navigator: the owner decisions on sentences 58, 121, 191'
tags:
- breadcrumb.test.nav_owner_decisions.rules
description: '"workflows" is the dynamic-workflow list; bare "endpoint usage" is the LLM Endpoints list;
  the question an alias states ("what did we deliver") names its screen.'
---
# Navigator: the owner decisions on sentences 58, 121, 191

> Ground truth. Decided on 2026-11-11 under the owner's delegation (QA, before the next cycle). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.nav_owner_decisions.rules
sites:
  - rel_path: "tests/unit/test_navigator.py"
    line: 511
    note: "FAILING? read this tag's rules before changing these names"
```

## Expected behavior

- "show workflows" / "open my workflows" open `/dock/assets/list/dynamic_workflow` by rule. "graph workflows" opens Graph Workflows.
- "show endpoint usage" with no endpoint in context opens `/dock/hub/llm-endpoints` by rule. Its list shows each endpoint's usage today.
- "what did we deliver" / "what have we delivered" open Artifacts by rule. "what did we decide" is not a name, so the model decides it.

## Internals

- `flow_sdk/core/navigation.py` `LIST_WORDS`: a type's list called by a word beside its own names (`dynamic_workflow`: "workflow").
- `flow_sdk/core/dock_address.py`: Graph Workflows has no "workflows" alias. LLM Endpoints has "endpoint usage" / "endpoints usage".
- `flow_sdk/core/navigator.py` `_ASKED` / `_stated`: `what did|have we|i <verb>` is read as `what we <verb>ed|d`. It is a rule only when that statement is a name.

## Invariants

- A name opens one place. The question form opens a place only when exactly one name matches it.
- "workflows" belongs to the dynamic workflows: their asset family is `workflows` (`.claude/workflows`). Graph Workflows is a dev-mode editor.
