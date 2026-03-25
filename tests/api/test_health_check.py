"""
Health check API test.

Ported from FlowPad: flowpad/hub/tests/api/test_health_check.py
"""

import pytest


async def test_health_check(client):
    response = await client.get("/api/v1/health/status")
    assert response.status_code == 200, response.text
    assert response.json() == {
        "data": True,
        "message": "Flowpad is up and running",
        "status": "SUCCESS",
    }
