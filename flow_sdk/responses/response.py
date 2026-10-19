"""API Response classes for standardized API responses.

Ported from FlowPad: flowpad/hub/core/responses/response.py
"""

import json
import logging
from enum import Enum
from typing import Generic, TypeVar

from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class ApiResponseStatus(Enum):
    """API response status values"""
    NA = "NA"
    SUCCESS = "SUCCESS"
    FAIL = "FAIL"
    TIMEOUT = "TIMEOUT"


class ApiResponse(BaseModel, Generic[T]):
    """Generic API response container

    Attributes:
        status: Response status (SUCCESS, FAIL, TIMEOUT, NA)
        message: Optional message describing the response
        request_id: Optional request identifier
        data: Response payload of type T
        warnings: Non-fatal problems the caller should know about on an otherwise
            successful response — each ``{"error_code": ..., "message": ...}``.
            ``status`` stays SUCCESS (the client treats anything else as a
            failure); the list is only serialized when non-empty.
    """
    model_config = ConfigDict(use_enum_values=True)
    status: ApiResponseStatus = Field(default=ApiResponseStatus.NA, validate_default=True)
    message: str | None = None
    request_id: str | None = None
    data: T | None = None
    warnings: list[dict] | None = None

    def model_dump(self, **kwargs) -> dict:
        """Safely dump response to dict, handling nested models"""
        exclude_none = kwargs.get("exclude_none", False)

        # Use FastAPI's jsonable_encoder for safe JSON serialization
        data = jsonable_encoder(self.data, exclude_none=exclude_none)

        res = {
            "status": self.status,
            "message": self.message,
            "data": data,
        }
        if self.request_id is not None:
            res["request_id"] = self.request_id
        if self.warnings:
            res["warnings"] = self.warnings
        return res

    @staticmethod
    def parse_json(json_str: str):
        """Parse JSON string to ApiResponse"""
        try:
            if not isinstance(json_str, str):
                raise ValueError("json_str must be a string")
            data = json.loads(json_str)
            return ApiResponse(**data)
        except Exception as e:
            logging.error(f"Error parsing API response json: {e}")

    @staticmethod
    def success(data: T | None = None, message: str | None = None) -> "ApiSuccessResponse[T]":
        """Create a successful API response"""
        if isinstance(data, BaseModel):
            data = data.model_dump()
        return ApiSuccessResponse(data=data, message=message or "success")

    @staticmethod
    def error(message: str, data: T | None = None) -> "ApiFailResponse[T]":
        """Create an error API response"""
        if isinstance(data, BaseModel):
            data = data.model_dump()
        return ApiFailResponse(message=message, data=data)


class ApiSuccessResponse(ApiResponse[T], Generic[T]):
    """Successful API response"""
    status: ApiResponseStatus = Field(default=ApiResponseStatus.SUCCESS, validate_default=True)
    message: str | None = "success"


class ApiFailResponse(ApiResponse[T], Generic[T]):
    """Failed API response with error details"""
    status: ApiResponseStatus = Field(default=ApiResponseStatus.FAIL, validate_default=True)
    status_code: int = 500
