import logging
from enum import StrEnum
from typing import ClassVar, Optional

from fastapi import Request

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.core.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


class QuestionStatus(StrEnum):
    RECEIVED = "received"
    PENDING = "pending"
    SENT = "sent"
    DISCARDED = "discarded"


class Question(Entity):
    type: str = APIField(default="question")
    question: str = APIField()
    answer: Optional[str] = APIField(None)
    status: QuestionStatus = APIField(default=QuestionStatus.RECEIVED)
    reporter: Optional[str] = APIField(None)
    reviewer: Optional[str] = APIField(None)
    _api_visible: ClassVar[bool] = True

    @action.post()
    async def send(request: Request) -> ApiResponse:
        request_info = get_current_request_info()
        try:
            if not request_info:
                raise ValueError("Request info not found")
            if not request_info.auth_result or not request_info.auth_result.target:
                raise ValueError("Question entity must be provided.")
            question = request_info.auth_result.target
            if not question:
                raise ValueError("Question not found")
            raise NotImplementedError(f"Slack Send Not implemented {question.answer}")
            question.deployment_status = QuestionStatus.SENT
            await question.save()
            return ApiSuccessResponse()
        except Exception as e:
            logging.error(f"question: Error in send ({request_info.target_entity_typeid}): {e}")
            return ApiFailResponse(message=str(e))
