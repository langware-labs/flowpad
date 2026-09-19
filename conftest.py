"""The repo's pytest fixtures, for every test path — ``tests/`` and each data source asset's own
``tests/`` folder alike (``agentic-assets/data_driver/<name>/tests``), which no conftest under
``tests/`` would reach."""

pytest_plugins = ["tests.pytest_plugin"]
