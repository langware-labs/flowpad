"""One real agent on every message channel at once, validated live on its deployment's threads.

A running backend (``--backend``) and the channel doubles (``tests/e2e/channel_doubles.py``, at
``--control``). This makes an agent with a real worker, runs it locally (its deployment's own loop
process), gives it one source per channel over that channel's double — plus its deployment's own
``http_chat`` — each with a thread timeout, and then runs every channel's conversation AT ONCE,
staggered so the channels are always at different steps::

    1. remember   "Remember the code word <W>."            → the agent answers, on the channel
    2. recall     "What is the code word?"  (same thread)  → <W>, and no other channel's word
    3. timeout    quiet past the thread timeout, ask again  → a NEW thread, where the agent does not know

What it checks, per channel, from the outside only — what the channel's double saw sent, and the
deployment's ``threads`` (what the page shows):

* each answer left through its own channel, and a conversation never leaks another channel's word;
* while the agent works a thread reads ``working``; the first thread reads ``ended`` after the timeout
  and the question after it opened a second thread on the same source.

    FLOW_INSTANCE=mix-7 FLOWPAD_HUB_URL=http://localhost:8093 uv run python tests/e2e/deployment_channels_mix.py \\
        --backend http://localhost:6007 --control http://127.0.0.1:<port> [--timeout 90] [--report out.json] \\
        [--watch http://localhost:5007 --watch-out <dir>]

``cloud_email`` needs the hub (the agent's mailbox is allocated there); the doubles host runs with
``--own-credentials`` so the channels' credentials are declared in this run's project.

Prints one JSON line per step as it happens, and the report at the end; exits non-zero on a failure.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import httpx

from flow_sdk.utils.serialization import iso_to_utc

#: One code word per channel — distinct, so a leak between conversations is visible.
WORDS = ("PELICAN", "TANGERINE", "GLACIER", "SAXOPHONE", "LANTERN", "CACTUS", "NEBULA", "WALRUS", "ORIGAMI", "HAMMOCK")
SYSTEM_PROMPT = (
    "You are Mix, a test agent answering on many channels. Follow each instruction literally and answer in "
    "one short line, with no other text."
)
REMEMBER = "Remember this code word: {word}. Reply with exactly: OK {word}"
#: The run's own project is named so; cleanup removes a folder only by this name.
PROJECT_PREFIX = "mix-e2e-"
RECALL = "What is the code word I gave you in this conversation? Reply with only the word, or UNKNOWN if I gave you none."


def log(**event: Any) -> None:
    print(json.dumps({"t": time.strftime("%H:%M:%S"), **event}), flush=True)


@dataclass
class Channel:
    provider: str
    word: str
    source_id: str = ""
    #: When the run bound the channel: a thread that started before is the channel's past — shown on
    #: the page, never answered — and not one of this run's.
    bound: Optional[datetime] = None
    thread: Optional[str] = None
    answers: dict = field(default_factory=dict)
    failures: list = field(default_factory=list)
    timings: dict = field(default_factory=dict)
    #: step → whether the page showed the channel's thread ``working`` while that step's turn ran.
    seen_working: dict = field(default_factory=dict)


class Mix:
    def __init__(self, backend: str, control: str, timeout: int, answer_budget: float) -> None:
        self.api = httpx.AsyncClient(base_url=backend.rstrip("/") + "/api/v1", timeout=60)
        self.control = httpx.AsyncClient(base_url=control.rstrip("/"), timeout=60)
        self.timeout, self.answer_budget = timeout, answer_budget
        self.agent_id = self.deployment_id = self.chat_endpoint = self.project_id = ""
        self.source_ids: list[str] = []
        #: source id → the moments its thread read ``working`` (``watch_statuses``), and how long each read took
        self.working: dict[str, list[float]] = {}
        self.read_seconds: list[float] = []

    async def graph(self, method: str, path: str, **kw) -> Any:
        r = await self.api.request(method, f"/graph/{path}", **kw)
        body = r.json()
        if r.status_code >= 400 or body.get("status") == "FAIL":
            raise RuntimeError(f"{method} {path}: {r.status_code} {body.get('message') or body}")
        return body.get("data")

    # ── setup ────────────────────────────────────────────────────────────────
    async def setup(self, providers: list[str]) -> list[Channel]:
        """A project of its own, holding the agent, its channels and their credentials — nothing of
        the test lands in the user scope, and :meth:`cleanup` takes it all away."""
        boot = await self.graph("get", "bootstrap")
        user = boot.get("user") or boot.get("someone") or {}
        user_id = user.get("id") if isinstance(user, dict) else str(user)
        project = await self.graph("post", f"user/{user_id}/project", json={"name": f"{PROJECT_PREFIX}{uuid.uuid4().hex[:6]}"})
        self.project_id = project["id"]
        agent = await self.graph("post", f"project/{self.project_id}/agent", json={
            "name": "Mix", "worker_type": "claude", "system_prompt": SYSTEM_PROMPT})
        self.agent_id = agent["id"]
        deployed = await self.graph("post", f"agent/{self.agent_id}/deploy", json={"provider": "local"})
        self.deployment_id = deployed["deployment"]["id"]
        log(step="agent", agent_id=self.agent_id, deployment_id=self.deployment_id)

        mailbox_source = await self.agent_mailbox() if "cloud_email" in providers else ""
        doubles = (await self.control.get("/channels")).json()
        channels = [Channel(p, WORDS[i]) for i, p in enumerate(["http_chat", *[p for p in providers if p in doubles]])]
        for channel in channels:
            channel.bound = datetime.now(timezone.utc)
            if channel.provider in ("http_chat", "cloud_email"):  # born with the agent: its chat, its mailbox
                channel.source_id = await self.chat_source() if channel.provider == "http_chat" else mailbox_source
                await self.graph("patch", f"data_source/{channel.source_id}", json={"thread_timeout_seconds": self.timeout})
                continue
            entry = doubles[channel.provider]
            if entry.get("credential"):  # a named credential: declared in this project, never the user's
                credential = entry["credential"]
                await self.graph("post", "compute_node/@local/credentials/save", json={
                    "scope": "project", "project_id": self.project_id, "values": credential["values"],
                    "manifest": {"name": credential["name"], "value_store": "vault", "setup": "Planted by the channels mix.",
                                 "vars": {var: {"label": var, "secret": True, "required": True} for var in credential["values"]}},
                })
            body = {
                "name": f"Mix {channel.provider}", "provider": channel.provider, "config": entry["config"],
                "owner": f"agent-{self.agent_id}", "allowed_senders": [entry["sender"]],
                "thread_timeout_seconds": self.timeout, **(entry.get("fields") or {}),
                # A pulled channel is read at its interval (a fast-lane driver sooner): the floor, 60s.
                "poll_interval_seconds": 60,
            }
            if entry.get("secret_store"):
                body["secret_store"] = entry["secret_store"]
            source = await self.graph("post", f"project/{self.project_id}/data_source", json=body)
            channel.source_id = source["id"]
            row = await self.verify(channel)
            if row.get("status") == "setup":  # waiting on the person (a QR to scan): they do it, and verify again
                if (await self.control.post("/pair", json={"channel": channel.provider})).json().get("paired"):
                    row = await self.verify(channel)
            if row.get("status") != "active":
                raise RuntimeError(f"{channel.provider}: {row.get('status')} after verify — {row.get('setup_detail')}")
            await self.graph("post", f"data_source/{channel.source_id}/sync", json={})  # what the double holds now is history
        self.source_ids = [c.source_id for c in channels]
        log(step="channels", channels={c.provider: c.source_id for c in channels})
        return channels

    async def agent_mailbox(self) -> str:
        """Agent email: the hub allocates the agent an address; an outsider's mailbox (the double,
        opened through the instance) writes to it and is the one sender admitted."""
        state = await self.graph("post", f"agent/{self.agent_id}/allocate_mailbox", json={})
        address = (state.get("mailbox") or {}).get("address") or ""
        if not address:
            raise RuntimeError("the hub allocated no mailbox address (is AGENT_MAILBOX_ENABLED on?)")
        outsider = (await self.control.post("/agent_mailbox", json={"agent_id": self.agent_id, "address": address})).json()
        if "error" in outsider:
            raise RuntimeError(f"agent mailbox double: {outsider['error']}")
        await self.graph("post", f"agent/{self.agent_id}/configure_mailbox", json={
            "allowed_senders": [outsider["outsider_address"]], "poll_interval_seconds": 60})
        mailbox = next((src for src in state.get("sources") or [] if src.get("provider") == "cloud_email"), None)
        if mailbox is None:
            raise RuntimeError(f"no cloud_email source among the agent's: {state.get('sources')}")
        return mailbox["id"]

    async def verify(self, channel: Channel) -> dict:
        await self.graph("post", f"data_source/{channel.source_id}/verify", json={})
        return await self.graph("get", f"data_source/{channel.source_id}")

    async def chat_source(self) -> str:
        """The deployment's own chat: its ``chat`` endpoint, and the http_chat source it answers."""
        endpoints = await self.graph("get", f"deployment/{self.deployment_id}/endpoints")
        rows = endpoints if isinstance(endpoints, list) else endpoints.get("endpoints") or endpoints.get("items") or []
        chat = next(e for e in rows if e.get("name") == "chat")
        self.chat_endpoint = chat["id"]
        for _ in range(100):
            sources = await self.graph("get", "data_source")
            rows = sources if isinstance(sources, list) else sources.get("items") or []
            found = next((s for s in rows if s.get("provider") == "http_chat" and s.get("owner") == f"agent-{self.agent_id}"), None)
            if found:
                return found["id"]
            await asyncio.sleep(0.2)
        raise RuntimeError("the deployment's http_chat source never appeared")

    # ── one message, one answer ──────────────────────────────────────────────
    async def ask(self, channel: Channel, text: str) -> str:
        """Say *text* on the channel and return the agent's answer, as the channel saw it leave."""
        if channel.provider == "http_chat":
            body: dict = {"model": "agent", "messages": [{"role": "user", "content": text}]}
            if channel.thread:
                body["metadata"] = {"conversation_id": channel.thread}
            r = await self.api.post(f"/graph/service_endpoint/{self.chat_endpoint}/service/v1/chat/completions",
                                    json=body, timeout=self.answer_budget)
            r.raise_for_status()
            reply = r.json()
            channel.thread = (reply.get("flowpad") or {}).get("conversation_id") or channel.thread
            return reply["choices"][0]["message"]["content"]
        before = len((await self.control.get("/sent", params={"channel": channel.provider})).json())
        delivered = (await self.control.post("/deliver", json={
            "channel": channel.provider, "text": text, "thread": channel.thread})).json()
        if "error" in delivered or delivered.get("webhook_status", 200) >= 300:
            raise RuntimeError(f"delivery failed: {delivered}")
        channel.thread = channel.thread or delivered.get("thread")
        deadline = time.monotonic() + self.answer_budget
        while time.monotonic() < deadline:
            sent = (await self.control.get("/sent", params={"channel": channel.provider})).json()
            if len(sent) > before:
                # The newest post: a reply that went anywhere else still fails the word check below.
                return str(sent[-1].get("text") or "")
            await asyncio.sleep(0.5)
        raise TimeoutError(f"no answer left {channel.provider} in {self.answer_budget:.0f}s")

    # ── what the page shows ──────────────────────────────────────────────────
    async def threads(self) -> list[dict]:
        data = await self.graph("get", f"deployment/{self.deployment_id}/threads")
        return data.get("threads") or []

    async def threads_of(self, channel: Channel) -> list[dict]:
        mine = [t for t in await self.threads()
                if t["data_source_id"] == channel.source_id and iso_to_utc(t["started_at"]) >= channel.bound - timedelta(seconds=2)]
        return sorted(mine, key=lambda t: t["started_at"] or "")

    async def watch_statuses(self) -> None:
        """ONE reader of what the page shows, for every channel: each time a source's thread reads
        ``working``, noted with the moment (a reader per channel would be N times the load on the
        endpoint it measures)."""
        while True:
            started = time.monotonic()
            try:
                for thread in await self.threads():
                    if thread["status"] == "working":
                        self.working.setdefault(thread["data_source_id"], []).append(time.monotonic())
            except Exception as exc:  # noqa: BLE001 — a missed read is a gap, not a failure
                log(step="watch_statuses", error=str(exc))
            self.read_seconds.append(time.monotonic() - started)
            await asyncio.sleep(0.5)

    async def step(self, channel: Channel, name: str, text: str) -> str:
        started = time.monotonic()
        answer = await self.ask(channel, text)
        ended = time.monotonic()
        channel.timings[name] = round(ended - started, 1)
        channel.answers[name] = answer
        channel.seen_working[name] = any(started <= t <= ended for t in self.working.get(channel.source_id, []))
        self.expect(channel, channel.seen_working[name], f"{name}: the page never showed the thread working")
        log(channel=channel.provider, step=name, seconds=channel.timings[name], answer=answer[:120])
        return answer

    # ── one channel's conversation ───────────────────────────────────────────
    async def converse(self, channel: Channel, others: list[str], delay: float) -> None:
        await asyncio.sleep(delay)
        try:
            ok = await self.step(channel, "remember", REMEMBER.format(word=channel.word))
            self.expect(channel, channel.word in ok.upper(), f"remember: the answer {ok!r} does not repeat {channel.word}")

            recalled = (await self.step(channel, "recall", RECALL)).upper()
            self.expect(channel, channel.word in recalled, f"recall: {recalled!r} is not {channel.word}")
            leaked = [w for w in others if w in recalled]
            self.expect(channel, not leaked, f"recall: another channel's word leaked in: {leaked}")
            first = await self.threads_of(channel)
            self.expect(channel, len(first) == 1, f"one thread before the timeout, found {len(first)}")

            await asyncio.sleep(self.timeout + 5)
            ended = await self.threads_of(channel)
            self.expect(channel, ended and ended[-1]["status"] == "ended", f"after {self.timeout}s of quiet the thread reads {ended and ended[-1]['status']}")

            after = (await self.step(channel, "after_timeout", RECALL)).upper()
            self.expect(channel, channel.word not in after, f"after the timeout the agent still knew {channel.word}: {after!r}")
            # The answer left the channel; the page shows it once its record is projected — moments later.
            threads = await self.settled(channel, lambda ts: len(ts) == 2 and ts[-1]["messages"] >= 2)
            self.expect(channel, len(threads) == 2, f"two threads after the timeout, found {len(threads)}")
            if len(threads) == 2:
                old, new = threads
                self.expect(channel, old["status"] == "ended" and old["messages"] >= 4, f"first thread: {old['status']}, {old['messages']} messages")
                self.expect(channel, new["messages"] >= 2, f"second thread: {new['messages']} messages")
        except Exception as exc:  # noqa: BLE001 — one channel's failure is reported, the others run on
            self.expect(channel, False, f"{type(exc).__name__}: {exc}")

    async def report(self, channels: list[Channel]) -> dict:
        return {
            "project_id": self.project_id, "agent_id": self.agent_id, "deployment_id": self.deployment_id, "timeout": self.timeout,
            "channels": {c.provider: {"ok": not c.failures, "word": c.word, "answers": c.answers, "timings": c.timings,
                                      "seen_working": c.seen_working, "failures": c.failures} for c in channels},
            "threads": await self.threads(),
            "threads_read_seconds": {"reads": len(self.read_seconds), "max": round(max(self.read_seconds, default=0), 2),
                                     "mean": round(sum(self.read_seconds) / max(1, len(self.read_seconds)), 2)},
        }

    async def cleanup(self) -> None:
        """Stop the agent's process and remove everything the run made: its channels, the agent, the
        project, and the project's folder (its assets and credentials live there, and deleting the
        project row leaves them on disk)."""
        if self.deployment_id:
            await self.api.post(f"/graph/deployment/{self.deployment_id}/pause", json={})
        for source_id in self.source_ids:
            await self.api.delete(f"/graph/data_source/{source_id}")
        if self.agent_id:
            await self.api.delete(f"/graph/agent/{self.agent_id}")
        if self.project_id:
            project = await self.graph("get", f"project/{self.project_id}")
            folder = Path(str(project.get("fs_storage_mount_path") or ""))
            await self.api.delete(f"/graph/project/{self.project_id}")
            if folder.name.startswith(PROJECT_PREFIX) and folder.is_dir():
                shutil.rmtree(folder)
        log(step="cleanup", project_id=self.project_id)

    async def settled(self, channel: Channel, done, budget: float = 15.0) -> list[dict]:
        """The channel's threads once *done* holds for them (or as they are when *budget* runs out)."""
        deadline = time.monotonic() + budget
        while True:
            threads = await self.threads_of(channel)
            if done(threads) or time.monotonic() >= deadline:
                return threads
            await asyncio.sleep(0.5)

    @staticmethod
    def expect(channel: Channel, ok: bool, what: str) -> None:
        if not ok:
            channel.failures.append(what)
            log(channel=channel.provider, failure=what)


async def watch(frontend: str, mix: Mix, out: Path):
    """The browser watching the deployment's page, as a child process (``deployment_page_watch.cjs``)."""
    out.mkdir(parents=True, exist_ok=True)
    (out / "stop").unlink(missing_ok=True)
    script = Path(__file__).with_name("deployment_page_watch.cjs")
    log(step="watch", out=str(out))
    return await asyncio.create_subprocess_exec(
        "node", str(script), frontend, mix.agent_id, mix.deployment_id, str(out), str(out / "stop"),
        stdout=open(out / "watch.log", "w"), stderr=asyncio.subprocess.STDOUT,
    )


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True)
    parser.add_argument("--control", required=True)
    parser.add_argument("--channels", default="gmail,slack,whatsapp,waha,telegram,teams,agentmail,cloud_email")
    parser.add_argument("--timeout", type=int, default=90, help="each source's thread_timeout_seconds")
    parser.add_argument("--answer-budget", type=float, default=240, help="how long one real turn may take to answer")
    parser.add_argument("--stagger", type=float, default=4, help="seconds between channels' starts")
    parser.add_argument("--report")
    parser.add_argument("--keep", action="store_true", help="leave the project, agent and channels in place (to look at the page)")
    parser.add_argument("--watch", help="a frontend URL: watch the deployment's page in a browser meanwhile (deployment_page_watch.cjs)")
    parser.add_argument("--watch-out", default="deployment-mix-watch", help="where the browser's video, shots and thread pages go")
    args = parser.parse_args()

    mix = Mix(args.backend, args.control, args.timeout, args.answer_budget)
    watcher = None
    try:
        channels = await mix.setup([c for c in args.channels.split(",") if c])
        if args.watch:
            watcher = await watch(args.watch, mix, Path(args.watch_out))
        words = [c.word for c in channels]
        statuses = asyncio.create_task(mix.watch_statuses())
        await asyncio.gather(*(
            mix.converse(c, [w for w in words if w != c.word], i * args.stagger) for i, c in enumerate(channels)
        ))
        statuses.cancel()
        report = await mix.report(channels)
        log(step="finished", ok=[c.provider for c in channels if not c.failures])
    finally:
        if watcher is not None:  # the page is read to the end — each thread opened — before anything goes
            await asyncio.sleep(5)  # the last answer's lines reach the page just after the runner sees it
            (Path(args.watch_out) / "stop").touch()
            await watcher.wait()
        if not args.keep:
            await mix.cleanup()
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
    log(step="done", ok=[c.provider for c in channels if not c.failures], failed=[c.provider for c in channels if c.failures])
    return 0 if all(not c.failures for c in channels) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
