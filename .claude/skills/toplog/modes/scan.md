# Mode: `scan` — reconcile code with the catalog

Keep the catalog honest: every topic the code traces should be documented, and
every documented topic should still exist in the code.

1. Run `python .claude/skills/toplog/scripts/scan_topics.py`.
2. Reproduce its reconciliation table for the user:
   ```
   catalogued: <topics in topics.md>
   UNDOCUMENTED (in code, not catalogued): <topics>
   STALE (catalogued, not in code):        <topics>
   ```
3. For each **undocumented** topic, propose a catalog entry (hand to `learn`); for
   each **stale** topic, confirm the trace lines are truly gone before proposing
   retirement. Surface findings — `scan` reports and recommends; it leaves code
   and catalog edits to `learn`, because removing a trace point is the one
   irreversible move here and belongs in a deliberate pass.
