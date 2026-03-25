import json
import re
from typing import Callable, Optional

_last_parse_remaining: Optional[str] = None
_on_extra_token: Optional[Callable] = None


def set_on_extra_token(callback: Callable):
    global _on_extra_token
    _on_extra_token = callback


def reset_on_extra_token():
    global _on_extra_token
    _on_extra_token = None


def last_parse_remaining():
    global _last_parse_remaining
    return _last_parse_remaining


def set_last_parse_remaining(remaining: str):
    global _last_parse_remaining
    _last_parse_remaining = remaining


def reset_last_parse_remaining():
    global _last_parse_remaining
    _last_parse_remaining = None


def parse(s):
    if s is None:
        return None
    if s == "":
        return ""

    # Remove incomplete escaped characters at the end of the string
    s = re.sub(r"\\+$", lambda m: m.group() if len(m.group()) % 2 == 0 else m.group()[:-1], s)

    try:
        return json.loads(s)
    except json.JSONDecodeError:
        try:
            data, remaining = parse_any(s.lstrip())
            global _last_parse_remaining, _on_extra_token
            _last_parse_remaining = remaining
            if _on_extra_token and remaining:
                _on_extra_token(s, data, remaining)
            return data
        except json.JSONDecodeError:
            return None


def parse_any(s):
    if not s:
        return None, ""

    first_char = s[0]
    if first_char == "{":
        return parse_object(s)
    elif first_char == "[":
        return parse_array(s)
    elif first_char in ('"', "'"):
        return parse_string(s)
    elif first_char.isdigit() or first_char in ("-", "."):
        return parse_number(s)
    elif s.startswith("true"):
        return True, s[4:]
    elif s.startswith("false"):
        return False, s[5:]
    elif s.startswith("null"):
        return None, s[4:]
    else:
        return parse_string_without_quote(s)


def parse_object(s):
    result = {}
    s = s[1:].lstrip()  # Skip opening '{'

    while s and s[0] != "}":
        key, s = parse_string_casual(s)
        s = s.lstrip()

        if s.startswith(":"):
            s = s[1:].lstrip()
            value, s = parse_any(s)
            result[key] = value
        else:
            result[key] = None

        s = s.lstrip()
        if s.startswith(","):
            s = s[1:].lstrip()

    return result, s[1:] if s else ""  # Skip closing '}'


def parse_array(s):
    result = []
    s = s[1:].lstrip()  # Skip opening '['

    while s and s[0] != "]":
        value, s = parse_any(s)
        result.append(value)
        s = s.lstrip()
        if s.startswith(","):
            s = s[1:].lstrip()

    return result, s[1:] if s else ""  # Skip closing ']'


def fix_escaped_characters(s: str) -> str:
    return s.replace("\n", "\\n").replace("\t", "\\t").replace("\r", "\\r")


def parse_string(s):
    quote = s[0]
    i = 1
    while i < len(s):
        if s[i] == "\\":
            i += 2  # Skip both the backslash and the escaped character
            continue
        if s[i] == quote:
            return json.loads('"' + fix_escaped_characters(s[1:i]) + '"'), s[i + 1 :]
        i += 1
    return json.loads('"' + fix_escaped_characters(s[1:]) + '"'), ""


def parse_string_casual(s):
    if s[0] in ('"', "'"):
        return parse_string(s)
    return parse_string_without_quote(s)


def parse_string_without_quote(s, delimiters=None):
    if delimiters is None:
        delimiters = [" ", ",", "}", "]", ":"]
    for i, char in enumerate(s):
        if char in delimiters:
            return s[:i].strip(), s[i:]
    return s.strip(), ""


def parse_number(s):
    match = re.match(r"-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", s)
    if match:
        num_str = match.group()
        try:
            return float(num_str), s[len(num_str) :]
        except ValueError:
            return num_str, s[len(num_str) :]
    return s, ""
