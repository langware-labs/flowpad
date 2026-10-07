"""What a kind looks like, and which apps edit a thing -- the two reads a shape-driven editor needs.

``GET /api/v1/kinds/{kind}``: the fields of a registered kind with their shapes and meanings, so an
editor can build its form from the schema (a ``data_schema`` folder's ``description``s ride
along). ``GET /api/v1/editors/{typeid}``: the apps that edit an entity, best first
(``flow_sdk.builtin.faas.editors``). ``GET /api/v1/viewers/{kind}``: the viewers that show a value
(or a list) of a kind, best first. Standard envelope, so the SDK reads them through ``apiClient``.
"""

from __future__ import annotations

from fastapi import APIRouter

from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.webapp_spec import ViewShape

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
    # A schema a data schema FOLDER defines keeps the forms its author wrote (``enum:``, ``?``).
    authored = getattr(shape, "__authoring__", None) or {}
    fields = {}
    for name, field in shape.model_fields.items():
        form = authored.get(name)
        if form is None:
            try:
                form = to_authoring_form(field.annotation)
            except NoAuthoringForm:
                form = None
        fields[name] = {"shape": form, "description": field.description or "", "required": field.is_required()}
    return {"kind": kind, "subkind": "record", "description": shape.__doc__ or "", "fields": fields}


@router.get("/api/v1/kinds/{kind}")
async def get_kind(kind: str) -> ApiResponse:
    form = kind_form(kind)
    if form is None:
        return ApiFailResponse(message=f"no kind {kind!r} is registered", status_code=404)
    return ApiSuccessResponse(data=form)


@router.get("/api/v1/editors/{typeid}")
async def get_editors(typeid: str) -> ApiResponse:
    from flow_sdk.builtin.faas.editors import editors_for  # noqa: PLC0415
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    subject = await Entity.get_by_typeid(typeid)
    if subject is None:
        return ApiFailResponse(message=f"no {typeid}", status_code=404)
    return ApiSuccessResponse(data=await editors_for(subject))


@router.get("/api/v1/viewers/{kind}")
async def get_viewers(kind: str, shape: ViewShape = "single", within: str = "") -> ApiResponse:
    """The viewers that show ``kind`` as a ``single`` value or a ``collection``, best first."""
    from flow_sdk.builtin.faas.editors import viewers_for  # noqa: PLC0415
    from flow_sdk.worldview.ontology import normalize_kind  # noqa: PLC0415

    try:
        normalize_kind(kind)
    except ValueError as exc:  # a malformed kind (``*`` is a viewer's wildcard, not a kind) is the caller's
        return ApiFailResponse(message=f"{kind!r} is not a kind: {exc}", status_code=400)
    return ApiSuccessResponse(data=await viewers_for(kind, shape, within or None))
