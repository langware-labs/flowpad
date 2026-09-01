"""The agent ingest contracts name fields the write route actually accepts.

These two markdown files are prompts, so nothing executes them and nothing
caught it when they drifted: they asked the model for `source_id`, `stream_key`
and `title` long after ``SourceItemSpec`` had renamed those to
``data_source_id``, ``segment_key`` and ``name``. The spec is ``extra="forbid"``,
so every such batch was refused with five validation errors — while the
contract went on saying otherwise and the model improvised around it, landing
records with an empty subject.

The driver now names the accepted fields from the schema at prompt-build time
(``accepted_fields``). This pins the hand-written tables to the same source, so
a future rename breaks a fast test instead of a live mailbox sync.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.drivers.agent import accepted_fields

_AGENTS = Path(__file__).parents[2] / "flow_sdk/system_projects/flowpad_assistant/.claude/agents"
CONTRACTS = (_AGENTS / "email_analyzer.md", _AGENTS / "email_sender.md")

#: Pre-rename names. A contract asking for one of these is refused by the route.
RETIRED = ("source_id", "stream_key", "title")


def _field_table_rows(text: str) -> list[str]:
    """The first column of every `| \\`field\\` | … |` row — the names being asked for."""
    return re.findall(r"^\|\s*`([a-z_]+)`\s*\|", text, flags=re.MULTILINE)


@pytest.mark.parametrize("contract", CONTRACTS, ids=lambda p: p.name)
def test_contract_asks_only_for_fields_the_route_accepts(contract: Path):
    text = contract.read_text(encoding="utf-8")
    rows = _field_table_rows(text)
    assert rows, f"{contract.name} has no field table — did its shape change?"
    unknown = sorted(set(rows) - set(SourceItemSpec.model_fields))
    assert not unknown, (
        f"{contract.name} asks the model for {unknown}, which SourceItemSpec forbids "
        f"(extra='forbid'). Accepted: {sorted(SourceItemSpec.model_fields)}"
    )


@pytest.mark.parametrize("contract", CONTRACTS, ids=lambda p: p.name)
def test_contract_does_not_request_a_retired_name(contract: Path):
    """Naming a retired field in prose is fine — asking for one in the table is not."""
    requested = set(_field_table_rows(contract.read_text(encoding="utf-8")))
    assert not requested & set(RETIRED), (
        f"{contract.name} still requests retired field(s) {sorted(requested & set(RETIRED))}"
    )


def test_accepted_fields_lists_every_spec_field():
    """What the driver tells the worker is the schema, not a copy of it."""
    rendered = accepted_fields()
    for name in SourceItemSpec.model_fields:
        assert f"`{name}`" in rendered, f"{name} missing from the generated list"
    assert rendered.count("`") == 2 * len(SourceItemSpec.model_fields)
