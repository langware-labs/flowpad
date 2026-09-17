"""``PhoneNumberSpec``: a forgiving input, a canonical value, the digits WhatsApp keys by."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.schema.data_spec.phone_spec import PhoneNumberSpec

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


def test_a_local_israeli_number_becomes_its_international_form():
    phone = PhoneNumberSpec(country_code="972", number="055-770-9288")
    assert (phone.country_code, phone.number) == ("972", "557709288")
    assert (phone.digits, phone.e164, str(phone)) == ("972557709288", "+972557709288", "+972557709288")


def test_separators_and_a_plus_are_accepted():
    assert PhoneNumberSpec(country_code="+1", number="(555) 192 3480").e164 == "+15551923480"


@pytest.mark.parametrize(("country_code", "number"), [("", "557709288"), ("0972", "557709288"), ("972", "12"), ("972", "abc55770"), ("1", "1234567890123456")])
def test_what_is_not_a_phone_number_is_refused(country_code, number):
    with pytest.raises(ValidationError):
        PhoneNumberSpec(country_code=country_code, number=number)


def test_the_value_is_frozen_and_round_trips_as_its_two_fields():
    phone = PhoneNumberSpec(country_code="972", number="557709288")
    with pytest.raises(ValidationError):
        phone.number = "1"
    dumped = phone.model_dump(mode="json")
    assert dumped == {"country_code": "972", "number": "557709288"}
    assert PhoneNumberSpec.model_validate(dumped) == phone
