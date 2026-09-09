"""Killing a timed-out child AND everything it forked.

A leaf module on purpose: `core/wizard/exec.py` is deliberately entity-free
(that is what lets the wizard runner test in milliseconds) and `hook_models`
imports entities, so neither can import the other. They had a byte-identical
copy of this each.

One owner matters here because the lesson is specific and was learned the hard
way: `proc.kill()` alone reaps the script's own process only. Its children
inherit the stdout/stderr pipes, so they keep the write end open and the
follow-up `communicate()` blocks for as long as they run — a 1s timeout on a
script that forks a 10s `sleep` returned after 10s. Killing the whole group is
what makes `timeout_seconds` a real bound rather than a suggestion. A second
copy is a second chance to lose that.
"""

from __future__ import annotations

import os
import signal

#: POSIX-only; on Windows the command is spawned and killed as a lone child.
CAN_KILLPG = hasattr(os, "killpg")


def kill_process_tree(proc) -> None:
    """SIGKILL the process and its whole group, falling back to the process."""
    if CAN_KILLPG:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            return
        except OSError:
            # Group already gone, or we never got one — fall through.
            pass
    try:
        proc.kill()
    except ProcessLookupError:
        pass
