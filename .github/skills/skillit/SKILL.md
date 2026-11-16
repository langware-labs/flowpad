---
id: 9ad58753-7eb4-501a-a8d2-65001e264330
name: skillit
description: Skill quality lens — map a skill's flow, review it against skill-writing best practices, trace what a real run did on that map (time and cost per block), and improve the skill from the run. Triggers on "map this skill", "review / audit this skill", "trace this run of <skill>", "how did <skill> do", "improve / fix this skill from this run", or `skillit map|review|trace|improve`.
tags: ''
version: 6
---

# Skillit — map, review, trace and improve skills

Skillit teaches skills from two sides: the recipe as written (map, review) and
the recipe as it ran (trace, improve). The map and the run on it are the
**flowmap** skill's format and viewer; skillit decides what to do with them.

This file only routes. Load a file when its row matches the task at hand, and
follow routing chains until you reach instructions.

## Mode dispatch

| Request shape                                                                                                                                 | Mode    |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| "map this skill", "show me how it flows" — build or refresh the skill's flowmap                                                              | map     |
| "review / audit / check / lint this skill" — no run-time issues given; optionally with a context document (transcript, spec) to judge against | review  |
| "trace this run", "what did it actually do", "how long / how much did it cost" — lay one run on the map                                       | trace   |
| a run (session) to learn from, or issues observed while *running* the skill                                                                   | improve |

Run-time issues force improve mode even if the user says "review". Trace only
measures; when the person wants the skill changed from a run, it is improve.

Resolve the target skill before loading anything else: a path, or a name under
`.claude/skills/` (project) / `~/.claude/skills/` (user). The target is the
whole folder — SKILL.md plus everything it routes to.

## Routing table

| When you need to…                                                 | Load                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| build or refresh the skill's map                                  | `modes/map.md`                                                            |
| run a review pass (incl. deciding whether to stop on a re-review) | `modes/review.md`                                                         |
| lay a run on the map (time, cost, traveled path)                  | `modes/trace.md`                                                          |
| apply corrections from a run or reported issues                   | `modes/improve.md`                                                        |
| judge the target against best practices (review, improve)         | `rubric/rubric.md` — an index itself; it routes to the specific criterion |

## Ground rules (apply in every mode)

* Never delete knowledge from a target skill — fix its routing, structure, or
  content instead; unused is not a reason to remove. Unused today is a retrieval
  problem, not a content problem; tomorrow's reader may need it.

* Integrate edits in place — edit the existing instruction so the nuance becomes
  part of it, keeping the file readable as if it were always correct. When you
  append changelogs, dated bullets, or mistakes-log sections, they accumulate
  into a changelog nobody reads; integrating ensures the skill guidance stays
  current and navigable for each reader.

* At most 5 findings or corrections per pass — small batches keep each correction
  attributable and reviewable; large batches hide which change caused a side effect.

* After any edit, audit the touched files against `structure.md #1` (indexes
  stay thin) and `structure.md #6` (every routing reference resolves, every
  file reachable). If the audit fails, revert the edit.
