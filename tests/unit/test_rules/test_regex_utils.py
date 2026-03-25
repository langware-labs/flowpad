"""Tests for regex_utils module."""

import re
from flow_sdk.rules.regex_utils import (
    compile_regex,
    regex_match,
    regex_match_ignorecase,
    contains,
    starts_with,
    ends_with,
    matches_any,
    extract_match,
    word_boundary_match,
)


def test_compile_regex_caches():
    """Compiled patterns should be cached."""
    p1 = compile_regex(r"hello")
    p2 = compile_regex(r"hello")
    assert p1 is p2


def test_regex_match_basic():
    assert regex_match(r"hello", "say hello world") is True
    assert regex_match(r"hello", "goodbye") is False


def test_regex_match_empty():
    assert regex_match(r"hello", "") is False


def test_regex_match_ignorecase_basic():
    assert regex_match_ignorecase(r"hello", "HELLO world") is True
    assert regex_match_ignorecase(r"hello", "goodbye") is False


def test_contains_case_insensitive():
    assert contains("hello", "Hello World") is True
    assert contains("hello", "goodbye") is False


def test_contains_case_sensitive():
    assert contains("Hello", "Hello World", case_sensitive=True) is True
    assert contains("hello", "Hello World", case_sensitive=True) is False


def test_contains_empty():
    assert contains("", "text") is False
    assert contains("text", "") is False


def test_starts_with_basic():
    assert starts_with("hello", "Hello World") is True
    assert starts_with("world", "Hello World") is False


def test_starts_with_case_sensitive():
    assert starts_with("Hello", "Hello World", case_sensitive=True) is True
    assert starts_with("hello", "Hello World", case_sensitive=True) is False


def test_ends_with_basic():
    assert ends_with("world", "Hello World") is True
    assert ends_with("hello", "Hello World") is False


def test_matches_any_basic():
    assert matches_any([r"foo", r"bar"], "hello bar") is True
    assert matches_any([r"foo", r"bar"], "hello baz") is False


def test_matches_any_empty():
    assert matches_any([], "text") is False
    assert matches_any(["foo"], "") is False


def test_extract_match_basic():
    result = extract_match(r"(\d+)", "abc 123 def")
    assert result == "123"


def test_extract_match_group():
    result = extract_match(r"(\w+)@(\w+)", "user@host", group=2)
    assert result == "host"


def test_extract_match_no_match():
    result = extract_match(r"\d+", "no numbers here")
    assert result is None


def test_word_boundary_match():
    assert word_boundary_match("cat", "the cat sat") is True
    assert word_boundary_match("cat", "concatenate") is False


def test_word_boundary_match_case_insensitive():
    assert word_boundary_match("Cat", "the cat sat") is True


def test_word_boundary_match_case_sensitive():
    assert word_boundary_match("Cat", "the cat sat", case_sensitive=True) is False
    assert word_boundary_match("cat", "the cat sat", case_sensitive=True) is True
