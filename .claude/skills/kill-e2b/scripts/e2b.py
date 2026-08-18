#!/usr/bin/env python3
"""List or kill E2B sandboxes, filtered by the metadata the hub stamps on them.

    e2b.py list
    e2b.py kill                        # default: environment=staging,dev
    e2b.py kill environment=staging
    e2b.py kill size=lg

Every box the hub provisions carries ``{"environment": <deploy_env>, "size": …}``
(see ``e2b_provider.create_node``). That metadata is the ONLY reliable way to tell
a staging box from a production one — sandbox ids and template ids do not say, and
a box's name is not sent to the provider at all.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

API = "https://api.e2b.app"
DEFAULT_FILTER = "environment=staging,dev"
# Overridable so this works from another GCP project without editing the script.
PROJECT = os.environ.get("GCP_PROJECT", "langware")


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def _run(cmd: list[str]) -> str:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        die(f"timed out: {' '.join(cmd[:3])}…")
    if out.returncode != 0:
        err = (out.stderr or "").strip()
        if "reauth" in err.lower() or "auth login" in err.lower():
            die("gcloud needs a fresh login. Ask the user to run:  ! gcloud auth login")
        die(f"{' '.join(cmd[:3])}… failed: {err[:200]}")
    return out.stdout.strip()


def resolve_key() -> str:
    """A local ``E2B_API_KEY`` if set, else the staging hub's own ``.env.local``.

    Never printed: it is a live credential for every sandbox in the account.
    """
    if os.environ.get("E2B_API_KEY"):
        return os.environ["E2B_API_KEY"]
    # Zone comes from the listing, not a constant: the VM is recreated on every
    # release and nothing guarantees it lands in the zone it was in last time.
    found = _run([
        "gcloud", "compute", "instances", "list", f"--project={PROJECT}",
        "--filter=name~staging AND status=RUNNING", "--format=value(name,zone)",
    ]).splitlines()
    if not found:
        die("no running staging VM found, and E2B_API_KEY is not set")
    name, _, zone = found[0].partition("\t")
    remote = (
        'dir=$(ls -d /opt/flowpad_app/flowpad-hub-*/ 2>/dev/null | tail -1); '
        'grep -E "^e2b_api_key=" "$dir/.env.local" | cut -d= -f2- | tr -d "\\"\' "'
    )
    key = _run([
        "gcloud", "compute", "ssh", name, f"--zone={zone.strip()}", f"--project={PROJECT}",
        f"--command={remote}",
    ]).strip()
    if not key:
        die("the staging VM has no e2b_api_key in its .env.local")
    return key


def api(key: str, path: str = "/sandboxes", method: str = "GET"):
    req = urllib.request.Request(f"{API}{path}", method=method, headers={"X-API-KEY": key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode() or "null"
            return r.status, json.loads(body) if method == "GET" else None
    except urllib.error.HTTPError as e:
        return e.code, None


def rows(boxes: list, filters: dict[str, list[str]]) -> list:
    return [
        b for b in boxes
        if all(str((b.get("metadata") or {}).get(k, "")) in vals for k, vals in filters.items())
    ]


def show(boxes: list) -> None:
    print(f"total: {len(boxes)}")
    for b in boxes:
        md = b.get("metadata") or {}
        env, size = str(md.get("environment")), str(md.get("size"))
        print(f"  {b.get('sandboxID', '?'):24} env={env:12} size={size:4} started={b.get('startedAt', '?')[:19]}")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    args = sys.argv[2:] or ([DEFAULT_FILTER] if cmd == "kill" else [])
    if cmd not in ("list", "kill"):
        die(f"unknown command: {cmd} (expected list or kill)")

    filters: dict[str, list[str]] = {}
    for arg in args:
        k, _, v = arg.partition("=")
        filters[k] = [s.strip() for s in v.split(",") if s.strip()]

    # Killing production is possible but never accidental: it has to be named
    # AND confirmed, because those are live machines someone else is using.
    if cmd == "kill" and any("production" in v for v in filters.values()):
        if os.environ.get("FORCE_PRODUCTION") != "1":
            die("that filter matches production. Re-run with FORCE_PRODUCTION=1 if you mean it.")

    key = resolve_key()
    _, boxes = api(key)
    if boxes is None:
        die("could not list sandboxes (is the api key valid?)")

    if cmd == "list":
        show(boxes)
        return

    doomed = rows(boxes, filters)
    if not doomed:
        print(f"nothing matches {args} — nothing killed")
        return
    print(f"killing (filter: {' '.join(args)}):")
    show(doomed)
    for b in doomed:
        sid = b.get("sandboxID")
        code, _ = api(key, f"/sandboxes/{sid}", "DELETE")
        print(f"  {sid} -> {code}")
    _, left = api(key)
    print("remaining:")
    show(left or [])


if __name__ == "__main__":
    main()
