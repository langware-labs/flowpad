"""Type metadata for SPEC."""
from typing import Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_id, resolved_path_key, write_frontmatter
from flow_sdk.fs_store.indexer.functions.spec import (
    extract_spec,
)
from flow_sdk.schema.type_info import TypeMetadata, render_entity_frontmatter
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class SpecMeta(BaseMeta):
    title: Optional[str] = None
    spec_type: Optional[str] = None


def _spec_default_body(entity) -> str:
    """Markdown written to the spec's main_ref (``specs/<name>/spec.md``).

    ``Spec`` owns its main_ref, so this re-renders on every save. Frontmatter
    matches what ``extract_spec`` parses back (id/title/spec_type) and the body
    is ``content`` (which ``extract_spec`` stores frontmatter-free, so the
    round-trip is stable — no frontmatter accumulation).
    """
    title = (getattr(entity, "title", None) or getattr(entity, "name", None) or "").strip()
    fields = {
        "title": title,
        "spec_type": getattr(entity, "spec_type", None) or "plan",
    }
    body = (getattr(entity, "content", None) or "").strip()
    return render_entity_frontmatter(entity, fields) + "\n\n" + body + ("\n" if body else "")


SPEC = TypeMetadata(
    type=EntityType.SPEC,
    from_disk_fn=extract_spec,
    id_from_file_fn=frontmatter_id,
    id_stable_key_fn=resolved_path_key,
    id_write_fn=write_frontmatter,
    indexed_by_default=True,
    browseable_by=ViewMode.STANDARD,
    icon="FileText",
    api_visible=True,
    index_fields=["name", "spec_type"],
    asset_class="repo",
    family="spec",
    main_layout="folder",
    main_file="spec.md",
    # asset_ref IS specs/<name>/spec.md (the indexer emits the inner file), so
    # both create and rescan agree on the inner-file path.
    main_file_is_asset_ref=True,
    default_body_fn=_spec_default_body,
    # WRITE-ONCE (owns_main_ref stays False): a DB-only spec materializes its
    # ``specs/<name>/spec.md`` body file the first time it's saved without one,
    # so the file exists to carry into a bundle and to index from. Thereafter
    # the file is USER DATA — preserved verbatim, never re-rendered on save
    # (re-rendering would mutate the user's file). Original filenames from a
    # received bundle are kept as-is via the record's existing asset_ref.
    meta_model=SpecMeta,
)
