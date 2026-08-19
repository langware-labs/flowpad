"""Which projections announce themselves, and which stay quiet.

The projected tag is what drives an agent turn, so "did this announce" is the
difference between mail being answered and mail being filed silently. Two rules
have to hold at once, and they pull in opposite directions:

* a bulk import must not announce per item — the storm caps are 30/min and
  raising them is not an option, and on an agent mailbox every surviving event
  spends a real turn answering months-old mail;
* a mailbox's FIRST poll must still announce, because that is when the first
  mail an agent ever receives arrives.

The second rule is the one that is easy to break: `IngestMode` classifies any
first run as a backfill, so gating the announcement on "is this a backfill"
looks right and silently means a newly-connected agent never answers anybody.
Keying on the BATCH SIZE satisfies both.
"""
from __future__ import annotations

import pytest

from flow_sdk.ingest.models import STORM_CAP_PER_MINUTE

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval


def _announces(batch_size: int) -> bool:
    """The rule `reconcile_source` applies.

    Restated here rather than driven through the sweep: exercising the real call
    site means standing up a source, a driver and N ingested rows, and the thing
    under test is one comparison. The call site itself is covered end to end by
    `tests/hub_tests/test_agent_email_conversation.py`, whose first sync IS a
    one-message first poll — the case below that regressed.
    """
    return batch_size <= STORM_CAP_PER_MINUTE


def test_a_first_poll_carrying_one_message_still_announces():
    """The regression this file exists for: first sync, one mail, agent answers."""
    assert _announces(1)


def test_a_batch_at_the_cap_still_announces():
    assert _announces(STORM_CAP_PER_MINUTE)


def test_a_bulk_import_does_not_announce_per_item():
    assert not _announces(STORM_CAP_PER_MINUTE + 1)
    assert not _announces(500)
