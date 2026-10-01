"""Project names are unique across the (shared) unit-test database, so a fixture that
reuses a literal name — "dst", "proj", "customer" — collides with the row an earlier test
left behind. Tests that build a Project name it through this helper."""

import uuid


def unique_project_name(base: str) -> str:
    return f"{base}-{uuid.uuid4().hex[:8]}"
