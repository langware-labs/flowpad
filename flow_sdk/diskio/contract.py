"""The diskio contract — the Protocols a backend implements, and every value
that crosses the kernel boundary (``docs/data-management/diskio.md`` §0-§9, §13).

The value classes are declared in ``flow_sdk/schema/data_spec/diskio_spec.py``,
where every shape the SDK vouches for lives and from where
``register_builtin_kinds()`` reaches them; they are re-exported here so this
module is the one import a caller or a backend needs.
"""

from __future__ import annotations

from typing import Final, Iterator, Protocol, Sequence, runtime_checkable

from flow_sdk.schema.data_spec.diskio_spec import (
    CONTRACT_VERSION,
    VALUES,
    ClaudeSessionStats,
    CodexSessionStats,
    DocText,
    DocumentRead,
    FileNodeValue,
    FingerprintRule,
    FolderNodeValue,
    ItemError,
    LinkGrammar,
    LinkOccurrence,
    Probe,
    ProbeRequest,
    ScanCandidate,
    ScanProblem,
    ScanRequest,
    ScanRoot,
    ShadowRecord,
    ShapeSpec,
    StreamEnd,
    TypeScanSpec,
    WalkEntry,
    WalkPolicy,
    WalkSpec,
    YamlProfile,
)

__all__ = [
    "CONTRACT_VERSION",
    "ClaudeSessionStats",
    "CodexSessionStats",
    "DeclaredScanner",
    "DocText",
    "DocumentRead",
    "DocumentReader",
    "FileNodeValue",
    "FingerprintRule",
    "FolderNodeValue",
    "ItemError",
    "LinkGrammar",
    "LinkOccurrence",
    "PIECES",
    "Probe",
    "ProbeRequest",
    "Prober",
    "ScanCandidate",
    "ScanProblem",
    "ScanRequest",
    "ScanRoot",
    "Scanner",
    "SessionReader",
    "ShadowRecord",
    "ShadowStore",
    "ShapeSpec",
    "StreamEnd",
    "TextExtractor",
    "TreeHasher",
    "TreeWalker",
    "TypeScanSpec",
    "VALUES",
    "WalkEntry",
    "WalkPolicy",
    "WalkSpec",
    "YamlProfile",
]


@runtime_checkable
class TreeWalker(Protocol):
    def walk(self, root: str, policy: WalkPolicy, *, threads: int = 1) -> Iterator[WalkEntry | StreamEnd]: ...


@runtime_checkable
class DeclaredScanner(Protocol):
    def scan(
        self, root: str, root_type: str, specs: Sequence[TypeScanSpec],
    ) -> tuple[list[ScanCandidate], list[ScanProblem]]: ...


@runtime_checkable
class DocumentReader(Protocol):
    def read(
        self, paths: Sequence[str], profile: YamlProfile = "yaml11", *, threads: int = 1,
    ) -> Iterator[DocumentRead | StreamEnd]: ...

    def read_bytes(self, data: bytes, profile: YamlProfile = "yaml11") -> DocumentRead: ...


@runtime_checkable
class TextExtractor(Protocol):
    def extract_text(self, body: str, grammar: LinkGrammar) -> DocText: ...


@runtime_checkable
class Prober(Protocol):
    def probe(
        self, requests: Sequence[ProbeRequest], rules: dict[str, FingerprintRule], *, threads: int = 1,
    ) -> Iterator[Probe | StreamEnd]: ...


@runtime_checkable
class ShadowStore(Protocol):
    def ids(self, records_root: str, types: Sequence[str] | None) -> dict[str, tuple[str, ...]]: ...

    def records(
        self, records_root: str, types: Sequence[str] | None, *, load_meta: bool, threads: int = 1,
    ) -> Iterator[ShadowRecord | StreamEnd]: ...

    def pending(
        self, records_root: str, rules: dict[str, FingerprintRule], *, threads: int = 1,
    ) -> dict[str, bool]: ...


@runtime_checkable
class SessionReader(Protocol):
    def claude(self, paths: Sequence[str], *, threads: int = 1) -> Iterator[ClaudeSessionStats | StreamEnd]: ...

    def codex(self, paths: Sequence[str], *, threads: int = 1) -> Iterator[CodexSessionStats | StreamEnd]: ...


@runtime_checkable
class TreeHasher(Protocol):
    def scan_tree(
        self, root: str, policy: WalkPolicy, *, threads: int = 1,
    ) -> Iterator[FileNodeValue | FolderNodeValue | StreamEnd]: ...


@runtime_checkable
class Scanner(Protocol):
    def scan(self, request: ScanRequest) -> Iterator[WalkEntry | ScanCandidate | ScanProblem | StreamEnd]: ...


#: Every Protocol ``kernel()`` can answer for.
PIECES: Final[tuple[type, ...]] = (
    TreeWalker, DeclaredScanner, Scanner, DocumentReader, TextExtractor,
    Prober, ShadowStore, SessionReader, TreeHasher,
)
