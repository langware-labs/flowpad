import importlib.util
import os

import pytest

# The best_effort_json_parser module is standalone (only uses json and re),
# but its parent package external_apis.llm.__init__.py triggers a circular
# import chain. We load it directly from its file path to avoid that.
_module_path = os.path.join(
    os.path.dirname(__file__),
    os.pardir,
    os.pardir,
    "flow_sdk",
    "external_apis",
    "llm",
    "utils",
    "best_effort_json_parser.py",
)
_spec = importlib.util.spec_from_file_location("best_effort_json_parser", _module_path)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

parse = _mod.parse
last_parse_remaining = _mod.last_parse_remaining
reset_last_parse_remaining = _mod.reset_last_parse_remaining
reset_on_extra_token = _mod.reset_on_extra_token
set_on_extra_token = _mod.set_on_extra_token


@pytest.fixture(scope="function", autouse=True)
def reset_parser():
    reset_last_parse_remaining()
    reset_on_extra_token()


def test_valid_json():
    valid_json = '{"name": "John", "age": 30, "city": "New York"}'
    expected = {"name": "John", "age": 30, "city": "New York"}
    assert parse(valid_json) == expected


def test_single_quotes():
    single_quotes = "{'name': 'Jane', 'age': 25, 'city': 'San Francisco'}"
    expected = {"name": "Jane", "age": 25, "city": "San Francisco"}
    assert parse(single_quotes) == expected


def test_escaped_quotes():
    escaped_quotes = '{"text":"This is a \\"quoted\\" text with \\"multiple\\" quotes"}'
    expected = {"text": 'This is a "quoted" text with "multiple" quotes'}
    assert parse(escaped_quotes) == expected


def test_unquoted_keys():
    unquoted_keys = "{name: 'Alice', age: 35, city: 'London'}"
    expected = {"name": "Alice", "age": 35, "city": "London"}
    assert parse(unquoted_keys) == expected


def test_trailing_commas():
    trailing_commas = '["apple", "banana", "cherry",]'
    expected = ["apple", "banana", "cherry"]
    assert parse(trailing_commas) == expected


def test_extra_tokens():
    extra_tokens = '{"name": "Bob", "age": 40} extra stuff'
    expected = {"name": "Bob", "age": 40}
    assert parse(extra_tokens) == expected
    assert last_parse_remaining() == " extra stuff"


def test_invalid_json():
    invalid_json = '{name: "Eve", "age": 28, hobbies: ["reading" "writing"]}'
    expected = {"name": "Eve", "age": 28, "hobbies": ["reading", "writing"]}
    assert parse(invalid_json) == expected


def test_null_and_empty():
    assert parse(None) is None
    assert parse("") == ""


def test_numbers():
    numbers = '{"int": 42, "float": 3.14, "sci": 1.23e-4}'
    expected = {"int": 42, "float": 3.14, "sci": 1.23e-4}
    assert parse(numbers) == expected


def test_nested_structures():
    nested = '{"array": [1, 2, {"nested": "object"}], "object": {"key": "value"}}'
    expected = {"array": [1, 2, {"nested": "object"}], "object": {"key": "value"}}
    assert parse(nested) == expected


def test_unicode():
    unicode_json = '{"unicode": "\\u00A9 2023"}'
    expected = {"unicode": "\u00a9 2023"}
    assert parse(unicode_json) == expected


def test_boolean_and_null():
    bool_null = '{"bool_true": true, "bool_false": false, "null_value": null}'
    expected = {"bool_true": True, "bool_false": False, "null_value": None}
    assert parse(bool_null) == expected


def test_on_extra_token():
    extra_token_called = False

    def custom_handler(text, data, remaining):
        nonlocal extra_token_called
        extra_token_called = True
        assert data == {"key": "value"}
        assert remaining == " extra"

    set_on_extra_token(custom_handler)
    parse('{"key": "value"} extra')
    assert extra_token_called


def test_multiline_json():
    multiline_json = """
    {
        "name": "Alice",
        "age": 30,
        "address": {
            "street": "123 Main St",
            "city": "Wonderland",
            "country": "Imagination"
        },
        "hobbies": [
            "reading",
            "painting",
            "coding"
        ],
        "is_student": false,
        "grades": null
    }
    """
    expected = {
        "name": "Alice",
        "age": 30,
        "address": {
            "street": "123 Main St",
            "city": "Wonderland",
            "country": "Imagination",
        },
        "hobbies": ["reading", "painting", "coding"],
        "is_student": False,
        "grades": None,
    }
    assert parse(multiline_json) == expected


def test_multiline_string_json():
    multiline_json = """
    {
        "name": "Alice
         in wonderland",
    }
    """
    expected = {
        "name": "Alice\n         in wonderland",
    }
    assert parse(multiline_json) == expected


def test_incomplete_value():
    incomplete_json = '{"name": "Bob", "age": [40, a'
    expected = {"name": "Bob", "age": [40, "a"]}
    assert parse(incomplete_json) == expected
    assert last_parse_remaining() == ""


def test_incomplete_key():
    incomplete_json = '{"nam"'
    expected = {"nam": None}
    assert parse(incomplete_json) == expected
    assert last_parse_remaining() == ""


if __name__ == "__main__":
    pytest.main()
