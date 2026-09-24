"""An agent answers on WhatsApp through WAHA — the demo, from scratch, checked from the outside.

    1. an agent whose instructions hold a serial number made for this run   (SN-<8 hex>)
    2. its own WAHA channel (a real WAHA server, or the loopback WAHA double)
    3. "what is the serial number?" on WhatsApp → the agent answers the serial, on WhatsApp

What it checks: the channel verifies ``active`` (WAHA's session is WORKING); the answer holds the
serial — which exists nowhere but this run's system prompt; the answer left through WAHA (the double
saw ``sendText`` / the deployment's timeline holds the ``reply_sent``); the deployment's page showed
the thread ``working`` during the turn. ``--watch`` records the page in a browser
(``deployment_page_watch.cjs``) and writes what ``deployment_console_check.py`` reads.

Double (repeatable)::

    FLOW_INSTANCE=wa-3 uv run python tests/e2e/channel_doubles.py --backend http://localhost:6003 --channels waha --own-credentials
    FLOW_INSTANCE=wa-3 uv run python tests/e2e/whatsapp_serial_demo.py --backend http://localhost:6003 --double http://127.0.0.1:<port>

Real WAHA (``docker start waha``, its ``default`` session paired to the agent's number; the question is
sent by a person from WhatsApp — the run prints SEND NOW and waits)::

    FLOW_INSTANCE=wa-3 uv run python tests/e2e/whatsapp_serial_demo.py --backend http://localhost:6003 --real \\
        --sender <digits or id@lid> [--waha http://localhost:3010] [--watch http://localhost:5003 --watch-out <dir>] [--keep]

The real WAHA credential (``WAHA_API_KEY``, ``WAHA_WEBHOOK_HMAC``) is read from ``.env.local`` and
declared in the run's own project; it is never printed. Exits non-zero on a failure.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))
from deployment_channels_mix import Channel, Mix, log, watch  # noqa: E402

QUESTION = "What is the serial number?"
SYSTEM_PROMPT = (
    "You are Serial, a device support agent answering on WhatsApp. The device's serial number is {serial}. "
    "When someone asks for the serial number, answer in one short line that includes it exactly as written."
)
PROJECT_PREFIX = "wa-serial-"
WAHA_VARS = ("WAHA_API_KEY", "WAHA_WEBHOOK_HMAC")


def env_values(names: tuple[str, ...]) -> dict[str, str]:
    """``NAME=value`` lines of the repo's ``.env.local`` (a space before ``=`` allowed, as the product reads it)."""
    found: dict[str, str] = {}
    for line in (Path(__file__).parents[2] / ".env.local").read_text().splitlines():
        name, sep, value = line.partition("=")
        if sep and name.strip() in names:
            found[name.strip()] = value.strip().strip("'\"")
    missing = [n for n in names if n not in found]
    if missing:
        raise RuntimeError(f".env.local has no {', '.join(missing)}")
    return found


class Demo(Mix):
    def __init__(self, backend: str, control: Optional[str], answer_budget: float) -> None:
        super().__init__(backend, control or "http://127.0.0.1:9", timeout=0, answer_budget=answer_budget)
        self.backend = backend
        self.real = control is None
        self.serial = f"SN-{secrets.token_hex(4).upper()}"

    async def setup_agent(self) -> None:
        boot = await self.graph("get", "bootstrap")
        user = boot.get("user") or boot.get("someone") or {}
        user_id = user.get("id") if isinstance(user, dict) else str(user)
        project = await self.graph("post", f"user/{user_id}/project", json={"name": f"{PROJECT_PREFIX}{secrets.token_hex(3)}"})
        self.project_id = project["id"]
        agent = await self.graph("post", f"project/{self.project_id}/agent", json={
            "name": "Serial", "worker_type": "claude", "system_prompt": SYSTEM_PROMPT.format(serial=self.serial)})
        self.agent_id = agent["id"]
        deployed = await self.graph("post", f"agent/{self.agent_id}/deploy", json={"provider": "local"})
        self.deployment_id = deployed["deployment"]["id"]
        log(step="agent", agent_id=self.agent_id, deployment_id=self.deployment_id, serial=self.serial)

    async def setup_channel(self, waha: str, sender: Optional[str]) -> Channel:
        if self.real:
            credential = {"name": "waha", "values": env_values(WAHA_VARS)}
            port = urlparse(self.backend).port or 80
            config = {"base_url": waha, "session": "default",
                      "webhook_url": f"http://host.docker.internal:{port}/api/v1/data_source/webhook/waha"}
            senders = [sender]
        else:
            entry = (await self.control.get("/channels")).json()["waha"]
            credential, config, senders = entry["credential"], entry["config"], [entry["sender"]]
        await self.graph("post", "compute_node/@local/credentials/save", json={
            "scope": "project", "project_id": self.project_id, "values": credential["values"],
            "manifest": {"name": credential["name"], "value_store": "vault", "setup": "Declared by the WhatsApp serial demo.",
                         "vars": {var: {"label": var, "secret": True, "required": True} for var in credential["values"]}},
        })
        channel = Channel("waha", self.serial, bound=datetime.now(timezone.utc))
        source = await self.graph("post", f"project/{self.project_id}/data_source", json={
            "name": "Serial WhatsApp", "provider": "waha", "config": config,
            "owner": f"agent-{self.agent_id}", "inbound_allowed_senders": senders,
        })
        channel.source_id = source["id"]
        self.source_ids = [channel.source_id]
        row = await self.verify(channel)
        if row.get("status") == "setup":
            if self.real:  # a QR to scan, on the agent's phone — the person does it, the run waits
                log(step="pair", detail=row.get("setup_detail"), qr=f"{waha}/api/default/auth/qr")
                for _ in range(120):
                    await asyncio.sleep(5)
                    row = await self.verify(channel)
                    if row.get("status") != "setup":
                        break
            elif (await self.control.post("/pair", json={"channel": "waha"})).json().get("paired"):
                row = await self.verify(channel)
        if row.get("status") != "active":
            raise RuntimeError(f"waha: {row.get('status')} after verify — {row.get('setup_detail')}")
        await self.graph("post", f"data_source/{channel.source_id}/sync", json={})  # what is there now is history
        # The mix's run.log shape — deployment_console_check.py reads it.
        log(step="channels", channels={"waha": channel.source_id}, status=row.get("status"), detail=row.get("setup_detail"))
        return channel

    async def ask(self, channel: Channel, text: str) -> str:
        if not self.real:
            return await super().ask(channel, text)
        # A person sends it from WhatsApp; the answer is the deployment's reply on the channel's thread.
        log(step="SEND NOW", text=text, to="the agent's WhatsApp number")
        deadline = time.monotonic() + self.answer_budget
        refused_seen: set[str] = set()
        while time.monotonic() < deadline:
            for thread in await self.threads_of(channel):
                page = await self.graph("get", f"deployment/{self.deployment_id}/timeline",
                                        params={"conversation": thread["conversation_id"], "limit": 50})
                for event in page.get("events") or []:
                    if event["kind"] == "refused" and event.get("text") not in refused_seen:
                        refused_seen.add(event.get("text"))  # a sender not admitted: say who, so it can be
                        log(step="refused", who=event.get("who"), text=event.get("text"))
                    if event["kind"] == "reply_sent" and datetime.fromisoformat(event["at"].replace("Z", "+00:00")) >= channel.bound:
                        channel.thread = thread["conversation_id"]
                        return str(event.get("text") or "")
            await asyncio.sleep(1)
        raise TimeoutError(f"no reply on WhatsApp in {self.answer_budget:.0f}s")

    async def run(self, channel: Channel) -> None:
        try:
            answer = await self.step(channel, "serial", QUESTION)
            self.expect(channel, self.serial in answer.upper(), f"the answer {answer!r} does not hold {self.serial}")
            threads = await self.settled(channel, lambda ts: bool(ts) and ts[-1]["messages"] >= 2)
            self.expect(channel, bool(threads) and threads[-1]["messages"] >= 2,
                        f"the page's thread: {threads and threads[-1]}")
        except Exception as exc:  # noqa: BLE001 — reported as the run's failure
            self.expect(channel, False, f"{type(exc).__name__}: {exc}")

    async def cleanup(self) -> None:
        import deployment_channels_mix as mix  # noqa: PLC0415 — cleanup removes a folder only by its prefix

        mix.PROJECT_PREFIX = PROJECT_PREFIX
        await super().cleanup()


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--double", metavar="CONTROL", help="the channel doubles' control URL (channel_doubles.py)")
    mode.add_argument("--real", action="store_true", help="a real WAHA server; a person sends the question")
    parser.add_argument("--waha", default="http://localhost:3010", help="the real WAHA server")
    parser.add_argument("--sender", help="--real: the one WhatsApp sender admitted (digits, or <id>@lid)")
    parser.add_argument("--answer-budget", type=float, default=600, help="--real includes the person's time to send")
    parser.add_argument("--report")
    parser.add_argument("--keep", action="store_true", help="leave the project, agent and channel in place")
    parser.add_argument("--watch", help="a frontend URL: record the deployment's page in a browser meanwhile")
    parser.add_argument("--watch-out", default="whatsapp-serial-watch")
    args = parser.parse_args()
    if args.real and not args.sender:
        parser.error("--real needs --sender")

    demo = Demo(args.backend, args.double, args.answer_budget)
    watcher, channel, report = None, None, {}
    try:
        await demo.setup_agent()
        channel = await demo.setup_channel(args.waha, args.sender)
        if args.watch:
            watcher = await watch(args.watch, demo, Path(args.watch_out))
            await asyncio.sleep(8)  # the page is open before the question arrives
        statuses = asyncio.create_task(demo.watch_statuses())
        await demo.run(channel)
        statuses.cancel()
        report = await demo.report([channel])
        report["serial"] = demo.serial
    finally:
        if watcher is not None:
            await asyncio.sleep(5)
            (Path(args.watch_out) / "stop").touch()
            await watcher.wait()
        if not args.keep:
            await demo.cleanup()
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2))
    ok = channel is not None and not channel.failures
    log(step="done", ok=ok, failures=channel.failures if channel else ["setup failed"])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
