"""DocumentReader — spec §4. The parse is ``assets.document.read_document_bytes``;
this module turns the three exceptions that abort one file's read into the
``error`` of that file's value, so a batch is never aborted by one item."""

from __future__ import annotations

from typing import Iterator, Sequence

from flow_sdk.assets.document import content_revision, read_document_bytes
from flow_sdk.capsules.errors import MalformedCapsuleError
from flow_sdk.diskio.contract import DocumentRead, ItemError, StreamEnd, YamlProfile
from flow_sdk.diskio.python._stream import unreadable, with_end


def _profile(profile: YamlProfile) -> None:
    if profile != "yaml11":
        raise ValueError(f"the Python DocumentReader reads the 'yaml11' profile only, not {profile!r}")


def _failed(path: str, data: bytes, error: ItemError) -> DocumentRead:
    return DocumentRead(path=path, raw_text="", body="", fields={}, body_start_line=1,
                        metadata_error=None, revision=content_revision(data), error=error)


def _read(path: str, data: bytes) -> DocumentRead:
    try:
        doc = read_document_bytes(data)
    except UnicodeDecodeError as exc:
        return _failed(path, data, ItemError(path=path, kind="decode", detail=str(exc)))
    except MalformedCapsuleError as exc:  # DuplicateCapsuleError is one
        return _failed(path, data, ItemError(path=path, kind="capsule", detail=str(exc)))
    return DocumentRead(path=path, raw_text=doc.raw_text, body=doc.body, fields=doc.fields,
                        body_start_line=doc.body_start_line, metadata_error=doc.metadata_error,
                        revision=doc.revision, error=None)


class PyDocumentReader:
    def read(
        self, paths: Sequence[str], profile: YamlProfile = "yaml11", *, threads: int = 1,
    ) -> Iterator[DocumentRead | StreamEnd]:
        _profile(profile)
        return with_end(self._documents(paths))

    @staticmethod
    def _documents(paths: Sequence[str]) -> Iterator[DocumentRead]:
        for path in paths:
            try:
                with open(path, "rb") as fh:
                    data = fh.read()
            except OSError as exc:
                yield _failed(path, b"", unreadable(path, exc))
                continue
            yield _read(path, data)

    def read_bytes(self, data: bytes, profile: YamlProfile = "yaml11") -> DocumentRead:
        _profile(profile)
        return _read("", data)
