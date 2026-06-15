# Criterion: triggering

> Ground rules (inline by design): never delete knowledge; integrate, don't
> append; max 5 findings/corrections per pass; converged is a valid verdict.

The frontmatter `description` is the only thing the model sees before deciding
to use a skill — it carries the entire triggering burden.

1. The description states what the skill does AND when to use it, with
   concrete trigger contexts — specific moments in the user's workflow where
   they need this skill (e.g., "when writing a SKILL.md", "after a test fails",
   "reviewing a PR before shipping"). Generic situations ("fixing code",
   "improving quality") under-trigger because they don't signal the exact
   decision point where the model should reach for this tool vs. another.
2. All "when to use" information lives in the description, never in the body —
   the body is only read *after* triggering, so placement there is too late.
3. The description is a little pushy: it names adjacent phrasings where the
   user doesn't say the skill's name but clearly needs it — moment-of-need
   recognition without broadening the claimed scope (bounded by rule #4).
   Models under-trigger by default; a timid description compounds that.
4. The description does not overclaim — triggering on requests the skill can't
   handle erodes trust in every future trigger.
