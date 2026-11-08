"""One ignore file (``.gitignore`` or ``.flowignore``), matched the way git matches it.

A port of git's own matcher, not "a gitignore library": ``wildmatch.c`` (``dowild``) and the pattern
rules of ``dir.c`` (``add_patterns_from_buffer``, ``trim_trailing_spaces``, ``parse_path_pattern``,
``match_basename``, ``match_pathname``, ``last_matching_pattern_from_list``). The oracle is git itself:
``tests/unit/diskio/test_ignore_files.py`` asks ``git ls-files`` and compares.

Matching is on bytes, as git's is (a ``?`` is one byte), and case-sensitive on every platform — git with
``core.ignorecase=false`` — so a project's rules mean the same on every machine.

The Rust walker carries the same port: ``flow_sdk/rust/diskio/src/gitignore.rs``.
"""
from __future__ import annotations

import os
import stat

GITIGNORE = ".gitignore"
FLOWIGNORE = ".flowignore"

_MATCH, _NOMATCH, _ABORT_ALL, _ABORT_TO_STARSTAR = 0, 1, -1, -2
_STAR, _SLASH, _BACKSLASH, _QUESTION, _OPEN, _CLOSE = 0x2A, 0x2F, 0x5C, 0x3F, 0x5B, 0x5D
_GLOB_SPECIAL = frozenset(b"*?[\\")

_NEGATIVE, _MUSTBEDIR, _NODIR, _ENDSWITH = 1, 2, 4, 8

# The [:class:] names wildmatch knows, over git's ASCII-only ctype (its isspace has no \v or \f).
_CLASSES = {
    b"alnum": lambda c: 48 <= c <= 57 or 65 <= c <= 90 or 97 <= c <= 122,
    b"alpha": lambda c: 65 <= c <= 90 or 97 <= c <= 122,
    b"blank": lambda c: c in (9, 32),
    b"cntrl": lambda c: c < 32 or c == 127,
    b"digit": lambda c: 48 <= c <= 57,
    b"graph": lambda c: 33 <= c <= 126,
    b"lower": lambda c: 97 <= c <= 122,
    b"print": lambda c: 32 <= c <= 126,
    b"punct": lambda c: 33 <= c <= 47 or 58 <= c <= 64 or 91 <= c <= 96 or 123 <= c <= 126,
    b"space": lambda c: c in (9, 10, 13, 32),
    b"upper": lambda c: 65 <= c <= 90,
    b"xdigit": lambda c: 48 <= c <= 57 or 65 <= c <= 70 or 97 <= c <= 102,
}


def _dowild(p: bytes, pi: int, t: bytes, ti: int, pathname: bool) -> int:
    """``wildmatch.c``'s ``dowild``, index for pointer."""
    plen, tlen = len(p), len(t)
    while pi < plen:
        p_ch = p[pi]
        t_ch = t[ti] if ti < tlen else 0
        if ti >= tlen and p_ch != _STAR:
            return _ABORT_ALL
        if p_ch == _BACKSLASH:
            pi += 1
            p_ch = p[pi] if pi < plen else 0
            if t_ch != p_ch:
                return _NOMATCH
        elif p_ch == _QUESTION:
            if pathname and t_ch == _SLASH:
                return _NOMATCH
        elif p_ch == _STAR:
            pi += 1
            if pi < plen and p[pi] == _STAR:
                prev = pi - 2
                while pi < plen and p[pi] == _STAR:
                    pi += 1
                nxt = p[pi] if pi < plen else 0
                if (prev < 0 or p[prev] == _SLASH) and (
                    nxt in (0, _SLASH) or (nxt == _BACKSLASH and pi + 1 < plen and p[pi + 1] == _SLASH)
                ):
                    # "foo/**/bar" matches "foo/bar": try "**/" as nothing first.
                    if nxt == _SLASH and _dowild(p, pi + 1, t, ti, pathname) == _MATCH:
                        return _MATCH
                    match_slash = True
                else:
                    match_slash = False
            else:
                match_slash = not pathname
            if pi >= plen:
                # A trailing "**" matches everything; a trailing "*" only what has no more slashes.
                if not match_slash and t.find(b"/", ti) != -1:
                    return _NOMATCH
                return _MATCH
            if not match_slash and p[pi] == _SLASH:
                # One star then a slash: the rest of this directory name, then that slash.
                slash = t.find(b"/", ti)
                if slash == -1:
                    return _NOMATCH
                pi, ti = pi + 1, slash + 1
                continue
            while True:
                if t_ch == 0:
                    break
                if p[pi] not in _GLOB_SPECIAL:
                    # A literal follows the star: skip straight to its next occurrence.
                    p_ch = p[pi]
                    while ti < tlen:
                        t_ch = t[ti]
                        if (not match_slash and t_ch == _SLASH) or t_ch == p_ch:
                            break
                        ti += 1
                    else:
                        t_ch = 0
                    if t_ch != p_ch:
                        return _ABORT_ALL if match_slash else _ABORT_TO_STARSTAR
                matched = _dowild(p, pi, t, ti, pathname)
                if matched != _NOMATCH:
                    if not match_slash or matched != _ABORT_TO_STARSTAR:
                        return matched
                elif not match_slash and t_ch == _SLASH:
                    return _ABORT_TO_STARSTAR
                ti += 1
                t_ch = t[ti] if ti < tlen else 0
            return _ABORT_ALL
        elif p_ch == _OPEN:
            pi += 1
            p_ch = p[pi] if pi < plen else 0
            if p_ch == 0x5E:  # "^" negates, as "!" does
                p_ch = 0x21
            negated = p_ch == 0x21
            if negated:
                pi += 1
                p_ch = p[pi] if pi < plen else 0
            prev_ch = 0
            matched = False
            while True:
                if p_ch == 0:
                    return _ABORT_ALL
                if p_ch == _BACKSLASH:
                    pi += 1
                    p_ch = p[pi] if pi < plen else 0
                    if p_ch == 0:
                        return _ABORT_ALL
                    if t_ch == p_ch:
                        matched = True
                elif p_ch == 0x2D and prev_ch and pi + 1 < plen and p[pi + 1] != _CLOSE:
                    pi += 1
                    p_ch = p[pi]
                    if p_ch == _BACKSLASH:
                        pi += 1
                        p_ch = p[pi] if pi < plen else 0
                        if p_ch == 0:
                            return _ABORT_ALL
                    if prev_ch <= t_ch <= p_ch:
                        matched = True
                    p_ch = 0  # so the next prev_ch is 0: a range never starts a range
                elif p_ch == _OPEN and pi + 1 < plen and p[pi + 1] == 0x3A:
                    start = pi = pi + 2
                    while pi < plen and p[pi] != _CLOSE:
                        pi += 1
                    if pi >= plen:
                        return _ABORT_ALL
                    if pi - start - 1 < 0 or p[pi - 1] != 0x3A:
                        # No ":]": the "[" is an ordinary member of the set.
                        pi = start - 2
                        p_ch = _OPEN
                        if t_ch == p_ch:
                            matched = True
                    else:
                        test = _CLASSES.get(p[start:pi - 1])
                        if test is None:
                            return _ABORT_ALL
                        if test(t_ch):
                            matched = True
                        p_ch = 0
                elif t_ch == p_ch:
                    matched = True
                prev_ch = p_ch
                pi += 1
                p_ch = p[pi] if pi < plen else 0
                if p_ch == _CLOSE:
                    break
            if matched == negated or (pathname and t_ch == _SLASH):
                return _NOMATCH
        elif t_ch != p_ch:
            return _NOMATCH
        pi += 1
        ti += 1
    return _NOMATCH if ti < tlen else _MATCH


def wildmatch(pattern: bytes, text: bytes, *, pathname: bool) -> bool:
    """git's ``wildmatch(pattern, text, pathname ? WM_PATHNAME : 0) == WM_MATCH``."""
    return _dowild(pattern, 0, text, 0, pathname) == _MATCH


def _simple_length(p: bytes) -> int:
    for i, c in enumerate(p):
        if c in _GLOB_SPECIAL:
            return i
    return len(p)


def _trim_trailing_spaces(line: bytes) -> bytes:
    """Drop trailing spaces unless the first of them is escaped (``\\ ``)."""
    last_space = None
    i = 0
    while i < len(line):
        c = line[i]
        if c == 0x20:
            if last_space is None:
                last_space = i
        elif c == _BACKSLASH:
            i += 1
            if i >= len(line):
                return line
            last_space = None
        else:
            last_space = None
        i += 1
    return line if last_space is None else line[:last_space]


class _Rule:
    __slots__ = ("pattern", "flags", "prefix")

    def __init__(self, line: bytes) -> None:
        flags = 0
        if line[:1] == b"!":
            flags |= _NEGATIVE
            line = line[1:]
        length = len(line)
        if length and line[-1] == _SLASH:
            length -= 1
            flags |= _MUSTBEDIR
        if b"/" not in line[:length]:
            flags |= _NODIR
        if line[:1] == b"*" and _simple_length(line[1:]) == len(line) - 1:
            flags |= _ENDSWITH
        self.pattern = line[:length]
        self.flags = flags
        self.prefix = min(_simple_length(line), length)

    def matches(self, rel: bytes, basename: bytes) -> bool:
        pattern, prefix = self.pattern, self.prefix
        if self.flags & _NODIR:  # match_basename
            if prefix == len(pattern):
                return pattern == basename
            if self.flags & _ENDSWITH:
                return len(pattern) - 1 <= len(basename) and basename.endswith(pattern[1:])
            return wildmatch(pattern, basename, pathname=False)
        # match_pathname, relative to the file's own folder. The literal prefix is only a
        # shortcut: the whole pattern is matched, so a "**" right after it ("ab**/c") stays an
        # ordinary star, as git has it.
        if pattern[:1] == b"/":
            pattern, prefix = pattern[1:], prefix - 1
        if not rel or (prefix and pattern[:prefix] != rel[:prefix]):
            return False
        return wildmatch(pattern, rel, pathname=True)


class IgnoreFile:
    """The rules of one ignore file, in file order."""

    __slots__ = ("rules",)

    def __init__(self, rules: tuple[_Rule, ...]) -> None:
        self.rules = rules

    @classmethod
    def parse(cls, data: bytes) -> IgnoreFile:
        """``add_patterns_from_buffer``: a BOM dropped, blank and ``#`` lines skipped, one ``\\r`` and
        the unescaped trailing spaces cut from each line."""
        if data.startswith(b"\xef\xbb\xbf"):
            data = data[3:]
        rules = []
        for line in data.split(b"\n"):
            if not line or line[0] == 0x23:
                continue
            if line[-1] == 0x0D:
                line = line[:-1]
            rules.append(_Rule(_trim_trailing_spaces(line)))
        return cls(tuple(rules))

    def decide(self, rel: bytes, is_dir: bool) -> bool | None:
        """git's word on ``rel`` (``/``-separated, relative to this file's folder): True ignored,
        False re-included by a ``!`` line, None when no line matches. The last matching line wins."""
        basename = rel[rel.rfind(b"/") + 1:]
        for rule in reversed(self.rules):
            if rule.flags & _MUSTBEDIR and not is_dir:
                continue
            if rule.matches(rel, basename):
                return not rule.flags & _NEGATIVE
        return None


def read_ignore_file(folder: str, name: str) -> IgnoreFile | None:
    """``folder/name`` parsed, or None when it is absent, unreadable or not a regular file — git
    does not follow an in-tree ignore file that is a symlink."""
    path = os.path.join(folder, name)
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return None
        with open(path, "rb") as fh:
            return IgnoreFile.parse(fh.read())
    except OSError:
        return None
