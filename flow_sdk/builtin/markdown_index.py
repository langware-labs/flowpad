"""MarkdownIndex entity — single-file LLM-generated folder index.

A `MarkdownIndex` IS an `index.md` file on disk. Its YAML frontmatter holds
all entity metadata (inputs_hash, parent_ref, etc.); its markdown body is the
human-readable index of files + subfolders in the containing directory.

Merkle property: a parent `MarkdownIndex` (one folder up) reads each child's
`index.md` content into its own `inputs_hash`, so a leaf-file change
invalidates exactly the chain from leaf to root — nothing else.

Build runs as an `AgenticProcess` tagged `context_data.kind = "markdown_index_rebuild"`;
the linked process id is stored on `latest_process_ref`.
"""

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.claude_memory_entities import Markdown
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class MarkdownIndex(Markdown):
    type: str = APIField(default=BuiltinEntityType.MARKDOWN_INDEX.value)
    asset_type: str = APIField(default="markdown_index")

    inputs_hash: str = APIField(default="")
    template_version: int = APIField(default=1)
    prompt_version: int = APIField(default=1)

    parent_ref: str = APIField(default="")
    file_count: int = APIField(default=0)
    subfolder_count: int = APIField(default=0)
    latest_process_ref: str = APIField(default="")

