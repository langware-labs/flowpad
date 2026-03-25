"""
Dynamic type registration API tests.

Ported from FlowPad: flowpad/hub/tests/api/test_basic_crud.py
(test_type_register, test_type_register_and_create)

Tests the register_type action which allows creating new entity types
dynamically, and then performing CRUD operations on those types.

SKIPPED: The register_type endpoint does not exist in minihub.
This is a cloud-only feature that requires the FlowPad service layer.
"""

import pytest

pytestmark = pytest.mark.skip(
    reason="register_type endpoint not implemented in minihub (cloud-only feature)"
)


async def test_register_new_type(bootstrapped_client):
    """Test registering a new entity type and querying it."""
    pass


async def test_register_and_create_entity(bootstrapped_client):
    """Test registering a new type and then creating an entity of that type."""
    pass


async def test_register_type_crud_cycle(bootstrapped_client):
    """Test full CRUD cycle on a dynamically registered type."""
    pass
