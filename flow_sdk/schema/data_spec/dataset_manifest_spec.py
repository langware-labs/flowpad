"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import logging
from typing import Annotated, Any, Dict, Optional

from pydantic import BeforeValidator, PlainSerializer, ValidationError, model_validator

from flow_sdk.schema.data_spec import FreeSection, FrontMatter, to_authoring_form
from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec

logger = logging.getLogger(__name__)


DatasetSpecType = Annotated[type, BeforeValidator(DatasetSpec.parse), PlainSerializer(to_authoring_form, return_type=Any)]


class DatasetManifestSpec(FrontMatter):
    """The ``metadata`` section of ``dataset.json`` — the fields a human authors.
    The denormalized counts are NOT here: the indexer computes them from the
    rows, and writing them back would make the manifest lie after an append.

    A malformed ``spec`` ON DISK degrades the SLOT, never the dataset: raising
    would cost every example row, and an ``orphan_action=DELETE`` sweep would
    then reap rows that parsed fine. That is a disk-read policy — the entity
    field itself is strict — so it lives here, at the header read.
    """

    @model_validator(mode="before")
    @classmethod
    def _lenient_spec(cls, values: Any) -> Any:
        raw = values.get("spec") if isinstance(values, dict) else None
        if raw is None or isinstance(raw, type):
            return values
        try:
            DatasetSpec.parse(raw)
        except (ValueError, ValidationError) as exc:
            logger.warning("[dataset] ignoring malformed `spec`: %s", exc)
            return {k: v for k, v in values.items() if k != "spec"}
        return values

    title: Optional[str] = None
    description: Optional[str] = None
    #: The DataSource whose items this dataset curates (empty when hand-authored).
    source_id: Optional[str] = None
    data_layout: Optional[str] = None
    field_spec: Optional[Dict[str, str]] = None
    delimiter: Optional[str] = None
    spec: Optional[DatasetSpecType] = None
    #: The free ``data`` section of ``dataset.json`` — the document's second half.
    data: Optional[FreeSection] = None
