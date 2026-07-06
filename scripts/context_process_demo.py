"""ContextProcess live demo — runs OUTSIDE pytest so there's no 30s cap.

Same flow as the test, but standalone (bash: `uv run python scripts/context_process_demo.py`):
bootstrap @local + discovery, create a message carrying a random key, bind it to a
process as context, prompt a real HAIKU (model tier "sm") worker, and assert the
worker surfaces the key from its context.

Exit 0 = the worker answered with the key; exit 1 = it did not.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import sys
from pathlib import Path


async def main() -> int:
    from flow_sdk.core.capabilities.discovery import ensure_discovered
    from flow_sdk.migrations.runner import _bootstrap_local

    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.graph_context import GraphContext

    import time

    # Substrate the standalone worker needs (mirrors `flow diagnose`).
    t0 = time.monotonic()
    await _bootstrap_local()
    await ensure_discovered()
    print(f"[demo] bootstrap + discovery: {time.monotonic() - t0:.1f}s", flush=True)

    key = f"KEY-{secrets.token_hex(4).upper()}"  # random; only ever in the message body
    print(f"[demo] secret key = {key}", flush=True)

    msg = await FlowMessage(text=f"the secret key is {key}. remember it.").save()
    gc = await GraphContext(context_typeids=[str(msg.typeid)]).save()

    # model tier "sm" -> haiku (flow_sdk/builtin/agentic_process/model_tiers.py).
    # pty_mode=False -> headless print-mode worker (no PTY); prompt() then routes
    # straight to driver.headless_prompt without needing the process in the DB.
    ap = AgenticProcess(
        cli_config={"permission_mode": "bypassPermissions", "model": "sm"},
        workdir=str(Path.cwd()),
        visible=False,
        pty_mode=False,
    )
    ap.set_graph_context(gc)
    print(f"[demo] resolve_context_summary() = {await ap.resolve_context_summary()!r}", flush=True)

    async def _ask() -> str:
        res = await ap.prompt("what is the secret key in the message? answer with just the key.")
        print(f"[demo] prompt() -> {res}", flush=True)
        # Drive the turn to completion via the event stream...
        async for _entry in ap.stream_transcript():
            pass
        # ...then read the worker's ACTUAL claude JSONL transcript (where the
        # assistant answer + the injected system prompt live).
        tpath = ap.driver.transcript_path(ap)
        print(f"[demo] session_id={ap.session_id}  transcript={tpath}", flush=True)
        text = tpath.read_text(encoding="utf-8", errors="replace") if (tpath and tpath.exists()) else ""
        print(f"[demo] system-prompt injected? {'YES' if 'At creation time' in text else 'NO'}", flush=True)
        return text

    # The worker turn itself must be fast — cap it (default 5s; override to measure).
    import os
    cap = float(os.environ.get("CTX_DEMO_TIMEOUT", "5"))
    t1 = time.monotonic()
    try:
        text = await asyncio.wait_for(_ask(), timeout=cap)
    except asyncio.TimeoutError:
        print(f"[demo] worker turn exceeded {cap:.0f}s cap ({time.monotonic() - t1:.1f}s elapsed)", flush=True)
        return 1
    print(f"[demo] worker turn: {time.monotonic() - t1:.1f}s", flush=True)

    ok = key in text
    print(f"[demo] worker {'ANSWERED' if ok else 'DID NOT answer'} the key from its context", flush=True)
    if not ok:
        print(text[:1500], flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
