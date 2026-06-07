"""Record PTY fuzz streams into replayable fixtures.

For every (content strategy x resize schedule) cell, runs the strategy under
a real PTY, applies the schedule's resizes while reading, and writes an
asciicast-v2-like JSON fixture:

    {
      "cols": 100, "rows": 30,                 # initial size
      "strategy": "erase_repaint",
      "schedule": "shrink-grow",
      "events": [
        ["o", "<base64 bytes>"],               # output chunk (as read)
        ["r", [60, 20]],                       # resize to cols x rows
        ...
      ]
    }

The vitest equivalence matrix consumes these. No production code involved —
this is the lab bench for validating the replay theory.

Resize injection is threshold-based on captured byte count: deterministic
*per recording* (offsets are recorded), which is all the differential oracle
needs — it compares two interpretations of the SAME recording.

Usage:
    uv run python -m tests.pty_fuzz.record_streams --out ui/tests/fixtures/pty-fuzz
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

from ptyprocess import PtyProcess

STRATEGIES_SH = Path(__file__).parent / "strategies.sh"

INITIAL = (100, 30)  # cols, rows

# (name, initial_size, [(byte_threshold, (cols, rows)), ...])
# Thresholds: a resize is applied once captured bytes >= threshold.
RESIZE_SCHEDULES: dict[str, list[tuple[int, tuple[int, int]]]] = {
    "none": [],
    "early": [(256, (80, 24))],
    "mid-output": [(2048, (74, 22))],
    "shrink-grow": [(1024, (60, 20)), (4096, (100, 30))],
    "grow-shrink": [(1024, (140, 50)), (4096, (80, 24))],
    "rapid": [
        (512, (98, 30)),
        (1024, (92, 28)),
        (1536, (85, 26)),
        (2048, (70, 22)),
        (2560, (110, 34)),
    ],
}


def list_strategies() -> list[str]:
    out = subprocess.run(
        ["bash", str(STRATEGIES_SH), "--list"], capture_output=True, text=True, check=True
    )
    return out.stdout.split()


def record(
    strategy: str,
    schedule_name: str,
    production_max_size: int | None = None,
    tmp_dir: Path | None = None,
) -> dict:
    """Record one (strategy, schedule) cell.

    Default mode builds the fixture dict directly. With ``production_max_size``
    set, the recording is driven through the REAL ``PtyStreamFile`` writer
    (seq'd output frames, resize frames, frame-boundary truncation) and the
    fixture is whatever ``read_frames()`` returns — i.e. exactly what the
    ``/pty-stream`` endpoint would serve.
    """
    cols, rows = INITIAL
    stream_file = None
    if production_max_size is not None:
        from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile

        assert tmp_dir is not None
        stream_file = PtyStreamFile(
            tmp_dir / f"{strategy}__{schedule_name}.pty",
            cols=cols,
            rows=rows,
            max_size_bytes=production_max_size,
        )

    proc = PtyProcess.spawn(
        ["bash", str(STRATEGIES_SH), strategy],
        dimensions=(rows, cols),
        env={**os.environ, "TERM": "xterm-256color"},
    )
    pending = list(RESIZE_SCHEDULES[schedule_name])
    events: list[list] = []
    captured = 0
    seq = 0
    while True:
        try:
            data = proc.read(8192)
        except EOFError:
            break
        if not data:
            break
        seq += 1
        if stream_file is not None:
            stream_file.write(data, seq)
        else:
            events.append(["o", base64.b64encode(data).decode("ascii"), seq])
        captured += len(data)
        while pending and captured >= pending[0][0]:
            _, (rcols, rrows) = pending.pop(0)
            proc.setwinsize(rrows, rcols)
            if stream_file is not None:
                stream_file.write_resize(rcols, rrows)
            else:
                events.append(["r", [rcols, rrows]])
    proc.wait()
    # Apply any resizes the stream was too short to trigger — at end-of-stream,
    # so every schedule exercises its full size sequence on every strategy.
    for _, (rcols, rrows) in pending:
        if stream_file is not None:
            stream_file.write_resize(rcols, rrows)
        else:
            events.append(["r", [rcols, rrows]])

    if stream_file is not None:
        fixture = stream_file.read_frames()
        fixture["strategy"] = strategy
        fixture["schedule"] = schedule_name
        return fixture
    return {
        "v": 1,
        "cols": cols,
        "rows": rows,
        "strategy": strategy,
        "schedule": schedule_name,
        "events": events,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="output fixtures directory")
    ap.add_argument("--strategies", nargs="*", help="subset of strategies (default: all)")
    ap.add_argument("--schedules", nargs="*", help="subset of schedules (default: all)")
    ap.add_argument(
        "--production",
        action="store_true",
        help="record through the real PtyStreamFile writer (seq frames, truncation)",
    )
    ap.add_argument(
        "--max-size",
        type=int,
        default=10 * 1024 * 1024,
        help="PtyStreamFile max_size_bytes in --production mode (small → truncation)",
    )
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    strategies = args.strategies or list_strategies()
    schedules = args.schedules or list(RESIZE_SCHEDULES.keys())

    import tempfile

    manifest = []
    tmp_dir = Path(tempfile.mkdtemp(prefix="pty-fuzz-prod-")) if args.production else None
    for strategy in strategies:
        for schedule in schedules:
            fixture = record(
                strategy,
                schedule,
                production_max_size=args.max_size if args.production else None,
                tmp_dir=tmp_dir,
            )
            name = f"{strategy}__{schedule}.json"
            (out_dir / name).write_text(json.dumps(fixture))
            n_out = sum(1 for e in fixture["events"] if e[0] == "o")
            n_res = sum(1 for e in fixture["events"] if e[0] == "r")
            total = sum(
                len(base64.b64decode(e[1])) for e in fixture["events"] if e[0] == "o"
            )
            manifest.append(name)
            print(f"  {name}: {total} bytes, {n_out} chunks, {n_res} resizes")

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote {len(manifest)} fixtures to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
