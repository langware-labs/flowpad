"""Reading a recorded diagnosis back.

A diagnosis is asked for through Ask for help (``ask_for_help_action``) -- "Diagnose & fix" is the same
request with nobody asked and ``purpose=repair`` -- or from the CLI (``flow diagnose``). These are the
reads both share: a ``flowpad_diagnosis`` record by id, and the ``DiagnosisSpec`` it carries.
"""

from __future__ import annotations


async def diagnosis_value(record):
    """The full diagnosis a recorded ``flowpad_diagnosis`` carries -- its ``diagnosis`` value, else
    one made of its headline fields (a record written before that value existed)."""
    from flow_sdk.schema.data_spec.diagnose_spec import DiagnosisSpec  # noqa: PLC0415

    value = getattr(record, "diagnosis", None)
    if isinstance(value, DiagnosisSpec):
        return value
    if isinstance(value, dict) and value:
        return DiagnosisSpec.model_validate(value)
    return DiagnosisSpec(**{k: getattr(record, k, None) or "" for k in ("title", "summary", "symptoms", "rca", "fix")})


async def recorded_diagnosis(diagnosis_id: str):
    """The ``flowpad_diagnosis`` of this id, or ``None``."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    cls = SchemaRegistry.get_entity_cls(EntityType.FLOWPAD_DIAGNOSIS)
    return await cls.get_by_id(diagnosis_id) if (cls and diagnosis_id) else None
