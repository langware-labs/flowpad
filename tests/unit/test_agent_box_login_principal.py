"""A deployed agent's box signs in against a hub that names an Identity only as a principal (FLOWPAD-2353).

Since hub release 0.29, ``/current-user`` answers an Identity's key with ``{"status": "SUCCESS", "message":
"Not a person", "data": null}`` and names it at ``/current-principal``. The box's login validates its key with
``FlowpadClient.get_user``; reading only ``/current-user`` it raised "argument of type 'NoneType' is not
iterable", so every agent box stayed signed out: its mailbox polls answered 401 and its allocation bind 409.

Nothing in the client is stubbed: a real local HTTP server plays the hub's two routes, as that hub answers them.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from flow_sdk.cloud_client import ApiConfig, FlowpadClient

IDENTITY = {"id": "5d2c4b1a-0e9f-4a8b-9c7d-6e5f4a3b2c1d", "typeid": "identity-5d2c4b1a-0e9f-4a8b-9c7d-6e5f4a3b2c1d", "type": "identity", "name": "Opening hours"}
PERSON = {"id": "7973e998-96b8-4b49-9ca6-25f4988fe192", "type": "user", "name": "Alice"}


def _hub(person: dict | None, principal: dict) -> ThreadingHTTPServer:
    class Hub(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 -- http.server's spelling
            if self.path.endswith("/current-user"):
                body = {"status": "SUCCESS", "message": "Not a person" if person is None else "Token verified successfully", "data": person}
            elif self.path.endswith("/current-principal"):
                body = {"status": "SUCCESS", "message": "Principal verified", "data": principal}
            else:
                self.send_error(404)
                return
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Hub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.agent_box_login.rules: FAILING? an agent box that never signs
#       in reads no mail and refuses its allocation - read this tag's rules first
# flowpad:endcapsule tag
@pytest.mark.parametrize(
    ("person", "principal", "expected"),
    [(None, IDENTITY, IDENTITY), (PERSON, PERSON, PERSON)],
    ids=["an agent identity", "a person"],
)
async def test_a_key_is_resolved_to_its_principal(person, principal, expected):
    hub = _hub(person, principal)
    try:
        config = ApiConfig(api_base_url=f"http://127.0.0.1:{hub.server_address[1]}/api/v1")
        async with FlowpadClient(config, api_key="fp_test_key") as client:
            assert await client.get_user() == expected
    finally:
        hub.shutdown()
