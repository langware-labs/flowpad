"""Files on a message channel: what a channel takes (``FileSupport``), the check an outgoing file passes
before any provider I/O (``resolve_files``), and how one send splits into provider messages
(``plan_parts``).

Generic on purpose. A channel declares its limits as data on its class (``MessageSource.files``); the
runtime asks. A file the channel cannot take is refused with the fix in the message — never converted,
never dropped.
"""

from __future__ import annotations

import mimetypes
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, ClassVar, Iterable, Optional

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.sources.values.items import FileItem, FileKind, MessageFileData
from flow_sdk.sources.values.origin import CloudOrigin

#: The origin kind of a file on this machine — an outgoing file, before the provider names it.
LOCAL_KIND = "local"


class FileSupport(DataSpec):
    """What a channel's ``send`` accepts. The default takes nothing."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "message.file_support"

    #: Empty: the channel sends no files.
    kinds: frozenset[FileKind] = frozenset()
    #: Files one provider message carries; more fan out, one send per group.
    per_message: int = Field(default=1, ge=1)
    #: Per-kind byte ceilings the provider documents; a missing kind means none we know of.
    max_bytes: dict[FileKind, int] = Field(default_factory=dict)
    #: Bytes one provider message carries in all (email's message size); 0 = no such limit.
    max_message_bytes: int = 0
    #: 0: no per-file caption — the body goes out as a message of its own.
    caption_max: int = 0
    #: The kinds that take a caption; empty means every kind (when ``caption_max`` allows one).
    caption_kinds: frozenset[FileKind] = frozenset()

    def captions(self, kind: FileKind) -> bool:
        return self.caption_max > 0 and (not self.caption_kinds or kind in self.caption_kinds)


def kind_of(media_type: str) -> FileKind:
    """The kind a media type is shown as when the caller says ``auto``."""
    top = (media_type or "").split("/", 1)[0]
    if media_type == "image/webp":
        return FileKind.IMAGE
    return {"image": FileKind.IMAGE, "video": FileKind.VIDEO, "audio": FileKind.AUDIO}.get(top, FileKind.DOCUMENT)


def media_type_of(path: str) -> str:
    guessed, _ = mimetypes.guess_type(path)
    if guessed:
        return guessed
    if path.lower().endswith((".ogg", ".opus", ".oga")):
        return "audio/ogg"
    return "application/octet-stream"


#: Where ``mimetypes`` answers oddly for a type channels carry (``audio/ogg`` → ``.oga``) or not at all.
_EXTENSIONS = {
    "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "image/jpeg": ".jpg",
    "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm", "application/x-tgsticker": ".tgs",
}


def extension_of(media_type: Optional[str]) -> str:
    """The file extension a media type is written with — ``""`` when none is known. Parameters
    (``audio/ogg; codecs=opus``) are ignored."""
    base = (media_type or "").split(";", 1)[0].strip().lower()
    return _EXTENSIONS.get(base) or (mimetypes.guess_extension(base) if base else None) or ""


def safe_name(name: Optional[str], *, fallback: str = "file") -> str:
    """ONE rule for a file name on this machine: no path separators or control characters, no
    leading dots, at most 120 characters."""
    cleaned = re.sub(r"[^\w.\- ()]+", "_", Path(str(name or "")).name).strip(" .")
    return cleaned[:120] or fallback


def normalize_emoji(emoji: str) -> str:
    """An emoji as reactions compare it: without the variation selector (U+FE0F) keyboards add, so
    ❤ and ❤️ from one person are one reaction."""
    return (emoji or "").replace("\ufe0f", "")


async def chunked(blob: bytes, size: int = 65536) -> AsyncIterator[bytes]:
    """Bytes already in hand, as the chunk stream ``Openable.open`` yields."""
    for i in range(0, len(blob), size):
        yield blob[i : i + size]


def local_file(path: str | os.PathLike, *, as_: str = "auto", caption: Optional[str] = None) -> FileItem:
    """An outgoing file as the contract carries it: a ``local`` origin and a readable absolute path."""
    resolved = Path(path).expanduser().resolve()
    media_type = media_type_of(str(resolved))
    kind = kind_of(media_type) if as_ == "auto" else FileKind(as_)
    size = resolved.stat().st_size if resolved.is_file() else None
    data = MessageFileData(
        name=resolved.name, path=str(resolved), media_type=media_type, size=size, as_=kind, caption=caption or None
    )
    return FileItem(origin=CloudOrigin(kind=LOCAL_KIND, namespace="outbox", key=str(resolved)), data=data)


def _mb(n: int) -> str:
    return f"{n / 1_000_000:.1f} MB" if n >= 1_000_000 else f"{n // 1000} KB"


def resolve_files(files: Iterable[FileItem], support: FileSupport, *, title: str) -> tuple[FileItem, ...]:
    """Check every outgoing file against ``support``; answer them unchanged or raise ``ValueError``
    naming the file, the limit and the fix. Runs before any provider I/O."""
    out: list[FileItem] = []
    total = 0
    for f in files:
        data = f.data
        if f.origin.kind != LOCAL_KIND or not isinstance(data, MessageFileData):
            raise ValueError(f"an outgoing file must be a local file, got {f.origin!r}")
        name = data.name or "file"
        if not data.path or not Path(data.path).is_file():
            raise ValueError(f"{name}: no such file ({data.path})")
        if not support.kinds:
            raise ValueError(f"{title} does not send files")
        if data.as_ not in support.kinds:
            takes = ", ".join(sorted(k.value for k in support.kinds))
            raise ValueError(f"{title} cannot send a {data.as_.value}; {name} would need one of: {takes}")
        size = data.size if data.size is not None else Path(data.path).stat().st_size
        cap = support.max_bytes.get(data.as_)
        if cap and size > cap:
            fix = " Send it with as_='document'." if FileKind.DOCUMENT in support.kinds and data.as_ != FileKind.DOCUMENT else ""
            raise ValueError(f"{title} {data.as_.value}s are {_mb(cap)} at most; {name} is {_mb(size)}.{fix}")
        if data.caption and not support.captions(data.as_):
            raise ValueError(f"{title} shows no caption on a {data.as_.value} ({name}); put the words in the message body")
        if data.caption and len(data.caption) > support.caption_max:
            raise ValueError(f"{title} captions are {support.caption_max} characters at most; {name}'s has {len(data.caption)}")
        total += size
        out.append(f)
    if support.max_message_bytes and total > support.max_message_bytes:
        raise ValueError(f"{title} messages carry {_mb(support.max_message_bytes)} at most; these files are {_mb(total)}")
    return tuple(out)


def check_files(files: tuple[FileItem, ...], support: FileSupport, *, title: str, text: Optional[str]) -> None:
    """What every channel's ``send`` checks about the files it is handed, beyond ``resolve_files``'s
    limits: text or a file is there, and no more files than one provider message carries. A driver
    adds only the rules that are its provider's own."""
    if text is None and not files:
        raise ValueError("text is required")
    if files:
        resolve_files(files, support, title=title)
    if len(files) > support.per_message:
        raise ValueError(f"{title} carries {support.per_message} file(s) per message, got {len(files)}")


@dataclass(frozen=True)
class Part:
    """One provider message of a send: its text, its files, and whether it quotes."""

    text: Optional[str]
    files: tuple[FileItem, ...]
    quotes: bool


def plan_parts(support: FileSupport, text: Optional[str], files: tuple[FileItem, ...], *, quote: bool) -> list[Part]:
    """Split one send into provider messages. The body rides as the caption of the first file when that
    file's kind takes one and the text fits; otherwise it goes first as a text message. Only the first
    part quotes."""
    body = (text or "").strip() or None
    if not files:
        return [Part(text=body, files=(), quotes=quote)]
    groups = [files[i : i + support.per_message] for i in range(0, len(files), support.per_message)]
    parts: list[Part] = []
    first = groups[0][0].data
    captionable = (
        body is not None
        and support.per_message == 1
        and isinstance(first, MessageFileData)
        and not first.caption
        and support.captions(first.as_)
        and len(body) <= support.caption_max
    )
    if body is not None and captionable:
        head = groups[0][0]
        head = head.model_copy(update={"data": first.model_copy(update={"caption": body})})
        groups[0] = (head,)
        body = None
    if body is not None and support.per_message == 1:
        parts.append(Part(text=body, files=(), quotes=quote))
        body = None
    for i, group in enumerate(groups):
        parts.append(Part(text=body if i == 0 else None, files=tuple(group), quotes=quote and not parts and i == 0))
    return parts


def read_file(file: FileItem) -> bytes:
    """The bytes of an outgoing (``local``) file — what a driver uploads."""
    data = file.data
    if file.origin.kind != LOCAL_KIND or not data.path:
        raise ValueError(f"{file.origin!r} is not a local file")
    return Path(data.path).read_bytes()


__all__ = [
    "LOCAL_KIND",
    "FileSupport",
    "check_files",
    "chunked",
    "extension_of",
    "normalize_emoji",
    "safe_name",
    "Part",
    "kind_of",
    "local_file",
    "media_type_of",
    "plan_parts",
    "read_file",
    "resolve_files",
]
