"""Shared test configuration for flow-cli tests.

Mirrors FlowPad: flowpad/hub/tests/test_settings.py

Usage in long tests:
    from tests.test_settings import test_service_config
    pytestmark = pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    )

Set DEEP_TESTING=1 (or true/yes) in the environment to opt in:
    DEEP_TESTING=1 python -m pytest tests/long_tests/ -v
"""

from flow_sdk.config import default_service_config

# Shared config instance for tests — reads deep_testing from DEEP_TESTING env var.
# ServiceConfig is a pydantic BaseSettings (case_sensitive=False), so DEEP_TESTING=1,
# DEEP_TESTING=true, and DEEP_TESTING=yes all enable it.
test_service_config = default_service_config
