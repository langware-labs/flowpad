"""A failure, typed: normalized text and a fingerprint computed here, never by hand or by an agent.

Two occurrences of one failure must read as one, whatever port the relay got, whatever build hash the bundler
put in a URL, whatever pid the crashed server had. ``normalize`` strips what varies; ``fingerprint`` hashes what
is left with the failure's phase, code and source.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from flow_sdk.schema.data_spec.webapp_lifecycle_spec import FailureCode, FailurePhase, WebappFailureSpec

#: What varies between two occurrences of one failure, in the order it is stripped.
_VARYING: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "<id>"),
    (re.compile(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"), "<time>"),
    (re.compile(r"([?&])(v|t|ts|hash|import|_)=[\w.-]*"), r"\1\2=<v>"),
    (re.compile(r"\.[0-9a-f]{8,}\.(js|mjs|css|map)\b", re.I), r".<hash>.\1"),
    (re.compile(r"(\.\w{1,5}):\d+:\d+\b"), r"\1:<pos>"),
    (re.compile(r"\b(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d{2,5}\b"), "<host>"),
    (re.compile(r"\bport \d{2,5}\b", re.I), "port <n>"),
    (re.compile(r"\bpid \d+\b", re.I), "pid <n>"),
    (re.compile(r"\(exit -?\d+\)"), "(exit <n>)"),
    (re.compile(r"— log: \S+"), "— log: <log>"),
    (re.compile(r"\(log: [^)]+\)"), "(log: <log>)"),
    (re.compile(r"\s+"), " "),
]


def normalize(text: str, *, folder: str | Path | None = None) -> str:
    """``text`` with what varies between occurrences replaced by placeholders, and the app folder as ``<app>``."""
    out = str(text or "")
    if folder:
        out = out.replace(str(Path(folder)), "<app>")
    out = re.sub(r"(/Users|/home|[A-Z]:\\\\Users)[^\s'\"`)]*", "<path>", out)
    for pattern, repl in _VARYING:
        out = pattern.sub(repl, out)
    return out.strip()[:500]


def fingerprint(phase: str, code: str, source: str, text: str) -> str:
    """The failure's identity: what it is, where it was seen, and its normalized text."""
    return hashlib.sha1(f"{phase}|{code}|{source}|{text}".encode()).hexdigest()[:16]


def make(phase: FailurePhase, code: FailureCode, raw: str, *, source: str = "step", process: str = "",
         folder: str | Path | None = None) -> WebappFailureSpec:
    """A failure with its normalized text and fingerprint filled in."""
    text = normalize(raw, folder=folder)
    return WebappFailureSpec(
        phase=phase, code=code, source=source, text=text, raw=str(raw or "")[:4000], process=process,
        fingerprint=fingerprint(phase.value, code.value, source, text), at=datetime.now(timezone.utc),
    )


#: A page report's source → its code.
_PAGE_CODES = {"page": FailureCode.JS_ERROR, "console": FailureCode.CONSOLE_ERROR,
               "network": FailureCode.REQUEST_FAILED, "relay": FailureCode.NOT_ANSWERING}


def of_page(text: str, source: str = "page", *, folder: str | Path | None = None) -> WebappFailureSpec:
    """One error the page's reporter sent (``server/reporter_relay``)."""
    code = _PAGE_CODES.get(source, FailureCode.JS_ERROR)
    if source == "relay" and text.strip() == "not_answering":
        return make(FailurePhase.HEALTH, FailureCode.NOT_ANSWERING, "not_answering", source="relay")
    return make(FailurePhase.PAGE, code, text, source=source, folder=folder)


def of_step(value: object) -> Optional[WebappFailureSpec]:
    """The failure a web-app step answered with (``ReturnedValue.value``), when it carried one."""
    if isinstance(value, WebappFailureSpec):
        return value
    if isinstance(value, dict) and value.get("phase"):
        try:
            return WebappFailureSpec.model_validate(value)
        except ValueError:
            return None
    return None


__all__ = ["fingerprint", "make", "normalize", "of_page", "of_step"]
