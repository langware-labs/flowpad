"""``flow hooks report`` must read Claude Code's hook payload as UTF-8.

Claude Code writes the hook payload to the handler's stdin as UTF-8. On Windows a
piped stdin is decoded with the ANSI code page (cp1252) and ``surrogateescape``
(CPython's Windows stdio default), so Hebrew arrives as mojibake with lone
surrogates for the bytes cp1252 leaves undefined (ם = D7 9D → ``\\udc9d``). The
question then lands in ``context_data.pending_user_input`` and the process can no
longer be served: ``'utf-8' codec can't encode character '\\udc9d'``.

``PYTHONIOENCODING=cp1252:surrogateescape`` gives the child exactly the stdio a
Windows pipe gets, so the test reproduces the platform on any OS.
"""

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from flow_sdk.api.api_types.identifier import mint_uuid

QUESTION = "תשלום לשיעורי פיזיקה – איזה אמצעי תשלום?"


class _Capture(BaseHTTPRequestHandler):
    bodies: list[bytes] = []

    def do_POST(self):  # noqa: N802
        _Capture.bodies.append(self.rfile.read(int(self.headers["Content-Length"])))
        body = b'{"status":"SUCCESS","data":{}}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def test_hook_report_reads_a_windows_piped_stdin_as_utf8(tmp_path):
    server = HTTPServer(("127.0.0.1", 0), _Capture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    instance = tmp_path / "flow home" / "instances" / "hooktest"
    instance.mkdir(parents=True)
    (instance / "server.json").write_text(json.dumps({"port": server.server_port}))
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "AskUserQuestion",
        "tool_use_id": "toolu_1",
        "tool_input": {"questions": [{"question": QUESTION}]},
    }
    env = {
        **os.environ,
        "FLOW_HOME": str(tmp_path / "flow home"),
        "FLOW_INSTANCE": "hooktest",
        "FLOWPAD_SKIP_DOTENV": "true",
        "PYTHONIOENCODING": "cp1252:surrogateescape",
    }
    try:
        subprocess.run(
            [
                sys.executable,
                "-c",
                "from flow_sdk.cli import cli_main; cli_main()",
                "hooks",
                "report",
                "--process-id",
                str(mint_uuid()),
            ],
            input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            env=env,
            check=True,
        )
    finally:
        server.shutdown()

    (body,) = _Capture.bodies
    raw = json.loads(body)["webhook_payload"]["hook_data"]["raw_hook_data"]
    question = raw["tool_input"]["questions"][0]["question"]
    question.encode("utf-8")  # what the backend's JSONResponse does with it
    assert question == QUESTION
