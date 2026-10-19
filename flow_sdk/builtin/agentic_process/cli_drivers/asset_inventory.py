"""Owned subprocess transport for native worker inventory probes."""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from tempfile import TemporaryFile
from typing import Any

from flow_sdk.assets.asset_inventory import AssetInventoryError, InventoryInputs


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




def inventory_spawn(inputs: InventoryInputs, argv: list[str]):
    return [inputs.executable, *argv[1:]], dict(inputs.env)
