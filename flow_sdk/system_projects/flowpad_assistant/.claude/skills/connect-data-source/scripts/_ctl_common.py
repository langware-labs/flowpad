"""Gate-safe transport shared by the connect-data-source scripts.

There is no `flow` verb for data sources or datasets, and the backend's cookie
gate rejects an un-gated request with a 403 — `discover_port()` +
`local_get`/`local_post` from `flow_sdk.cli.commands._common` are the gate-safe
path, so every call goes through here and none builds a bare request.
"""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Any


@lru_cache(maxsize=1)
def api_base() -> str:
    """Base URL, resolved once. `discover_port` reads `server.json` off disk and
    the port cannot change inside one invocation — `observe` alone would have
    re-read it three times per loop iteration."""
    from flow_sdk.cli.commands._common import discover_port  # noqa: PLC0415

    return f"http://127.0.0.1:{discover_port()}/api/v1"


def envelope(resp) -> Any:
    """The SUCCESS envelope's `data`, or a described failure.

    A body that is not JSON is the cookie gate's HTML 403, which used to surface
    from here as a bare `JSONDecodeError` — unactionable, and stdout JSON is the
    only evidence this skill's caller gets. `bad_response_message` is the same
    sentence the CLI shows for it.
    """
    from flow_sdk.cli.commands._common import bad_response_message  # noqa: PLC0415

    try:
        body = resp.json() or {}
    except ValueError:
        # RuntimeError, not SystemExit: `main` turns an Exception into the
        # one-JSON-object contract, and a BaseException would escape it.
        raise RuntimeError(bad_response_message(resp))
    return body.get("data")


def get(path: str, **params: Any) -> Any:
    """GET a graph path. `params` are FILTERED SERVER-SIDE.

    The list routes parse a `filter` JSON param and honour a top-level `limit`,
    so asking for one source's rows costs one source's rows. Pulling the whole
    collection and filtering here would scale with everything the instance has
    ever ingested — and `observe` reads on a loop.
    """
    from urllib.parse import urlencode  # noqa: PLC0415

    from flow_sdk.cli.commands._common import local_get  # noqa: PLC0415

    limit = params.pop("limit", None)
    query = {}
    if params:
        query["filter"] = json.dumps(params)
    if limit is not None:
        query["limit"] = str(limit)
    url = f"{api_base()}{path}" + (f"?{urlencode(query)}" if query else "")
    return envelope(local_get(url))


def post(path: str, body: dict | None = None) -> Any:
    from flow_sdk.cli.commands._common import local_post  # noqa: PLC0415

    return envelope(local_post(f"{api_base()}{path}", json=body or {}))



def json_arg(raw: str) -> Any:
    """A JSON argument, or ``-`` for stdin."""
    import sys  # noqa: PLC0415

    return json.loads(sys.stdin.read() if raw == "-" else raw)


def sources() -> list[dict]:
    # Unfiltered on purpose: `one` needs the whole set to detect an ambiguous
    # name, and this table has one row per configured row of the type.
    return list(get("/graph/data_source") or [])


def one(path: str, ref: str, *, label: str, fields: tuple = ("name",)) -> dict:
    """A row of ``path`` by id, or by an unambiguous match on ``fields``.

    Ambiguity is an error, never a guess: acting on the wrong row is worse than
    asking which one. THE resolver for both scripts, so a source and a dataset
    are found — and refused — the same way.
    """
    rows = list(get(path) or [])
    exact = [r for r in rows if r.get("id") == ref]
    if exact:
        return exact[0]
    needle = ref.strip().lower()
    hits = [r for r in rows if any(needle == str(r.get(f) or "").lower() or needle in str(r.get(f) or "").lower() for f in fields)]
    if not hits:
        raise LookupError(f"no {label} matches {ref!r}")
    if len(hits) > 1:
        raise LookupError(f"{ref!r} matches {len(hits)} {label}s: " + ", ".join(f"{r.get('name')} ({r.get('id')})" for r in hits))
    return hits[0]


def one_source(ref: str) -> dict:
    """A data source by id, name or provider."""
    return one("/graph/data_source", ref, label="data source", fields=("name", "provider"))


def create_and_verify(path: str, body: dict, keys: tuple, *, read_path: str = "") -> tuple[str, dict, list]:
    """POST, then READ THE ROW BACK and diff — the create route silently drops
    any key it does not recognise, so a misspelled field returns 200 with the
    value missing. The read-back is the evidence, never the 201.

    Returns ``(id, row, dropped)``.
    """
    created = post(path, body) or {}
    new_id = created.get("id")
    if not new_id:
        raise RuntimeError("create returned no id")
    row = get(f"{read_path or path.rsplit('/', 1)[0] + '/' + path.rsplit('/', 1)[-1]}/{new_id}") or {}
    dropped = [k for k in keys if k in body and row.get(k) != body[k]]
    return new_id, row, dropped


def run(verbs: dict, doc: str) -> int:
    """argparse over ``verbs`` → exactly one JSON object on stdout."""
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(description=doc)
    subs = parser.add_subparsers(dest="verb", required=True)
    for name, (_fn, params) in verbs.items():
        sub = subs.add_parser(name)
        for flag, kwargs in params:
            sub.add_argument(flag, **kwargs)
    args = parser.parse_args()
    try:
        payload = verbs[args.verb][0](args)
    except Exception as exc:  # noqa: BLE001 — the contract is one JSON object, always
        print(json.dumps({"ok": False, "error_code": type(exc).__name__, "error": str(exc)}))  # noqa: T201
        return 1
    # Printed OUTSIDE the try: a serialization failure after a successful verb
    # must not be reported as the verb having failed.
    print(json.dumps({"ok": True, **payload}, default=str))  # noqa: T201 — the contract IS stdout
    return 0
