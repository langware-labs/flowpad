"""Read-only worker inventory transport and file-backed asset observations.

Inventory commands never send a user prompt or run an LLM turn. Discovery
failures are errors, not evidence that the worker has no available assets.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryFile
from typing import Any

from pydantic import Field

from flow_sdk.assets.asset_discovery import AssetSearchRoot
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.types import EntityType


class AssetInventoryError(RuntimeError):
    pass


def inventory_rows(response: dict, key: str) -> list[dict]:
    """A missing or malformed inventory is not proof of an empty inventory."""
    rows = response.get(key) if isinstance(response, dict) else None
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise AssetInventoryError(f"Worker did not return a valid {key} inventory")
    return rows


class WorkerAsset(DataSpec):
    asset_type: EntityType
    name: str
    path: Path


def skill_observations(rows: list[dict], *, path_key: str) -> list[WorkerAsset]:
    """Normalize native skill paths; virtual built-ins have no asset carrier."""
    assets = []
    for row in rows:
        if row.get("enabled") is False:
            continue
        raw_path, name = row.get(path_key), row.get("name")
        if not isinstance(raw_path, str) or not isinstance(name, str):
            continue
        path = Path(raw_path)
        # OpenCode's <built-in> marker is not relative to the process CWD.
        if not path.is_absolute():
            continue
        folder = path.parent if path.name == "SKILL.md" else path
        if (folder / "SKILL.md").is_file():
            assets.append(WorkerAsset(asset_type=EntityType.SKILL, name=name, path=folder.resolve()))
    return assets


@asynccontextmanager
async def inventory_process(argv: list[str], *, cwd: str, env: dict[str, str], stdout=asyncio.subprocess.PIPE):
    """Own the probe for exactly the duration of a read, including cancellation."""

    process = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd, env=env,
        stdin=asyncio.subprocess.PIPE, stdout=stdout,
        stderr=asyncio.subprocess.DEVNULL,
        limit=4 * 1024 * 1024,
    )
    try:
        yield process
    finally:
        if process.stdin is not None:
            process.stdin.close()
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.communicate()


async def json_command(argv: list[str], *, cwd: str, env: dict[str, str]) -> Any:
    # OpenCode exits without draining a pipe's buffered stdout; a real inventory
    # is truncated at 64 KiB even though the command reports success. A regular
    # file receives the full synchronous write, just like shell redirection.
    with TemporaryFile() as output:
        async with inventory_process(argv, cwd=cwd, env=env, stdout=output) as process:
            await process.communicate()
            if process.returncode:
                raise AssetInventoryError(f"Worker inventory command failed (exit {process.returncode})")
        output.seek(0)
        try:
            return json.load(output)
        except (ValueError, UnicodeError) as error:
            raise AssetInventoryError("Worker inventory returned invalid JSON") from error


async def json_request(process, message: dict, *, response_id: int | str, framed: bool = False) -> dict:
    """One JSON-lines request; notifications may precede its response."""
    encoded = json.dumps(message).encode()
    wire = f"Content-Length: {len(encoded)}\r\n\r\n".encode() + encoded if framed else encoded + b"\n"
    process.stdin.write(wire)
    await process.stdin.drain()
    while True:
        if framed:
            headers = await process.stdout.readuntil(b"\r\n\r\n")
            length = next((int(line.split(b":", 1)[1]) for line in headers.splitlines()
                           if line.lower().startswith(b"content-length:")), None)
            if length is None:
                raise AssetInventoryError("Worker inventory frame has no content length")
            line = await process.stdout.readexactly(length)
        else:
            line = await process.stdout.readline()
        if not line:
            break
        try:
            response = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if response.get("id") == response_id:
            if "error" in response:
                raise AssetInventoryError("Worker rejected the inventory request")
            return response["result"]
        if response.get("type") == "control_response":
            body = response.get("response", {})
            if body.get("request_id") == response_id:
                if body.get("subtype") != "success":
                    raise AssetInventoryError("Worker rejected the inventory request")
                return body.get("response", {})
    raise AssetInventoryError("Worker closed its inventory channel before responding")



class InventoryInputs(DataSpec):
    workdir: str
    executable: str
    env: dict[str, str]
    roots: list[AssetSearchRoot] = Field(default_factory=list)
    add_dirs: list[str] = Field(default_factory=list)
    plugin_dirs: list[str] = Field(default_factory=list)
    settings_json: dict = Field(default_factory=dict)
    agents_json: dict = Field(default_factory=dict)
    json_stream: bool = False
    no_auto_update: bool = False
    agent: str | None = None
    claude_home: Path | None = None
    skill_paths: list[str] = Field(default_factory=list)


def inventory_spawn(inputs: InventoryInputs, argv: list[str]):
    return [inputs.executable, *argv[1:]], dict(inputs.env)
