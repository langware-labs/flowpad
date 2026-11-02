# tests/pty_fuzz - how to run

**What**: PTY replay-equivalence fuzzer support. The pytest part (`test_strategies_selfcheck.py`) checks that each bash content generator in `strategies.sh` emits the escape patterns it claims, under a real PTY via ptyprocess. Tier: mock, local only. The equivalence matrix itself is vitest: `ui/tests/unit/pty-replay-equivalence.test.ts`. `*.mjs` files are upstream xterm.js repro scripts, not tests. See `README.md`.

## Prerequisites
- POSIX (ptyprocess), bash. `uv sync`. For the `.mjs` repros and the vitest matrix: `cd ui && npm ci`.

## Commands (repo root)
```bash
uv run pytest tests/pty_fuzz
uv run pytest tests/pty_fuzz/test_strategies_selfcheck.py::test_name
cd ui && npx vitest run --project unit tests/unit/pty-replay-equivalence.test.ts   # the matrix
node tests/pty_fuzz/xterm-utf8-split-repro.mjs                                       # repro (from repo root, needs ui deps)
```

## Env vars
None specific.

## Pitfalls
- Not runnable on Windows (ptyprocess).
- `record_streams.py` records real Claude sessions and needs a signed-in CLI; it is a tool, not a test.
- Per-test cap 30 s (pytest.ini).

## Time
Seconds.
