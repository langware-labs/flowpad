"""Tests for template_engine.engine."""

import tempfile
from pathlib import Path

import pytest

import flow_sdk.template_engine as template_engine
from flow_sdk.template_engine import (
    CircularDependencyError,
    DuplicateTemplateError,
    TemplateEngine,
    TemplateError,
)

TEMPLATES_DIR = Path(template_engine.__file__).parent / "templates"


# ------------------------------------------------------------------
# Loading
# ------------------------------------------------------------------


def test_load_template():
    engine = TemplateEngine()
    engine.load_template("greeting", "Hello {{name}}!")
    assert "greeting" in engine.template_names


def test_load_template_duplicate():
    engine = TemplateEngine()
    engine.load_template("x", "a")
    with pytest.raises(DuplicateTemplateError):
        engine.load_template("x", "b")


def test_load_folder():
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "alpha.md").write_text("content A")
        (Path(d) / "sub").mkdir()
        (Path(d) / "sub" / "beta.md").write_text("content B")

        engine = TemplateEngine()
        engine.load_folder(d)
        assert sorted(engine.template_names) == ["alpha", "beta"]


def test_load_folder_duplicate_stem():
    """Two files with the same stem in different dirs should error."""
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "a.md").write_text("1")
        (Path(d) / "sub").mkdir()
        (Path(d) / "sub" / "a.md").write_text("2")

        engine = TemplateEngine()
        with pytest.raises(DuplicateTemplateError):
            engine.load_folder(d)


def test_load_folder_nonexistent():
    engine = TemplateEngine()
    with pytest.raises(TemplateError, match="does not exist"):
        engine.load_folder("/nonexistent/path")


# ------------------------------------------------------------------
# Generation
# ------------------------------------------------------------------


def test_simple_render():
    engine = TemplateEngine()
    engine.load_template("greet", "Hello {{name}}!")
    result = engine.generate("greet", {"name": "World"})
    assert result == "Hello World!"


def test_dependency_resolution():
    engine = TemplateEngine()
    engine.load_template("header", "## {{title}}")
    engine.load_template("page", "{{header}}\nBody text")

    result = engine.generate("page", {"title": "My Page"})
    assert "## My Page" in result
    assert "Body text" in result


def test_nested_dependencies():
    engine = TemplateEngine()
    engine.load_template("inner", "inner({{x}})")
    engine.load_template("middle", "middle[{{inner}}]")
    engine.load_template("outer", "outer{{{middle}}}")

    result = engine.generate("outer", {"x": "val"})
    assert "inner(val)" in result
    assert "middle[inner(val)]" in result


def test_if_block():
    engine = TemplateEngine()
    engine.load_template("t", "{{#if show}}YES{{/if}}")
    assert "YES" in engine.generate("t", {"show": True})
    assert "YES" not in engine.generate("t", {"show": False})
    assert "YES" not in engine.generate("t", {})


def test_missing_context_var_renders_empty():
    engine = TemplateEngine()
    engine.load_template("t", "before{{missing}}after")
    result = engine.generate("t", {})
    assert result == "beforeafter"


def test_unknown_root():
    engine = TemplateEngine()
    with pytest.raises(TemplateError, match="Unknown template"):
        engine.generate("nope", {})


def test_circular_dependency():
    engine = TemplateEngine()
    engine.load_template("a", "{{b}}")
    engine.load_template("b", "{{a}}")
    with pytest.raises(CircularDependencyError):
        engine.generate("a", {})


# ------------------------------------------------------------------
# Integration: load real templates folder
# ------------------------------------------------------------------


def test_load_real_templates():
    """Verify the shipped templates load without errors."""
    engine = TemplateEngine()
    engine.load_folder(TEMPLATES_DIR)
    assert len(engine.template_names) >= 5  # at least the core templates


def test_generate_solution_engineer():
    """Smoke-test: render solution_engineer with minimal context."""
    engine = TemplateEngine()
    engine.load_folder(TEMPLATES_DIR)

    context = {
        "agent_name": "TestBot",
        "allowed_artifact_table": "| type | desc |",
        "allowed_artifact_types_csv": '"file"',
    }
    result = engine.generate("solution_engineer", context)
    assert "TestBot" in result
    assert "Instructions" in result
