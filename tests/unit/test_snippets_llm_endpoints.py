"""Every symbol ``docs/snippets/llm-endpoints.md`` names must exist and mean what it says.

The snippet shelf is the onboarding path, so a snippet that no longer runs is worse than no
snippet: it is a confident wrong answer. The behaviour behind each block is pinned by
``test_llm_endpoint_rows.py`` and ``test_llm_client.py``; this file is the cheap guard
against the other failure mode — a rename that leaves the prose pointing at nothing.

It reads the document, so a block that names a symbol nobody exported fails here.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

SNIPPET_DOC = Path(__file__).resolve().parents[2] / "docs" / "snippets" / "llm-endpoints.md"


def _doc() -> str:
    return SNIPPET_DOC.read_text()


def test_the_snippet_file_is_on_the_shelf_index():
    readme = (SNIPPET_DOC.parent / "README.md").read_text()
    assert "llm-endpoints.md" in readme, "a category with no README row is a category nobody finds"


@pytest.mark.parametrize(
    ("module", "symbol"),
    [
        ("flow_sdk.builtin.llm_endpoint", "LLMEndpoint"),
        ("flow_sdk.builtin.llm_endpoint", "LLMEndpointKind"),
        ("flow_sdk.lm_api", "set_lm_api"),
        ("flow_sdk.instance_settings.llm_endpoint", "fetch_hub_llm_endpoints"),
        ("flow_sdk.builtin.agentic_process.cli_drivers.llm_source", "list_llm_candidates"),
        ("flow_sdk.builtin.agentic_process.cli_drivers.llm_source", "list_llm_sources"),
        ("flow_sdk.builtin.agentic_process.cli_drivers.llm_source", "resolve_box_llm_endpoint"),
        ("flow_sdk.external_apis.llm.errors", "LLMAuthError"),
        ("flow_sdk.external_apis.llm.errors", "LLMNoCredential"),
        ("flow_sdk.external_apis.llm.errors", "LLMRateLimited"),
        ("flow_sdk.external_apis.llm.errors", "LLMNotSupported"),
        ("flow_sdk.external_apis.llm.errors", "LLMNotInvocable"),
    ],
)
def test_every_import_the_snippets_show_resolves(module, symbol):
    import importlib

    assert hasattr(importlib.import_module(module), symbol)
    assert symbol in _doc(), f"{symbol} is pinned here but no longer appears in the snippets"


@pytest.mark.parametrize(
    "method", ["create_completion", "create_embeddings", "list_models", "probe", "ensure_for_secret", "find_by_secret"]
)
def test_every_call_the_snippets_make_exists_on_the_endpoint(method):
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

    assert callable(getattr(LLMEndpoint, method, None)), f"snippets call {method}()"
    assert f"{method}(" in _doc()


def test_the_three_kinds_the_table_documents_are_the_three_that_exist():
    """The doc's table is the contract; a fourth kind must be written up, not smuggled in."""
    from flow_sdk.builtin.llm_endpoint import LLMEndpointKind

    documented = set(re.findall(r"`(api_key|hub|device)`", _doc()))
    assert documented == {k.value for k in LLMEndpointKind}


def test_the_batch_size_the_doc_quotes_is_the_one_the_client_uses():
    from flow_sdk.external_apis.llm.client import OPENAI_EMBEDDING_BATCH

    assert str(OPENAI_EMBEDDING_BATCH) in _doc()


def test_the_default_slugs_the_doc_quotes_are_the_configured_ones():
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

    assert LLMEndpoint(provider="openrouter").secret_name in _doc()
