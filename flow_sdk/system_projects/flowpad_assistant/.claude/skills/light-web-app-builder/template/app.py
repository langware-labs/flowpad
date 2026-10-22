"""The whole app: one FastAPI server that serves the pages in static/ and the API under /api.

Data lives in one SQLite file, data/app.db. The tables are in schema.sql and are created on
every start, so a fresh copy of the app works with no setup beyond `python3 setup.py`.

Run by Flowpad from webapp.json. By hand: .venv/bin/python -m uvicorn app:app --reload
"""

import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "app.db"


def db() -> sqlite3.Connection:
    """A connection per request. Rows read like dicts: row["title"]."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    """Changes to tables that already hold data. Each step must be safe to run again.

    Example — add a column only when it is missing:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(items)")}
        if "priority" not in columns:
            conn.execute("ALTER TABLE items ADD COLUMN priority INTEGER NOT NULL DEFAULT 0")
    """


@asynccontextmanager
async def lifespan(_: FastAPI):
    DB_PATH.parent.mkdir(exist_ok=True)
    with db() as conn:
        conn.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
        migrate(conn)
    yield


app = FastAPI(title="App", lifespan=lifespan)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# ── items: the example table. Rename or replace it with what the app needs. ──


class ItemIn(BaseModel):
    title: str


class ItemPatch(BaseModel):
    title: str | None = None
    done: bool | None = None


@app.get("/api/items")
def list_items():
    with db() as conn:
        rows = conn.execute("SELECT id, title, done, created_at FROM items ORDER BY id DESC").fetchall()
    return [dict(row) | {"done": bool(row["done"])} for row in rows]


@app.post("/api/items", status_code=201)
def add_item(item: ItemIn):
    title = item.title.strip()
    if not title:
        raise HTTPException(400, "title is empty")
    with db() as conn:
        cur = conn.execute("INSERT INTO items (title) VALUES (?)", (title,))
        row = conn.execute("SELECT id, title, done, created_at FROM items WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row) | {"done": bool(row["done"])}


@app.patch("/api/items/{item_id}")
def update_item(item_id: int, patch: ItemPatch):
    with db() as conn:
        if patch.title is not None:
            conn.execute("UPDATE items SET title = ? WHERE id = ?", (patch.title.strip(), item_id))
        if patch.done is not None:
            conn.execute("UPDATE items SET done = ? WHERE id = ?", (int(patch.done), item_id))
        row = conn.execute("SELECT id, title, done, created_at FROM items WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "no such item")
    return dict(row) | {"done": bool(row["done"])}


@app.delete("/api/items/{item_id}", status_code=204)
def delete_item(item_id: int):
    with db() as conn:
        conn.execute("DELETE FROM items WHERE id = ?", (item_id,))


# The pages. Mounted last, so every /api route above wins over a file of the same name.
app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")
