import pytest


@pytest.fixture(autouse=True)
def _records(tmp_records_root):
    """Every lifecycle record of these tests lives under the test's tmp folder."""
    return tmp_records_root
