from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.data_spec import Body, FrontMatter


class SpecType(StrEnum):
    PLAN = "plan"
    ISSUE = "issue"
    SUPPORT_TICKET = "support_ticket"


class SpecDocSpec(FrontMatter):
    """``specs/<name>/spec.md`` — the shape of the document: two frontmatter
    keys and the markdown ``Body``. ``name`` is not here: it is the title, or
    the folder (``derive_spec``)."""

    title: Optional[str] = None
    spec_type: Optional[str] = None
    content: Body = ""


class Spec(Entity):
    type: str = APIField(default="spec")
    title: str = APIField("")
    content: Optional[str] = APIField(None, blob=True)
    spec_type: str = APIField(SpecType.PLAN)
    author_id: Optional[str] = APIField(None)
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)
    metadata: Optional[Dict[str, Any]] = APIField(None)

    @model_validator(mode="after")
    def _hydrate_content_from_asset_ref(self) -> "Spec":
        """The spec body lives in its ``asset_ref`` file (``specs/<name>/spec.md``)
        — the source of truth the indexer reads and the share bundle carries.
        ``content`` is a blob field that the entity GET does not expand, so a
        spec loaded from the DB row arrives with ``content=None`` and the editor
        renders blank. Hydrate it from the file (frontmatter stripped) whenever
        the row carries no inline content and the source file exists. No-op when
        content is already set (create / index paths) — so we never re-read or
        clobber a freshly-authored body.
        """
        if not (self.content or "").strip() and self.asset_ref:
            try:
                from pathlib import Path  # noqa: PLC0415

                from flow_sdk.fs_store.indexer._frontmatter import _extract_body  # noqa: PLC0415

                p = Path(self.asset_ref)
                if p.is_file():
                    object.__setattr__(self, "content", _extract_body(p.read_text(encoding="utf-8")))
            except OSError:
                pass
        return self
    # NOTE: plan_id moved into ``context_entities``. Use
    # ``spec.first_context_of_type('plan')`` to read it back.

    # NOTE: Spec's former ``author_id`` projection moved alongside other
    # implicit projections to ``Entity.get_implicit_private_context_entities``.
    # The base now projects ``project_id`` only; ``author_id`` was dropped
    # per "base returns project_id only for now". Override
    # ``get_implicit_private_context_entities`` here and call ``super()`` to
    # bring it back if the UX needs an author chip.
