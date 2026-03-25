"""
Fixtures for CLI integration tests.

Extracted from the original tests/conftest.py:
- local_server: starts/stops the minihub server in a thread
- temp_workdir: temporary working directory
- claude_settings: temporary Claude settings directory
- client: synchronous httpx test client via ASGITransport
"""

import os
import time
import socket
from pathlib import Path

import pytest
import httpx


def is_port_in_use(port: int) -> bool:
    """Check if a port is already in use."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0


@pytest.fixture
def client(app):
    """Synchronous test client for FastAPI app using httpx with ASGI transport."""
    from httpx import ASGITransport
    transport = ASGITransport(app=app)
    return httpx.Client(transport=transport)


@pytest.fixture
def local_server(request):
    """Function-scoped fixture to start and stop the local test server."""
    import threading
    import requests
    from flow_sdk.server.app import start_server
    from flow_sdk.server.state import ping_results, prompt_results

    port = getattr(request, 'param', {}).get('port', 9007) if hasattr(request, 'param') else 9007

    ping_results.clear()
    prompt_results.clear()

    server_thread = threading.Thread(
        target=start_server,
        args=(port,),
        daemon=True
    )
    server_thread.start()
    time.sleep(1)

    class ServerHelper:
        def __init__(self, port):
            self.port = port
            self.base_url = f"http://127.0.0.1:{port}"

        def get_pings(self):
            response = requests.get(f"{self.base_url}/get_pings", timeout=5)
            if response.status_code == 200:
                return response.json()["pings"]
            return []

        def get_prompts(self):
            response = requests.get(f"{self.base_url}/get_prompts", timeout=5)
            if response.status_code == 200:
                return response.json()["prompts"]
            return []

    yield ServerHelper(port)


@pytest.fixture
def temp_workdir(tmp_path):
    """Function-scoped fixture that provides a temporary working directory."""
    yield tmp_path


@pytest.fixture
def claude_settings(temp_workdir, monkeypatch):
    """Function-scoped fixture that provides a temporary Claude settings directory."""
    import shutil

    original_cwd = Path.cwd()
    original_home = os.environ.get("HOME")

    if original_home:
        real_claude_dir = Path(original_home) / ".claude"
        claude_dir = temp_workdir / ".claude"
        claude_dir.mkdir(parents=True, exist_ok=True)

        if (real_claude_dir / ".claude.json").exists():
            shutil.copy(real_claude_dir / ".claude.json", claude_dir / ".claude.json")
        if (real_claude_dir / ".claude.json.backup").exists():
            shutil.copy(real_claude_dir / ".claude.json.backup", claude_dir / ".claude.json.backup")
    else:
        claude_dir = temp_workdir / ".claude"
        claude_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("HOME", str(temp_workdir))
    os.chdir(temp_workdir)

    settings_file = claude_dir / "settings.json"

    class SettingsHelper:
        def __init__(self, file_path, dir_path, home_path):
            self.file = file_path
            self.dir = dir_path
            self.home = home_path

    yield SettingsHelper(settings_file, claude_dir, temp_workdir)

    os.chdir(original_cwd)
