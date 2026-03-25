"""flow_sdk.mcp — Base MCP server using raw MCP protocol (no fastmcp)."""

import json
import sys


def _read_message():
    """Read a JSON-RPC message from stdin.

    Supports both newline-delimited JSON and Content-Length framing.
    """
    buf = sys.stdin.buffer
    while True:
        line = buf.readline()
        if not line:
            raise EOFError
        line_str = line.decode("utf-8").strip()
        if not line_str:
            continue
        if line_str.lower().startswith("content-length:"):
            content_length = int(line_str.split(":", 1)[1].strip())
            # consume blank line after headers
            while True:
                hline = buf.readline().decode("utf-8").strip()
                if hline == "":
                    break
            body = buf.read(content_length)
            return json.loads(body.decode("utf-8"))
        else:
            return json.loads(line_str)


def _send_message(msg):
    """Write a JSON-RPC message to stdout."""
    body = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(body + b"\n")
    sys.stdout.buffer.flush()


def _respond(req_id, result):
    _send_message({"jsonrpc": "2.0", "id": req_id, "result": result})


def _error(req_id, code, message):
    _send_message({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


# --- Tool registry ---
_tools: dict[str, tuple[callable, dict]] = {}


def register_tool(name: str, func: callable, description: str, input_schema: dict):
    """Register an MCP tool. Plugins call this to add their tools."""
    _tools[name] = (func, {
        "name": name,
        "description": description,
        "inputSchema": input_schema,
    })


# --- Built-in tools ---

def _flow_ping():
    from flow_sdk import __version__
    return f"flow_sdk {__version__} connected"


register_tool("flow_ping", _flow_ping, "Health check — returns SDK version.", {
    "type": "object", "properties": {}, "required": []
})


# --- Server loop ---

def run():
    """Run the MCP server on stdio."""
    while True:
        try:
            msg = _read_message()
        except (EOFError, ValueError):
            break

        method = msg.get("method")
        req_id = msg.get("id")

        if method == "initialize":
            _respond(req_id, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "flow_sdk", "version": "0.1"},
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            tool_list = [info for _, info in _tools.values()]
            _respond(req_id, {"tools": tool_list})
        elif method == "tools/call":
            tool_name = msg["params"]["name"]
            args = msg["params"].get("arguments", {})
            if tool_name in _tools:
                func, _ = _tools[tool_name]
                try:
                    result = func(**args)
                    _respond(req_id, {"content": [{"type": "text", "text": str(result)}]})
                except Exception as e:
                    _respond(req_id, {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True})
            else:
                _error(req_id, -32601, f"Unknown tool: {tool_name}")
        elif req_id is not None:
            _error(req_id, -32601, f"Unknown method: {method}")
