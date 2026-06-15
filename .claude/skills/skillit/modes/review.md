# Mode: review

> Ground rules (inline by design): never delete knowledge; integrate, don't
> append; max 5 findings/corrections per pass; converged is a valid verdict.

Input: the target skill, plus an optional **context document** — a transcript,
guideline doc, or spec the skill is judged against in addition to the rubric.
Review judges the skill as written — it does not run it, and it does not edit
anything; the report is the deliverable.

## Procedure — fan out, then aggregate

1. Read the target's entry file, then traverse its routing: every file an
   index row points at, recursively. This yields the file list and exposes
   unreachable files (`structure.md #6` findings the orchestrator reports
   directly — reviewers only see reachable files).
2. Launch ONE skill-reviewer agent per target file, all in parallel, each on
   `model: haiku`. Build each prompt from `../agents/skill-reviewer.md`,
   filling: target root, that agent's assigned file, the rubric index path,
   the context path if given, and the sub-task ("judge this file against the
   rubric and context"). One file per agent keeps each judgment deep and the
   fan-out bounded by the skill's own size.
3. Aggregate the returned verdicts:
   - PASS files: list briefly — they are the evidence for convergence.
   - CORRECT findings: merge across agents, dedupe (same file+section+cite is
     one finding), keep the 5 most consequential; queue the rest explicitly.
   - CONFLICT entries (per the decisive test in the reviewer template's
     verdict meanings): surface verbatim in their own section — a conflict is
     the user's decision, never resolved silently. Conflicts block only the
     findings they cover, not the rest of the pass.
   - OUT_OF_SCOPE entries: merge and dedupe into their own report section.
     These are real guidelines that should not be handled inside this skill —
     they go to the user, never into the findings list, never to a fixer, and
     they don't count against the 5-finding cap or block convergence.

   Derive the pass verdict from the aggregate: any unreachable file or broken
   routing reference → broken; any CORRECT finding → needs work; all PASS, or
   only queued repeats / CONFLICTs awaiting the user → converged — stop;
   healthy = converged on a first review (nothing to fix, nothing pending).

## Stopping — review will be called repeatedly

A skill under review is a static artifact: between two reviews with no edits,
no new evidence exists, so "look harder" can only manufacture findings.
Therefore:

- A finding must cite a rubric rule (`<file> #<rule>`) or a context location
  (short verbatim quote). An uncitable preference is not a finding — this
  binds the reviewer agents and the orchestrator's aggregation alike.
- If a prior skillit review of this target is available (in the conversation,
  or supplied), do not re-raise a finding that was fixed and has not
  regressed; verify the fix held instead, and say so — checking less as
  confidence rises is the mechanism, re-litigating is not.
- **Converged** is the verdict when every reviewer returns PASS, or the only
  CORRECT findings are queued repeats of already-reported ones, or the only
  remaining entries are CONFLICTs awaiting the user. State it plainly and
  recommend stopping the loop. Two consecutive converged passes mean further
  review calls are waste — refuse the third politely.

## The loop

review(context) → CORRECT findings feed correct mode → correct applies them →
review again. Stop per the verdicts above; CONFLICTs go to the user, then one
more cycle. On a re-review, fan out only over files edited since the prior
pass (plus held-fix verification) and carry forward prior PASS verdicts for
untouched files — no edits means no new evidence.

## Report format

```
# Skillit review: <skill-name>  (pass N)

## Verdict
<healthy | needs work | broken | converged — stop>

## Findings (max 5)
- [<criterion-file> #<rule> | context: "<quote>"] <file>:<section> — what, why, one-line fix
...
<held back: K more, next pass>

## Conflicts (user decision required)
- side A: "<quote>" (<source>) vs side B: "<quote>" (<source>) — <question>

## Out of scope (flagged for user)
- <cite> — why it doesn't belong in this skill; where it belongs instead

## Held fixes (re-reviews only)
- <prior finding> — fix held / regressed

## What's good
<patterns worth keeping, so a correct pass doesn't destroy them>
```
