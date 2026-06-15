# Reference — Output Formats, Schemas, Storage, Error Handling

## Summary Table Format

Always end with a summary:
```
QA Cycle Results
────────────────
Total:       N scenarios
Passed:      N (green)
Failed:      N (red)      ← app bugs
Test Issues: N (orange)   ← scenario authoring problems
Flagged:     N (purple)   ← senior dev review required
Skipped:     N (yellow)
Errors:      N (red)
Duration:    Xs
Pass Rate:   N%           ← excludes test-issues from denominator
Report:      <path-to-report.html>
```

**Pass rate calculation**: `passed / (total - skipped - test_issues) * 100`. Flagged scenarios **stay in the denominator** — a flag is a real coverage hole, and the pass rate must reflect it. They are listed separately so senior review can find them.

---

## Test Index Format

The file `.flow/skills/agentic-qa/test_index.md` uses this format:

```markdown
# Test Index

> Last updated: 2026-03-04T10:30:00Z
> Scope: .md scenarios only. .md.ts-only files without a .md spec are not counted.

## chat (20 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| chat_input_controls.md | 3 | yes | no | - |
| chat_streaming.md | 2 | yes | no | - |
| in_claude_ctrlv_does_not_paste.md | 1 | no | no | clipboard |
...

## terminal (19 scenarios)
...
```

**Column definitions**:
- **Playwright**: `yes` if a `.md.ts` file exists
- **Fast Path**: `yes` if a `_fast_paths/<category>/<name>.fast.ts` file exists
- **Skip**: skip reason if unautomatable (`clipboard`, `live-claude`, `platform`), or `-` if runnable

---

## JSON Schemas

### Test Result (`schemas/test-result.schema.json`)
- `scenario_path`, `category`, `status` (pass|fail|skip|error|test-issue|flagged)
- `execution_method` (playwright|fast-path|mcp-browser|skipped)
- `known_bug`, `flag_reason`, `tests[]`, `environment`
- **Filled sample**: `examples/sample-test-result.json`

### Cycle Report (`schemas/cycle-report.schema.json`)
- `summary` (incl. `flagged` count), `categories`, `results[]`, `stale_fast_paths[]`, `flagged[]`
- **Filled sample**: `examples/sample-cycle-report.json`

---

## HTML Report Template

Inject at `<!-- REPORT_DATA -->`:
```html
<script>const REPORT_DATA = { /* cycle-report JSON */ };</script>
```

---

## Result Storage

```
_results/
  2026-03-04T10-30-00/
    cycle-state.md                 ← durable orchestration ledger (phase, dispositions, owners, locks)
    phase10--chat.json             ← raw Playwright JSON reporter output, per category
    phase10-summary.json           ← aggregated per-test pass/fail list (Phase 11's work list)
    chat--chat_input_controls.json
    terminal--run_basic_command.json
    flagged.md                     ← senior-dev-review queue (Autonomous Run Policy)
    cycle-report.json
    report.html
```

File naming: `<category>--<scenario-name>.json`.

---

## Error Handling

- If a tester teammate fails to produce a result, create an error result with `status: "error"`
- If the HTML template is missing, generate a minimal HTML report inline
- If the results directory doesn't exist, create it
- Never let a single scenario failure stop the entire cycle
- **Never launch a tester without a current test index file**
