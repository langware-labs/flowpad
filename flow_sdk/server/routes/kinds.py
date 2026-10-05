"""What a kind looks like, and which apps edit a thing -- the two reads a shape-driven editor needs.

``GET /api/v1/kinds/{kind}``: the fields of a registered kind with their shapes and meanings, so an
editor can build its form from the definition (a ``data_spec`` folder's ``description``s ride
along). ``GET /api/v1/editors/{typeid}``: the apps that edit an entity, best first
(``flow_sdk.assets.editors``). Standard envelope, so the SDK reads them through ``apiClient``.
"""

from __future__ import annotations

from fastapi import APIRouter

from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

router = APIRouter()


def kind_form(kind: str) -> dict | None:
    """``{kind, fields: {name: {shape, description, required}}}`` -- or, for a dataset kind, its
    example ``slots``. None when nothing registers ``kind``."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec  # noqa: PLC0415
    from flow_sdk.schema.data_spec.spec import NoAuthoringForm, to_authoring_form  # noqa: PLC0415

    shape = SchemaRegistry.kind_type(kind)
    if not isinstance(shape, type) or not hasattr(shape, "model_fields"):
        return None
    if issubclass(shape, DatasetSpec):
        row = shape.example_type()
        slots = {"input": row.input_type(), "output": row.output_type(), "context": row.context_type()}
        return {
            "kind": kind,
            "subkind": "dataset",
            "slots": {k: to_authoring_form(v) for k, v in slots.items() if v is not None and v.model_fields},
        }
    fields = {}
    for name, field in shape.model_fields.items():
        try:
            form = to_authoring_form(field.annotation)
        except NoAuthoringForm:
            form = None
        authored = (getattr(shape, "__field_forms__", None) or {}).get(name)
        fields[name] = {
            "shape": authored or form,
            "description": field.description or "",
            "required": field.is_required(),
        }
    return {"kind": kind, "subkind": "record", "description": shape.__doc__ or "", "fields": fields}


@router.get("/api/v1/kinds/{kind}")
async def get_kind(kind: str) -> ApiResponse:
    form = kind_form(kind)
    if form is None:
        return ApiFailResponse(message=f"no kind {kind!r} is registered", status_code=404)
    return ApiSuccessResponse(data=form)


@router.get("/api/v1/editors/{typeid}")
async def get_editors(typeid: str) -> ApiResponse:
    from flow_sdk.assets.editors import editors_for  # noqa: PLC0415
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    subject = await Entity.get_by_typeid(typeid)
    if subject is None:
        return ApiFailResponse(message=f"no {typeid}", status_code=404)
    return ApiSuccessResponse(data=await editors_for(subject))
