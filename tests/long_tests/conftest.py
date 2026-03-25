"""Shared fixtures for long-running API tests.

Re-exports the in-process HTTPX client fixtures from tests/api/conftest.py
so tests in this directory can use bootstrapped_client without modification.
"""

from tests.api.conftest import clean_db, client, bootstrapped_client, reset_db_for_testclient  # noqa: F401
