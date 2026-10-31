"""A web app's lifecycle on this machine — one record, one readiness rule, one coordinator.

The contract is ``docs/webapp-lifecycle.md``:

* ``record`` — the per-app ``webapp.lifecycle`` value (instance-local), its writes and its push to screens.
* ``failure`` — a failure typed, normalized and fingerprinted by code.
* ``handling`` — the app's learned handlings (``setup/webapp_handlings.json``), matched before any agent.
* ``readiness`` — THE rule for "this app is up here".
* ``coordinator`` — THE way an app comes up and recovers, whoever asks.
"""
