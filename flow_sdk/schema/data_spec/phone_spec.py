"""``PhoneNumberSpec`` — a phone number as a country code and the national number.

Stored structured (``{"country_code": "972", "number": "557709288"}``) rather than as one string,
because splitting a free-form number into country code and national part is ambiguous without a
numbering-plan database. Input is forgiving — a ``+`` on the country code, spaces, dashes, parens
and one national trunk ``0`` (``055-770-9288``) are stripped — and the value is always canonical.

``digits`` is the international number without ``+`` (``972557709288``), the form WhatsApp sources
key a person by; ``e164`` adds the ``+``.
"""
from __future__ import annotations

import re
from typing import ClassVar

from pydantic import ConfigDict, field_validator, model_validator

from flow_sdk.schema.data_spec.spec import DataSpec

_NOT_DIGIT = re.compile(r"[\s\-().]")


class PhoneNumberSpec(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "phone_number"

    #: The ITU country calling code, digits only (``"972"``).
    country_code: str
    #: The national significant number, digits only, no trunk prefix (``"557709288"``).
    number: str

    @field_validator("country_code", mode="before")
    @classmethod
    def _country_code(cls, value: object) -> str:
        text = str(value or "").strip().lstrip("+")
        if not re.fullmatch(r"[1-9][0-9]{0,2}", text):
            raise ValueError(f"country_code must be 1-3 digits, got {value!r}")
        return text

    @field_validator("number", mode="before")
    @classmethod
    def _number(cls, value: object) -> str:
        text = _NOT_DIGIT.sub("", str(value or ""))
        if text.startswith("0"):
            text = text[1:]  # the national trunk prefix: 055-… dialled at home is 55-… abroad
        if not re.fullmatch(r"[0-9]{4,14}", text):
            raise ValueError(f"number must be 4-14 digits after removing separators, got {value!r}")
        return text

    @model_validator(mode="after")
    def _length(self) -> "PhoneNumberSpec":
        if not 8 <= len(self.country_code) + len(self.number) <= 15:
            raise ValueError("a phone number has 8-15 digits including its country code")
        return self

    @property
    def digits(self) -> str:
        return f"{self.country_code}{self.number}"

    @property
    def e164(self) -> str:
        return f"+{self.digits}"

    def __str__(self) -> str:
        return self.e164


__all__ = ["PhoneNumberSpec"]
