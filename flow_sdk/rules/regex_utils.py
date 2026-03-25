"""Cached regex utilities for trigger.py scripts."""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Pattern


@lru_cache(maxsize=128)
def compile_regex(pattern: str, flags: int = 0) -> Pattern[str]:
    """Compile and cache a regex pattern.

    Args:
        pattern: The regex pattern string.
        flags: Optional regex flags (e.g., re.IGNORECASE).

    Returns:
        Compiled regex Pattern object.
    """
    return re.compile(pattern, flags)


def regex_match(pattern: str, text: str, flags: int = 0) -> bool:
    """Check if pattern matches anywhere in text.

    Args:
        pattern: Regex pattern to match.
        text: Text to search in.
        flags: Optional regex flags.

    Returns:
        True if pattern matches anywhere in text.
    """
    if not text:
        return False
    compiled = compile_regex(pattern, flags)
    return bool(compiled.search(text))


def regex_match_ignorecase(pattern: str, text: str) -> bool:
    """Case-insensitive regex match.

    Args:
        pattern: Regex pattern to match.
        text: Text to search in.

    Returns:
        True if pattern matches anywhere in text (case-insensitive).
    """
    return regex_match(pattern, text, re.IGNORECASE)


def contains(substring: str, text: str, case_sensitive: bool = False) -> bool:
    """Check if text contains a substring.

    Args:
        substring: The substring to search for.
        text: The text to search in.
        case_sensitive: Whether to do case-sensitive search.

    Returns:
        True if substring is found in text.
    """
    if not text or not substring:
        return False
    if case_sensitive:
        return substring in text
    return substring.lower() in text.lower()


def starts_with(prefix: str, text: str, case_sensitive: bool = False) -> bool:
    """Check if text starts with a prefix.

    Args:
        prefix: The prefix to check for.
        text: The text to check.
        case_sensitive: Whether to do case-sensitive check.

    Returns:
        True if text starts with prefix.
    """
    if not text or not prefix:
        return False
    if case_sensitive:
        return text.startswith(prefix)
    return text.lower().startswith(prefix.lower())


def ends_with(suffix: str, text: str, case_sensitive: bool = False) -> bool:
    """Check if text ends with a suffix.

    Args:
        suffix: The suffix to check for.
        text: The text to check.
        case_sensitive: Whether to do case-sensitive check.

    Returns:
        True if text ends with suffix.
    """
    if not text or not suffix:
        return False
    if case_sensitive:
        return text.endswith(suffix)
    return text.lower().endswith(suffix.lower())


def matches_any(patterns: list[str], text: str, case_sensitive: bool = False) -> bool:
    """Check if text matches any of the given patterns.

    Args:
        patterns: List of regex patterns to check.
        text: Text to search in.
        case_sensitive: Whether to do case-sensitive matching.

    Returns:
        True if any pattern matches.
    """
    if not text or not patterns:
        return False
    flags = 0 if case_sensitive else re.IGNORECASE
    for pattern in patterns:
        if regex_match(pattern, text, flags):
            return True
    return False


def extract_match(pattern: str, text: str, group: int = 0, flags: int = 0) -> str | None:
    """Extract the first match of a pattern from text.

    Args:
        pattern: Regex pattern with optional groups.
        text: Text to search in.
        group: Which group to return (0 for full match).
        flags: Optional regex flags.

    Returns:
        The matched text, or None if no match.
    """
    if not text:
        return None
    compiled = compile_regex(pattern, flags)
    match = compiled.search(text)
    if match:
        try:
            return match.group(group)
        except IndexError:
            return match.group(0)
    return None


def word_boundary_match(word: str, text: str, case_sensitive: bool = False) -> bool:
    """Check if word appears as a whole word in text (not as part of another word).

    Args:
        word: The word to search for.
        text: The text to search in.
        case_sensitive: Whether to do case-sensitive matching.

    Returns:
        True if word appears as a whole word.
    """
    if not text or not word:
        return False
    pattern = r'\b' + re.escape(word) + r'\b'
    flags = 0 if case_sensitive else re.IGNORECASE
    return regex_match(pattern, text, flags)
