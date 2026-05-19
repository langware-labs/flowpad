#!/usr/bin/env python3
"""Host-side browser validation for the migration e2e test.

Phase 4 of the plan — runs OUTSIDE the Docker container, on the host,
inside a Claude Code session that exposes the ``mcp__debugMcp__browser_*``
tools. Loads ``http://localhost:${PORT}`` (default 9711, container's
forwarded port), asserts the app boots cleanly:

  * no console.error / console.severe messages
  * no 4xx/5xx network responses
  * every seeded asset name (from /tmp/seeded_ids.json) appears in the
    accessibility snapshot — proving the migration didn't just preserve
    files on disk, it surfaced them to the UI

This script is **driver-agnostic by design**: it can't be invoked directly
from a non-MCP shell. Run it via the Claude Code prompt:

    Please run the browser validation in
    tests/migration_e2e/browser_validate.py against port 9711.

…and Claude will use the debugMCP tools to drive the browser. The seeded
IDs are read from the host filesystem (the container's
``/tmp/seeded_ids.json`` is copied out by ``run.sh`` if you want full
automation — currently a manual handoff).

Until that hand-off is wired, this file is a **specification + checklist**
of what the browser validation must assert. See run.sh's Phase 4 banner
for the manual invocation hint.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

PORT = int(os.environ.get("PORT", "9711"))
SEEDED_IDS_PATH = Path(os.environ.get("SEEDED_IDS", "/tmp/seeded_ids.json"))


def load_seeded() -> list[dict]:
    if not SEEDED_IDS_PATH.exists():
        raise SystemExit(
            f"seeded_ids.json not found at {SEEDED_IDS_PATH}. "
            f"Copy from container first: "
            f"docker cp flowpad-e2e:/tmp/seeded_ids.json {SEEDED_IDS_PATH}"
        )
    return json.loads(SEEDED_IDS_PATH.read_text())


CHECKLIST = """
Browser validation checklist (drive via debugMCP):

  1. mcp__debugMcp__browser_navigate("http://localhost:{port}")
  2. mcp__debugMcp__browser_wait_for(text="Flowpad", timeout=20_000)
  3. console = mcp__debugMcp__browser_console_messages()
     → assert no entry with level in ("error", "severe")
  4. network = mcp__debugMcp__browser_network_requests()
     → assert no entry with status_code >= 400
  5. snapshot = mcp__debugMcp__browser_snapshot()
     → for each asset in seeded_ids.json:
         assert asset["name"] in snapshot.text
  6. mcp__debugMcp__browser_close()

Expected seeded assets (these names should appear in the UI):
{names}
""".strip()


def main() -> int:
    seeded = load_seeded()
    names = "\n".join(f"  - {a['type']:10s} {a['name']}" for a in seeded)
    print(CHECKLIST.format(port=PORT, names=names))
    print()
    print(f"Seeded IDs file: {SEEDED_IDS_PATH}")
    print(f"App URL:         http://localhost:{PORT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
