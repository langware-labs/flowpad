"""Fixtures shared by every data-source matrix.

The suites differ in TRANSPORT — one writes files, one commits — but they assert
the same things about the same content, so the content and the assertions live
here and only the mechanism is written twice.

Keeping the tokens in one place matters more than it looks: an update test
asserts the OLD token has stopped matching and the NEW one has started, so two
suites drifting to different literals would silently weaken one of them.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.core.entity.entity_model import Entity

#: Bare alphanumeric on purpose. FTS appends `*` per term and quotes anything
#: containing `.+^(){}[]~?\/:!-`, and the search route pre-strips `-/_:` — a
#: token with punctuation would be testing the tokenizer, not the index.
FIRST_TOKEN = "quartzfeather"
SECOND_TOKEN = "zinctrellis"

DOC_BODY = f"# Alpha\n\n{FIRST_TOKEN} is a distinctive token for full-text assertions.\n"
DOC_BODY_UPDATED = f"# Alpha\n\n{SECOND_TOKEN} replaced it.\n"

SKILL_BODY = f"""---
name: alpha-skill
description: A skill used by the data-source matrix.
---

# Alpha Skill

{FIRST_TOKEN} steps for the matrix.
"""

SKILL_BODY_UPDATED = f"""---
name: alpha-skill
description: A skill used by the data-source matrix.
---

# Alpha Skill

{SECOND_TOKEN} steps, revised.
"""


async def entity_at(path: Path):
    """The entity owning ``path`` — containment-resolved, so a file inside a
    folder-layout asset answers with the asset."""
    return await Entity.get_by_asset_ref(str(path), resolve_containing=True)


async def id_at(path: Path):
    entity = await entity_at(path)
    return str(entity.id) if entity is not None else None


async def searchable(token: str, record_type: str = "markdown") -> bool:
    """Is ``token`` findable in the full-text index right now?"""
    return bool(await Entity.search(token, limit=50, record_type=record_type))
