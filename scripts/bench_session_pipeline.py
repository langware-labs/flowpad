"""Profile the actual per-session indexing pipeline.

Runs the production code paths (`from_fsref` → `Entity.from_record` →
`sync_from_entity` → FtsEntry building) on a sample of real sessions and
reports per-step latency. No production code changes.

Usage:
    uv run python scripts/bench_session_pipeline.py [--limit 30]
"""

from __future__ import annotations

import argparse
import asyncio
import os
import statistics
import time
from pathlib import Path


async def main(limit: int) -> None:
    # Trigger record/type registration
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401
    from flow_sdk.fs_store.fs_record import FSRecord as ClaudeSessionRecord
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry
    from flow_sdk.db import get_db_driver

    base = Path.home() / ".claude" / "projects"
    files: list[Path] = []
    for d in base.iterdir():
        if not d.is_dir():
            continue
        for f in d.glob("*.jsonl"):
            files.append(f)
    files.sort(key=lambda p: -p.stat().st_size)
    files = files[:limit]
    print(f"profiling {len(files)} sessions ({sum(p.stat().st_size for p in files)/1024/1024:.1f} MB)\n")

    timings = {
        "from_fsref": [],
        "entity_from_record": [],
        "  -> meta_dict": [],
        "  -> get_one": [],
        "  -> record_domain (to_dict)": [],
        "  -> entity_construct": [],
        "  -> entity_save": [],
        "sync_from_entity": [],
        "search_title": [],
        "search_content": [],
        "fts_entry": [],
        "fts_upsert_batched": 0.0,
        "total": [],
    }

    fts_batch: list = []
    driver = get_db_driver()

    for path in files:
        ref = FSRef(path, record_type=RecordType.CLAUDE_SESSION)

        t_total = time.perf_counter()

        t = time.perf_counter()
        records = await ClaudeSessionRecord.from_fsref(ref)
        timings["from_fsref"].append((time.perf_counter() - t) * 1000)

        for rec in records:
            # Hand-rolled equivalent of Entity.from_record so we can time substeps
            from flow_sdk.fs_store.schema_registry import SchemaRegistry
            from flow_sdk.db.drivers.query import QueryFilter

            t_from = time.perf_counter()

            t = time.perf_counter()
            record_type = rec.type or rec._record_type
            entity_cls = SchemaRegistry.get_entity_cls(record_type) or Entity
            data = rec.meta_dict()
            entity_uuid = entity_cls.allocate_id(data)
            timings["  -> meta_dict"].append((time.perf_counter() - t) * 1000)

            t = time.perf_counter()
            entity = await entity_cls.get_one(QueryFilter.parse({"id": entity_uuid}))
            timings["  -> get_one"].append((time.perf_counter() - t) * 1000)

            t = time.perf_counter()
            record_domain = {}
            if entity_cls is not Entity and hasattr(entity_cls, "model_fields"):
                entity_field_names = set(entity_cls.model_fields.keys())
                missing = entity_field_names - set(data.keys()) - {"id", "type"}
                if missing:
                    record_fields = set(getattr(rec, '_property_types', None) or {}) | set(
                        object.__getattribute__(rec, "__dict__").keys()
                    )
                    # NEW: targeted getattr instead of record.to_dict()
                    for k in missing & record_fields:
                        try:
                            v = getattr(rec, k, None)
                        except Exception:
                            v = None
                        if v is not None:
                            record_domain[k] = v
            timings["  -> record_domain (to_dict)"].append((time.perf_counter() - t) * 1000)

            t = time.perf_counter()
            if entity is None:
                create_kwargs = {"id": entity_uuid, "type": record_type}
                create_kwargs.update({k: v for k, v in data.items() if k not in ("id", "type")})
                create_kwargs.update(record_domain)
                try:
                    entity = entity_cls(**create_kwargs)
                except Exception:
                    entity = Entity(**create_kwargs)
            else:
                entity.type = record_type
                all_updates = {**data, **record_domain}
                for k, v in all_updates.items():
                    if k not in ("id",) and hasattr(entity, k):
                        setattr(entity, k, v)
            timings["  -> entity_construct"].append((time.perf_counter() - t) * 1000)

            t = time.perf_counter()
            await entity.save(notify=False)
            timings["  -> entity_save"].append((time.perf_counter() - t) * 1000)

            timings["entity_from_record"].append((time.perf_counter() - t_from) * 1000)

            t = time.perf_counter()
            await asyncio.to_thread(rec.sync_from_entity, entity)
            timings["sync_from_entity"].append((time.perf_counter() - t) * 1000)

            t = time.perf_counter()
            title = rec.search_title
            timings["search_title"].append((time.perf_counter() - t) * 1000)

            t = time.perf_counter()
            content = rec.search_content
            timings["search_content"].append((time.perf_counter() - t) * 1000)

            t = time.perf_counter()
            entry = FtsEntry(
                entity_id=entity.id,
                entity_type=entity.type,
                name=rec.name or None,
                title=title,
                description=rec.search_description,
                content=content,
            )
            fts_batch.append(entry)
            timings["fts_entry"].append((time.perf_counter() - t) * 1000)

        timings["total"].append((time.perf_counter() - t_total) * 1000)

    # Single batched FTS upsert at the end (matches indexer behavior)
    if fts_batch and hasattr(driver, "fts_upsert"):
        t = time.perf_counter()
        await driver.fts_upsert(fts_batch)
        timings["fts_upsert_batched"] = (time.perf_counter() - t) * 1000

    # Summary
    def line(label: str, samples: list[float]) -> None:
        if not samples:
            print(f"  {label:<28}  {'(no data)':>10}")
            return
        s = sorted(samples)
        avg = statistics.mean(s)
        p50 = s[len(s) // 2]
        p99 = s[min(len(s) - 1, int(len(s) * 0.99))]
        total = sum(s)
        print(
            f"  {label:<28}  avg={avg:>7.2f} ms  p50={p50:>6.2f} ms  "
            f"p99={p99:>7.2f} ms  total={total:>8,.0f} ms"
        )

    print("== per-session step latency ==\n")
    line("from_fsref            ", timings["from_fsref"])
    line("Entity.from_record    ", timings["entity_from_record"])
    line("  -> meta_dict        ", timings["  -> meta_dict"])
    line("  -> get_one          ", timings["  -> get_one"])
    line("  -> record_domain    ", timings["  -> record_domain (to_dict)"])
    line("  -> entity_construct ", timings["  -> entity_construct"])
    line("  -> entity_save      ", timings["  -> entity_save"])
    line("sync_from_entity      ", timings["sync_from_entity"])
    line("search_title          ", timings["search_title"])
    line("search_content        ", timings["search_content"])
    line("FtsEntry build        ", timings["fts_entry"])
    line("TOTAL per session     ", timings["total"])
    print()
    print(f"  {'fts_upsert (single batched)':<28}  {timings['fts_upsert_batched']:>8,.0f} ms")
    print()
    grand = sum(timings["total"]) + timings["fts_upsert_batched"]
    print(f"  grand total ({len(files)} sessions): {grand:,.0f} ms")
    print(f"  ms/session: {grand/len(files):.2f}")
    print(f"  sessions/sec: {len(files) / (grand / 1000):.1f}")


def _parse() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--db", help="override SQLITE_DATABASE_PATH")
    return ap.parse_args()


if __name__ == "__main__":
    args = _parse()
    if args.db:
        os.environ["SQLITE_DATABASE_PATH"] = args.db
    elif "SQLITE_DATABASE_PATH" not in os.environ:
        env_local = Path(__file__).resolve().parent.parent / ".env.local"
        if env_local.exists():
            for line in env_local.read_text().splitlines():
                if line.startswith("SQLITE_DATABASE_PATH="):
                    os.environ["SQLITE_DATABASE_PATH"] = line.split("=", 1)[1].strip()
                    break
    asyncio.run(main(args.limit))
