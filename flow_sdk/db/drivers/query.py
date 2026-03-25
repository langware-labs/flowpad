import json
import logging
import traceback
from enum import Enum, StrEnum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, ValidationError

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
    operands: List[Union["ExpressionNode", StrEnum, str, int, float, bool, List]] = []
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


class QueryFilter(BaseModel):
    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True, extra="forbid")

    type: str | None = None
    match: ExpressionNode | None = None
    order_by: Optional[OrderType | List[OrderType]] = None
    limit: Optional[int] = None
    offset: Optional[int] = None
    expand: Optional[List[str]] = None

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

            if "match" not in data:
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
