"""ClaudeProjectEnvManager -- manage isolated Claude project folders for testing.

Creates and manages::

    <root>/
        CLAUDE.md                    # System prompt (injected context)
        .claude/agents/<name>.md     # Agent definitions
        .claude/settings.json        # Project settings
        output/                      # Agent output directory

Also provides session management, prompt execution, plugin installation,
rules engine integration, and debug/dump support.  Subclass and override
hook methods (``_hook_log_path``, ``_pre_install_plugin``) for plugin-
specific behaviour.
"""

from __future__ import annotations

import dataclasses
import io
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import redirect_stdout
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from flow_sdk._compat import StrEnum

if TYPE_CHECKING:
    from flow_sdk.fs_store.fs_record import FSRecord as AgentRecord

TEMP_DIR = Path(tempfile.gettempdir()) / "claude_plugin_test"


# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

def _current_platform() -> str:
    """Return ``'darwin'``, ``'win32'``, or ``'linux'``."""
    if sys.platform.startswith("darwin"):
        return "darwin"
    if sys.platform.startswith("win"):
        return "win32"
    return "linux"


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------

def _rmtree_onexc(func, path, exc):
    """Handle Windows errors during rmtree (file locks, reserved names)."""
    if not isinstance(exc, (PermissionError, OSError)):
        raise exc
    try:
        os.chmod(path, stat.S_IRWXU)
        time.sleep(0.1)
        func(path)
    except OSError:
        pass  # still locked or reserved device name – skip so cleanup proceeds


def _rmtree_safe(path) -> None:
    """rmtree with error handler, compatible with Python 3.10–3.12+."""
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=_rmtree_onexc)
    else:
        def _onerror(func, p, excinfo):
            _rmtree_onexc(func, p, excinfo[1])
        shutil.rmtree(path, onerror=_onerror)


def open_terminal(
    cwd: str | Path,
    command: str | None = None,
    env: dict[str, str] | None = None,
) -> None:
    """Open a visible terminal window at the given directory.

    Args:
        cwd: Directory to open the terminal in.
        command: Optional command to run in the new terminal.
        env: Optional environment variables for the child process.
    """
    cwd = str(cwd)
    platform = _current_platform()

    def _check_popen_exit(cmd: list[str], timeout: float = 0.25) -> None:
        proc = subprocess.Popen(cmd)
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return
        if proc.returncode != 0:
            raise subprocess.CalledProcessError(proc.returncode, cmd)

    # Build an export prefix so the new shell inherits custom env vars
    export_prefix = ""
    if env:
        inherited = {
            k: v for k, v in env.items()
            if k == "PATH" or k not in os.environ or os.environ[k] != v
        }
        if inherited:
            if platform == "win32":
                export_prefix = " && ".join(
                    f"set {k}={v}" for k, v in inherited.items()
                ) + " && "
            else:
                export_prefix = " ".join(
                    f"export {k}={shlex.quote(v)};" for k, v in inherited.items()
                ) + " "

    if platform == "darwin":
        clean_env = "unset CLAUDECODE; "
        inner = (
            f"{clean_env}{export_prefix}cd {cwd} && {command}"
            if command
            else f"{clean_env}{export_prefix}cd {cwd}"
        )
        # DEBUG: dump exact terminal command for troubleshooting
        _dbg = Path("/tmp/_open_terminal_debug.txt")
        _dbg.write_text(inner)
        inner_escaped = inner.replace("\\", "\\\\").replace('"', '\\"')
        script = (
            'tell application "Terminal"\n'
            f'    do script "{inner_escaped}"\n'
            "    activate\n"
            "end tell"
        )
        subprocess.run(["osascript", "-e", script], check=True)
    elif platform == "win32":
        inner = (
            f"{export_prefix}cd /d {cwd} && {command}"
            if command
            else f"{export_prefix}cd /d {cwd}"
        )
        subprocess.run(["cmd", "/c", "start", "cmd", "/K", inner], check=True)
    else:
        shell_cmd = (
            f"{export_prefix}cd {cwd} && {command}; exec $SHELL"
            if command
            else f"{export_prefix}cd {cwd} && $SHELL"
        )
        for term in ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"]:
            try:
                if term == "gnome-terminal":
                    if command:
                        _check_popen_exit(
                            [term, "--working-directory", cwd, "--", "bash", "-c", shell_cmd]
                        )
                    else:
                        _check_popen_exit([term, "--working-directory", cwd])
                elif term == "konsole":
                    if command:
                        _check_popen_exit(
                            [term, "--workdir", cwd, "-e", "bash", "-c", shell_cmd]
                        )
                    else:
                        _check_popen_exit([term, "--workdir", cwd])
                else:
                    _check_popen_exit([term, "-e", f"cd {cwd} && $SHELL"])
                return
            except FileNotFoundError:
                continue
        raise RuntimeError("No supported terminal emulator found")


class _TeeIO(io.StringIO):
    """StringIO that also forwards writes to a second stream (e.g. real stdout)."""

    def __init__(self, terminal: io.TextIOBase | None = None):
        super().__init__()
        self._terminal = terminal

    def write(self, s: str) -> int:
        if self._terminal:
            self._terminal.write(s)
            self._terminal.flush()
        return super().write(s)


# ---------------------------------------------------------------------------
# Enums / dataclasses
# ---------------------------------------------------------------------------

class LaunchMode(StrEnum):
    """How to launch claude."""

    HEADLESS = "headless"
    TERMINAL = "terminal"
    INTERACTIVE = "interactive"


@dataclass
class PromptResult:
    """Result from running a prompt."""

    returncode: int
    stdout: str
    hook_log: str = ""

    @property
    def skill_log(self) -> str:
        """Backward-compat alias for *hook_log*."""
        return self.hook_log

    @skill_log.setter
    def skill_log(self, value: str) -> None:
        object.__setattr__(self, "hook_log", value)

    def response_contains(self, text: str) -> bool:
        return text.lower() in self.stdout.lower()

    def response_not_contains(self, text: str) -> bool:
        return text.lower() not in self.stdout.lower()

    def hook_output_contains(self, text: str) -> bool:
        """Check if the hook output contains *text* (case-insensitive)."""
        return text.lower() in self.hook_log.lower()

    def to_dict(self) -> dict:
        """Return a JSON-serializable dict."""
        return dataclasses.asdict(self)


@dataclass
class ClaudeTranscript:
    """Transcript with path and entries from a JSONL file."""

    path: Path
    entries: list[dict] = field(default_factory=list)

    @classmethod
    def load(cls, transcript_path: Path) -> ClaudeTranscript:
        """Load transcript from a JSONL file."""
        entries: list[dict] = []
        if transcript_path.exists():
            with open(transcript_path) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        entries.append(json.loads(line))
        return cls(path=transcript_path, entries=entries)

    def get_entries(self, entry_type: str) -> list[dict]:
        """Return entries whose ``type`` field matches *entry_type*."""
        return [e for e in self.entries if e.get("type") == entry_type]

    def __iter__(self):
        return iter(self.entries)

    def __len__(self):
        return len(self.entries)


# ---------------------------------------------------------------------------
# Main class
# ---------------------------------------------------------------------------

class ClaudeProjectEnvManager:
    """Manage an isolated Claude project folder for agent execution and testing.

    Provides session management, prompt execution, plugin installation,
    rules engine integration, and debug/dump support.  Subclass and override
    hook methods for plugin-specific behaviour.
    """

    DUMP_FILENAME = "stdin_dump.jsonl"

    def __init__(
        self,
        root: Path | str | None = None,
        clean: bool = True,
        session_id: str | None = None,
        resume_session_id: str | None = None,
        fork: bool = False,
        dump: bool = False,
        plugin_root: Path | str | None = None,
        include_user_home: bool = False,
    ) -> None:
        """
        Args:
            root: Directory for the project.  Defaults to a temp dir keyed
                  by session ID.
            clean: If *True* and *root* already exists, wipe it first.
            session_id: Explicit session UUID (generated if omitted).
            resume_session_id: Resume an existing session instead of
                               starting a new one.
            fork: If *True* and resuming, pass ``--fork-session``.
            dump: If *True*, enable stdin dumping for hook invocations.
            plugin_root: Path to the plugin source tree (used by
                         ``install_plugin``).
            include_user_home: If *True*, include user-level rules from
                               ``~/.flow/skill_rules/``.
        """
        # Session
        self._resume_session_id = resume_session_id
        self._session_id = session_id or str(uuid.uuid4())
        self._fork = fork
        self._session_started = False

        # Root directory
        if root is None:
            root = TEMP_DIR / self._session_id
        self._root = Path(root)

        self._clean = clean
        self._env_vars: dict[str, str] = {}
        self._mcp_config_path: Path | None = None
        self._debug_file: Path | None = None
        self._dump_activations = False
        self._plugin_root = Path(plugin_root) if plugin_root else None
        self._include_user_home = include_user_home

        if dump:
            self.dump_activations = True

        self._setup()

    # -- Setup ----------------------------------------------------------------

    def _setup(self) -> None:
        """Create a clean project folder."""
        if self._root.exists() and self._clean:
            _rmtree_safe(self._root)
        self._root.mkdir(parents=True, exist_ok=True)
        self.agents_dir.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    # -- Properties -----------------------------------------------------------

    @property
    def path(self) -> Path:
        """Root directory of the project."""
        return self._root

    @property
    def temp_dir(self) -> Path:
        """Alias for *path* (backward compat)."""
        return self._root

    @property
    def output_dir(self) -> Path:
        """``<root>/output/`` -- where agents write results."""
        return self._root / "output"

    @property
    def agents_dir(self) -> Path:
        """``<root>/.claude/agents/`` -- agent definition files."""
        return self._root / ".claude" / "agents"

    @property
    def claude_md_path(self) -> Path:
        """``<root>/CLAUDE.md`` -- the system prompt file."""
        return self._root / "CLAUDE.md"

    # -- Session management ---------------------------------------------------

    @property
    def session_id(self) -> str:
        """The active session ID (resume ID takes precedence)."""
        return self._resume_session_id or self._session_id

    @session_id.setter
    def session_id(self, value: str) -> None:
        self._session_id = value

    @property
    def is_resuming(self) -> bool:
        """True if this env resumes an existing session."""
        return self._resume_session_id is not None

    def _session_args(self) -> list[str]:
        """Return CLI args for session continuity.

        When resuming (resume_session_id set or session already started),
        returns ``['--resume', <uuid>]`` (plus ``--fork-session`` if fork
        is set).  Otherwise returns ``['--session-id', <uuid>]`` for the
        first call, then switches to resume for subsequent calls.
        """
        if self.is_resuming or self._session_started:
            args = ["--resume", self.session_id]
            if self._fork and self.is_resuming:
                args.append("--fork-session")
            return args
        self._session_started = True
        return ["--session-id", self.session_id]

    def _session_arg_str(self) -> str:
        """Return session CLI fragment as a shell string."""
        return " ".join(self._session_args())

    # -- Debug / dump ---------------------------------------------------------

    @property
    def debug_file(self) -> Path | None:
        """Path to the debug log file, if set."""
        return self._debug_file

    @debug_file.setter
    def debug_file(self, value: Path | str | None) -> None:
        self._debug_file = Path(value) if value else None

    @property
    def dump_activations(self) -> bool:
        """Whether stdin dumping is enabled for hook invocations."""
        return self._dump_activations

    @dump_activations.setter
    def dump_activations(self, value: bool) -> None:
        self._dump_activations = value
        if value:
            dump_path = self._root / ".flow" / self.DUMP_FILENAME
            self.env_set("CLAUDE_PLUGIN_DUMP_STDIN", str(dump_path))
        else:
            self.env_unset("CLAUDE_PLUGIN_DUMP_STDIN")

    @property
    def dump_file(self) -> Path | None:
        """Return the path to the stdin dump file, or None if off."""
        if not self._dump_activations:
            return None
        return self._root / ".flow" / self.DUMP_FILENAME

    @property
    def dump_entries(self) -> list[dict]:
        """Return the parsed entries from the dump file."""
        dump_file = self.dump_file
        if dump_file is None or not dump_file.exists():
            return []
        entries: list[dict] = []
        with open(dump_file) as f:
            for line in f:
                line = line.strip()
                if line:
                    entries.append(json.loads(line))
        return entries

    # -- Environment variables ------------------------------------------------

    def env_set(self, key: str, value: str) -> None:
        """Set an environment variable to be passed to child processes."""
        self._env_vars[key] = value

    def env_unset(self, key: str) -> None:
        """Remove a previously set environment variable."""
        self._env_vars.pop(key, None)

    def build_env(self) -> dict[str, str]:
        """Build a sanitized environment dict for subprocess execution.

        Starts from ``os.environ``, strips ``CLAUDECODE*`` variables,
        sets UTF-8 encoding, and overlays any variables set via
        ``env_set()``.
        """
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
        env["PYTHONIOENCODING"] = "utf-8"
        env.update(self._env_vars)
        return env

    # Backward-compat alias (skillit tests use _build_env)
    _build_env = build_env

    # -- Rules engine integration ---------------------------------------------

    @property
    def user_rules(self):
        """Return user-level rules (~/.flow/skill_rules).

        Empty if ``include_user_home`` is False.
        """
        from flow_sdk.rules.engine import RulesPackage

        if not self._include_user_home:
            return RulesPackage(source="user", rules=[])
        from flow_sdk.rules.rule_loader import get_user_rules_dir

        return RulesPackage.from_folder(get_user_rules_dir(), source="user")

    @property
    def project_rules(self):
        """Return project-level rules (<root>/.flow/skill_rules)."""
        from flow_sdk.rules.engine import RulesPackage

        rules_path = self._root / ".flow" / "skill_rules"
        rules_path.mkdir(parents=True, exist_ok=True)
        return RulesPackage.from_folder(rules_path, source="project")

    @property
    def all_rules(self):
        """Return merged rules (user + project, project overrides user)."""
        from flow_sdk.rules.engine import RulesPackage

        user_path = None
        if self._include_user_home:
            from flow_sdk.rules.rule_loader import get_user_rules_dir

            user_path = get_user_rules_dir()
        return RulesPackage.from_multiple_folders(
            user_path=user_path,
            project_path=self._root / ".flow" / "skill_rules",
        )

    @property
    def rule_engine(self):
        """Return RuleEngine for this environment."""
        from flow_sdk.rules.engine import RuleEngine

        return RuleEngine(project_dir=str(self._root))

    def load_rule(self, rule_path: str) -> None:
        """Copy a rule into the env's .flow/skill_rules folder.

        Args:
            rule_path: Full path to a rule directory.
        """
        rule_src = Path(rule_path).expanduser()
        if not rule_src.exists():
            raise FileNotFoundError(f"Rule not found: {rule_path}")
        rules_dir = self._root / ".flow" / "skill_rules"
        rules_dir.mkdir(parents=True, exist_ok=True)
        shutil.copytree(rule_src, rules_dir / rule_src.name)

    def load_all_user_rules(self) -> None:
        """Copy all rules from the per-instance skill_rules dir into the env."""
        from flow_sdk.instance_settings import get_instance_settings
        user_rules = get_instance_settings().skill_rules_dir
        if not user_rules.exists():
            return
        rules_dir = self._root / ".flow" / "skill_rules"
        rules_dir.mkdir(parents=True, exist_ok=True)
        for rule_dir in user_rules.iterdir():
            if rule_dir.is_dir() and (rule_dir / "trigger.py").exists():
                shutil.copytree(
                    rule_dir, rules_dir / rule_dir.name, dirs_exist_ok=True
                )

    # -- Agent management -----------------------------------------------------

    def load_subagent(self, agent: "AgentRecord | str | Path") -> None:
        """Copy an agent definition into ``.claude/agents/``.

        Accepts:
          - ``Record`` (AGENT type): renders via ``render_subagent_markdown`` and writes it
          - ``str``: treated as agent name, loaded via ``load_subagent`` from operations
          - ``Path``: path to a ``.md`` file, copied directly
        """
        from flow_sdk.fs_store.operations.subagent import (  # noqa: PLC0415
            load_subagent as _load_agent,
        )

        if isinstance(agent, Path):
            dest = self.agents_dir / agent.name
            dest.write_text(agent.read_text(encoding="utf-8"), encoding="utf-8")
        elif isinstance(agent, str):
            loaded = _load_agent(agent)
            if loaded is None:
                raise FileNotFoundError(f"Agent {agent!r} not found")
            self._write_agent_md(loaded)
        else:
            self._write_agent_md(agent)

    def _write_agent_md(self, agent: "AgentRecord") -> None:
        from flow_sdk.fs_store.operations.subagent import render_subagent_markdown  # noqa: PLC0415
        name = agent.name or agent.id or "agent"
        dest = self.agents_dir / f"{name}.md"
        dest.write_text(render_subagent_markdown(agent), encoding="utf-8")

    # -- System prompt --------------------------------------------------------

    def set_system_prompt(self, content: str) -> None:
        """Write *content* to ``CLAUDE.md`` (overwrites)."""
        self.claude_md_path.write_text(content, encoding="utf-8")

    def append_system_prompt(self, content: str) -> None:
        """Append *content* to ``CLAUDE.md``."""
        with self.claude_md_path.open("a", encoding="utf-8") as f:
            f.write(content)

    def load_system_prompt(self, file_path: str | Path) -> None:
        """Copy file content into the env's CLAUDE.md.

        Args:
            file_path: Path to the file whose content becomes CLAUDE.md.
        """
        src = Path(file_path).expanduser()
        if not src.exists():
            raise FileNotFoundError(f"System prompt file not found: {src}")
        shutil.copy2(src, self._root / "CLAUDE.md")

    # -- MCP config -----------------------------------------------------------

    def set_mcp_config(self, config: dict[str, Any]) -> None:
        """Write ``mcp.json`` to the project root."""
        mcp_path = self._root / "mcp.json"
        mcp_path.write_text(json.dumps(config, indent=2), encoding="utf-8")

    def loadMcp(self) -> None:
        """Write an MCP config pointing to the flow-sdk MCP server."""
        mcp_config = {
            "mcpServers": {
                "flow_sdk": {
                    "command": shutil.which("flow-sdk-mcp") or "flow-sdk-mcp",
                    "args": [],
                }
            }
        }
        self._mcp_config_path = self._root / "mcp.json"
        self._mcp_config_path.write_text(json.dumps(mcp_config, indent=2))

    # -- Plugin installation --------------------------------------------------

    def _read_plugin_meta(self) -> tuple[str, str, str]:
        """Read plugin name, marketplace name, and version from plugin_root."""
        if self._plugin_root is None:
            raise ValueError("plugin_root is not set")
        plugin_meta = json.loads(
            (self._plugin_root / ".claude-plugin" / "plugin.json").read_text()
        )
        marketplace_meta = json.loads(
            (self._plugin_root / ".claude-plugin" / "marketplace.json").read_text()
        )
        return (
            plugin_meta["name"],
            marketplace_meta["name"],
            plugin_meta["version"],
        )

    def _plugin_cache_dir(self) -> Path:
        """Return the plugin cache directory."""
        plugin_name, marketplace_name, version = self._read_plugin_meta()
        return (
            Path.home()
            / ".claude"
            / "plugins"
            / "cache"
            / marketplace_name
            / plugin_name
            / version
        )

    def _expand_plugin_root_in_cache(self) -> None:
        """Replace $CLAUDE_PLUGIN_ROOT with the real cache path in plugin files.

        Patches .json and .md files that Claude Code reads at runtime
        (hooks, commands, MCP config).  Only needed on Windows where
        cmd.exe does not expand ``$VAR`` syntax.

        Expands ALL cached versions of this plugin across ALL marketplaces.
        """
        plugin_name, _marketplace_name, _version = self._read_plugin_meta()
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
        base_cache = get_instance_settings().claude_home / "plugins" / "cache"
        if not base_cache.is_dir():
            return
        for marketplace_dir in base_cache.iterdir():
            if not marketplace_dir.is_dir():
                continue
            plugin_dir = marketplace_dir / plugin_name
            if not plugin_dir.is_dir():
                continue
            for version_dir in plugin_dir.iterdir():
                if not version_dir.is_dir():
                    continue
                replacement = str(version_dir).replace("\\", "/")
                for pattern in ("**/*.json", "**/*.md"):
                    for fpath in version_dir.glob(pattern):
                        try:
                            content = fpath.read_text(encoding="utf-8")
                        except (OSError, UnicodeDecodeError):
                            continue
                        if "$CLAUDE_PLUGIN_ROOT" in content:
                            fpath.write_text(
                                content.replace(
                                    "$CLAUDE_PLUGIN_ROOT", replacement
                                ),
                                encoding="utf-8",
                            )

    def installed_plugin_version(self) -> str | None:
        """Return the version of the plugin installed in the cache, or None."""
        cache_dir = self._plugin_cache_dir()
        cached_plugin_json = cache_dir / ".claude-plugin" / "plugin.json"
        if not cached_plugin_json.exists():
            return None
        return json.loads(cached_plugin_json.read_text()).get("version")

    def _pre_install_plugin(self) -> None:
        """Hook for subclasses to run build steps before plugin install.

        Override in subclasses to e.g. bump versions and render templates.
        """

    def install_plugin(self, plugin_root: Path | str | None = None) -> None:
        """Build and install the plugin at project scope.

        Calls ``_pre_install_plugin()`` first (override for build steps),
        then registers the plugin marketplace, installs, and enables.

        Args:
            plugin_root: Override *plugin_root* for this call.
        """
        if plugin_root is not None:
            self._plugin_root = Path(plugin_root)
        if self._plugin_root is None:
            raise ValueError("plugin_root is not set")

        self._pre_install_plugin()

        plugin_name, marketplace_name, _ = self._read_plugin_meta()
        env = self.build_env()

        # Ensure marketplace points at the local repo
        subprocess.run(
            ["claude", "plugin", "marketplace", "remove", marketplace_name],
            capture_output=True,
            env=env,
        )
        rel_path = os.path.relpath(self._plugin_root, os.getcwd())
        local_path = f"./{rel_path.replace(os.sep, '/')}"
        subprocess.run(
            ["claude", "plugin", "marketplace", "add", local_path],
            check=True,
            env=env,
        )

        # Install plugin
        plugin_ref = f"{plugin_name}@{marketplace_name}"
        subprocess.run(
            ["claude", "plugin", "install", plugin_ref, "--scope", "project"],
            cwd=str(self._root),
            check=True,
            env=env,
        )

        # Enable plugin at project scope
        result = subprocess.run(
            ["claude", "plugin", "enable", plugin_name, "--scope", "project"],
            cwd=str(self._root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
        )
        if result.returncode != 0 and "already enabled" not in result.stderr:
            raise RuntimeError(
                f"'claude plugin enable {plugin_name} --scope project' failed "
                f"(exit {result.returncode}): {result.stderr}"
            )

        # Workaround: expand $CLAUDE_PLUGIN_ROOT on Windows
        if _current_platform() == "win32":
            self._expand_plugin_root_in_cache()

    # -- Hook log (override in subclass) --------------------------------------

    def _hook_log_path(self) -> Path | None:
        """Return the path to the hook log file.

        Override in subclasses to point to a plugin-specific log file.
        Returns ``None`` by default (no hook log).
        """
        return None

    # -- Prompt execution -----------------------------------------------------

    def _write_win_prompt_launcher(
        self, prompt_file: Path, claude_args: str
    ) -> Path:
        """Write a Python launcher that reads a prompt file and calls claude.

        Uses Python + subprocess to avoid cmd.exe escaping issues.

        Returns:
            Path to the generated launcher script (.cmd wrapper around .py).
        """
        py_script = self._root / "_launch_claude.py"
        py_script.write_text(
            "import subprocess, sys\n"
            "from pathlib import Path\n"
            f'prompt = Path(r"{prompt_file}").read_text(encoding="utf-8")\n'
            f"sys.exit(subprocess.call([\"claude\", *{claude_args.split()!r}, prompt]))\n",
            encoding="utf-8",
        )
        # Wrap in a .cmd so open_terminal can run it directly in cmd.exe
        cmd_script = self._root / "_launch_claude.cmd"
        cmd_script.write_text(
            f'@python "{py_script}"\r\n',
            encoding="utf-8",
        )
        return cmd_script

    def prompt(
        self, text: str, verbose: bool = True, timeout: int = 180
    ) -> PromptResult:
        """Run ``claude -p`` with the prompt and return the result.

        Args:
            text: The prompt to send.
            verbose: Stream stdout to the console as it arrives.
            timeout: Maximum seconds to wait for claude to finish.
        """
        platform = _current_platform()

        # Re-expand $CLAUDE_PLUGIN_ROOT right before launch in case new
        # cache entries were created after install_plugin().
        if platform == "win32" and self._plugin_root is not None:
            self._expand_plugin_root_in_cache()

        # Clear hook log before running
        log_path = self._hook_log_path()
        if log_path and log_path.exists():
            log_path.unlink()

        cmd = [
            "claude",
            "-p",
            text,
            "--dangerously-skip-permissions",
            *self._session_args(),
        ]
        if self._mcp_config_path:
            cmd.extend(["--mcp-config", str(self._mcp_config_path)])
        if self._debug_file:
            cmd.extend(["--debug-file", str(self._debug_file)])

        proc = subprocess.Popen(
            cmd,
            cwd=str(self._root),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=self.build_env(),
        )

        stdout_parts: list[str] = []
        deadline = time.monotonic() + timeout

        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    proc.kill()
                    proc.wait()
                    raise subprocess.CalledProcessError(
                        proc.returncode if proc.returncode is not None else 1,
                        proc.args,
                        output="".join(stdout_parts),
                        stderr="[timed out]",
                    )

                line = proc.stdout.readline()
                if not line and proc.poll() is not None:
                    break
                if line:
                    stdout_parts.append(line)
                    if verbose:
                        print(line, end="", flush=True)
        except Exception:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            raise

        returncode = proc.returncode if proc.returncode is not None else 1
        stdout_output = "".join(stdout_parts)
        stderr_output = proc.stderr.read() if proc.stderr else ""

        if returncode != 0:
            raise subprocess.CalledProcessError(
                returncode,
                proc.args,
                output=stdout_output,
                stderr=stderr_output,
            )

        hook_log = ""
        if log_path and log_path.exists():
            hook_log = log_path.read_text()

        return PromptResult(returncode, stdout_output, hook_log)

    # -- Launch helpers -------------------------------------------------------

    def open_terminal(self, command: str | None = None) -> None:
        """Open a new terminal window in this environment.

        Args:
            command: Optional command to run in the terminal.
        """
        open_terminal(self._root, command=command, env=self.build_env())

    def launch_claude(
        self,
        prompt: str | None = None,
        mode: LaunchMode = LaunchMode.HEADLESS,
    ) -> PromptResult | None:
        """Launch claude in this environment.

        Args:
            prompt: Prompt text.  Required for headless mode.
            mode: How to launch claude (headless, terminal, interactive).
        """
        platform = _current_platform()

        # Re-expand $CLAUDE_PLUGIN_ROOT before launch
        if platform == "win32" and self._plugin_root is not None:
            self._expand_plugin_root_in_cache()

        if mode == LaunchMode.HEADLESS and prompt:
            return self.prompt(prompt)

        if prompt:
            prompt_file = self._root / ".prompt_input.txt"
            prompt_file.write_text(prompt, encoding="utf-8")
            debug_flag = (
                f" --debug-file {shlex.quote(str(self._debug_file))}"
                if self._debug_file
                else ""
            )
            claude_base = (
                f"claude --dangerously-skip-permissions"
                f" {self._session_arg_str()}{debug_flag}"
            )

            if platform == "win32":
                if mode == LaunchMode.INTERACTIVE:
                    launcher = self._write_win_prompt_launcher(
                        prompt_file,
                        "--dangerously-skip-permissions",
                    )
                else:
                    launcher = self._write_win_prompt_launcher(
                        prompt_file,
                        f"--dangerously-skip-permissions"
                        f" {self._session_arg_str()} -p",
                    )
                self.open_terminal(command=str(launcher))
            else:
                quoted = shlex.quote(str(prompt_file))
                if mode == LaunchMode.INTERACTIVE:
                    self.open_terminal(
                        command=f"cat {quoted} | {claude_base}"
                    )
                else:
                    self.open_terminal(
                        command=f'{claude_base} -p "$(cat {quoted})"'
                    )
        else:
            debug_flag = (
                f" --debug-file {shlex.quote(str(self._debug_file))}"
                if self._debug_file
                else ""
            )
            self.open_terminal(
                command=(
                    f"claude --dangerously-skip-permissions"
                    f" {self._session_arg_str()}{debug_flag}"
                )
            )
        return None

    # -- Activation replay ----------------------------------------------------

    def run_last_activation(
        self, main_fn: Callable[[], None] | None = None
    ) -> PromptResult:
        """Re-run the hook main with the last dumped stdin, in-process.

        Calls *main_fn* directly in the current Python process so that
        breakpoints are hit by the debugger.

        Args:
            main_fn: The ``main()`` callable to invoke.

        Returns:
            PromptResult with captured stdout and hook log.
        """
        if main_fn is None:
            raise ValueError("main_fn must be provided")

        dump = self.dump_file
        if dump is None or not dump.exists():
            raise FileNotFoundError(
                f"No dump file found at {dump}. "
                "Run a prompt with dump_activations=True first."
            )
        print(f"Re-running last activation from dump: {dump}")

        lines = [line for line in dump.read_text().splitlines() if line.strip()]
        if not lines:
            raise ValueError(f"Dump file is empty: {dump}")
        last_entry = lines[-1]

        # Save state we're about to mutate
        old_stdin = sys.stdin
        old_cwd = os.getcwd()
        saved_env: dict[str, str | None] = {}

        stdout_buf = _TeeIO(sys.stdout)
        exit_code = 0

        try:
            # Apply env vars to the real os.environ (so main sees them)
            for key, value in self._env_vars.items():
                saved_env[key] = os.environ.get(key)
                os.environ[key] = value

            os.chdir(str(self._root))
            sys.stdin = io.StringIO(last_entry)

            with redirect_stdout(stdout_buf):
                try:
                    main_fn()
                except SystemExit as exc:
                    exit_code = exc.code if isinstance(exc.code, int) else 0
        finally:
            # Restore everything
            sys.stdin = old_stdin
            os.chdir(old_cwd)
            for key, orig in saved_env.items():
                if orig is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = orig

        log_path = self._hook_log_path()
        hook_log_text = ""
        if log_path and log_path.exists():
            hook_log_text = log_path.read_text()

        return PromptResult(exit_code, stdout_buf.getvalue(), hook_log_text)

    # -- Cleanup --------------------------------------------------------------

    def cleanup(self) -> None:
        """Remove the entire project directory."""
        if self._root.exists():
            if _current_platform() == "win32":
                _rmtree_safe(self._root)
            else:
                shutil.rmtree(self._root)
