"""The cleanup list must cover every hub type this tier creates.

``_CLEANUP_TYPES`` in ``conftest.py`` is a hardcoded tuple, and a hardcoded
tuple drifts: someone adds a test that POSTs a new entity type, nothing
complains, and that type quietly accumulates on the hub forever — which is the
exact failure the cleanup exists to stop. It went unnoticed long enough to reach
417 conversations, 36 organizations, 18 teams and 17 skills on one dev hub.

Discovering the types at runtime is not viable: ``BuiltinEntityType`` has ~160
members, and snapshotting each one per identity would cost hundreds of HTTP
round-trips per run to watch types no test ever touches. So the list stays
explicit and this test keeps it honest.

Two creation shapes exist here and both must be caught — the first version of
this guard only caught the first, and reported ``organization`` and ``team`` as
uncovered-by-nobody when in fact tests create them constantly:

  1. a literal path — ``post(f"{hub}/api/v1/graph/skill", ...)``
  2. a parameterised one — ``post(f"{hub}/api/v1/graph/{etype}", ...)`` with
     ``etype`` passed in as ``"organization"`` / ``"team"``

Shape 2 cannot be resolved statically, so any file that builds a dynamic
``/graph/{...}`` path has ALL its entity-type-looking string literals treated as
candidates. That over-detects by design: a spurious entry costs one extra
snapshot per run, while a missed one leaks rows forever. Cheap direction to be
wrong in.
"""

from __future__ import annotations

import re
from pathlib import Path

from tests.hub_tests.conftest import _CLEANUP_TYPES

_TIER = Path(__file__).resolve().parent

# Shape 1 — POST straight at a literal type. Anchored on POST because the tier
# GETs plenty of types it never creates, and flagging those would be noise.
# A trailing quote means ``/graph/<type>`` (a create); a trailing slash means
# ``/graph/<type>/<id>/<action>`` (join, members, add_message), which mints
# nothing.
_LITERAL_POST = re.compile(r"post\(\s*[^)]*?/graph/(?P<type>[a-z_]+)(?P<tail>[\"'])", re.IGNORECASE | re.DOTALL)

# Shape 2 — the path's type segment is an f-string placeholder.
_DYNAMIC_GRAPH_PATH = re.compile(r"/graph/\{")

# A literal in call-argument position. The lookbehinds matter: without them
# this matched ``data.get("api_key")`` and ``payload["user"]`` — JSON FIELD
# names that happen to collide with entity types — and would have pushed
# ``user`` onto a list of things to DELETE. Over-detecting a type is cheap;
# over-detecting into "delete every user account" is not.
_STRING_LITERAL = re.compile(r"(?<!\.get\()(?<!\[)[\"']([a-z][a-z_]{2,30})[\"']")


def _known_hub_types() -> set[str]:
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

    return {t.value for t in BuiltinEntityType}


def _types_created_by_the_tier() -> set[str]:
    known = _known_hub_types()
    found: set[str] = set()
    for path in sorted(_TIER.glob("test_*.py")):
        if path.name == Path(__file__).name:
            continue
        source = path.read_text()
        for m in _LITERAL_POST.finditer(source):
            found.add(m.group("type"))
        if _DYNAMIC_GRAPH_PATH.search(source):
            # Cannot resolve the placeholder — treat every entity-type-shaped
            # literal in the file as a candidate. Over-detection is the safe
            # direction (see the module docstring).
            found |= {lit for lit in _STRING_LITERAL.findall(source) if lit in known}
    return found


def test_cleanup_covers_every_type_the_tier_creates():
    """Fail with the missing type names, not a bare boolean."""
    uncovered = sorted(_types_created_by_the_tier() - set(_CLEANUP_TYPES))
    assert not uncovered, (
        f"these hub types are created by tests but never reclaimed: {uncovered}. "
        f"Add them to _CLEANUP_TYPES in tests/hub_tests/conftest.py, or they will "
        f"accumulate on the hub forever — that is how this tier reached 417 stale "
        f"conversations. Currently covered: {sorted(_CLEANUP_TYPES)}"
    )
