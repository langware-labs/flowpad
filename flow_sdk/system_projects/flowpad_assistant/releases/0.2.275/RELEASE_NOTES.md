---
release: 0.2.275
from: v0.2.274
to: HEAD
source_hash: 4af712732a00247d
---

# Flowpad 0.2.275

*Released Nov 19, 2026*

## New
- **QA** — Q, the QA app, keeps its test plan (phases, test files, test cases), its runs (cycles, iterations, every test execution) and its findings in Flowpad instead of its own database; a record sent twice updates the one already there rather than making a copy.
- **QA test files** — a test file remembers the commit it was mapped at, so Q can tell when it has changed and suggest remapping it.
- **Root-cause analyses** — an RCA is its own kind of record and can be about any record, not only a failed test.
