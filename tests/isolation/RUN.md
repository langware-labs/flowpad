# tests/isolation - how to run

**What**: proves that spawning a worker on a machine with NO agent harness fails fast with a clear reason (`no_harness_check.py`; success prints `ISOLATION_PASS`). Not pytest. Tier: local process, or docker. Not wired into CI; `tests/unit/test_lazy_capability_resolution.py` is the continuous guard. See `README.md`.

## Prerequisites
- Weak form: `.venv` with the package installed. Strong form: Docker daemon, `uv` (builds a wheel; no UI build needed).

## Commands (repo root)
```bash
EMPTY=$(mktemp -d); PATH="$EMPTY" .venv/bin/python tests/isolation/no_harness_check.py   # no container
bash tests/isolation/run.sh                                                              # docker, exit 0 = pass
```

## Env vars
None.

## Pitfalls
- The empty-PATH form is partial: the CLIs exist on the host, only out of reach. Only the container proves it.
- `run.sh` writes a wheel into `tests/isolation/wheels` (rm -rf'd each run); keep it out of commits.
- Needs docker image pulls (network) for the base python image.

## Time
Local: seconds. Docker: 1-3 min (build + run).
