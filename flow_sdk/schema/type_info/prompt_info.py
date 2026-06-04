"""Type metadata for PROMPT (docs/prompt-library.md)."""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.prompt import (
    extract_prompt,
    prompt_gen_id,
)


class PromptMeta(BaseMeta):
    icon: Optional[str] = None
    color: Optional[str] = None


PROMPT = TypeMetadata(
    type=EntityType.PROMPT,
    from_disk_fn=extract_prompt,
    gen_id_fn=prompt_gen_id,
    indexed_by_default=True,
    browseable=True,
    # v1: creation lives in the Prompt Library menu (PromptEditDialog with the
    # generic pickers); the AssetsPage quick-create path needs a descriptor in
    # quick-create/registry.ts before this flips on.
    creatable=False,
    icon="BookMarked",
    api_visible=True,
    index_fields=["name", "group_id"],
    main_subdir="prompts",
    meta_model=PromptMeta,
)
