"""Offline checks for the live runners' cell inventory and evidence gates."""

from types import SimpleNamespace

import pytest

from tests.loginless_e2e.make_matrix_endpoint import MATRIX_SLUGS, VERTEX_SLUGS, matrix_cells
from tests.loginless_e2e.worker_matrix import MODELS, _said, _source_evidence, selected_workers


def test_default_grids_keep_all_cells():
    workers = selected_workers([])
    cells = matrix_cells("kimi glm openai claude", "sm md lg")
    assert len(workers) * len(MODELS) == 15
    assert len(workers) * len(cells) == 60
    assert len(set(MATRIX_SLUGS)) == 12, "each family/size must exercise a distinct model"
    assert set(VERTEX_SLUGS) <= set(MATRIX_SLUGS)
    assert {slug for _, _, slug in cells} == set(MATRIX_SLUGS)
    assert all(":" not in slug for _, _, slug in cells)


@pytest.mark.parametrize("families,sizes", [("typo", "sm"), ("kimi", "huge"), ("", "sm"), ("kimi", ""), ("kimi kimi", "sm")])
def test_invalid_family_filters_do_not_shrink_the_matrix(families, sizes):
    with pytest.raises(ValueError):
        matrix_cells(families, sizes)


def test_worker_alias_and_unknown_filter():
    assert selected_workers(["claude"]) == selected_workers(["claude_code"])
    with pytest.raises(ValueError, match="unknown workers"):
        selected_workers(["typo"])


def test_prompt_and_reasoning_cannot_supply_the_answer():
    history = [
        SimpleNamespace(attributes={"role": "user", "element-type": "chat"}, flow_value="say pong"),
        SimpleNamespace(attributes={"role": "assistant", "element-type": "thinking"}, flow_value="pong"),
    ]
    assert _said(history) == ""
    history.append(SimpleNamespace(attributes={"role": "assistant", "element-type": "chat"}, flow_value="answer"))
    assert _said(history) == "answer"


@pytest.mark.asyncio
async def test_source_evidence_requires_actual_binding_stamp(monkeypatch):
    from flow_sdk.instance_settings import llm_endpoint

    monkeypatch.setattr(llm_endpoint, "get_hub_llm_endpoint", lambda: SimpleNamespace(endpoint_typeid="expected"))
    process = SimpleNamespace(resolved_llm_endpoint_typeid=None, resolved_model_slug="openrouter/vendor/model")
    with pytest.raises(ValueError, match="unproven source"):
        await _source_evidence(process, "vendor/model")
    process.resolved_llm_endpoint_typeid = "expected"
    assert "source=expected" in await _source_evidence(process, "vendor/model")
    with pytest.raises(ValueError, match="wrong model"):
        await _source_evidence(process, "vendor/other")


@pytest.mark.asyncio
async def test_missing_binaries_report_every_required_cell_as_failure(monkeypatch, capsys):
    from tests.loginless_e2e import worker_matrix

    monkeypatch.setattr(worker_matrix.sys, "argv", ["worker_matrix.py"])
    monkeypatch.setattr(worker_matrix.shutil, "which", lambda _: None)
    assert await worker_matrix.main() == 1
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 15
    assert all(line.startswith("FAIL") and "BLOCKED" in line for line in lines)


def _accounting_rows():
    # Actual Codex ledger shape: model-list discovery has no model, usage, or charge.
    return {
        "-": {"requests": 1, "estimated_requests": 1},
        "openai/gpt-4o-mini": {"requests": 1, "input_tokens": 38525, "output_tokens": 2, "cost_micro_usd": 5780},
    }


def _sum_rows(rows):
    return {field: sum(row.get(field, 0) for row in rows.values()) for field in {k for row in rows.values() for k in row}}


def test_accounting_accepts_only_unbilled_metadata_and_exact_model():
    from tests.long_tests.test_llm_endpoint_workers import _assert_model_accounting

    rows = _accounting_rows()
    _assert_model_accounting(_sum_rows(rows), {}, rows, "openai/gpt-4o-mini")
    # Provider-reported cost may differ from the bundled static price table.
    rows["openai/gpt-4o-mini"]["cost_micro_usd"] = 7000
    _assert_model_accounting(_sum_rows(rows), {}, rows, "openai/gpt-4o-mini")


@pytest.mark.parametrize("failure", ["metadata_charge", "other_model", "missing_cost", "mismatched_totals"])
def test_accounting_rejects_false_source_or_cost_evidence(failure):
    from tests.long_tests.test_llm_endpoint_workers import _assert_model_accounting

    rows = _accounting_rows()
    if failure == "metadata_charge":
        rows["-"]["cost_micro_usd"] = 1
    elif failure == "other_model":
        rows["google/gemini-3.8-flash"] = {"requests": 1, "input_tokens": 549, "output_tokens": 3, "cost_micro_usd": 423}
    elif failure == "missing_cost":
        rows["openai/gpt-4o-mini"]["cost_micro_usd"] = 0
    total = _sum_rows(rows)
    if failure == "mismatched_totals":
        total["input_tokens"] += 1
    with pytest.raises(AssertionError):
        _assert_model_accounting(total, {}, rows, "openai/gpt-4o-mini")
