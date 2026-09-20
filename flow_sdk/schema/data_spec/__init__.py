"""``DataSpec`` — the shape of data, as a class. See ``spec.py``.

``FrontMatter`` is a ``DataSpec`` for a disk document (``extra="ignore"``).
Where a field lands is read off its TYPE — ``Text`` is a document body,
``FreeForm`` a free section, a nested document its own file — never off a
marker. What a type's document holds is its ``TypeInfo.asset_spec``.
"""
from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec, FrontMatter, SectionedHeader
from flow_sdk.schema.data_spec.spec import DataSpec, SpecType, Tagged, to_authoring_form

__all__ = ["AssetDocumentSpec", "DataSpec", "FrontMatter", "SectionedHeader", "SpecType", "Tagged", "to_authoring_form"]
