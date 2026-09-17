"""The message-channel doubles as ONE process a running backend can talk to.

Every shipped message driver ships a ``Double`` in its ``tests/matrix.py`` (a loopback provider with an
inbound you can inject and the outbound it saw). This hosts them all for a browser test: it enters each
Double, plants the credentials the backend will resolve them with, and serves a small control API::

    FLOW_INSTANCE=mx-8 FLOWPAD_HUB_URL=http://localhost:8093 uv run python tests/e2e/channel_doubles.py --backend http://localhost:6009

    GET  /channels                          {provider: {config, fields, secret_store?, sender, agent_only}}
    POST /deliver   {channel, text, sender?} → the delivery (a webhook delivery is POSTed to the backend here)
    GET  /sent?channel=<provider>           → [{to, text, thread, external_id}]
    POST /agent_mailbox {agent_id, address} → {outsider_address}   (agent email: the outsider that writes in)
    POST /shutdown

It prints one JSON line ``{"control": "http://127.0.0.1:<port>"}`` once everything is up. Nothing
provider-specific lives here: the driver folders answer through their Doubles, and the credential shapes
come from each ``data_driver.json``. Run it with ``FLOW_INSTANCE=<name>`` so the in-process pieces (a
connector token, the hub mailbox) address the same instance the backend runs.
"""
from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module, read_manifest  # noqa: E402
from flow_sdk.ingest.testing import local_http_server  # noqa: E402
from tests.unit._stream_inbox_matrix import CHANNELS  # noqa: E402

CREDENTIALS = "/api/v1/graph/compute_node/@local/credentials"


class Doubles:
    def __init__(self, backend: str, tmp: Path) -> None:
        self.backend, self.tmp = backend.rstrip("/"), tmp
        self.doubles: dict[str, Any] = {}
        self.stores: dict[str, dict] = {}
        #: ``(kind, key)`` to undo at shutdown: a credential's typeid, a connector's name.
        self.planted: list[tuple[str, str]] = []
        self.loop = asyncio.new_event_loop()
        self.http = httpx.AsyncClient(base_url=self.backend, timeout=30)

    def run(self, coroutine):
        return self.loop.run_until_complete(coroutine)

    # ── lifecycle ────────────────────────────────────────────────────────────
    def start(self) -> None:
        for provider in CHANNELS:
            module = load_module(SHIPPED_ROOT / provider / "tests", "matrix")
            if getattr(module.Double, "agent_only", False):
                continue  # opened per agent, through /agent_mailbox
            self.doubles[provider] = module.Double().__enter__()
        self.run(self.plant_all())

    def stop(self) -> None:
        for kind, key in reversed(self.planted):
            try:
                self.run(self.unplant(kind, key))
            except Exception as exc:  # noqa: BLE001 — teardown
                print(json.dumps({"warning": f"cleanup of {kind} {key} failed: {exc}"}), flush=True)
        for double in self.doubles.values():
            self.run(self.call(double.close)) if hasattr(double, "close") else double.__exit__(None, None, None)
        self.run(self.http.aclose())

    # ── credentials, by the manifest's auth shape ───────────────────────────
    async def plant_all(self) -> None:
        await asyncio.gather(*(self.plant(provider, double) for provider, double in self.doubles.items()))

    async def plant(self, provider: str, double) -> None:
        auth = read_manifest(SHIPPED_ROOT / provider).auth
        secrets = dict(getattr(double, "secrets", {}) or {})
        if auth is None:
            return
        if auth.credential:
            values = {auth.vars[key]: value for key, value in secrets.items() if key in auth.vars}
            status = (await self.http.get(f"{CREDENTIALS}/status")).json().get("data") or {}
            existing = next((c for c in status.get("credentials") or [] if c.get("name") == auth.credential and c.get("scope") == "user"), None)
            if existing is not None:
                # Already declared on this instance (a previous run's, or the person's own): set the
                # double's values and leave the declaration in place.
                (await self.http.post(f"{CREDENTIALS}/values", json={"typeid": existing["typeid"], "values": values})).raise_for_status()
                return
            saved = await self.http.post(f"{CREDENTIALS}/save", json={
                "scope": "user",
                "manifest": {"name": auth.credential, "value_store": "vault",
                             "vars": {var: {"label": var, "secret": True, "required": True} for var in auth.vars.values()}},
                "values": values,
            })
            saved.raise_for_status()
            self.planted.append(("credential", str((saved.json().get("data") or {}).get("typeid") or "")))
        elif auth.connector:
            await self.plant_connector(auth.connector, secrets.get("token", ""))
        elif auth.env:
            path = self.tmp / f"{provider}.env"
            path.write_text("".join(f"{name}={secrets.get(name, '')}\n" for name in auth.env), encoding="utf-8")
            self.stores[provider] = {"type": "env_file", "config": {"env_file_path": str(path)}}

    async def plant_connector(self, provider: str, token: str) -> None:
        """The machine's connection for ``provider``: written where ``credential_for`` reads it."""
        from flow_sdk.builtin.user import User  # noqa: PLC0415
        from flow_sdk.core.oauth.provider_registry import user_credentials_name  # noqa: PLC0415
        from flow_sdk.request_context.methods import set_user_credentials  # noqa: PLC0415

        user = await User.get_local()
        name = user_credentials_name(provider)
        if user is None or not name:
            raise RuntimeError(f"cannot plant a {provider} connection: local user {user!r}, credential {name!r}")
        await set_user_credentials(user, name, {"access_token": token, "token_type": "bearer"}, str(user.id))
        self.planted.append(("connector", name))

    async def unplant(self, kind: str, key: str) -> None:
        if kind == "credential" and key:
            await self.http.post(f"{CREDENTIALS}/delete", json={"typeid": key})
        elif kind == "connector":
            from flow_sdk.builtin.user import User  # noqa: PLC0415
            from flow_sdk.request_context.methods import delete_user_credentials  # noqa: PLC0415

            user = await User.get_local()
            await delete_user_credentials(user, key, str(user.id))

    # ── the control API ─────────────────────────────────────────────────────
    async def call(self, fn, *args, **kwargs):
        """A Double's verb, whether it is sync (a loopback server) or async (the hub)."""
        out = fn(*args, **kwargs)
        return await out if inspect.isawaitable(out) else out

    def channels(self) -> dict:
        out = {}
        for provider, double in self.doubles.items():
            entry = {"config": dict(double.config), "fields": dict(getattr(double, "fields", {}) or {}),
                     "sender": double.sender, "agent_only": bool(getattr(double, "agent_only", False))}
            if provider in self.stores:
                entry["secret_store"] = self.stores[provider]
            if hasattr(double, "handshake"):
                entry["handshake"] = double.handshake()
            out[provider] = entry
        return out

    def deliver(self, channel: str, text: str, sender: str | None) -> dict:
        double = self.doubles[channel]
        delivered = self.run(self.call(double.deliver, text, sender=sender or double.sender))
        if delivered.get("path"):
            r = self.run(self.http.post(delivered["path"], content=delivered["body"], headers={**delivered["headers"], "Content-Type": "application/json"}))
            delivered = {"external_id": delivered["external_id"], "thread": delivered["thread"], "webhook_status": r.status_code, "webhook_body": r.text[:200]}
        return delivered

    def sent(self, channel: str) -> list[dict]:
        return self.run(self.call(self.doubles[channel].sent))

    def agent_mailbox(self, agent_id: str, address: str) -> dict:
        """Agent email: the outsider mailbox that writes to ``address``, opened through the instance."""
        module = load_module(SHIPPED_ROOT / "cloud_email" / "tests", "matrix")
        double = module.HubDouble(agent_id=agent_id, address=address)
        self.run(double.open(self.backend))
        self.doubles["cloud_email"] = double
        return {"outsider_address": double.outsider_address}


def serve(doubles: Doubles) -> None:
    """The control API on a loopback port, until ``/shutdown``."""
    lock = threading.Lock()
    stop = threading.Event()

    def reply(status: int, payload: Any):
        return status, json.dumps(payload).encode(), {"Content-Type": "application/json"}

    def respond(path: str, headers) -> tuple:
        url = urlparse(path)
        body = json.loads(headers["_body"]) if headers.get("_body") else {}
        with lock:
            try:
                if url.path == "/channels":
                    return reply(200, doubles.channels())
                if url.path == "/sent":
                    return reply(200, doubles.sent((parse_qs(url.query).get("channel") or [""])[0]))
                if url.path == "/deliver":
                    return reply(200, doubles.deliver(body["channel"], body["text"], body.get("sender")))
                if url.path == "/agent_mailbox":
                    return reply(200, doubles.agent_mailbox(body["agent_id"], body["address"]))
                if url.path == "/shutdown":
                    stop.set()
                    return reply(200, {"ok": True})
            except Exception as exc:  # noqa: BLE001 — reported to the caller, never swallowed
                return reply(500, {"error": f"{type(exc).__name__}: {exc}"})
        return reply(404, {"error": "no such route"})

    with local_http_server(respond) as control:
        print(json.dumps({"control": control}), flush=True)
        stop.wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True)
    args = parser.parse_args()
    doubles = Doubles(args.backend, Path(tempfile.mkdtemp(prefix="channel-doubles-")))
    doubles.start()
    try:
        serve(doubles)
    finally:
        doubles.stop()


if __name__ == "__main__":
    main()
