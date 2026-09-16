"""``SourceConfig`` — the typed config one data driver takes, declared as ``Config`` on its ``Source``.

A driver's ``source.py`` owns the shape of its config the way it owns everything else about itself::

    class FeedConfig(SourceConfig):
        urls: list[Annotated[str, StringConstraints(pattern=r"^https?://")]] = Field(min_length=1)

    class FeedSource(CollectionSource):
        Config = FeedConfig

The manifest's ``config`` catalog keeps only what a form needs to draw a field (label, hint, widget);
the rules — required, pattern, default, type — are this class, and the loader refuses a driver whose
catalog and ``Config`` disagree. A config is VALUE-FREE: a secret is a credential the driver declares
in ``auth``, never a field here.

Three ways a config is read, because three callers want three different things:

* ``Config.model_validate(raw)`` — a create: every rule, and an error names the field.
* ``Config.draft(raw)`` — a form half filled in: the keys that are there and valid, nothing else.
* ``Config.best_match(raw)`` — a stored row: whatever still validates, a default for what does not.
"""
from __future__ import annotations

from typing import Any, ClassVar, Mapping, Union, get_args, get_origin

from pydantic import ConfigDict, TypeAdapter, ValidationError, model_validator
from pydantic.fields import FieldInfo

from flow_sdk.schema.data_spec.spec import DataSpec


def _is_list(annotation: Any) -> bool:
    origin = get_origin(annotation)
    if origin is Union:
        return any(_is_list(arg) for arg in get_args(annotation) if arg is not type(None))
    return origin in (list, tuple, set, frozenset)


def _number(annotation: Any) -> type | None:
    for candidate in (annotation, *get_args(annotation)):
        if candidate in (int, float):
            return candidate
    return None


def coerce_value(field: FieldInfo, value: Any) -> Any:
    """A value as a person typed it → the field's shape: a list field splits a string on lines (or
    commas, for one line), a number field parses one. Anything else passes through for the
    validator to accept or name."""
    if not isinstance(value, str):
        return value
    annotation = field.annotation
    if _is_list(annotation):
        sep = "\n" if "\n" in value else ","
        return [part.strip() for part in value.split(sep) if part.strip()]
    kind = _number(annotation)
    if kind is not None and value.strip():
        try:
            number = float(value)
        except ValueError:
            return value
        return int(number) if kind is int and number.is_integer() else number
    return value


class ChoiceEntry(DataSpec):
    """One entry a person PICKED from a choosable field: the id the source reads and the name the
    form showed. A typed id beside it stays a plain string."""

    model_config = ConfigDict(frozen=True)

    id: str
    name: str = ""


class SourceConfig(DataSpec):
    """Base of every driver's ``Config``. Frozen: a config is a value."""

    model_config = ConfigDict(frozen=True)

    #: Fields the application fills (``Source.configure``), never the form: exempt from the catalog.
    derived: ClassVar[tuple[str, ...]] = ()

    @classmethod
    def lift(cls, raw: Mapping[str, Any]) -> dict[str, Any]:
        """A config written under older key names, as this class names them. Override to adopt a
        renamed key; every read — create, draft, best match — goes through it."""
        return dict(raw)

    @model_validator(mode="before")
    @classmethod
    def _coerce_strings(cls, data: Any) -> Any:
        if not isinstance(data, Mapping):
            return data
        fields = cls.model_fields
        return {k: (coerce_value(fields[k], v) if k in fields else v) for k, v in cls.lift(data).items()}

    @classmethod
    def draft(cls, raw: Mapping[str, Any]) -> dict[str, Any]:
        """The keys of ``raw`` this config knows and that validate on their own — a form in
        progress. Unknown and invalid keys are dropped, silently: the form names them."""
        raw = cls.lift(raw or {})
        return {k: v for k, (ok, v) in ((k, _one(cls, k, raw[k])) for k in raw) if ok}

    @classmethod
    def best_match(cls, raw: Mapping[str, Any]) -> dict[str, Any]:
        """A stored config read as well as it can be: every known key that still validates, the
        declared default for one that no longer does. Never raises — a row saved under an older
        rule keeps running on what still makes sense."""
        try:  # the common case: a stored config that is simply valid
            return cls.model_validate(raw or {}).model_dump(mode="json")
        except ValidationError:
            pass
        valid = cls.draft(raw or {})
        out: dict[str, Any] = {}
        for name, field in cls.model_fields.items():
            if name in valid:
                out[name] = valid[name]
            elif not field.is_required():
                default = field.get_default(call_default_factory=True, validated_data=out)
                out[name] = _adapter(cls, name).dump_python(default, mode="json")
        return out

    @classmethod
    def secret_fields(cls) -> list[str]:
        """Fields typed as a secret — which a config must never have."""
        from pydantic import SecretBytes, SecretStr  # noqa: PLC0415

        return [
            name for name, field in cls.model_fields.items()
            if any(arg in (SecretStr, SecretBytes) for arg in (field.annotation, *get_args(field.annotation)))
        ]


def _one(config: type[SourceConfig], name: str, value: Any) -> tuple[bool, Any]:
    field = config.model_fields.get(name)
    if field is None:
        return False, None
    adapter = _adapter(config, name)
    try:
        # Plain JSON values, as a row stores them and a source reads them.
        return True, adapter.dump_python(adapter.validate_python(coerce_value(field, value)), mode="json")
    except ValidationError:
        return False, None


def _adapter(config: type[SourceConfig], name: str) -> TypeAdapter:
    """One field's validator, kept on its class so a reloaded driver's old class takes its cache with it."""
    cache = config.__dict__.get("_field_adapters")
    if cache is None:
        cache = {}
        setattr(config, "_field_adapters", cache)
    if name not in cache:
        from typing import Annotated  # noqa: PLC0415

        field = config.model_fields[name]
        cache[name] = TypeAdapter(Annotated[(field.annotation, *field.metadata)]) if field.metadata else TypeAdapter(field.annotation)
    return cache[name]


__all__ = ["ChoiceEntry", "SourceConfig", "coerce_value"]
