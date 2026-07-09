import base64
import logging
import shlex
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from io import BytesIO

from fastapi import UploadFile
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from flow_sdk.config import ComputeProviderType, PLATFORM_WIN32
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.core.flow.models.execution.env_context import FlowEnv


class ComputeSourceControlInitializeOptions(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)

    git_init: bool = True
    git_origin: GitOrigin | None = None
    zip_file: UploadFile | None = None


@dataclass
class ComputeSourceControl:
    compute_node: ComputeNode
    _fs_state_cache: str | None = field(default=None, init=False)
    _git_branch: str | None = field(default=None, init=False)
    _env: list[FlowEnv] | None = field(default=None, init=False)

    async def is_content_in_file(self, content: str, file: str) -> bool:
        try:
            file_contents = await self.compute_node.read_files(file)
            if file not in file_contents:
                return False
            file_content = file_contents[file]
            # Check if content is in the file (handle both single line and multi-line content)
            content_lines = content.strip().split("\n")
            file_lines = file_content.split("\n")
            # Check if all content lines exist in file lines
            for content_line in content_lines:
                if content_line.strip() and content_line.strip() not in [line.strip() for line in file_lines]:
                    return False
            return True
        except FileNotFoundError:
            return False
        except Exception as e:
            logging.warning(f"Error checking content in {file}: {e}")
            return False

    async def write_content(self, content: str, file: str) -> None:
        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE and sys.platform == PLATFORM_WIN32:
            # Use cmd.exe echo on Windows - write each line separately to avoid quote issues
            lines = content.strip().split("\n")
            for line in lines:
                if line.strip():  # Only write non-empty lines
                    escaped_line = line.strip().replace('"', '\\"')
                    write_cmd = await self.compute_node.run_command(f'cmd /c "echo {escaped_line} >> {file}"')
                    await write_cmd.wait()
                    if write_cmd.exit_code != 0:
                        logging.warning(
                            f"Failed to add line to {file} (exit code: {write_cmd.exit_code}): {write_cmd.all_stderr}"
                        )
        else:
            # Use echo for Unix/Linux
            write_cmd = await self.compute_node.run_command(f"echo '{content}' >> {file}")
            await write_cmd.wait()
            if write_cmd.exit_code != 0:
                logging.error(f"Failed to write to {file} (exit code: {write_cmd.exit_code}): {write_cmd.all_stderr}")

    async def _init_git_repository(self) -> bool:
        # Check if git already initialized
        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value and sys.platform == PLATFORM_WIN32:
            # Windows: Don't redirect stderr (Windows doesn't handle 2>/dev/null)
            git_status_cmd = await self.compute_node.run_command("git rev-parse --is-inside-work-tree")
        else:
            # Unix: Redirect stderr to /dev/null
            git_status_cmd = await self.compute_node.run_command("git rev-parse --is-inside-work-tree 2>/dev/null")
        await git_status_cmd.wait()
        if "true" == git_status_cmd.all_stdout.strip():
            return True

        # Git init
        git_init_cmd = await self.compute_node.run_command("git init --initial-branch=main")
        await git_init_cmd.wait()
        if git_init_cmd.exit_code != 0:
            logging.error(
                f"Failed to initialize git repository (exit code: {git_init_cmd.exit_code}): {git_init_cmd.all_stderr}"
            )
            return False

        # Identity + push config for a fresh Flowpad repo — one shared spec with
        # GitRepo.init() (the GitPanel "Initialize git repo" path) so the two
        # init surfaces can't drift. Failures are non-fatal, same as before.
        from flow_sdk.builtin.faas.git_repo import GIT_INIT_CONFIG

        for key, value in GIT_INIT_CONFIG:
            git_config_cmd = await self.compute_node.run_command(f"git config {key} {shlex.quote(value)}")
            await git_config_cmd.wait()
            if git_config_cmd.exit_code != 0:
                logging.error(
                    f"Failed to set git config {key} (exit code: {git_config_cmd.exit_code}): {git_config_cmd.all_stderr}"
                )

        return True

    async def _backup_mcp_servers(self) -> str | None:
        temp_backup_path = "../temp_mcp_servers_backup"

        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value and sys.platform == PLATFORM_WIN32:
            # Windows: Use PowerShell Copy-Item, create parent directory if needed
            copy_cmd = await self.compute_node.run_command(
                'powershell -Command "if (Test-Path .mcp_servers) { New-Item -ItemType Directory -Force -Path ../temp_mcp_servers_backup | Out-Null; Copy-Item -Recurse -Force .mcp_servers ../temp_mcp_servers_backup } else { exit 1 }"'
            )
        else:
            # Unix: Use cp command, create parent directory if needed
            copy_cmd = await self.compute_node.run_command(
                "mkdir -p ../temp_mcp_servers_backup && cp -r .mcp_servers ../temp_mcp_servers_backup 2>/dev/null || exit 1"
            )

        await copy_cmd.wait()

        if copy_cmd.exit_code == 0:
            logging.info(f"Backed up .mcp_servers to {temp_backup_path}")
            return temp_backup_path
        else:
            logging.debug(".mcp_servers directory does not exist, skipping backup")
            return None

    async def _restore_mcp_servers(self, temp_path: str | None) -> None:
        if not temp_path:
            return

        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value and sys.platform == PLATFORM_WIN32:
            # Windows: Use PowerShell Copy-Item
            copy_cmd = await self.compute_node.run_command(
                f'powershell -Command "if (Test-Path {temp_path}) {{ Copy-Item -Recurse -Force {temp_path} .mcp_servers }} else {{ exit 1 }}"'
            )
        else:
            # Unix: Use cp command
            copy_cmd = await self.compute_node.run_command(f"cp -r {temp_path} .mcp_servers 2>/dev/null || exit 1")

        await copy_cmd.wait()

        if copy_cmd.exit_code == 0:
            logging.info(f"Restored .mcp_servers from {temp_path}")
            # Delete the backup folder after successful restore
            if (
                self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value
                and sys.platform == PLATFORM_WIN32
            ):
                # Windows: Use PowerShell Remove-Item
                delete_cmd = await self.compute_node.run_command(
                    f'powershell -Command "if (Test-Path {temp_path}) {{ Remove-Item -Recurse -Force {temp_path} }}"'
                )
            else:
                # Unix: Use rm command
                delete_cmd = await self.compute_node.run_command(f"rm -rf {temp_path} 2>/dev/null || true")

            await delete_cmd.wait()
            if delete_cmd.exit_code == 0:
                logging.info(f"Deleted backup folder {temp_path}")
            else:
                logging.warning(f"Failed to delete backup folder {temp_path} (exit code: {delete_cmd.exit_code})")
        else:
            logging.warning(f"Failed to restore .mcp_servers from {temp_path}, MCPConnector will create fresh")

    async def _clean_working_directory(self) -> None:
        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value and sys.platform == PLATFORM_WIN32:
            # Windows: Use PowerShell to remove all files including hidden ones
            clean_cmd = await self.compute_node.run_command(
                'powershell -Command "Get-ChildItem -Path . -Force | Remove-Item -Recurse -Force"'
            )
        else:
            # Unix: Remove all files including hidden files (but not . and ..)
            clean_cmd = await self.compute_node.run_command("rm -rf * .[!.]*")

        await clean_cmd.wait()

        if clean_cmd.exit_code == 0:
            logging.info("Cleaned working directory")
        else:
            logging.warning(
                f"Failed to clean working directory (exit code: {clean_cmd.exit_code}): {clean_cmd.all_stderr}"
            )

    async def _setup_remote_repo(self, clone_url: str) -> bool:
        env_variable_name = oauth_providers_config_cache["github"].user_credentials_name
        project_env_variable_name = build_shared_var_name(env_variable_name, BuiltinEntityType.PROJECT.value.upper())
        logging.info(f"Looking for GitHub token in env variable: {project_env_variable_name}")

        # GitHub accepts any non-empty username when using a personal access token
        github_user = "oauth2"

        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value and sys.platform == PLATFORM_WIN32:
            ps_script_content = (
                f'Write-Output "username={github_user}"; Write-Output "password=$env:{project_env_variable_name}"'
            )
            encoded_script = base64.b64encode(ps_script_content.encode("utf-16le")).decode("ascii")
            credential_helper_script = (
                f'git config credential.helper "!powershell.exe -NoProfile -EncodedCommand {encoded_script}"'
            )
        else:
            credential_helper_script = (
                f'git config credential.helper "!bash -c \\"'
                f"echo username={github_user}; "
                f"echo password=\\${{{project_env_variable_name}}}; "
                f'\\""'
            )

        git_cred_cmd = await self.compute_node.run_command(credential_helper_script, env=self._env)
        await git_cred_cmd.wait()
        if git_cred_cmd.exit_code != 0:
            logging.error(
                f"Failed to configure in-memory credential helper (exit code: {git_cred_cmd.exit_code}): "
                f"{git_cred_cmd.all_stderr}"
            )
            raise RuntimeError("Failed to configure in-memory git credentials")

        git_remote_add_cmd = await self.compute_node.run_command(f'git remote add origin "{clone_url}"', env=self._env)
        await git_remote_add_cmd.wait()
        if git_remote_add_cmd.exit_code != 0:
            error_msg = (
                f"Failed to add git remote origin (exit code: {git_remote_add_cmd.exit_code}): "
                f"{git_remote_add_cmd.all_stderr}"
            )
            logging.error(error_msg)
            raise RuntimeError(error_msg)

        logging.info("Configured remote repo and temporary in-memory authentication for the MCP git session.")
        return True

    async def _fetch_and_checkout_branch(self, branch_name: str, is_error: bool = True) -> bool:
        git_fetch_cmd = await self.compute_node.run_command(f"git fetch origin {branch_name}", env=self._env)
        await git_fetch_cmd.wait()

        if git_fetch_cmd.exit_code != 0:
            error_msg = (
                f"Failed to fetch origin/{branch_name} (exit code: {git_fetch_cmd.exit_code}): "
                f"{git_fetch_cmd.all_stderr}"
            )
            log_level = logging.error if is_error else logging.warning
            log_level(error_msg)
            if is_error:
                raise RuntimeError(error_msg)
            return False

        # Always use empty-repo path: create the branch pointing to the remote commit
        # This avoids divergent histories by starting from the remote's state
        git_checkout_cmd = await self.compute_node.run_command(
            f"git checkout -b {branch_name} origin/{branch_name}", env=self._env
        )
        await git_checkout_cmd.wait()

        if git_checkout_cmd.exit_code == 0:
            # Set up tracking after checkout
            git_set_upstream_cmd = await self.compute_node.run_command(
                f"git branch --set-upstream-to=origin/{branch_name} {branch_name}", env=self._env
            )
            await git_set_upstream_cmd.wait()
            if git_set_upstream_cmd.exit_code != 0:
                warning_msg = (
                    f"Failed to set upstream for branch {branch_name} (exit code: {git_set_upstream_cmd.exit_code}): "
                    f"{git_set_upstream_cmd.all_stderr}"
                )
                logging.warning(warning_msg)
            # Store the branch name for later use
            self._git_branch = branch_name
            return True
        else:
            error_msg = (
                f"Failed to checkout branch {branch_name} from remote (exit code: {git_checkout_cmd.exit_code}): "
                f"{git_checkout_cmd.all_stderr}"
            )
            log_level = logging.error if is_error else logging.warning
            log_level(error_msg)
            if is_error:
                raise RuntimeError(error_msg)
            return False

    async def _pull_and_checkout_branch(self, branch: str | None = None) -> bool:
        if branch:
            return await self._fetch_and_checkout_branch(branch, is_error=True)
        else:
            # Try main first, then master if main fails
            if await self._fetch_and_checkout_branch("main", is_error=False):
                return True

            # Try master branch as fallback
            if await self._fetch_and_checkout_branch("master", is_error=True):
                return True

            return False

    @asynccontextmanager
    async def initialize(
        self,
        initialize_options: ComputeSourceControlInitializeOptions | None = None,
        env: "list[FlowEnv] | None" = None,
    ):
        if not initialize_options:
            initialize_options = ComputeSourceControlInitializeOptions()

        if env:
            self._env = env

        async with self.compute_node.ready_session():
            if initialize_options.git_init:
                # Setup remote repository if provided (Scenarios 2 & 3)
                if initialize_options.git_origin:
                    git_origin = initialize_options.git_origin
                    clone_url = git_origin.clone_url()
                    git_branch = git_origin.branch or None
                    # Backup .mcp_servers before cleaning
                    mcp_backup_path = await self._backup_mcp_servers()

                    # Clean working directory before cloning
                    await self._clean_working_directory()

                    # Initialize git repository
                    if not await self._init_git_repository():
                        yield
                        return

                    # Setup remote repository
                    if await self._setup_remote_repo(clone_url):
                        # Pull and checkout branch
                        git_pull_success = await self._pull_and_checkout_branch(git_branch)

                        if not git_pull_success:
                            branch_message = (
                                f"Failed to pull from specified branch '{git_branch}'."
                                if git_branch
                                else "Failed to pull from both main and master branches."
                            )
                            logging.error(f"{branch_message} Repository may be empty or inaccessible.")
                        else:
                            # If no branch was specified but pull succeeded, default to main
                            if not git_branch:
                                self._git_branch = self._git_branch or "main"

                            # Restore .mcp_servers after successful checkout
                            await self._restore_mcp_servers(mcp_backup_path)

                            # Write to .gitignore AFTER successful git checkout and restore
                            if not await self.is_content_in_file(".mcp_servers", ".gitignore"):
                                await self.write_content(".mcp_servers", ".gitignore")
                else:
                    # No remote repo (Scenario 1) - keep current flow
                    # Initialize git repository
                    if not await self._init_git_repository():
                        yield
                        return

                    # Write to .gitignore before any git operations
                    if not await self.is_content_in_file(".mcp_servers", ".gitignore"):
                        await self.write_content(".mcp_servers", ".gitignore")

                # Handle zip file upload if provided (after git init for both scenarios)
                if initialize_options.zip_file:
                    zip_file = initialize_options.zip_file
                    if not zip_file.filename:
                        raise ValueError("No file name")
                    await self.compute_node.fs_storage.upload_zip(BytesIO(await zip_file.read()), zip_file.filename)

                # Create initial checkpoint right after git init
                await self.create_checkpoint("Initiated flow")
            yield

    @property
    def checkpoint_message(self):
        return "Flowpad Checkpoint"

    # Ensure we're on the correct branch before committing
    async def _ensure_on_branch(self) -> bool:
        if not self._git_branch:
            return True  # No branch specified, use current branch

        # Check current branch
        git_branch_cmd = await self.compute_node.run_command("git rev-parse --abbrev-ref HEAD")
        await git_branch_cmd.wait()
        current_branch = git_branch_cmd.all_stdout.strip()

        if current_branch != self._git_branch:
            # Checkout the correct branch
            if (
                self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value
                and sys.platform == PLATFORM_WIN32
            ):
                # Windows: Try checkout first, if it fails, try creating new branch
                # Don't use 2>/dev/null or || operator (Windows CMD doesn't support them the same way)
                git_checkout_cmd = await self.compute_node.run_command(f"git checkout {self._git_branch}")
                await git_checkout_cmd.wait()
                if git_checkout_cmd.exit_code != 0:
                    # Try creating new branch with tracking
                    git_checkout_cmd = await self.compute_node.run_command(
                        f"git checkout -b {self._git_branch} --track origin/{self._git_branch}"
                    )
                    await git_checkout_cmd.wait()
            else:
                # Unix: Use stderr redirection and || operator
                git_checkout_cmd = await self.compute_node.run_command(
                    f"git checkout {self._git_branch} 2>/dev/null || git checkout -b {self._git_branch} --track origin/{self._git_branch}"
                )
                await git_checkout_cmd.wait()

            if git_checkout_cmd.exit_code != 0:
                logging.warning(
                    f"Failed to checkout branch {self._git_branch} (exit code: {git_checkout_cmd.exit_code}): {git_checkout_cmd.all_stderr}. Continuing with current branch."
                )
                return False

        return True

    async def create_checkpoint(self, message: str) -> str:
        try:
            # Ensure we're on the correct branch before committing
            await self._ensure_on_branch()

            git_commit_cmd = await self.compute_node.run_command(
                f"git add --all && git commit --message '{self.checkpoint_message}: {message}'"
            )
            await git_commit_cmd.wait()

            if "nothing to commit" in git_commit_cmd.all_stdout:
                return ""

            # Clear cache since filesystem state may have changed
            self.clear_fs_state_cache()

            checkpoint_hash = await self.get_current_checkpoint_hash()
            return checkpoint_hash
        except Exception as e:
            logging.error(f"Error while creating checkpoint: {e!r}")
            return ""

    async def get_current_checkpoint_hash(self) -> str:
        git_rev_parse_cmd = await self.compute_node.run_command("git rev-parse HEAD")
        await git_rev_parse_cmd.wait()
        return git_rev_parse_cmd.all_stdout.strip()

    async def get_git_diff(
        self,
        checkpoint_hash: str,
        max_files: int = 50,
        max_lines_per_file: int = 500,
        timeout_seconds: float = 10.0,
    ) -> str:
        """Get git diff for a checkpoint, with GitHub-style limits.

        Runs limiting on the remote machine to prevent streaming huge diffs.

        Args:
            checkpoint_hash: The git commit hash to diff
            max_files: Maximum number of files to show (default 50)
            max_lines_per_file: Maximum lines per file before skipping (default 500)
            timeout_seconds: Maximum time to wait for command (default 10s)
        """
        logging.debug(f"[get_git_diff] Starting git diff for {checkpoint_hash}")

        # Step 1: Get file stats (fast, small output) - limit to max_files+1 to detect overflow
        numstat_cmd = await self.compute_node.run_command(
            f"git diff --numstat {checkpoint_hash}^! | head -n {max_files + 1}"
        )
        completed = await numstat_cmd.wait(timeout=timeout_seconds)
        if not completed:
            return f"[DIFF TIMED OUT after {timeout_seconds}s]"

        # Step 2: Parse numstat to identify large files
        small_files = []
        large_files = []
        lines = numstat_cmd.all_stdout.strip().split("\n")
        has_more_files = len(lines) > max_files

        # If truncated, get total file count
        total_file_count = None
        if has_more_files:
            count_cmd = await self.compute_node.run_command(f"git diff --numstat {checkpoint_hash}^! | wc -l")
            if await count_cmd.wait(timeout=5):
                try:
                    total_file_count = int(count_cmd.all_stdout.strip())
                except ValueError:
                    pass

        for line in lines[:max_files]:
            if not line:
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            added, deleted, filename = parts[0], parts[1], parts[2]
            # Binary files show "-" for added/deleted
            if added == "-" or deleted == "-":
                total_lines = max_lines_per_file + 1  # Treat binary as large
            else:
                total_lines = int(added) + int(deleted)

            if total_lines > max_lines_per_file:
                large_files.append((filename, total_lines))
            else:
                small_files.append(filename)

        # If too many files, just return summary without diff content
        if has_more_files:
            if total_file_count:
                return f"[TOO_MANY_FILES: {total_file_count} files changed - diff content hidden]"
            else:
                return f"[TOO_MANY_FILES: more than {max_files} files changed - diff content hidden]"

        # Fast path: no large files and under limit - single simple diff call
        if not large_files:
            diff_cmd = await self.compute_node.run_command(f"git diff {checkpoint_hash}^!")
            completed = await diff_cmd.wait(timeout=timeout_seconds)
            if not completed:
                return f"[DIFF TIMED OUT after {timeout_seconds}s]"
            return diff_cmd.all_stdout

        # Slow path: some large files need to be filtered out
        result_parts = []
        summary_parts = []

        # Get actual diff for small files first (parser expects diff to start with "diff --git")
        files_to_diff = small_files[: max_files - len(large_files)]
        if files_to_diff:
            quoted_files = " ".join(f'"{f}"' for f in files_to_diff)
            diff_cmd = await self.compute_node.run_command(f"git diff {checkpoint_hash}^! -- {quoted_files}")
            completed = await diff_cmd.wait(timeout=timeout_seconds)
            if completed:
                result_parts.append(diff_cmd.all_stdout)

        # Add messages at the end (so git diff parser can parse the actual diff first)
        for filename, line_count in large_files[:max_files]:
            summary_parts.append(f"{filename}: {line_count} lines changed - skipped")
        summary_parts.append(f"[{len(large_files)} file(s) too large to display]")

        if summary_parts:
            result_parts.append("\n" + "\n".join(summary_parts))

        return "\n".join(result_parts)

    async def revert_to_checkpoint(self, checkpoint_index: int):
        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value and sys.platform == PLATFORM_WIN32:
            git_reset_cmd = await self.compute_node.run_command(
                f'powershell -Command "$c = '
                f"(git log --oneline "
                f"| Select-String '{self.checkpoint_message}' "
                f"| Select-Object -Index {checkpoint_index} "
                f"-ExpandProperty Line "
                f"| ForEach-Object {{ ($_ -split ' ')[0] }}"
                f"); "
                f'git reset --hard $c~1"'
            )
        else:
            git_reset_cmd = await self.compute_node.run_command(
                "git reset --hard "
                "$("
                "git log --oneline "
                f'| grep "{self.checkpoint_message}" '
                f'| awk "NR=={checkpoint_index + 1} {{ print $1 }}"'
                ")~1"
            )
        await git_reset_cmd.wait()

    async def revert_to_checkpoint_hash(self, checkpoint_hash: str):
        git_reset_cmd = await self.compute_node.run_command(f"git reset --hard {checkpoint_hash}")
        await git_reset_cmd.wait()

        # Clear the filesystem state cache after reset
        self.clear_fs_state_cache()

        return git_reset_cmd

    @property
    def fs_state_command(self):
        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value and sys.platform == PLATFORM_WIN32:
            # Windows: Use PowerShell Select-Object instead of head
            return 'git ls-files | tree --fromfile -L 2 -a | powershell -Command "$input | Select-Object -First 1000"'
        else:
            # Unix: Use head command
            return "git ls-files | tree --fromfile -L 2 -a | head -n 1000"

    async def get_current_fs_state(self):
        # Use cached value if available to avoid expensive command execution
        if self._fs_state_cache is not None:
            return self._fs_state_cache

        git_ls_files_cmd = await self.compute_node.run_command(self.fs_state_command)
        await git_ls_files_cmd.wait()
        self._fs_state_cache = git_ls_files_cmd.all_stdout
        return self._fs_state_cache

    def clear_fs_state_cache(self):
        self._fs_state_cache = None

    def set_branch(self, branch: str | None):
        self._git_branch = branch

    def get_branch(self) -> str | None:
        return self._git_branch
