---
id: 9ad58753-7eb4-501a-a8d2-65001e264330
name: skillit
description: Skill quality lens — review a skill against skill-writing best practices,
  or correct a skill given a list of issues observed while running it. Use whenever
  the user asks to review, audit, lint, fix, or improve a SKILL.md / skill folder,
  says "skillit <path>", or reports that a skill misbehaved during a run and wants
  it corrected.
tags:
- skills
- review
- quality
---

# Skillit — review & correct skills

Skillit is the static-artifact half of a teaching loop: it reviews and
corrects the recipes (skill files) themselves — it does not scan live
sessions or measure runtime usage.

This file only routes. Load a file when its row matches the task at hand, and
follow routing chains until you reach instructions.

## Mode dispatch

| Request shape                                                        | Mode    |
| -------------------------------------------------------------------- | ------- |
| "review / audit / check / lint this skill" — no run-time issues given; optionally with a context document (transcript, spec) to judge against | review  |
| issues observed while *running* the skill are supplied                | correct |

Run-time issues force correct mode even if the user says "review".

Resolve the target skill before loading anything else: a path, or a name under
`.claude/skills/` (project) / `~/.claude/skills/` (user). The target is the
whole folder — SKILL.md plus everything it routes to.

## Routing table

| When you need to…                                              | Load                  |
| --------------------------------------------------------------- | --------------------- |
| run a review pass (incl. deciding whether to stop on a re-review) | `modes/review.md`     |
| apply corrections for reported issues                           | `modes/correct.md`    |
| judge the target against best practices (either mode)          | `rubric/rubric.md` — an index itself; it routes to the specific criterion |

## Ground rules (apply in every mode)

- Never delete knowledge from a target skill — fix its routing, structure, or
  content instead; unused is not a reason to remove. Unused today is a retrieval
  problem, not a content problem; tomorrow's reader may need it.
- Integrate edits in place — edit the existing instruction so the nuance becomes
  part of it, keeping the file readable as if it were always correct. When you
  append changelogs, dated bullets, or mistakes-log sections, they accumulate
  into a changelog nobody reads; integrating ensures the skill guidance stays
  current and navigable for each reader.
- At most 5 findings or corrections per pass — small batches keep each correction
  attributable and reviewable; large batches hide which change caused a side effect.
- After any edit, audit the touched files against `structure.md #1` (indexes
  stay thin) and `structure.md #6` (every routing reference resolves, every
  file reachable). If the audit fails, revert the edit.
