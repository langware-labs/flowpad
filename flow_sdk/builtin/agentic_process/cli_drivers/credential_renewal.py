"""Renew a spent worker-CLI credential before anything has to wait on it.

The vendor-neutral seam for "this box may have been idle; make sure the coding
CLI can still authenticate." Callers outside this driver layer — the hub
WebSocket's (re)connect is the one that matters — say only that, and stay free of
any vendor's name or credential layout.

**Only claude is wired up.** That is a statement about coverage, not about the
other vendors being excluded on purpose:

- **claude** — implemented. Its OAuth access token lives 8 hours and is renewed
  only when a CLI process starts and finds it expired, so a box that hibernated
  longer than that wakes with a dead one. See ``claude/credential.py`` for the
  measurements and the failure it exists to keep off the critical path.
- **codex** — NOT implemented, and NOT tested. We have not established whether
  its stored credential expires on a comparable clock, whether it self-renews on
  spawn, or where it keeps the expiry we would have to read.
- **copilot** — NOT implemented, and NOT tested. Harder than codex: its real
  token lives in the OS credential store (see ``auth_probe.probe_copilot_auth``,
  which can never claim ``verified`` for the same reason), so there may be no
  expiry we can read at all without the CLI's help.

Adding a vendor means giving it the same shape claude has — a cheap "is it
spent?" read and a renewal that nobody awaits — and adding it to
:func:`renew_stale_worker_credentials`. Until someone does that work and
measures it, silence here is honest: we do not know that those CLIs have this
problem, and we equally do not know that they don't.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def renew_stale_worker_credentials() -> bool:
    """Start a background renewal for every worker whose credential is spent.

    Returns whether any worker reported a spent credential. Never waits for a
    renewal to finish, never raises, and costs one small file read per wired
    vendor when everything is healthy — cheap enough to call from any event that
    merely *might* follow an idle gap.

    Local import: the vendor sub-packages pull in the cloud client, and this
    module's callers live under it. Binding them at module scope would close the
    cycle.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.claude import credential as claude_credential

    return claude_credential.start_renewal_if_stale()
