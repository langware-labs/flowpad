"""Unit tests for SkillManager."""

from pathlib import Path

import pytest

from flow_sdk.core.flow.instructions.skill_manager import (
    Skill,
    SkillManager,
    SkillParseError,
)

RESOURCES_DIR = Path(__file__).parent / "resources" / "claude_test_skills"

HELLO_SKILL_CONTENT = """---
name: hello_skill
description: A simple test skill for unit tests
---

# Hello Skill

This is a minimal test skill for unit testing purposes.

## Usage

Use this skill to test skill loading and management functionality.
"""


@pytest.fixture
def api_test_skills_dir(tmp_path):
    """Fixture that creates a temporary API test skills directory with hello_skill."""
    skills_dir = tmp_path / "api_test_skills"
    hello_skill_dir = skills_dir / "hello_skill"
    hello_skill_dir.mkdir(parents=True, exist_ok=True)
    skill_file = hello_skill_dir / "SKILL.md"
    skill_file.write_text(HELLO_SKILL_CONTENT)
    return skills_dir


def test_load_multiple_skills_and_access():
    """Test loading skills directory and accessing via multiple methods."""
    skills = SkillManager.from_folder(RESOURCES_DIR)

    # len, iteration
    assert len(skills) == 3
    names = [s.metadata.name for s in skills]
    assert "pdf-processing" in names
    assert "csv-analysis" in names
    assert "deploy-skill" in names

    # __contains__, __getitem__ by name, get()
    assert "pdf-processing" in skills
    assert "nonexistent" not in skills
    _pdf = skills["pdf-processing"]  # noqa: F841
    assert skills.get("csv-analysis") is not None
    assert skills.get("nonexistent") is None

    # __getitem__ by index
    first = skills[0]
    assert first.metadata.name in names

    # names property
    assert set(skills.names) == {"pdf-processing", "csv-analysis", "deploy-skill"}

    # find()
    found = skills.find("PDF")
    assert len(found) == 1
    assert found[0].metadata.name == "pdf-processing"


def test_skill_metadata_and_content():
    """Test Skill metadata, content, and to_dict."""
    skill = Skill.from_folder(RESOURCES_DIR / "pdf-skill")

    # metadata fields
    assert skill.metadata.name == "pdf-processing"
    assert "PDF" in skill.metadata.description
    assert skill.metadata.allowed_tools == ["Read", "Grep", "Glob"]
    assert skill.metadata.tags == ["documents", "extraction", "analysis"]
    assert skill.metadata.extra["custom_field"] == "test_value"

    # content (SKILL.md body)
    assert "# PDF Processing Skill" in skill.content
    assert "extract script" in skill.content

    # path
    assert skill.path.name == "pdf-skill"

    # to_dict
    data = skill.to_dict()
    assert data["metadata"]["name"] == "pdf-processing"
    assert "content" in data

    # metadata.to_dict
    meta_dict = skill.metadata.to_dict()
    assert meta_dict["name"] == "pdf-processing"
    assert meta_dict["tags"] == ["documents", "extraction", "analysis"]
    assert meta_dict["custom_field"] == "test_value"


def test_skill_resources():
    """Test SkillResources access and SkillResource properties."""
    skill = Skill.from_folder(RESOURCES_DIR / "pdf-skill")

    # resources container
    resources = skill.resources
    assert len(resources) == 2
    assert "scripts/extract.py" in resources
    assert "reference.md" in resources
    assert "nonexistent.txt" not in resources

    # keys()
    keys = resources.keys()
    assert "scripts/extract.py" in keys

    # __getitem__, get()
    script = resources["scripts/extract.py"]
    assert resources.get("reference.md") is not None
    assert resources.get("missing") is None

    # SkillResource properties
    assert script.name == "extract.py"
    assert script.extension == ".py"
    assert script.is_script is True
    assert script.is_markdown is False
    assert "def extract_text" in script.content

    # markdown resource
    ref = resources["reference.md"]
    assert ref.is_markdown is True
    assert ref.is_script is False
    assert "PDF Reference" in ref.content

    # to_dict
    script_dict = script.to_dict()
    assert script_dict["name"] == "extract.py"
    assert script_dict["relative_path"] == "scripts/extract.py"


def test_single_skill_load():
    """Test loading a single skill folder directly."""
    skills = SkillManager.from_folder(RESOURCES_DIR / "csv-skill")

    assert len(skills) == 1
    skill = skills[0]
    assert skill.metadata.name == "csv-analysis"
    assert skill.metadata.allowed_tools == []
    assert skill.metadata.tags == []
    assert len(skill.resources) == 0


def test_manager_add_remove():
    """Test add and remove operations."""
    skills = SkillManager.from_folder(RESOURCES_DIR)
    assert len(skills) == 3

    # remove
    removed = skills.remove("csv-analysis")
    assert removed is True
    assert len(skills) == 2
    assert "csv-analysis" not in skills

    # remove nonexistent
    assert skills.remove("nonexistent") is False

    # add back
    csv_skill = Skill.from_folder(RESOURCES_DIR / "csv-skill")
    skills.add(csv_skill)
    assert len(skills) == 3
    assert "csv-analysis" in skills


def test_invalid_skill_errors():
    """Test error handling for invalid skills."""
    with pytest.raises(SkillParseError):
        Skill.from_folder("/nonexistent/path")

    with pytest.raises(SkillParseError):
        SkillManager.from_folder("/nonexistent/path")


def test_copy_to(tmp_path):
    """Test copying skills to a destination directory."""
    skills = SkillManager.from_folder(RESOURCES_DIR)

    # Copy skills to temp directory
    skills_dir = skills.copy_to(tmp_path)

    # Verify .claude/skills structure created
    assert skills_dir == tmp_path / ".claude" / "skills"
    assert skills_dir.exists()

    # Verify skills were copied
    assert (skills_dir / "pdf-processing").exists()
    assert (skills_dir / "csv-analysis").exists()

    # Verify SKILL.md files exist
    assert (skills_dir / "pdf-processing" / "SKILL.md").exists()
    assert (skills_dir / "csv-analysis" / "SKILL.md").exists()

    # Verify resources were copied
    assert (skills_dir / "pdf-processing" / "scripts" / "extract.py").exists()
    assert (skills_dir / "pdf-processing" / "reference.md").exists()

    # Verify content is correct
    skill_md = (skills_dir / "pdf-processing" / "SKILL.md").read_text()
    assert "pdf-processing" in skill_md

    # Test clear_existing=True (default) - copy again and verify clean
    skills.copy_to(tmp_path, clear_existing=True)
    assert (skills_dir / "pdf-processing").exists()

    # Test clear_existing=False - should fail if skill already exists
    # (copytree raises error on existing directory)
    with pytest.raises(FileExistsError):
        skills.copy_to(tmp_path, clear_existing=False)


def test_add_folder_combines_skills(tmp_path, api_test_skills_dir):
    """Test add_folder() combines skills from multiple folders."""
    # Start with unit test skills (pdf-processing, csv-analysis, deploy-skill)
    manager = SkillManager.from_folder(RESOURCES_DIR)
    assert len(manager) == 3
    assert "pdf-processing" in manager
    assert "csv-analysis" in manager
    assert "deploy-skill" in manager

    # Add API test skills (hello_skill)
    manager.add_folder(api_test_skills_dir)
    assert len(manager) == 4
    assert "hello_skill" in manager

    # Verify original skills still present
    assert "pdf-processing" in manager
    assert "csv-analysis" in manager
    assert "deploy-skill" in manager


def test_add_folder_first_wins_on_conflict(tmp_path):
    """Test that first-added skill wins when names conflict."""
    # Create a conflicting skill in temp folder with same name
    conflict_dir = tmp_path / "conflict_skills" / "pdf-processing"
    conflict_dir.mkdir(parents=True)
    (conflict_dir / "SKILL.md").write_text(
        "---\nname: pdf-processing\ndescription: Conflicting skill\n---\nConflicting content"
    )

    # Load original skills first
    manager = SkillManager.from_folder(RESOURCES_DIR)
    original_desc = manager["pdf-processing"].metadata.description

    # Add conflicting folder - original should win
    manager.add_folder(tmp_path / "conflict_skills")

    # Still 3 skills, original description preserved
    assert len(manager) == 3
    assert manager["pdf-processing"].metadata.description == original_desc


def test_add_folder_nonexistent_silent():
    """Test add_folder silently skips non-existent folders."""
    manager = SkillManager.from_folder(RESOURCES_DIR)
    initial_count = len(manager)

    # Adding non-existent folder should not raise, should return self
    result = manager.add_folder("/nonexistent/path/to/skills")
    assert result is manager
    assert len(manager) == initial_count


def test_add_folder_chaining(api_test_skills_dir):
    """Test add_folder returns self for method chaining."""
    manager = (
        SkillManager.from_folder(RESOURCES_DIR)
        .add_folder(api_test_skills_dir)
        .add_folder("/nonexistent/path")  # Should be silently skipped
    )

    assert len(manager) == 4
    assert "pdf-processing" in manager
    assert "csv-analysis" in manager
    assert "deploy-skill" in manager
    assert "hello_skill" in manager


def test_multi_folder_copy_to(tmp_path, api_test_skills_dir):
    """Test copying skills from multiple folders to temp destination."""
    # Combine skills from multiple folders
    manager = SkillManager.from_folder(RESOURCES_DIR).add_folder(api_test_skills_dir)

    # Copy to temp folder
    skills_dir = manager.copy_to(tmp_path)

    # Verify all skills were copied
    assert (skills_dir / "pdf-processing").exists()
    assert (skills_dir / "csv-analysis").exists()
    assert (skills_dir / "deploy-skill").exists()
    assert (skills_dir / "hello_skill").exists()

    # Verify SKILL.md files exist
    assert (skills_dir / "pdf-processing" / "SKILL.md").exists()
    assert (skills_dir / "hello_skill" / "SKILL.md").exists()

    # Verify can reload the copied skills
    reloaded = SkillManager.from_folder(skills_dir)
    assert len(reloaded) == 4
    assert "pdf-processing" in reloaded
    assert "csv-analysis" in reloaded
    assert "deploy-skill" in reloaded
    assert "hello_skill" in reloaded
