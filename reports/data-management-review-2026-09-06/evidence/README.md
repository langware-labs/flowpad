# Review evidence

These are archived diagnostic programs from the 2026-09-06 review, not application changes or a replacement for regression tests. They were run in separate processes against temporary files/databases. The area reports record their observations and limits.

Run Python probes from the repository root, for example:

```bash
PYTHONPATH=. uv run python reports/data-management-review-2026-09-06/evidence/flowpad_record_review_probe.py
```

| File | What it exercises |
|---|---|
| `flowpad_record_review_probe.py` | Real records/entities/SQLite: stale refresh, child session ownership, injected FTS rollback, duplicate-body size, nullable group clear, and real fs-records PUT handler |
| `flowpad-review-search-routes.py` | Both real search handlers and SQLite with six controlled rows |
| `flowpad-review-generation.py` | Old FTS DDL → real migration → preserved Entity/sentinel and empty FTS; evaluates the normal-index skip expression |
| `flowpad-review-index-probes.py` | In-memory SQL query-plan/timing comparison; the rowid alternative requires an explicit stable mapping in production |
| `flowpad-review-sidecars.py` | Real readers/writers rejecting one another's valid sidecar format |
| `flowpad-review-watch-leak.test.ts` | Real DataManager with stubbed HTTP; assertion fails because unsubscribe leaves a callback |
| `flowpad-review-search-race.test.tsx` | Real React asset-search hook with deferred responses; assertion fails because the old response wins |
| `count_sloc.py` | Recounts selected non-overlapping production source blocks, excluding blanks/comments/Python docstrings; uses the installed TypeScript compiler for TS token spans |
| `sloc-counts.json` | Recorded SLOC baseline, exact selected files/symbols, counting definition and follow-up snapshot |

The frontend probes were temporarily placed under `ui/tests/unit`, run with the existing Vitest unit configuration and unchanged timeout caps, then removed. They are intentionally outside test discovery here. Their assertions describe the correct behavior and failed during the review, demonstrating the defects. The existing `use-record-search-race.test.tsx` was also run and passed both tests.

Filesystem/orphan/identity probes from the agents are documented with their inputs and outputs in the scan and asset reports; their standalone source was not retained in this archive. No full application benchmark or complete E2E run is represented by these scripts.
