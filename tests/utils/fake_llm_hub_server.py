"""A minimal stand-in for the FlowPad hub's LLM-endpoint surface — just the two routes a
deepagents spawn actually calls: the OpenAI-compatible chat-completions invoke, and the
``chain`` action ``_fallback_model`` (``deepagents/runner.py``) reads on a rejection.

Not a mock of the WHOLE hub — only what funds one endpoint id. Configured entirely through
one JSON file (see :class:`EndpointScript`), so the two e2e scenarios that need this
(``ui/tests/e2e/llm-hub-endpoint/`` and ``ui/tests/e2e/llm-global-default/``) differ only in
what config they hand it, never in code.

Run standalone: ``python -m tests.utils.fake_llm_hub_server --config <path> --port <N>``.
Same ``ThreadingHTTPServer`` / stdlib-only shape as ``tests/utils/dummy_oauth_server.py``.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator
from urllib.parse import urlparse


@dataclass
class EndpointScript:
    """What one fake ``llm_endpoint`` id does.

    ``allowed_model`` always succeeds — the first turn gets a tool call running
    *install_command* (the REAL platform install, so the completion check the wizard runs
    afterward is genuinely satisfied, not stubbed), the second gets a closing text message.
    ``rejected_model`` (optional) fails on EVERY turn with the hub's own wording, so
    ``runner.py``'s ``_model_rejected`` matches it and the fallback-and-retry fires.
    ``chain_hops`` is served verbatim from ``GET .../chain`` — see ``_fallback_model`` for the
    shape it reads (``hops[].effective_filters.models_allow``).
    """

    allowed_model: str
    install_command: str
    tool_name: str = "execute"
    rejected_model: str | None = None
    chain_hops: list[dict[str, Any]] = field(default_factory=list)


def _rejection_body(model: str) -> dict[str, Any]:
    # The exact shape runner.py's _model_rejected looks for: the substring
    # "not allowed by endpoint" somewhere in the exception's str().
    return {
        "error": {
            "message": f"model {model} not allowed by endpoint Test budget",
            "type": "invalid_request_error",
            "code": 400,
        }
    }


def _completion_body(*, tool_call: dict[str, Any] | None, text: str | None, model: str) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant"}
    if tool_call is not None:
        message["content"] = None
        message["tool_calls"] = [tool_call]
        finish_reason = "tool_calls"
    else:
        message["content"] = text or ""
        finish_reason = "stop"
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion",
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


#: The user this fake hub says it is talking to. ``start_backend.py`` seeds the same id as the box's
#: local cloud profile, so the box's boot-time "who am I" check (``verify_current_user``) matches --
#: which is what makes a box count as signed in to FlowPad (``core.status.hub_status``).
FAKE_USER = {"type": "user", "id": "6f1a4f2e-8c5d-4c2b-9f77-2a0f5c9d3e11", "email": "e2e@fake-hub.test"}


def _ws_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    """One unmasked server frame (RFC 6455)."""
    head = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head += bytes([n])
    elif n < 1 << 16:
        head += bytes([126]) + n.to_bytes(2, "big")
    else:
        head += bytes([127]) + n.to_bytes(8, "big")
    return head + payload


def _ws_read(rfile) -> tuple[int, bytes] | None:
    """One client frame (masked), or None when the peer went away."""
    head = rfile.read(2)
    if len(head) < 2:
        return None
    opcode, n = head[0] & 0x0F, head[1] & 0x7F
    if n == 126:
        n = int.from_bytes(rfile.read(2), "big")
    elif n == 127:
        n = int.from_bytes(rfile.read(8), "big")
    mask = rfile.read(4) if head[1] & 0x80 else b"\0\0\0\0"
    data = bytearray(rfile.read(n))
    for i in range(len(data)):
        data[i] ^= mask[i % 4]
    return opcode, bytes(data)


def _handler_class(endpoints: dict[str, EndpointScript]) -> type[BaseHTTPRequestHandler]:
    class _Handler(BaseHTTPRequestHandler):
        # A WebSocket upgrade needs an HTTP/1.1 status line; every JSON reply carries a Content-Length.
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args: object) -> None:  # quiet — the test output speaks for itself
            pass

        def _send_json(self, status: int, body: dict[str, Any]) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _endpoint_id(self) -> str | None:
            # /api/v1/graph/llm_endpoint/<id>/... — the id is always the 5th path segment.
            parts = urlparse(self.path).path.strip("/").split("/")
            try:
                idx = parts.index("llm_endpoint")
            except ValueError:
                return None
            return parts[idx + 1] if idx + 1 < len(parts) else None

        def _serve_ws(self) -> None:
            """The hub socket, as much of it as a box needs: the ``ws_ready_msg`` greeting, an answer
            to "which user am I" (a ``user`` resource request), and pongs so the box's listener stays
            connected. Everything else it sends is read and dropped."""
            import base64  # noqa: PLC0415
            import hashlib  # noqa: PLC0415

            key = self.headers.get("Sec-WebSocket-Key", "")
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept.decode())
            self.end_headers()
            self.wfile.write(_ws_frame(json.dumps({"message_type": "ws_ready_msg"}).encode()))
            self.wfile.flush()
            while True:
                frame = _ws_read(self.rfile)
                if frame is None or frame[0] == 0x8:  # gone, or a close
                    return
                opcode, data = frame
                if opcode == 0x9:  # ping
                    self.wfile.write(_ws_frame(data, 0xA))
                elif opcode == 0x1:
                    try:
                        message = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if message.get("direct_resource_type") == "user":
                        reply = {"message_type": "response_msg", "content": {"status": "success", "data": FAKE_USER}}
                        self.wfile.write(_ws_frame(json.dumps(reply).encode()))
                self.wfile.flush()

        def do_GET(self) -> None:  # noqa: N802
            if self.headers.get("Upgrade", "").lower() == "websocket":
                self._serve_ws()
                return
            path = urlparse(self.path).path
            endpoint_id = self._endpoint_id()
            if path.endswith("/chain") and endpoint_id in endpoints:
                self._send_json(200, {"data": {"hops": endpoints[endpoint_id].chain_hops}})
                return
            self._send_json(404, {"error": {"message": "not found"}})

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            endpoint_id = self._endpoint_id()
            if not path.endswith("/chat/completions") or endpoint_id not in endpoints:
                self._send_json(404, {"error": {"message": "not found"}})
                return
            script = endpoints[endpoint_id]
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            model = str(body.get("model") or "")
            messages = body.get("messages") or []

            if script.rejected_model is not None and model == script.rejected_model:
                self._send_json(400, _rejection_body(model))
                return

            # Two-turn script, same shape tests/utils/deepagents_fake_model.py proves is
            # everything a single real-shell-command goal needs: a tool call, then a close.
            already_ran = any(m.get("role") == "tool" for m in messages)
            if not already_ran:
                tool_call = {
                    "id": "call_install",
                    "type": "function",
                    "function": {
                        "name": script.tool_name,
                        "arguments": json.dumps({"command": script.install_command}),
                    },
                }
                self._send_json(200, _completion_body(tool_call=tool_call, text=None, model=model))
            else:
                self._send_json(200, _completion_body(tool_call=None, text="Installed.", model=model))

    return _Handler


@contextmanager
def fake_llm_hub_server(endpoints: dict[str, EndpointScript], *, port: int = 0) -> Iterator[str]:
    """Run the fake hub for the duration of the block. Yields its base URL
    (``http://127.0.0.1:<port>`` — set ``FLOWPAD_HUB_URL`` to exactly this)."""
    httpd = ThreadingHTTPServer(("127.0.0.1", port), _handler_class(endpoints))
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def _load_config(path: str) -> dict[str, EndpointScript]:
    raw = json.loads(open(path, encoding="utf-8").read())
    return {
        endpoint_id: EndpointScript(
            allowed_model=cfg["allowed_model"],
            install_command=cfg["install_command"],
            tool_name=cfg.get("tool_name", "execute"),
            rejected_model=cfg.get("rejected_model"),
            chain_hops=cfg.get("chain_hops", []),
        )
        for endpoint_id, cfg in raw.items()
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config", required=True, help="JSON file: {endpoint_id: {allowed_model, install_command, ...}}"
    )
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--port-file", help="Write the bound port here once listening (0 = OS-chosen)")
    args = parser.parse_args()

    endpoints = _load_config(args.config)
    with fake_llm_hub_server(endpoints, port=args.port) as base_url:
        port = base_url.rsplit(":", 1)[-1]
        print(f"fake_llm_hub_server listening on {base_url}", flush=True)
        if args.port_file:
            open(args.port_file, "w", encoding="utf-8").write(port)
        while True:
            time.sleep(3600)


if __name__ == "__main__":
    main()
