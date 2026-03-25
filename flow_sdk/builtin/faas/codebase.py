import json
import logging
import os
import platform
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict

# ISO format for timestamps
TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


class CodeBaseState(BaseModel):
    """Model representing the state of a codebase."""

    model_config = ConfigDict(extra="forbid")

    last_build_time: Optional[str] = None
    last_build_exit_code: Optional[int] = None
    last_build_stdout: Optional[str] = None
    last_build_stderr: Optional[str] = None
    # Add more state fields as needed in the future

    @property
    def is_built(self) -> bool:
        """Indicates whether the codebase was built."""
        return self.last_build_time is not None

    @is_built.setter
    def is_built(self, value: bool) -> None:
        """Sets the build status and updates the timestamp if built."""
        if value:
            self.last_build_time = datetime.now(UTC).strftime(TIMESTAMP_FORMAT)
        else:
            self.last_build_time = None


class AppCodebase(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    root_folder: Optional[str] = None
    _state: Optional[CodeBaseState] = None

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.init_state_folder()

    def init_state_folder(self):
        if not self.root_folder:
            return

        # Create .flow directory under the app's root folder
        self.flow_folder.mkdir(exist_ok=True)

        # Create app subdirectory inside .flow
        self.app_local_folder.mkdir(exist_ok=True)

        self.load_state()

    def load_state(self) -> CodeBaseState:
        """Load the state from the state.json file."""
        if not self.root_folder:
            self._state = CodeBaseState()
            return self._state

        if not self.state_file_exist:
            self._state = CodeBaseState()
            return self._state

        # noinspection PyBroadException
        try:
            with open(self.state_file_path, "r") as f:
                state_data = json.load(f)
                self._state = CodeBaseState(**state_data)
        except Exception:
            # If there's an error loading the state, create a new one
            self._state = CodeBaseState()

        return self._state

    def save_state(self) -> None:
        """Save the current state to the state.json file."""
        if not self.root_folder or not self._state:
            return

        try:
            with open(self.state_file_path, "w") as f:
                # noinspection PyTypeChecker
                json.dump(self._state.model_dump(), f, indent=2)
        except Exception as e:
            # Log the error but don't raise it
            logging.info(f"Error saving state: {e}")

    @property
    def root(self) -> Path:
        if not self.root_folder:
            raise ValueError("Root folder is not set")
        return Path(self.root_folder).resolve()

    @property
    def flow_folder(self) -> Path:
        """Return the .flow folder path."""
        if not self.root_folder:
            raise ValueError("Root folder is not set")
        return self.root / ".flow"

    @property
    def app_local_folder(self) -> Path:
        """Return the .flow/app folder path."""
        return self.flow_folder / "local"

    @property
    def state_file_path(self) -> Path:
        """Return the path to the state.json file."""
        return self.app_local_folder / "state.json"

    @property
    def build_file_path(self) -> Path:
        """Return the path to the build.py file in the app's root directory."""
        return self.root / "build.py"

    @property
    def has_build_file(self) -> bool:
        """Check if the build.py file exists in the app's root directory."""
        return self.build_file_path.exists()

    @property
    def public_folder(self) -> Path:
        """Return the path to the public folder."""
        return self.root / "public"

    @property
    def state_file_exist(self) -> bool:
        """Check if the state file exists."""
        if not self.root_folder:
            return False

        return self.state_file_path.exists()

    def public_file_path(self, file_path: str) -> Path:
        if not self.root_folder:
            raise ValueError("Root folder is not set")
        requested_file = self.public_folder / Path(file_path)
        requested_file = requested_file.resolve()
        if not str(requested_file).startswith(str(self.root)):
            raise HTTPException(status_code=403, detail="Invalid file path")
        return requested_file

    def open_folder(self, relative_path):
        full_path = self.root / relative_path
        item_path = str(full_path.resolve())
        if not os.path.exists(item_path):
            raise FileNotFoundError(f"The path '{relative_path}' does not exist.")

        system_platform = platform.system()

        if system_platform == "Windows":
            if os.path.isdir(item_path):
                os.startfile(item_path)
            else:
                subprocess.run(["explorer", "/select,", os.path.normpath(item_path)])
        elif system_platform == "Darwin":  # macOS
            subprocess.run(["open", "-R", item_path])
        elif system_platform == "Linux":
            if os.path.isdir(item_path):
                subprocess.run(["xdg-open", item_path])
            else:
                # xdg-open may not support highlighting files; open the containing folder
                subprocess.run(["xdg-open", os.path.dirname(item_path)])
        else:
            raise OSError(f"Unsupported operating system: {system_platform}")

    def write_public_file(self, relative_path: str, content: str):
        public_rel_path = os.path.join("public", relative_path)
        return self.write_file(public_rel_path, content)

    def write_file(self, relative_path: str, content: str):
        """
        Write content to a file within the root folder.

        Args:
            relative_path (str): Relative path to the file inside the root.
            content (str): Content to write to the file.
        """
        full_path = self.root / relative_path
        full_path.parent.mkdir(parents=True, exist_ok=True)  # Create parent folders if needed
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(content)
        logging.info(f"[FolderDriver] File written to: {full_path}")

    def read_file(self, relative_path: str) -> str:
        """
        Read the content of a file inside the root.

        Args:
            relative_path (str): Relative path to the file.
        Returns:
            str: Content of the file.
        """
        full_path = self.root / relative_path
        if not full_path.exists():
            raise FileNotFoundError(f"File not found: {full_path}")
        return full_path.read_text(encoding="utf-8")

    def exists(self, relative_path: str) -> bool:
        """
        Check if a file or folder exists at the given relative path.

        Args:
            relative_path (str): Relative path to check.
        Returns:
            bool: True if it exists, False otherwise.
        """
        return (self.root / relative_path).exists()

    def delete_file(self, relative_path: str):
        """
        Delete a file in the root folder if it exists.

        Args:
            relative_path (str): Relative path to the file.
        """
        full_path = self.root / relative_path
        if full_path.exists():
            full_path.unlink()
            logging.info(f"[FolderDriver] File deleted: {full_path}")
        else:
            logging.info(f"[FolderDriver] File not found, nothing deleted: {full_path}")

    def build(self) -> bool:
        """
        Run the build.py file as a subprocess.

        Returns:
            bool: True if build was successful (exit code 0), False otherwise.
        """
        if not self.has_build_file:
            return False

        try:
            # Run the build script as a subprocess
            process = subprocess.Popen(
                ["python", str(self.build_file_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                universal_newlines=True,
            )

            # Stream output to terminal in real-time
            stdout_lines = []
            stderr_lines = []

            # Process stdout
            if process.stdout:
                for line in process.stdout:
                    stdout_lines.append(line)

            # Process stderr
            if process.stderr:
                for line in process.stderr:
                    stderr_lines.append(line)

            # Wait for the process to complete
            exit_code = process.wait()

            # Update state properties
            assert self._state is not None
            self._state.last_build_time = datetime.now(UTC).strftime(TIMESTAMP_FORMAT)
            self._state.last_build_exit_code = exit_code
            self._state.last_build_stdout = "".join(stdout_lines)
            self._state.last_build_stderr = "".join(stderr_lines)

            # Save the updated state
            self.save_state()

            # Return True if exit code is 0, False otherwise
            return exit_code == 0

        except Exception as e:
            # Log the error and update state
            error_msg = str(e)
            logging.info(f"Error during build: {error_msg}")
            assert self._state is not None
            self._state.last_build_time = datetime.now(UTC).strftime(TIMESTAMP_FORMAT)
            self._state.last_build_exit_code = -1
            self._state.last_build_stdout = ""
            self._state.last_build_stderr = error_msg
            self.save_state()
            return False
