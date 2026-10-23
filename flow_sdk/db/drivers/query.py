import json
import logging
import re
import traceback
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from flow_sdk._compat import StrEnum
from flow_sdk.flowpad_types.enums import ExpansionType


class QueryOp(Enum):
    OR = "$OR"
    AND = "$AND"
    EQ = "$EQ"
    NE = "$NE"
    GT = "$GT"
    GE = "$GE"
    LT = "$LT"
    LE = "$LE"
    IN = "$IN"
    NIN = "$NIN"
    LIKE = "$LIKE"
    IS_NULL = "$IS_NULL"
    IS_NOT_NULL = "$IS_NOT_NULL"
    PROP = "$PROP"


class ExpressionNode(BaseModel):
    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True)
    # IS_NULL/IS_NOT_NULL are unary: canonical wire shape ``operands=[field]``
    # (a trailing JSON null does not survive axios GET param serialization).
    # ``None`` stays admitted so the legacy ``[field, None]`` form still parses.
    # ``datetime`` is admitted for COLUMN comparisons (``created_date``): the SQLite DateTime
    # type binds only a datetime, so an ISO string would be rejected at execution.
    operands: List[Union["ExpressionNode", StrEnum, str, int, float, bool, datetime, List, None]] = []
    op: Optional[QueryOp] = QueryOp.EQ

    def __init__(self, **data):
        if "operands" not in data:
            if len(data.keys()) == 1:
                object_key = list(data.keys())[0]
                data["operands"] = [object_key, data[object_key]]
            else:
                op_list = [{k: v} for k, v in data.items()]
                data = {"operands": op_list, "op": QueryOp.AND}
        super().__init__(**data)


OrderType = Dict[str, Literal["asc", "desc"]]
#: The keys of a filter beside `match` (`QueryFilter.parse`).
_FILTER_WORDS = frozenset({"limit", "offset", "order_by", "expand"})
#: The same words in the hub's order (``PAGING_KEYS`` there).
PAGING_KEYS = ("limit", "offset", "order_by", "expand")
# A plain field name, as on the hub; the desktop also sorts on dotted JSON paths (``input.created``), each
# segment a plain name.
_FIELD_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")


def order_terms(order_by, paged: bool = False) -> list[tuple[str, bool]]:
    """``(field, descending)`` terms for ``order_by`` — the hub's rule: a page with no order is newest first
    (``created_date DESC``), and whenever there is an order the ``id`` settles every tie so equal keys never
    shuffle rows between pages."""
    if isinstance(order_by, (dict, str)):
        order_by = [order_by]
    terms: list[tuple[str, bool]] = []
    for spec in order_by or []:
        if isinstance(spec, str):
            spec = {spec.lstrip("-"): "desc" if spec.startswith("-") else "asc"}
        if isinstance(spec, dict):
            for field, direction in spec.items():
                terms.append((field, str(direction).lower() == "desc"))
    if paged and not terms:
        terms = [("created_date", True)]
    if terms and not any(field == "id" for field, _ in terms):
        terms.append(("id", False))
    return terms


def sort_in_order(rows: list, order_by, paged: bool = False) -> list:
    """``rows`` in the order the database would answer them (``order_terms``): nulls last ascending and
    first descending, as on the hub. For lists a database cannot order — a merge of two reads."""
    for field, descending in reversed(order_terms(order_by, paged)):
        rows.sort(key=lambda r, f=field: (getattr(r, f, None) is None, getattr(r, f, None)), reverse=descending)
    return rows


class QueryFilter(BaseModel):
    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True, extra="forbid")

    type: str | None = None
    match: ExpressionNode | None = None
    order_by: Optional[OrderType | List[OrderType]] = None
    limit: Optional[int] = Field(None, ge=1)
    offset: Optional[int] = Field(None, ge=0)
    expand: Optional[List[str]] = None

    @field_validator("order_by")
    @classmethod
    def _order_by_fields_are_identifiers(cls, value):
        # ORDER BY keys cannot be bound parameters, so a key that is not a plain field name is refused here.
        for spec in value if isinstance(value, list) else [value] if value else []:
            for field in spec:
                if not _FIELD_NAME_RE.match(field):
                    raise ValueError(f"order_by: not a field name: {field!r}")
        return value

    def __init__(self, **data):
        super().__init__(**data)

    def _add_expand(self, expand: str):
        if not self.expand:
            self.expand = []
        if expand not in self.expand:
            self.expand.append(expand)

    def _remove_expand(self, expand: str):
        if self.expand and expand in self.expand:
            self.expand.remove(expand)

    # noinspection PyUnresolvedReferences
    @classmethod
    def available_expansions(cls) -> List[str]:
        return [expansion_type.value for expansion_type in ExpansionType]

    @property
    def expanded_field_names(self) -> List[str]:
        return self.expand or []

    @property
    def expand_auth_scopes(self) -> bool:
        if not self.expand:
            return False
        return ExpansionType.AuthScopes.value in self.expand

    @expand_auth_scopes.setter
    def expand_auth_scopes(self, value: bool):
        if value:
            self._add_expand(ExpansionType.AuthScopes.value)
        else:
            self._remove_expand(ExpansionType.AuthScopes.value)

    @property
    def expand_permissions(self) -> bool:
        if not self.expand:
            return False
        return ExpansionType.Permissions.value in self.expand

    @expand_permissions.setter
    def expand_permissions(self, value: bool):
        if value:
            self._add_expand(ExpansionType.Permissions.value)
        else:
            self._remove_expand(ExpansionType.Permissions.value)

    @property
    def expand_is_private(self) -> bool:
        if not self.expand:
            return False
        return ExpansionType.IsPrivate.value in self.expand

    @expand_is_private.setter
    def expand_is_private(self, value: bool):
        if value:
            self._add_expand(ExpansionType.IsPrivate.value)
        else:
            self._remove_expand(ExpansionType.IsPrivate.value)

    @property
    def expand_blobs(self) -> bool:
        if not self.expand:
            return False
        return ExpansionType.Blobs.value in self.expand

    @expand_blobs.setter
    def expand_blobs(self, value: bool):
        if value:
            self._add_expand(ExpansionType.Blobs.value)
        else:
            self._remove_expand(ExpansionType.Blobs.value)

    @staticmethod
    def by_type(entity_type: str, keyval_match: dict | None = None) -> "QueryFilter":
        if keyval_match:
            return QueryFilter.parse({"match": keyval_match}, entity_type)
        return QueryFilter.parse({}, entity_type)

    @staticmethod
    def parse(filter_json: str | Dict[str, Any], entity_type: str | None = None) -> "QueryFilter":
        try:
            if isinstance(filter_json, str):
                data = json.loads(filter_json)
            else:
                data = filter_json

            # A map without `match` is the match itself (`{"status": "open"}`) -- unless every key is a
            # filter word: `{"limit": 3}` is a page of three, never "the rows whose limit is 3".
            if "match" not in data and not (data and set(data) <= _FILTER_WORDS):
                data = {"match": data}
            e = QueryFilter(**data)
            if entity_type:
                e.type = entity_type.lower()
            return e
        except json.JSONDecodeError as e:
            logging.error(f"JSONDecodeError: {filter_json=} {entity_type=} {traceback.format_exc()}")
            raise ValueError(f"Invalid query filter JSON: {e}")
        except ValidationError as e:
            logging.error(f"ValidationError: {filter_json=} {entity_type=} {traceback.format_exc()}")
            raise ValueError(f"Validation error: {e}")
        except Exception as e:
            logging.error(f"Unexpected error: {filter_json=} {entity_type=} {traceback.format_exc()}")
            raise ValueError(f"An unexpected error occurred: {e}")
