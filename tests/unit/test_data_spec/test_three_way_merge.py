"""The three-way rule for a field copied outside Flowpad (``flow_sdk.datasets.merge``): found on GTM
Studio, whose CRM sync let the site win when BOTH sides had changed -- silently dropping a CRM edit."""
from __future__ import annotations

import pytest

from flow_sdk.datasets.merge import three_way

pytestmark = pytest.mark.timeout(5)


@pytest.mark.parametrize(("here", "there", "agreed", "want"), [
    ("a", "a", "old", ("same", "a")),
    (None, "", "x", ("same", None)),            # empty is empty, whatever its spelling
    ("new", "old", "old", ("here", "new")),     # only Flowpad changed: write it out
    ("old", "new", "old", ("there", "new")),    # only the outside changed: take it in
    ("mine", "theirs", "old", ("hold", "mine")),  # both changed: neither wins, report it
    ("", "theirs", "old", ("hold", "")),        # a clear here and an edit there are both changes
])
def test_each_side_wins_only_when_the_other_did_not_change(here, there, agreed, want):
    assert three_way(here, there, agreed) == want


def test_with_no_agreement_on_record_an_empty_side_follows_and_a_difference_holds():
    assert three_way(None, "theirs") == ("there", "theirs")
    assert three_way("mine", None) == ("here", "mine")
    assert three_way("mine", "theirs") == ("hold", "mine")
