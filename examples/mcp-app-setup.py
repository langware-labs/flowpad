#!/usr/bin/env python3
"""
MCP App Demo Setup Script
─────────────────────────
Idempotent — safe to re-run.

Steps:
  1. Bootstrap @local entities
  2. Create (or reuse) a bookmark entity with record_data_ref="bookmark/mcp-app-demo"
  3. Write the record folder + MCP app dist files
  4. Print the URL to open in a browser

Prerequisites: backend running on http://localhost:9007
  cd flow-cli && python -m flow_sdk.server.run
"""

import json
import pathlib
import shutil
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "http://localhost:9007"
APP_NAME = "demo"
RECORD_DATA_REF = "bookmark/mcp-app-demo"

# Path of this script — used to locate the MCP app index.html
SCRIPT_DIR = pathlib.Path(__file__).parent.resolve()
APP_HTML_SRC = SCRIPT_DIR / "mcp-app-demo" / "index.html"


# ── HTTP helpers ───────────────────────────────────────────────────────────────


def _request(method: str, path: str, body: dict | None = None) -> dict:
    url = API_BASE + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code} {method} {path}: {body_text}") from e


def get(path: str) -> dict:
    return _request("GET", path)


def post(path: str, body: dict) -> dict:
    return _request("POST", path, body)


# ── Step 1: Bootstrap ──────────────────────────────────────────────────────────

print("1. Bootstrapping @local entities…")
get("/api/v1/graph/bootstrap")
print("   OK")


# ── Step 2: Get or create bookmark entity ─────────────────────────────────────

print("2. Looking for existing bookmark with record_data_ref='bookmark/mcp-app-demo'…")
resp = get("/api/v1/graph/bookmark")
existing = [e for e in (resp.get("data") or []) if e.get("record_data_ref") == RECORD_DATA_REF]

if existing:
    entity = existing[0]
    entity_id = entity["id"]
    print(f"   Found existing entity: {entity_id}")
else:
    print("   Not found — creating…")
    resp = post(
        "/api/v1/graph/bookmark",
        {
            "title": "MCP App Demo",
            "bookmark_type": "note",
            "record_data_ref": RECORD_DATA_REF,
        },
    )
    entity = resp.get("data") or {}
    entity_id = entity.get("id")
    if not entity_id:
        raise RuntimeError(f"Create bookmark failed: {resp}")
    print(f"   Created entity: {entity_id}")


# ── Step 3: Write record folder + MCP app dist ────────────────────────────────

# record_stem("bookmark", "mcp-app-demo") → "bookmark-@mcp-app-demo"
records_root = pathlib.Path.home() / ".flow" / "records"
record_dir = records_root / "bookmark" / "bookmark-@mcp-app-demo"
dist_dir = record_dir / "mcp_apps" / APP_NAME / "dist"

print(f"3. Writing record folder: {record_dir}")
dist_dir.mkdir(parents=True, exist_ok=True)

metadata_path = record_dir / "metadata.json"
data_path = record_dir / "_obj_data.json"

metadata_path.write_text(
    json.dumps({"data": {"id": "mcp-app-demo", "type": "bookmark", "name": "MCP App Demo"}}, indent=2)
)

data_path.write_text(json.dumps({"data": {"title": "MCP App Demo", "bookmark_type": "note"}}, indent=2))

print("   Wrote metadata.json and _obj_data.json")

if not APP_HTML_SRC.exists():
    raise RuntimeError(f"MCP app HTML not found: {APP_HTML_SRC}")

shutil.copy2(APP_HTML_SRC, dist_dir / "index.html")
print(f"   Copied index.html → {dist_dir / 'index.html'}")


# ── Step 4: Print URL ──────────────────────────────────────────────────────────

app_context = json.dumps(
    {
        "entityId": entity_id,
        "entityType": "bookmark",
        "appName": APP_NAME,
    }
)
encoded = urllib.parse.quote(app_context)
url = f"{API_BASE}/api/v1/graph/bookmark/{entity_id}/mcp_app/{APP_NAME}/?appContext={encoded}"

print()
print("=" * 60)
print("Setup complete!")
print()
print("Entity ID   :", entity_id)
print("Record dir  :", record_dir)
print()
print("Open this URL in your browser:")
print()
print(f"  {url}")
print()
print("=" * 60)
