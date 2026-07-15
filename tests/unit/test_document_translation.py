"""Unit tests for the document-translation model + path/data operations.

Covers the slick core that everything else rests on:
  * ``Translation`` round-trips on a ``Markdown``-family entity (FSRef field).
  * ``translations/<lang>.md`` path grammar + the path-traversal guard.
  * ``ensure_placeholder`` is idempotent and creates an empty, id-free file.
  * The target-language catalog is well-formed and distinct from UI locales.

The ``add_translation`` action's data logic is the model + these operations
(upsert-by-lang), exercised here directly; the HTTP wiring is thin.
"""

import pytest

import flow_sdk.fs_store.operations.translation as T
from flow_sdk.builtin.claude_memory_entities import Docs, Markdown, Translation
from flow_sdk.fs_store.fs_ref.base import FSRef
from flow_sdk.i18n.translation_targets import (
    TRANSLATION_TARGETS,
    get_translation_target,
    get_translation_targets,
)
from flow_sdk.i18n.supported_locales import SUPPORTED_LOCALES


@pytest.fixture
def records_data_root(tmp_path, monkeypatch):
    """Point the translation ops at an isolated temp records-data root."""
    monkeypatch.setattr(T, "get_default_records_data_root", lambda: tmp_path)
    return tmp_path


# ── model ────────────────────────────────────────────────────────────────────

def test_translation_round_trips_on_markdown_entity():
    doc = Docs(name="readme")
    doc.translations.append(
        Translation(lang="he", ref=FSRef("/x/translations/he.md"), process_id="agentic_process-@p1")
    )
    dumped = doc.model_dump()

    entry = dumped["translations"][0]
    assert entry["lang"] == "he"
    assert entry["ref"]["path"].endswith("translations/he.md")
    assert entry["process_id"] == "agentic_process-@p1"

    back = Docs(**dumped)
    assert back.translations[0].lang == "he"
    assert isinstance(back.translations[0].ref, FSRef)
    assert back.translations[0].ref.path.endswith("translations/he.md")


def test_translations_default_empty_and_optional_process_id():
    doc = Docs(name="x")
    assert doc.translations == []
    entry = Translation(lang="es", ref=FSRef("/x/translations/es.md"))
    assert entry.process_id is None


def test_translations_field_lives_on_the_abstract_base():
    # Right layer: every markdown-backed type inherits it, not just Docs.
    assert "translations" in Markdown.model_fields


# ── path operations ──────────────────────────────────────────────────────────

def test_translation_path_grammar(records_data_root):
    p = T.translation_path("markdown", "abc-123", "he")
    assert p == records_data_root / "markdown" / "markdown-@abc-123" / "translations" / "he.md"


def test_translation_path_rejects_traversal(records_data_root):
    for bad in ["../../etc/passwd", "he/../..", "a b", "he.md", ""]:
        with pytest.raises(ValueError):
            T.translation_path("markdown", "abc", bad)


def test_normalize_lang_accepts_bcp47ish():
    for good in ["es", "he", "fr-CA", "zh-Hans", "pt-BR"]:
        assert T.normalize_lang(good) == good


def test_ensure_placeholder_is_idempotent_and_empty(records_data_root):
    ref1 = T.ensure_placeholder("plan", "id1", "fr")
    path = T.translation_path("plan", "id1", "fr")
    assert path.exists()
    assert path.read_text() == ""  # empty pending placeholder
    assert "id:" not in path.read_text()  # never an entity

    # Idempotent: a second call must not clobber real content the worker wrote.
    path.write_text("# Bonjour")
    ref2 = T.ensure_placeholder("plan", "id1", "fr")
    assert path.read_text() == "# Bonjour"
    assert ref1.path == ref2.path


def test_upsert_by_lang_semantics(records_data_root):
    """Mirror the action's upsert: one entry per lang; second call attaches pid."""
    doc = Docs(name="x")
    doc.id = "doc-1"

    def add(lang, process_id=None):
        ref = T.ensure_placeholder(doc.get_type(), str(doc.id), lang)
        existing = next((t for t in doc.translations if t.lang == lang), None)
        if existing is not None:
            existing.ref = ref
            if process_id is not None:
                existing.process_id = process_id
        else:
            doc.translations.append(Translation(lang=lang, ref=ref, process_id=process_id))

    add("de")
    add("de", process_id="agentic_process-@w1")
    assert len(doc.translations) == 1
    assert doc.translations[0].process_id == "agentic_process-@w1"


# ── target catalog ───────────────────────────────────────────────────────────

def test_translation_targets_well_formed():
    targets = get_translation_targets()
    assert len(targets) >= 20
    codes = [t["code"] for t in targets]
    assert len(codes) == len(set(codes)), "duplicate target codes"
    for t in targets:
        assert set(t) == {"code", "englishName", "nativeName", "dir"}
        assert t["dir"] in ("ltr", "rtl")
    assert get_translation_target("he")["dir"] == "rtl"
    assert get_translation_target("es")["dir"] == "ltr"
    assert get_translation_target("does-not-exist") is None


def test_targets_carry_no_flag_and_are_distinct_from_ui_locales():
    # Document targets are language-only (no flag); the UI-locale list is a
    # small, catalog-guarded subset and must stay separate.
    assert all("flag" not in t for t in TRANSLATION_TARGETS)
    ui_codes = {loc["code"] for loc in SUPPORTED_LOCALES}
    target_codes = {t["code"] for t in TRANSLATION_TARGETS}
    # Broader than the UI set (which is en-US/he/ar today).
    assert len(target_codes) > len(ui_codes)
