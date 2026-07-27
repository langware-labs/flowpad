"""LLMIndex size tiers + LLM-free summary resolution fallback chain."""

from flow_sdk.llm_index.sizes import (
    BLOCK_MAX_WORDS,
    LINE_MAX_CHARS,
    clip_block,
    clip_line,
    resolve_doc_summaries,
)


def test_cache_hit_wins(tmp_path):
    summaries = tmp_path / "sums"
    summaries.mkdir()
    (summaries / "abc123.summary.md").write_text("Cached summary of the doc.\n")
    line, block = resolve_doc_summaries(
        "doc.md", "---\ndescription: ignored\n---\n# Ignored\n\nbody",
        summaries_dir=summaries, content_hash="abc123",
    )
    assert line == "Cached summary of the doc."
    assert block == "Cached summary of the doc."


def test_frontmatter_description_second(tmp_path):
    body = "---\ndescription: The frontmatter description wins here.\n---\n# Title\n\nFirst para."
    line, block = resolve_doc_summaries("doc.md", body)
    assert line == "The frontmatter description wins here."


def test_title_plus_first_paragraph_fallback():
    body = "# Flow Runs\n\nBudgets are enforced per run.\n\nMore text."
    line, block = resolve_doc_summaries("flow-runs.md", body)
    assert line.startswith("Flow Runs — Budgets are enforced per run.")


def test_budgets_enforced():
    long_text = "word " * 500
    body = f"---\ndescription: {long_text}\n---\nbody"
    line, block = resolve_doc_summaries("doc.md", body)
    assert len(line) <= LINE_MAX_CHARS
    assert len(block.split()) <= BLOCK_MAX_WORDS + 1  # +1 for the ellipsis token
    assert line.endswith("…")
    assert block.endswith("…")


def test_clip_helpers_noop_under_budget():
    assert clip_line("short") == "short"
    assert clip_block("a few words") == "a few words"
