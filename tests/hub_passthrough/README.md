# Hub pass-through harness

Runs hub tests THROUGH desktop instances (HubProxy) against a real hub. Not part of the OSS suite:
the files are named `live_*.py` so a plain `pytest tests` skips them; run them from the hub repo.

```bash
cd <FlowPad>/flowpad
env -u SOD_ENC_KEY DEPLOY_ENV=local NEO4J_DATABASE_DB_NAME_TEST=<own db> TMPDIR=<private dir> \
  PYTHONPATH=<oss>/tests/hub_passthrough:$PWD/.. \
  uv run pytest --rootdir=$PWD -c pytest.ini -p flowpad.hub.tests.conftest -p hub_passthrough_plugin \
  <oss>/tests/hub_passthrough/live_every_action.py <oss>/tests/hub_passthrough/live_shapes_and_failures.py
```

- `live_every_action.py` — every registered hub action (`hub_actions.json`) answers the same direct and through a desktop.
- `live_shapes_and_failures.py` — ticket close/reopen, another user's row refused, stale login signs out, hub down.
- The whole hub API suite: `-p hub_passthrough_plugin hub/tests/api` (every bearer graph request goes through a desktop).
