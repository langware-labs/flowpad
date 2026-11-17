"""``rca.json`` — the entity document of a root-cause analysis (builtin/rca.py).

Carries the row's id in its root and every field of the row, so the document alone rebuilds the row.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec


class RcaSpec(AssetDocumentSpec):
    main_file: ClassVar[str | None] = "rca.json"
    #: An entity document: it carries its own id in its root, the way ``compute_op.json`` does.
    manifest_layout: ClassVar[str | None] = "entity"

    #: The analysis's name AND its folder name.
    name: Optional[str] = None
    subject: Optional[str] = None
    complexity: Optional[str] = None
    severity: Optional[str] = None
    description_md: str = ""
    suggested_fix_md: Optional[str] = None
