# Isolation: a machine with no agent harness

`no_harness_check.py` asserts that spawning a worker where **nothing is
installed** fails immediately and says why — the property the lazy capability
resolver exists to guarantee.

Two ways to run it, strongest last:

```bash
# 1. no container: a real process with an empty PATH
EMPTY=$(mktemp -d); PATH="$EMPTY" .venv/bin/python tests/isolation/no_harness_check.py

# 2. a container that genuinely has no CLIs (needs the Docker daemon)
bash tests/isolation/run.sh
```

(1) is honest but partial — the CLIs exist on the host, they are merely out of
reach. (2) removes that caveat: `python:3.10-slim` has no node, so no vendor CLI
can be there at all.

Neither runs in CI. `tests/unit/test_lazy_capability_resolution.py` is the
continuous guard; these prove the same claim on a real empty machine.
