"""What a kind looks like, and which apps edit a thing -- the two reads a shape-driven editor needs.

``GET /api/v1/kinds/{kind}``: the fields of a registered kind with their shapes and meanings, so an
editor can build its form from the schema (a ``data_schema`` folder's ``description``s ride
along). ``GET /api/v1/editors/{typeid}``: the apps that edit an entity, best first
(``flow_sdk.builtin.faas.editors``). ``GET /api/v1/viewers/{kind}``: the viewers that show a value
(or a list) of a kind, best first. ``GET /api/v1/values/{ref}?within=``: one stored value, named
by its reference ``<kind>.id.<uuid>``, from the asset that keeps it (``flow_sdk.values``).
``POST /api/v1/kinds/{kind}/check``: would this value fit the kind? Writes nothing.
``GET /api/v1/kinds/{kind}/datasets?project=``: the datasets whose rows are that kind.
Standard envelope, so the SDK reads them through ``apiClient``.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.webapp_spec import ViewShape

router = APIRouter()


def _fail(message: str, status_code: int) -> JSONResponse:
    """A failure WITH its HTTP status. A plain route returning ``ApiFailResponse`` answers 200 (only
    the graph dispatcher applies ``status_code``), and the SDK client unwraps a 200 to ``data`` --
    so a 404 must be a real 404, or the caller reads "no such kind" as a null answer."""
    return JSONResponse(status_code=status_code, content=ApiFailResponse(message=message).model_dump())


def kind_form(kind: str) -> dict | None:
    """``{kind, fields: {name: {shape, description, required}}}`` -- or, for a dataset kind, its
    example ``slots``. None when nothing registers ``kind``."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec  # noqa: PLC0415
    from flow_sdk.schema.data_spec.spec import NoAuthoringForm, to_authoring_form  # noqa: PLC0415
    from flow_sdk.schema.data_spec.value_ref import kind_of  # noqa: PLC0415

    kind = kind_of(kind)  # a reference to one value has its kind's form
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


@router.get("/api/v1/kinds/{kind}", response_model=None)
async def get_kind(kind: str) -> ApiResponse | JSONResponse:
    form = kind_form(kind)
    if form is None:
        return _fail(f"no kind {kind!r} is registered", 404)
    return ApiSuccessResponse(data=form)


def check_value(kind: str, value: Any) -> list[str] | None:
    """What is wrong with ``value`` as a value of ``kind`` -- ``[]`` when it fits, None when no kind of
    that name exists. An unknown name is NEVER answered as fitting: ``DataSpec.parse`` would resolve
    it to ``Any`` and accept anything."""
    from pydantic import TypeAdapter, ValidationError  # noqa: PLC0415

    from flow_sdk.schema.data_spec.spec import DataSpec  # noqa: PLC0415

    try:
        shape = DataSpec.parse(kind)
    except ValueError:
        return None
    if shape is Any:
        return None
    try:
        TypeAdapter(shape).validate_python(value)
    except ValidationError as exc:
        return [f"{'.'.join(str(p) for p in e['loc']) or 'value'}: {e['msg']}" for e in exc.errors(include_url=False)]
    return []


@router.post("/api/v1/kinds/{kind}/check", response_model=None)
async def check_kind(kind: str, body: dict = Body(...)) -> ApiResponse | JSONResponse:
    """``{"value": ...}`` → ``{kind, ok, errors}``; 404 when no kind of that name is registered."""
    if "value" not in body:
        return _fail("value: required", 400)
    errors = check_value(kind, body["value"])
    if errors is None:
        return _fail(f"no kind {kind!r} is registered", 404)
    return ApiSuccessResponse(data={"kind": kind, "ok": not errors, "errors": errors})


@router.get("/api/v1/kinds/{kind}/datasets", response_model=None)
async def kind_datasets(kind: str, project: str = "") -> ApiResponse:
    """The datasets whose rows are ``kind`` (``{datasets: [{id, name, title, project_id, asset_ref}]}``),
    in ``project`` when given -- how an app finds where a kind's rows live, once, by kind.

    The index proposes, the disk decides: a dataset is listed only while its folder still holds
    rows of ``kind`` (``Dataset.for_kind``'s own reading), once per folder -- so a stale index
    entry never makes this answer differ from the Python lookup."""
    from pathlib import Path  # noqa: PLC0415

    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415
    from flow_sdk.datasets.links import datasets_for_kind, owner_of, row_kind  # noqa: PLC0415
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

    def on_disk(asset_ref: Any) -> Optional[Path]:
        folder = Path(asset_ref).resolve() if asset_ref else None
        if folder is None or not folder.is_dir():
            return None
        return folder if folder in {f.resolve() for f in datasets_for_kind(kind, owner_of(folder))} else None

    found, seen = [], set()
    for d in await Dataset.get_all(QueryFilter(type=Dataset.get_type())):
        if row_kind(d.spec) != kind or (project and d.project_id != project):
            continue
        folder = on_disk(d.asset_ref)
        if folder is not None and folder not in seen:
            seen.add(folder)
            found.append(d)
    return ApiSuccessResponse(data={"datasets": [
        {"id": d.id, "name": d.name, "title": d.title, "project_id": d.project_id, "asset_ref": d.asset_ref}
        for d in found]})


@router.get("/api/v1/values/{ref}")
async def get_value(ref: str, within: str) -> ApiResponse:
    """``{kind, id, ref, value}`` for a value kept by the asset ``within`` names (its
    ``agentic-assets/value`` store)."""
    import asyncio  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
    from flow_sdk.schema.data_spec.value_ref import parse_ref  # noqa: PLC0415
    from flow_sdk.values import resolve_ref, store_of  # noqa: PLC0415

    parsed = parse_ref(ref)
    if parsed is None:
        return ApiFailResponse(message=f"{ref!r} is not a reference ('<kind>.id.<uuid>')", status_code=400)
    owner = await Entity.get_by_typeid(within)
    if owner is None or not getattr(owner, "asset_ref", None):
        return ApiFailResponse(message=f"no {within} to look in", status_code=404)
    try:
        value = await asyncio.to_thread(resolve_ref, ref, store_of(Path(str(owner.asset_ref))))
    except LookupError as exc:
        return ApiFailResponse(message=str(exc), status_code=404)
    return ApiSuccessResponse(data={"kind": parsed[0], "id": parsed[1], "ref": ref, "value": value.model_dump(mode="json")})


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
