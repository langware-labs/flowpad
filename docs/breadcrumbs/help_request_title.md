---
id: 9a82bf7c-3b89-4345-900b-e85fccedeb84
title: A help request's message names the task by its base title
tags:
- breadcrumb.test.help_request_title.rules
description: When the ask-for-help dialog sends no title, the task is titled from
  the text's first line and may take the next free title ("… (2)"). The request message
  must compare against that same base (_task_base_title) so that it renames itself
  to the task's real title.
---
# A help request's message names the task by its base title

> Ground truth. Proven by the fix 644a268a7 (PR #814, 2026-11-10): the bound test failed without it and passes with it. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.help_request_title.rules
sites:
  - rel_path: "ui/tests/api/vibe_ask_for_help_failures.test.tsx"
    line: 32
    note: "FAILING? read this tag's rules before touching _task_base_title, _write_task or _write_request's title rename"
```

## Expected behavior

A person asks for help through the one-screen dialog, whose text starts with a title
another task in the project already has. The task is created as "<title> (2)", and the
request's opening message (the one carrying the task chip) also says "<title> (2)".

## Internals

All of this is in `flow_sdk/app/actions/ask_for_help_action.py`:

* The dialog (`AskForHelpDialog`, driven by `askForHelp()` in
  `ui/tests/utils/ask-for-help.tsx`) sends the notes as `ask.text` and **no** `ask.title`.
* `_write_task()` (`:761`) titles the task `base`, then `"{base} (n)"` for
  n = 2..20, until a save does not collide.
* `_write_request()` (`:316`) renames the message: when
  `task.title != asked_title` and the text starts with `asked_title`, it replaces that
  prefix with `task.title`.
* **The fix:** both use `_task_base_title(ask)` (`:755`):
  `(ask.title or first line of ask.text).strip()[:80]`. Before it, `_write_request`
  compared against `ask.title.strip()`, which is empty when the dialog sends no title,
  so the rename never fired.

## Invariants

* The task's base title and the message's comparison base are the same function
  of the request. Change one and you must change the other.
* The message names the task's real title (after collision numbering) whenever its
  text starts with the base.

## Failure modes

* **Before the fix:** the task was "<title> (2)", but the message still said
  "<title>", so `expect(opening?.text).toContain(task.title)` failed.
* A failure on the files assertion in the same test is a different matter. The opening
  message also carries the request's own context files (`CONTEXT_FILES` in this module:
  `help_request.value.json`, `logs.txt`, …), and the test filters them out.
