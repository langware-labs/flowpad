# Criterion: content

> Ground rules (inline by design): never delete knowledge; integrate, don't
> append; max 5 findings/corrections per pass; converged is a valid verdict.

1. **Principles, not incidents.** Instructions encode the general rule, never
   the one-off it was learned from. Hardcoded example paths, incident-specific
   values, or rules that only make sense for one past failure are defects — a
   skill is run across prompts its author never saw.
2. **Timeless vs. timebound is kept separate.** Durable rules ("how to do X
   safely") and expiring state ("status of the current effort") never share a
   file. The test: would a reader still want this line six months after the
   current work shipped? No → it doesn't belong in a capability file.
3. **Concrete examples where format matters.** Output formats, templates, and
   report shapes are shown as literal blocks, not described abstractly. This
   applies both to agent output and to instructions — when a rule prescribes a
   shape or format, show it literally.
   
   Bad: "Return a verdict and list of files."
   Good: "Return exactly:
   ```
   VERDICT: CORRECTED | CONFLICT
   FILES: <files touched, comma-separated>
   ```"
4. **Every section earns its tokens.** Instructions the model would follow
   anyway, duplicated rules (other than the deliberate inline ground-rules
   block), and stale references are dead weight.
5. **Self-consistent.** The body must not contradict the frontmatter, itself,
   or its bundled files.
