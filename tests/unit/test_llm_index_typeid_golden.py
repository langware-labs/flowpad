"""Golden: ``typeid_for`` is path-derived and must not move when the minting
call site changes (it now routes through ``mint_uuid``). A shifted id would
orphan every stored ``markdown_index`` row."""
from __future__ import annotations

import pytest

from flow_sdk.llm_index.indexer import typeid_for

pytestmark = pytest.mark.timeout(5)

# uuid5(NAMESPACE_URL, "/fixed/golden/path") — a literal, deliberately not recomputed here.
GOLDEN = "markdown_index-b863a30d-812c-560f-aff8-519341e031dd"


def test_typeid_for_is_unchanged_for_a_fixed_path():
    assert typeid_for("/fixed/golden/path") == GOLDEN
    assert typeid_for("/fixed/golden/../golden/path") == GOLDEN  # resolved first
