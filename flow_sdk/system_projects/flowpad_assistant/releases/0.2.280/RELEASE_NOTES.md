---
release: 0.2.280
from: v0.2.279
to: HEAD
source_hash: 03606b0c8c5f6616
---

# Flowpad 0.2.280

*Released Nov 23, 2026*

## New
- **Keep working until done** — tell a session to keep going until a goal is met ("until all tests pass", "stop after 3 failed attempts"). Flowpad checks the goal on a schedule while the session is idle, prompts it to continue when the goal is not met yet, and stops checking by itself once it is. Each check and prompt is logged with the monitor, and a monitor can be removed at any time.
