"""The toy ENTITY-DOCUMENT type the document tests are pinned on.

One probe type, shared: ``<type>.json`` holds the header fields the spec declares and each
``Body`` lives beside it as ``<field>.md``. Two suites exercise the same mechanism (the
rendered document and its patch path), so the type — and its one registration of
``note_probe`` per session — is declared here once rather than in each of them.
"""
from __future__ import annotations

from typing import Optional

from pydantic import ConfigDict

from flow_sdk.assets.layout import Folder
from flow_sdk.fs_store.schema_registry import ENTITY_LAYOUT, TypeInfo
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io.native import Text

TYPE = "note_probe"


class NoteSpec(DataSpec):
    model_config = ConfigDict(extra="ignore")

    title: Optional[str] = None
    tags: list[str] = []
    text: Text = ""


def info(**overrides) -> TypeInfo:
    """The probe's ``TypeInfo``; ``overrides`` replace any declared field (a suite's
    ``owns_main_ref``, or the deliberately wrong shape/carrier a layout check refuses)."""
    return TypeInfo(**{
        "type_name": TYPE, "shape": Folder.entity_json(TYPE), "asset_spec": NoteSpec,
        "manifest_layout": ENTITY_LAYOUT, "name_from_path": True, **overrides,
    })
