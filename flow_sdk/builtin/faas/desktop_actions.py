"""DesktopActionsMixin — desktop/OS interaction actions for ComputeNode."""
from __future__ import annotations

import json
import logging
import os
import platform

from starlette.responses import RedirectResponse

from flow_sdk.config import AGENT_MOUNT_FOLDER
from flow_sdk.core.resource_management.scan.system_profile.types import SystemProfile
from flow_sdk.flowpad_types.machine_status import ExecutionEnvironmentStatus, MachineStatus
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


class DesktopActionsMixin:
    def _desktop_get_host(self, port: int, redirect: bool = True):
        """Get the host URL for a given port on this compute node.

        Args:
            port: The port number (must be between 1024 and 65535)
            redirect: If True, returns a redirect response. If False, returns JSON with URL.

        Returns:
            RedirectResponse or ApiResponse with host URL
        """
        int_port = int(port)
        if not 1024 <= int_port <= 65535:
            return ApiFailResponse(message="Invalid port")

        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set")

        host = self.get_host(int_port)

        if not redirect:
            return ApiResponse(data={"url": host, "port": int_port})

        return RedirectResponse(url=host)

    async def _desktop_get_machine_status(self) -> ApiResponse:
        """Get machine status (processes, network, CPU, memory) from this compute node.

        This is a READ-ONLY operation - it does not attempt to resume paused nodes.
        If the node is in an unrecoverable state, it returns ERROR status quickly.

        Returns:
            ApiResponse with MachineStatus data
        """
        if not self.node_provider_id:
            machine_status = MachineStatus(
                node_provider_status=ExecutionEnvironmentStatus.NOT_FOUND,
                status_msg="Compute node provider ID not set",
            )
            return ApiSuccessResponse(data=machine_status.model_dump())

        machine_status = await self.get_machine_status()
        return ApiSuccessResponse(data=machine_status.model_dump())

    async def _desktop_get_system_profile(self) -> ApiResponse:
        """Get system profile (Claude Code environment info) from this compute node.

        Returns a simplified local system profile with platform info.
        Production runs a full system_profile script on the compute node;
        the local desktop version returns basic platform data directly.

        Returns:
            ApiResponse with SystemProfile data
        """
        from datetime import datetime

        try:
            profile = SystemProfile(
                generated=datetime.now().isoformat(),
                machine=platform.node(),
            )
            return ApiSuccessResponse(data=profile.model_dump())
        except Exception as e:
            logging.exception(f"ComputeNode {self.id} get-system-profile error: {e}")
            return ApiFailResponse(message=str(e))

    async def _desktop_open_external(self) -> ApiResponse:
        """Open a file or directory in the system's default application.

        This is useful for opening files like settings.json, CLAUDE.md, or commands
        in the user's preferred editor directly from the FlowPad UI.

        POST body:
            path: Absolute path to the file or directory to open

        Returns:
            ApiResponse with success status
        """
        import subprocess

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            path = body.get("path")
            if not path:
                return ApiFailResponse(message="path field is required")

            raw_path = str(path).strip()
            if not raw_path:
                return ApiFailResponse(message="path field is required")

            # Accept both absolute OS paths and relative desktop paths.
            # Relative paths are resolved against workspace/root fallbacks so
            # callers can pass project names like "my_first_project".
            expanded_path = os.path.expanduser(raw_path)
            if os.path.isabs(expanded_path):
                candidate_paths = [expanded_path]
            else:
                relative_path = expanded_path.lstrip("/\\")
                candidate_paths = [
                    os.path.join(AGENT_MOUNT_FOLDER, relative_path),
                    os.path.join(os.sep, relative_path),
                    os.path.abspath(expanded_path),
                ]

            seen = set()
            resolved_path = None
            for candidate in candidate_paths:
                normalized_candidate = os.path.normpath(candidate)
                if normalized_candidate in seen:
                    continue
                seen.add(normalized_candidate)
                if os.path.exists(normalized_candidate):
                    resolved_path = normalized_candidate
                    break

            if not resolved_path:
                return ApiFailResponse(message=f"Path does not exist: {raw_path}")

            # Open with system default application
            system = platform.system()
            if system == "Darwin":  # macOS
                subprocess.Popen(["open", resolved_path])
            elif system == "Windows":
                os.startfile(resolved_path)  # type: ignore
            else:  # Linux and other Unix-like
                subprocess.Popen(["xdg-open", resolved_path])

            return ApiSuccessResponse(data={"opened": resolved_path})

        except Exception as e:
            logging.exception(f"Failed to open external file: {e}")
            return ApiFailResponse(message=str(e))

    async def _desktop_open_terminal(self) -> ApiResponse:
        """Open an OS terminal and run a command, optionally in a specific directory.

        POST body:
            command: The command to execute in the terminal
            cwd: Optional working directory to open the terminal in

        Returns:
            ApiResponse with success status
        """
        import subprocess

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            command = body.get("command")
            if not command:
                return ApiFailResponse(message="command field is required")

            cwd = body.get("cwd")
            system = platform.system()

            if system == "Darwin":
                # On macOS, open a new Terminal tab and run the command.
                # Escape double-quotes and backslashes for embedding in AppleScript strings.
                def _escape_applescript(s: str) -> str:
                    return s.replace("\\", "\\\\").replace('"', '\\"')

                escaped_command = _escape_applescript(command)
                if cwd:
                    escaped_cwd = _escape_applescript(cwd)
                    shell_cmd = f'cd \\"{escaped_cwd}\\" && {escaped_command}'
                else:
                    shell_cmd = escaped_command

                apple_script = f'tell application "Terminal"\n  activate\n  do script "{shell_cmd}"\nend tell'
                subprocess.Popen(["osascript", "-e", apple_script])
            elif system == "Windows":
                args = ["cmd", "/c", "start", "cmd", "/k", command]
                subprocess.Popen(args, cwd=cwd)
            else:
                # Linux - try common terminal emulators
                for term in ["gnome-terminal", "xterm", "konsole"]:
                    import shutil

                    if shutil.which(term):
                        if term == "gnome-terminal":
                            subprocess.Popen([term, "--", "bash", "-c", command], cwd=cwd)
                        else:
                            subprocess.Popen([term, "-e", command], cwd=cwd)
                        break
                else:
                    return ApiFailResponse(message="No supported terminal emulator found")

            return ApiSuccessResponse(data={"command": command, "cwd": cwd})

        except Exception as e:
            logging.exception(f"Failed to open terminal: {e}")
            return ApiFailResponse(message=str(e))

    async def _desktop_pick_folder(self) -> ApiResponse:
        """Open a native OS folder-picker dialog and return the selected path.

        Accepts an optional JSON body: {"initial_dir": "/path/to/open"}.

        Returns:
            ApiSuccessResponse with {"path": "/selected/path"} or {"path": null} if cancelled.
        """
        try:
            from flow_sdk.request_context.methods import get_current_request_info
            request_info = get_current_request_info()
            body = await request_info.get_post_data() if request_info else {}
            initial_dir: str | None = body.get("initial_dir") if isinstance(body, dict) else None
            selected_path = await self.compute_provider.pick_folder(
                self.verified_node_provider_id, initial_dir=initial_dir
            )
            return ApiSuccessResponse(data={"path": selected_path})
        except Exception as e:
            logging.exception(f"Failed to open folder picker: {e}")
            return ApiFailResponse(message=str(e))

    async def _desktop_get_json_file(self) -> ApiResponse:
        """Read a JSON file and return its parsed contents.

        Query params:
            path: Absolute path to the JSON file

        Returns:
            ApiResponse with parsed JSON data
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        path = request_info.get_param("path")
        if not path:
            return ApiFailResponse(message="path parameter is required")

        try:
            # Read the file
            file_contents = await self.read_files(path)
            if path not in file_contents:
                return ApiFailResponse(message=f"File not found: {path}")

            content = file_contents[path]
            if not content:
                return ApiFailResponse(message=f"File is empty: {path}")

            # Parse JSON
            data = json.loads(content)
            return ApiSuccessResponse(data=data)

        except json.JSONDecodeError as e:
            return ApiFailResponse(message=f"Invalid JSON in file: {e}")
        except Exception as e:
            logging.exception(f"ComputeNode {self.id} get-json-file error: {e}")
            return ApiFailResponse(message=str(e))

    async def _desktop_save_json_file(self) -> ApiResponse:
        """Write JSON data to a file.

        POST body:
            path: Absolute path to the JSON file
            data: JSON data to write

        Returns:
            ApiResponse with success/failure status
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            path = body.get("path")
            if not path:
                return ApiFailResponse(message="path field is required")

            data = body.get("data")
            if data is None:
                return ApiFailResponse(message="data field is required")

            # Serialize JSON with pretty formatting
            json_content = json.dumps(data, indent=2)

            # Write the file
            await self.write_files(path, json_content)

            return ApiSuccessResponse(data={"message": f"File saved: {path}"})

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} save-json-file error: {e}")
            return ApiFailResponse(message=str(e))

    async def _desktop_generate_amd_plan(self) -> ApiResponse:
        """Generate an AMD execution plan from user content.

        This is a stub implementation for the desktop version.
        The production version uses AgenticProcessor with planner skills.

        POST body:
            content: The content to create a plan for

        Returns:
            ApiResponse with stub message
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            content = body.get("content")
            if not content:
                return ApiFailResponse(message="content field is required")

            return ApiFailResponse(
                message="AMD plan generation is not available in desktop mode. Use AgenticProcessor for task execution."
            )

        except Exception as e:
            logging.exception(f"Failed to generate AMD plan: {e}")
            return ApiFailResponse(message=str(e))
