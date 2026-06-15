# Mode: correct

> Ground rules (inline by design): never delete knowledge; integrate, don't
> append; max 5 findings/corrections per pass; converged is a valid verdict.

Input: the target skill plus a list of issues — review findings, run-time
observations, or a failed transcript. Output: edits applied to the target via
fixer agents, with an issue → outcome mapping. The aim of every correction:
the next run does it right with no awareness that it went wrong.

## Procedure — serialized fixers

1. Triage the issue list first: anything that is not a defect of the skill
   itself — environment problems, user preferences the skill shouldn't
   hardcode — is OUT_OF_SCOPE (same lane as review mode) and goes to the user
   in the report, never to a fixer. Cap what remains at 5 (ground rule);
   queue the rest and say so.
2. For each remaining issue, launch ONE skill-fixer agent on `model: haiku`,
   prompt built from `../agents/skill-fixer.md` (target root, rubric index
   path, the single issue). Run fixers **one at a time** — two issues can
   touch the same file, and serialization is what prevents one fixer
   clobbering another's edit. The fixer owns the edit discipline (locate the
   step, principle not incident, integrate in place); do not re-fix its work
   from the orchestrator.
3. After each CORRECTED return, audit the touched files against
   `structure.md #1` and `#6` (the canonical post-edit invariants). If the
   audit fails — or the fixer itself returns FAILED_AUDIT — revert that
   fixer's edit and record the issue as failed-audit (it returns to the
   queue with the audit reason attached).
4. Collect CONFLICT returns verbatim — a contradiction between guidelines is
   the user's decision, and both quoted sides go in the report untouched.

## Report format

```
## Corrections applied (pass N)
- issue: <as given> → CORRECTED: <files> — <what changed>
- issue: <as given> → ALREADY_APPLIED: <file>:<section>
- issue: <as given> → CONFLICT: side A "<quote>" vs side B "<quote>" — <question>
- issue: <as given> → OUT_OF_SCOPE: <why it isn't the skill's defect>
- issue: <as given> → failed-audit: <reason>, reverted, re-queued
<queued: K more, next pass>
Audit: <pass | reverted: which edit, why>
```

After the report, hand back to the loop (`review.md` — "The loop"): the next
review pass verifies these fixes held.
