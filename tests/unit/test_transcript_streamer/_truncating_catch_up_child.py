"""A catch-up child that dies part-way: one valid record for the first file,
then exit 0 with no terminal ``result`` line. ``test_catch_up_child`` points
``catch_up.CHILD_MODULE`` at this module to drive the parent's fallback.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

if __name__ == "__main__":
    request = json.load(sys.stdin)
    first = Path(request["files"][0])
    st = first.stat()
    sys.stdout.write(json.dumps({
        "path": str(first), "worker_type": "claude", "session_id": first.stem,
        "has_session_meta": False, "entries": 1,
        "size": st.st_size, "mtime_ns": st.st_mtime_ns,
    }) + "\n")
    sys.stdout.flush()
