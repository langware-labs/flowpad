"""``DataSpec`` — the shape of data, as a class. See ``spec.py``.

``FrontMatter`` is a ``DataSpec`` for a disk document (``extra="ignore"``);
``Body`` / ``FreeSection`` mark the document's body and free section. What a
type's document holds is its ``TypeInfo.asset_spec``.
"""
from flow_sdk.schema.data_spec.frontmatter import FrontMatter, SectionedHeader
from flow_sdk.schema.data_spec.markers import Body, FreeSection
from flow_sdk.schema.data_spec.spec import DataSpec, SpecType, to_authoring_form

__all__ = ["Body", "DataSpec", "FreeSection", "FrontMatter", "SectionedHeader", "SpecType", "to_authoring_form"]
