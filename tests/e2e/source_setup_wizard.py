"""Run a data source's setup wizard headless, answering its questions — what a person does in the Set up dialog.

    uv run python tests/e2e/source_setup_wizard.py --backend http://localhost:6005 --source <data_source id> \\
        --answers '{"<driver>-ask-base-url": "http://127.0.0.1:41234", "<driver>-ask-api-key": "..."}' \\
        --before '<driver>-ask-pair=http://127.0.0.1:<doubles control>/pair {"channel": "<driver>"}'

The first stage the source's driver declares that is not done (``setup_stages``) is run through the same
route the dialog uses (``wizard/<id>/run`` with the source as target and ``source`` / ``owner`` as inputs,
``approved`` — the person trusts the wizard to run its steps here). Every question the run raises is
answered by its op's name from ``--answers``; ``--before op=URL JSON`` POSTs to URL first (a test double
standing in for the person's own step: a QR scanned). Prints one JSON line — the run's result and the
stages after it — and exits 0 only when the stage reads ``done``.

Nothing provider-specific lives here: the wizard, its asks and its steps are the driver's own assets.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time

import httpx


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True)
    parser.add_argument("--source", required=True, help="The data source id.")
    parser.add_argument("--answers", default="{}", help="JSON {op name: answer}.")
    parser.add_argument("--before", action="append", default=[], help="op=URL JSON — POSTed before answering op.")
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args(argv)

    answers: dict = json.loads(args.answers)
    hooks: dict[str, tuple[str, dict]] = {}
    for spec in args.before:
        op, _, rest = spec.partition("=")
        url, _, body = rest.partition(" ")
        hooks[op] = (url, json.loads(body or "{}"))

    from flow_sdk.instance_settings.cookie_gate import gate_headers  # a gated box (a sandbox) answers 403 without it

    gate = gate_headers(args.backend)
    api = httpx.Client(base_url=f"{args.backend.rstrip('/')}/api/v1", timeout=60, headers=gate)
    source = api.get(f"graph/data_source/{args.source}").json()["data"]
    stages = api.get(f"graph/data_source/{args.source}/setup_stages").json()["data"]
    stage = next((s for s in stages if s.get("state") != "done"), None)
    if stage is None:
        print(json.dumps({"stages": stages, "note": "nothing to set up"}))
        return 0
    wizards = api.get("graph/wizard", params={"include_system": "true"}).json()["data"]
    wizard = next((w for w in wizards if w.get("name") == stage["wizard"]), None)
    if wizard is None:
        print(json.dumps({"error": f"no wizard named {stage['wizard']} is installed"}))
        return 2

    result: dict = {}

    def run() -> None:
        body = {"target": f"data_source-{args.source}", "inputs": {"source": args.source, "owner": source.get("owner") or ""}, "approved": True}
        reply = httpx.post(f"{args.backend.rstrip('/')}/api/v1/graph/wizard/{wizard['id']}/run", json=body, timeout=args.timeout, headers=gate)
        result.update(reply.json())

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    answered: list[str] = []
    deadline = time.monotonic() + args.timeout
    while worker.is_alive() and time.monotonic() < deadline:
        for question in api.get("ask").json().get("data", {}).get("questions", []):
            op = question.get("op")
            if op not in answers:
                continue
            if op in hooks:
                url, body = hooks[op]
                httpx.post(url, json=body, timeout=30).raise_for_status()
            reply = api.post(f"ask/{question['id']}/answer", json={"value": answers[op]})
            if reply.status_code == 200:
                answered.append(op)
        time.sleep(0.5)
    worker.join(timeout=5)
    after = api.get(f"graph/data_source/{args.source}/setup_stages").json()["data"]
    row = api.get(f"graph/data_source/{args.source}").json()["data"]
    done = next((s for s in after if s.get("stage") == stage["stage"]), {}).get("state") == "done"
    print(json.dumps({
        "stage": stage["stage"], "done": done, "answered": answered, "result": result.get("data") or result,
        "stages": after, "source": {k: row.get(k) for k in ("status", "health", "setup_detail")},
    }, default=str))
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
