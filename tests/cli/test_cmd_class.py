import pytest
from pathlib import Path
from flow_sdk.cli.cli_command import CLICommand
from flow_sdk.cli.cli_context import CLIContext


def test_clicommand_basic_parsing():
    """Test basic command parsing."""
    cmd = CLICommand("ping hello")

    assert cmd.command == "ping hello"
    assert cmd.subcommand == "ping"
    assert cmd.args == ["hello"]
    assert cmd.use_python is False


def test_clicommand_multi_word_args():
    """Test parsing command with multiple arguments."""
    cmd = CLICommand("ping hello world test")

    assert cmd.subcommand == "ping"
    assert cmd.args == ["hello", "world", "test"]


def test_clicommand_single_word():
    """Test parsing command with no arguments."""
    cmd = CLICommand("config")

    assert cmd.subcommand == "config"
    assert cmd.args == []


def test_clicommand_empty_string():
    """Test parsing empty command string."""
    cmd = CLICommand("")

    assert cmd.command == ""
    assert cmd.subcommand is None
    assert cmd.args == []


def test_clicommand_whitespace_handling():
    """Test that extra whitespace is handled correctly."""
    cmd = CLICommand("  ping   hello  ")

    assert cmd.command == "ping   hello"
    assert cmd.subcommand == "ping"
    assert cmd.args == ["hello"]


def test_executable_args_installed():
    """Test executable_args when use_python=False (installed command)."""
    cmd = CLICommand("ping hello", use_python=False)

    args = cmd.executable_args

    assert args == ["flow", "ping", "hello"]


def test_executable_args_python():
    """Test executable_args when use_python=True."""
    cmd = CLICommand("ping hello", use_python=True)

    args = cmd.executable_args

    assert args[0] == "python3"
    assert args[1].endswith("flow_cli.py")
    assert args[2:] == ["ping", "hello"]


def test_executable_args_python_no_args():
    """Test executable_args with use_python=True and no arguments."""
    cmd = CLICommand("", use_python=True)

    args = cmd.executable_args

    assert args[0] == "python3"
    assert args[1].endswith("flow_cli.py")
    assert len(args) == 2  # Just python3 and flow_cli.py


def test_command_str_installed():
    """Test command_str property for installed command."""
    cmd = CLICommand("ping hello", use_python=False)

    assert cmd.command_str == "flow ping hello"


def test_command_str_python():
    """Test command_str property for Python command."""
    cmd = CLICommand("ping hello", use_python=True)

    assert cmd.command_str == "python3 flow_cli.py ping hello"


def test_str_representation():
    """Test __str__ method."""
    cmd = CLICommand("ping hello", use_python=False)

    assert str(cmd) == "flow ping hello"


def test_repr_representation():
    """Test __repr__ method."""
    cmd = CLICommand("ping hello", use_python=True)

    repr_str = repr(cmd)

    assert "CLICommand" in repr_str
    assert "ping hello" in repr_str
    assert "use_python=True" in repr_str


def test_use_python_default():
    """Test that use_python defaults to False."""
    cmd = CLICommand("ping hello")

    assert cmd.use_python is False


def test_use_python_true():
    """Test setting use_python to True."""
    cmd = CLICommand("ping hello", use_python=True)

    assert cmd.use_python is True


def test_complex_command_setup():
    """Test parsing setup command with hyphenated argument."""
    cmd = CLICommand("setup claude-code")

    assert cmd.subcommand == "setup"
    assert cmd.args == ["claude-code"]


def test_config_set_command():
    """Test parsing config set command with key=value."""
    cmd = CLICommand("config set timeout=30")

    assert cmd.subcommand == "config"
    assert cmd.args == ["set", "timeout=30"]


def test_executable_args_consistency():
    """Test that executable_args returns consistent results."""
    cmd = CLICommand("ping test", use_python=True)

    args1 = cmd.executable_args
    args2 = cmd.executable_args

    assert args1 == args2


def test_clicommand_with_context():
    """Test CLICommand with context."""
    context = CLIContext()
    cmd = CLICommand("ping hello", context=context)

    assert cmd.context is not None
    assert cmd.context == context
    assert cmd.subcommand == "ping"
    assert cmd.args == ["hello"]


def test_clicommand_without_context():
    """Test CLICommand without context (default None)."""
    cmd = CLICommand("ping hello")

    assert cmd.context is None
    assert cmd.subcommand == "ping"
    assert cmd.args == ["hello"]


def test_repr_with_context():
    """Test __repr__ with context."""
    context = CLIContext()
    cmd = CLICommand("ping hello", use_python=True, context=context)

    repr_str = repr(cmd)

    assert "CLICommand" in repr_str
    assert "ping hello" in repr_str
    assert "use_python=True" in repr_str
    assert "context=True" in repr_str
