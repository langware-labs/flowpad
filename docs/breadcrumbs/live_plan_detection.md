---
title: Live plan detection — the plan path lives on the attachment
tags:
- breadcrumb.test.live_plan_detection.rules
description: ExitPlanMode carries only the plan prose; planFilePath lives on the earlier
  plan_mode attachment, so every plan consumer must resolve through plan_path_from_attachments().
---

# Live plan detection — the plan path lives on the attachment

> Ground truth. Proven on 2026-08-12 (FLOWPAD-1972). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.live_plan_detection.rules
sites:
  - rel_path: "tests/unit/test_agentic_process/test_live_plan_detection.py"
    line: 179
    note: "FAILING? the path is on the plan_mode ATTACHMENT, not on ExitPlanMode - read this tag before touching the guard"
```

## Expected behavior

A plan proposed mid-session must surface **on that turn**, not on the next page
reload. When the streamer flush sees an `ExitPlanMode` entry, the process's
`plan_path` is persisted, the entity-update broadcast goes out, and the ribbon's
Open-Plan chip appears — with no refresh.

The live (push) path and the `transcript/plan` (pull) path must never disagree
about *where* the plan is. Same transcript in, same path out.

## Internals

* **The tool_use does not carry the path.** `ExitPlanModeEntry.plan_file_path`
  (`flow_sdk/transcript_analyzer/entries/exit_plan_mode.py:23`) reads
  `tool_input["planFilePath"]`, and Claude Code's `ExitPlanMode` sends only
  `plan`. So `""` is the **normal** value for an ordinary Claude plan-mode turn,
  not an error. It is non-empty for the Codex-synthesized variant (and for
  Claude versions that do emit it), which is why it stays first in precedence.

* **The attachment carries it.** Claude announces the plan file on a `plan_mode`
  MetaEntry attachment when the turn *enters* plan mode — `attachment.type ==
  "plan_mode"`, `attachment.planFilePath`. That entry precedes the tool_use by
  the whole planning turn.

* **One resolver.** `AgenticProcess.plan_path_from_attachments()`
  (`flow_sdk/builtin/agentic_process/agentic_process.py:4709`) reverse-scans the
  transcript for the newest such attachment and returns its path, or `""` —
  including for a `None` transcript. It is a `@staticmethod`: it reads the
  transcript, nothing else.

* **Both paths resolve through it.** The pull path `_transcript_plan()`
  (`agentic_process.py:4582`) resolves `latest_plan` → cached `self.plan_path` →
  `plan_path_from_attachments()` (`:4617`). The live path
  `_process_transcript_entries()` (`agentic_process.py:7218`) — the seam the
  streamer's debounce flush actually calls — resolves
  `entry.plan_file_path or plan_path_from_attachments(self._load_transcript())`
  (`:7248`) and `continue`s only when both are empty.

* **The persist is the broadcast.** `on_plan_created()` (`:7670`) takes a
  `plan_file_path` override for callers that already resolved it, and the
  `self.save()` inside it is what emits the entity update the ribbon listens to.
  Order matters: the cross-link save runs *before* `emit_entity_event
  ("plan.create")` so consumers reading `private_context_entities` off the event
  already see the link.

* **Existence gates persistence, on the pull path only.** `_transcript_plan`
  clears a stale `plan_path` when the file is missing, keeping
  `hasPlan = !!plan_path` honest.

## Invariants

* **Never guard on `entry.plan_file_path` alone.** `isinstance(entry,
  ExitPlanModeEntry) and entry.plan_file_path` silently drops every ordinary
  Claude plan. Guard on the *resolved* path instead.

* **Precedence is fixed:** tool_use path → (pull path only: cached
  `self.plan_path`) → newest `plan_mode` attachment. The attachment is a
  fallback and must never displace a path the tool_use did carry.

* **One resolver, no fourth scan.** A new plan consumer delegates to
  `plan_path_from_attachments()` rather than re-walking the entries.

* Empty string means "not available", never "error". No consumer may raise on it.

## Failure modes

The on/off lever, at `agentic_process.py:7248`: replace the resolve with the old
`plan_file_path = entry.plan_file_path` and
`test_live_push_sets_plan_path_when_tool_use_omits_plan_file_path` fails —
`ap.plan_path` stays `None` because the entry is skipped, so nothing is
persisted and nothing is broadcast. Put the `or
plan_path_from_attachments(...)` back and all three pass. That is the whole bug.

Why it regressed silently: the only coverage was `plan_detection.test.ts`, which
polls `getPlan()` and therefore exercises the **pull** path — the path that
already had the fallback. The push path had no test at all. The tests here enter
through `_process_transcript_entries` with a real transcript, a real plan `.md`
and real DB rows; nothing on the resolution path is stubbed, because that path
*is* the bug.

One consumer is still un-migrated: `_derive_focused_asset`
(`agentic_process.py:7547`) guards on `entry.plan_file_path` at `:7563` and does
not fall back to the attachment, so for a Claude plan-mode turn it skips the
plan entry and keeps scanning back. It has no test here and was not part of the
proven fix — treat it as the next place this same shape can bite, not as a
proven defect.

<!-- flowpad:capsule identity
version: 1
data:
  id: 0a749f7a-15ff-475b-884b-26ecdc75750a
flowpad:endcapsule identity -->
