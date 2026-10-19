"""A registered kind, as the form an editor or a viewer builds from: its fields with their shapes
and meanings -- or, for a dataset kind, its example slots."""

from __future__ import annotations


def kind_form(kind: str) -> dict | None:
    """``{kind, fields: {name: {shape, description, required, owned_by?}}, rules: [{same | unique,
    description}]}`` (a record's included fields and rules among them) -- or,
    for a dataset kind, its example ``slots``. None when nothing registers ``kind``."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec  # noqa: PLC0415
    from flow_sdk.schema.data_spec.spec import NoAuthoringForm, to_authoring_form  # noqa: PLC0415
    from flow_sdk.schema.data_spec.value_ref import kind_of  # noqa: PLC0415

    kind = kind_of(kind)  # a reference to one value has its kind's form
    shape = SchemaRegistry.kind_type(kind)
    if not isinstance(shape, type) or not hasattr(shape, "model_fields"):
        return None
    if issubclass(shape, DatasetSpec):
        row = shape.row_type()
        slots = {"input": row.input_type(), "output": row.output_type(), "context": row.context_type()}
        return {
            "kind": kind,
            "subkind": "dataset",
            "slots": {k: to_authoring_form(v) for k, v in slots.items() if v is not None and v.model_fields},
        }
    # A schema a data schema FOLDER defines keeps the forms its author wrote (``enum:``, ``?``).
    authored = getattr(shape, "__authoring__", None) or {}
    owned = getattr(shape, "__owned__", None) or {}
    fields = {}
    for name, field in shape.model_fields.items():
        form = authored.get(name)
        if form is None:
            try:
                form = to_authoring_form(field.annotation)
            except NoAuthoringForm:
                form = None
        fields[name] = {"shape": form, "description": field.description or "", "required": field.is_required()}
        if name in owned:   # a copy of an outside system's value: read-only to everyone but that owner
            fields[name]["owned_by"] = owned[name]
    from flow_sdk.datasets.rules import rules_of  # noqa: PLC0415

    rules = [rule.model_dump(mode="json", exclude_none=True) for rule in rules_of(shape)]
    return {"kind": kind, "subkind": "record", "description": shape.__doc__ or "", "fields": fields, "rules": rules}
