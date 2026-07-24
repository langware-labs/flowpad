# Mode: `scan` — reconcile code with the catalog

Keep the catalog honest: every tag the code traces should be documented, and
every documented tag should still exist in the code.

1. Run `python .claude/skills/toplog/scripts/scan_tags.py`.
2. Reproduce its reconciliation table for the user:
   ```
   catalogued: <tags in tags.md>
   UNDOCUMENTED (in code, not catalogued): <tags>
   STALE (catalogued, not in code):        <tags>
   ```
3. For each **undocumented** tag, propose a catalog entry (hand to `learn`); for
   each **stale** tag, confirm the trace lines are truly gone before proposing
   retirement. Surface findings — `scan` reports and recommends; it leaves code
   and catalog edits to `learn`, because removing a trace point is the one
   irreversible move here and belongs in a deliberate pass.
