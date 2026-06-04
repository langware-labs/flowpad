"""PromptQueue — a pure file-backed FIFO prompt queue + debug log.

No knowledge of AgenticProcess, workers, PTY, or HTTP — it only manipulates two
files next to each other:

  * ``prompt_queue.json``      — ``{"enabled": bool, "entries": [entry, ...]}``
  * ``prompt_queue_log.jsonl`` — append-only debug log, one JSON object per line

Backed by an ``FSRef`` pointing at the json file; the log is its sibling.

Design invariants:
  * **Reads never raise.** A missing or corrupt queue file returns the default
    ``{"enabled": True, "entries": []}`` so a malformed file can never break a
    caller (notably entity serialization that reads the queue on every dump).
  * **Writes are atomic** (temp file + ``os.replace``), so a crash mid-write
    never leaves a partial json.
  * FIFO: the head is ``entries[0]``; ``pop()`` removes and returns it.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_ref import FSRef

_LOG_NAME = "prompt_queue_log.jsonl"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_state() -> dict:
    return {"enabled": True, "entries": []}


class PromptQueue:
    """File-backed FIFO prompt queue. Construct with the ``prompt_queue.json`` FSRef."""

    def __init__(self, fsref: FSRef) -> None:
        self._path = Path(fsref.path)
        self._log_path = self._path.parent / _LOG_NAME

    # ── read (corruption-tolerant) ───────────────────────────────────────────

    def read(self) -> dict:
        """Current state. Returns the default on missing/corrupt — never raises."""
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("entries"), list):
                data.setdefault("enabled", True)
                return data
        except Exception:  # noqa: BLE001 — any read/parse failure → default
            pass
        return _default_state()

    @property
    def entries(self) -> list[dict]:
        return self.read()["entries"]

    @property
    def enabled(self) -> bool:
        return bool(self.read()["enabled"])

    @property
    def is_empty(self) -> bool:
        return not self.read()["entries"]

    def peek(self) -> dict | None:
        ents = self.read()["entries"]
        return ents[0] if ents else None

    # ── mutate (each persists + logs) ────────────────────────────────────────

    def enqueue(self, prompt: str, source: str = "ui") -> dict:
        q = self.read()
        entry = {
            "id": uuid.uuid4().hex,
            "prompt": prompt,
            "source": source,
            "created_at": _now_iso(),
        }
        q["entries"].append(entry)
        self._write(q)
        self.log("enqueue", source, entry_id=entry["id"], prompt=prompt[:200])
        return entry

    def pop(self, source: str = "drain") -> dict | None:
        """Remove + return the FIFO head (persists the removal before returning)."""
        q = self.read()
        if not q["entries"]:
            return None
        head = q["entries"].pop(0)
        self._write(q)
        self.log("pop", source, entry_id=head.get("id"), remaining=len(q["entries"]))
        return head

    def dequeue(self, ident: str | int, source: str = "ui") -> bool:
        q = self.read()
        ents = q["entries"]
        removed: dict | None = None
        if isinstance(ident, bool):
            return False
        if isinstance(ident, int):
            if 0 <= ident < len(ents):
                removed = ents.pop(ident)
        else:
            for i, e in enumerate(ents):
                if e.get("id") == ident:
                    removed = ents.pop(i)
                    break
        if removed is None:
            return False
        self._write(q)
        self.log("dequeue", source, entry_id=removed.get("id"))
        return True

    def clear(self, source: str = "ui") -> None:
        q = self.read()
        removed = len(q["entries"])
        q["entries"] = []
        self._write(q)
        self.log("clear", source, removed=removed)

    def set_enabled(self, enabled: bool, source: str = "ui") -> None:
        q = self.read()
        q["enabled"] = bool(enabled)
        self._write(q)
        self.log("set_enabled", source, enabled=bool(enabled))

    # ── log ──────────────────────────────────────────────────────────────────

    def log(self, action: str, source: str, **payload: Any) -> None:
        """Append one debug line. Best-effort — IO errors are swallowed."""
        line = {"ts": _now_iso(), "action": action, "source": source, **payload}
        try:
            self._log_path.parent.mkdir(parents=True, exist_ok=True)
            with self._log_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(line, ensure_ascii=False) + "\n")
        except Exception:  # noqa: BLE001 — logging must never break the caller
            pass

    def log_entries(self) -> list[dict]:
        """Parsed debug-log lines (tolerant of blank/garbage lines). For tests/debug."""
        out: list[dict] = []
        try:
            for raw in self._log_path.read_text(encoding="utf-8").splitlines():
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    out.append(json.loads(raw))
                except Exception:  # noqa: BLE001
                    continue
        except Exception:  # noqa: BLE001
            pass
        return out

    # ── internal ─────────────────────────────────────────────────────────────

    def _write(self, q: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(f"{self._path.name}.tmp.{os.getpid()}.{uuid.uuid4().hex}")
        tmp.write_text(json.dumps(q, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self._path)  # atomic on the same filesystem
