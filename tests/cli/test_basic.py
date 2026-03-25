import pytest


async def test_async_example():
    """Basic async test that passes."""
    result = await async_function()
    assert result is True


async def async_function():
    """Helper async function for testing."""
    return True


def test_basic_sync():
    """Basic synchronous test that passes."""
    assert True
