"""Tests for template_engine.parser."""

from flow_sdk.template_engine.parser import extract_template_refs


def test_simple_variable():
    assert extract_template_refs("Hello {{name}}!") == ["name"]


def test_triple_brace():
    assert extract_template_refs("{{{raw_html}}}") == ["raw_html"]


def test_block_helper_if():
    refs = extract_template_refs("{{#if show}}visible{{/if}}")
    assert "show" in refs


def test_block_helper_each():
    refs = extract_template_refs("{{#each items}}{{this}}{{/each}}")
    assert "items" in refs


def test_deduplication():
    refs = extract_template_refs("{{x}} {{x}} {{#if x}}{{/if}}")
    assert refs == ["x"]


def test_preserves_order():
    refs = extract_template_refs("{{b}} {{a}} {{c}}")
    assert refs == ["b", "a", "c"]


def test_skips_helpers():
    """# / and ! prefixed tokens should not be extracted."""
    refs = extract_template_refs("{{#if x}}{{/if}}{{!-- comment --}}")
    # Only x from the #if block
    assert refs == ["x"]


def test_dotted_path():
    refs = extract_template_refs("{{user.name}}")
    assert refs == ["user.name"]


def test_empty_content():
    assert extract_template_refs("") == []
    assert extract_template_refs("no templates here") == []


def test_non_string():
    assert extract_template_refs(42) == []  # type: ignore[arg-type]
