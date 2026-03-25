import pytest
from pathlib import Path
from flow_sdk.cli.cli_context import CLIContext, ClaudeScope


@pytest.fixture
def temp_git_repo(tmp_path):
    """Create a temporary git repository for testing."""
    import subprocess
    repo_dir = tmp_path / "test_repo"
    repo_dir.mkdir()

    # Initialize git repo
    subprocess.run(["git", "init"], cwd=repo_dir, capture_output=True, check=True)

    return repo_dir


def test_cli_context_initialization():
    """Test that CLIContext initializes with current directory."""
    context = CLIContext()

    assert context.working_dir == Path.cwd()
    assert context.user_home == Path.home()


def test_cli_context_custom_working_dir(tmp_path):
    """Test CLIContext with custom working directory."""
    context = CLIContext(working_dir=tmp_path)

    assert context.working_dir == tmp_path
    assert context.user_home == Path.home()


def test_cli_context_in_git_repo(temp_git_repo):
    """Test CLIContext detects git repository."""
    context = CLIContext(working_dir=temp_git_repo)

    assert context.is_in_repo() is True
    assert context.repo_root == temp_git_repo


def test_cli_context_not_in_git_repo(tmp_path):
    """Test CLIContext when not in a git repository."""
    non_repo_dir = tmp_path / "not_a_repo"
    non_repo_dir.mkdir()

    context = CLIContext(working_dir=non_repo_dir)

    assert context.is_in_repo() is False
    assert context.repo_root is None


def test_get_claude_settings_path_user():
    """Test getting USER scope settings path."""
    context = CLIContext()

    user_settings = context.get_claude_settings_path(ClaudeScope.USER)

    assert user_settings == Path.home() / ".claude" / "settings.json"


def test_get_claude_settings_path_project(temp_git_repo):
    """Test getting PROJECT scope settings path."""
    context = CLIContext(working_dir=temp_git_repo)

    project_settings = context.get_claude_settings_path(ClaudeScope.PROJECT)

    assert project_settings == temp_git_repo / ".claude" / "settings.json"


def test_get_claude_settings_path_local(temp_git_repo):
    """Test getting LOCAL scope settings path."""
    context = CLIContext(working_dir=temp_git_repo)

    local_settings = context.get_claude_settings_path(ClaudeScope.LOCAL)

    assert local_settings == temp_git_repo / ".claude" / "settings.local.json"


def test_get_claude_settings_path_project_not_in_repo(tmp_path):
    """Test that PROJECT scope raises error when not in a git repo."""
    non_repo_dir = tmp_path / "not_a_repo"
    non_repo_dir.mkdir()

    context = CLIContext(working_dir=non_repo_dir)

    with pytest.raises(ValueError, match="not in a git repository"):
        context.get_claude_settings_path(ClaudeScope.PROJECT)


def test_get_claude_settings_path_local_not_in_repo(tmp_path):
    """Test that LOCAL scope raises error when not in a git repo."""
    non_repo_dir = tmp_path / "not_a_repo"
    non_repo_dir.mkdir()

    context = CLIContext(working_dir=non_repo_dir)

    with pytest.raises(ValueError, match="not in a git repository"):
        context.get_claude_settings_path(ClaudeScope.LOCAL)


def test_get_claude_dir_user():
    """Test getting .claude directory for USER scope."""
    context = CLIContext()

    user_dir = context.get_claude_dir(ClaudeScope.USER)

    assert user_dir == Path.home() / ".claude"


def test_get_claude_dir_project(temp_git_repo):
    """Test getting .claude directory for PROJECT scope."""
    context = CLIContext(working_dir=temp_git_repo)

    project_dir = context.get_claude_dir(ClaudeScope.PROJECT)

    assert project_dir == temp_git_repo / ".claude"


def test_get_available_scopes_not_in_repo(tmp_path):
    """Test available scopes when not in a git repository."""
    non_repo_dir = tmp_path / "not_a_repo"
    non_repo_dir.mkdir()

    context = CLIContext(working_dir=non_repo_dir)

    scopes = context.get_available_scopes()

    assert scopes == [ClaudeScope.USER]


def test_get_available_scopes_in_repo(temp_git_repo):
    """Test available scopes when in a git repository."""
    context = CLIContext(working_dir=temp_git_repo)

    scopes = context.get_available_scopes()

    assert scopes == [ClaudeScope.USER, ClaudeScope.PROJECT, ClaudeScope.LOCAL]


def test_get_scope_description():
    """Test getting human-readable scope descriptions."""
    context = CLIContext()

    user_desc = context.get_scope_description(ClaudeScope.USER)
    project_desc = context.get_scope_description(ClaudeScope.PROJECT)
    local_desc = context.get_scope_description(ClaudeScope.LOCAL)

    assert "applies to all projects" in user_desc.lower()
    assert "shared with team" in project_desc.lower()
    assert "not committed" in local_desc.lower()


def test_repr():
    """Test string representation of CLIContext."""
    context = CLIContext()

    repr_str = repr(context)

    assert "CLIContext" in repr_str
    assert "working_dir" in repr_str
    assert "user_home" in repr_str
    assert "repo_root" in repr_str
