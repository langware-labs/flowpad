"""Messages a worker read off a page, as the write route's batch — run by the worker, never typed.

A page shows a message's sender, text, and a time to the minute; it shows no id. So the record's
identity is built here, the same way on every run and by the reader and the sender alike: the
conversation, the sender, the minute and the text, plus a counter when one person sends the same
text twice in a minute — the words only, since two reads of one page space the same text
differently. An edited message is therefore a new one. The clock on the page is the
browser's local time; it becomes UTC here, not in a model's head.

    python page_batch.py --source <data_source_id> --provider <p> --kind <k> [--account <a>] [--media <dir>] --in observed.json --out batch.json

``observed.json`` is a list of ``{conversation, sender, date: "YYYY-MM-DD", time: "11:55 PM" | "23:55", text}``
in page order, with optional ``mine`` (the signed-in account wrote it), ``sender_id``,
``permalink`` and ``files`` — media the worker saved from the page, by path. With ``--media`` each
file is moved into that folder under a name built from the message's identity, so the same media
read twice is one file. ``--account`` is what the source knows its own account by: a ``mine`` message is
authored by it, so the application reads our own words as ours. Prints ``{external_ids, high_water}``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

_CLOCKS = ("%I:%M %p", "%H:%M")
NO_TEXT = "[attachment]"
_BLANK_RUN = re.compile(r"\n\s*\n+")


def minute_utc(date: str, time: str) -> datetime:
    """The page's local date and clock time as an aware UTC minute."""
    clock = " ".join(time.replace("\u202f", " ").upper().split())
    for form in _CLOCKS:
        try:
            local = datetime.strptime(f"{date} {clock}", f"%Y-%m-%d {form}")
        except ValueError:
            continue
        return local.astimezone().astimezone(timezone.utc)
    raise ValueError(f"not a page time: {date!r} {time!r}")


def items(observed: list[dict], *, source: str, provider: str, kind: str, account: str = "", media: str = "") -> list[dict]:
    seen: Counter = Counter()
    out = []
    for row in observed:
        conversation, sender = (str(row[k]).strip() for k in ("conversation", "sender"))
        text = _body(str(row.get("text") or ""))
        at = minute_utc(str(row["date"]), str(row["time"])).isoformat()
        key = (conversation, sender, at, " ".join(text.split()))
        seen[key] += 1
        digest = hashlib.sha256("\x1f".join((*key, str(seen[key]))).encode()).hexdigest()[:20]
        out.append({
            "data_source_id": source, "provider": provider, "kind": kind,
            "external_id": f"{conversation}:{digest}", "name": "", "body": text, "occurred_at": at,
            "author_display": sender, "author_external_id": account if account and row.get("mine") else str(row.get("sender_id") or sender),
            "thread_key": conversation, "permalink": row.get("permalink") or None,
            "files": [home for n, path in enumerate(row.get("files") or ()) if (home := _keep(Path(path), media, f"{digest}-{n}"))],
        })
    return out


def _body(text: str) -> str:
    """The text as it is stored: trailing spaces and runs of blank lines gone, and a message with no
    words of its own (a video, a file) named the same way on every read."""
    return _BLANK_RUN.sub("\n\n", "\n".join(line.rstrip() for line in text.strip().splitlines())) or NO_TEXT


def _keep(saved: Path, media: str, stem: str) -> str:
    """Where a saved file lives from now on — moved into ``media`` under the message's own name —
    or ``""`` when it is neither where the worker said nor already kept."""
    if not media:
        raise SystemExit("a message with files needs --media: where they are kept")
    saved = saved.expanduser()
    home = Path(media) / f"{stem}{saved.suffix.lower()}"
    if saved.is_file():
        home.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(saved), home)
    return str(home) if home.is_file() else ""


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("source", "provider", "kind", "in", "out"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--account", default="")
    parser.add_argument("--media", default="")
    args = vars(parser.parse_args())
    batch = items(json.loads(Path(args["in"]).read_text(encoding="utf-8")), source=args["source"], provider=args["provider"], kind=args["kind"], account=args["account"], media=args["media"])
    Path(args["out"]).write_text(json.dumps(batch, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"external_ids": [i["external_id"] for i in batch], "high_water": max((i["occurred_at"] for i in batch), default=None)}))  # noqa: T201 — the script's answer to the worker


if __name__ == "__main__":
    main()
