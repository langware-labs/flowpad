"""The disk-I/O kernel's values — ``diskio.*`` (``docs/data-management/diskio.md`` §0-§9, §13).

What crosses the boundary between the SDK and a ``flow_sdk.diskio`` backend:
every class is a frozen ``DataSpec`` registered under a ``diskio.*`` kind, and
this module is imported from ``register_builtin_kinds()`` so each kind resolves.
The Protocols these values travel through are in ``flow_sdk/diskio/contract.py``,
which re-exports every name here — import from there.

Every noun is OURS, except ``ClaudeSessionStats`` / ``CodexSessionStats``, which
MIRROR the two vendors' transcript JSONL and keep the vendors' key names.

Where the spec and the code it describes disagreed on a field a caller needs,
the code won; each such field is listed in ``flow_sdk/diskio/NOTES.md``.
"""

from __future__ import annotations

from typing import Any, Final, Literal

from flow_sdk.schema.data_spec.spec import DataSpec

#: Bumped with ANY change to a ``diskio.*`` field list — a field added, removed,
#: renamed or retyped. A Rust artefact exports the same number and ``kernel()``
#: compares at selection time (§0 Selector).
CONTRACT_VERSION: Final[int] = 1

# ── §0 — shared by every piece ────────────────────────────────────────────────

class ItemError(DataSpec):
    """One item of a batch that could not be read. A value, never an exception."""

    spec_kind = "diskio.item_error"
    path: str = ""  # "" when the value itself has no path (read_bytes)
    kind: Literal["unreadable", "decode", "capsule", "parse"]
    detail: str  # errno NAME for unreadable (EACCES, EPERM, ENOENT, …)

class StreamEnd(DataSpec):
    """The LAST item of every stream a backend returns (§0 Completeness)."""

    spec_kind = "diskio.stream_end"
    counts: dict[str, int]  # spec_kind → items emitted of that kind

# ── §1 TreeWalker ─────────────────────────────────────────────────────────────

class WalkPolicy(DataSpec):
    spec_kind = "diskio.walk_policy"
    gitignore: bool
    #: None = every file; () = no files; else only names with one of these suffixes (case-insensitive).
    file_exts: tuple[str, ...] | None
    deny_basenames: tuple[str, ...]
    #: Each ``(a, b)`` drops a path holding ``a`` then ``b`` as consecutive segments.
    skip_segments: tuple[tuple[str, str], ...]
    force_include: tuple[str, ...]  # applied only when ``gitignore``

class WalkEntry(DataSpec):
    spec_kind = "diskio.walk_entry"
    dir: str
    subdirs: tuple[str, ...]  # names, sorted, already filtered
    files: tuple[str, ...]  # names, per file_exts; empty when file_exts=()
    error: ItemError | None = None  # kinds: unreadable; the lists are empty

# ── §3 DeclaredScanner ────────────────────────────────────────────────────────

class ShapeSpec(DataSpec):
    spec_kind = "diskio.shape"
    kind: Literal["file", "folder"]
    ext: str | None = None  # file: ".md"
    main: str | None = None  # folder: "SKILL.md"; None is a bare folder asset
    also: tuple[str, ...] = ()

class WalkSpec(DataSpec):
    spec_kind = "diskio.walk_spec"
    roots: tuple[str, ...]  # "real_project_cwd", "user_home_folder", "folder", …
    #: Root-relative, placement already applied by the exporter — on EVERY walk.
    #: An ``anywhere`` walk does not scan its mounts: they are the directories
    #: whose entries it skips, and the skip reads the union over the type's walks.
    mounts: tuple[str, ...]
    recursive: bool = False
    anywhere: bool = False

class TypeScanSpec(DataSpec):
    spec_kind = "diskio.type_scan_spec"
    type_name: str
    shape: ShapeSpec
    walks: tuple[WalkSpec, ...]

class ScanCandidate(DataSpec):
    spec_kind = "diskio.scan_candidate"
    path: str
    type_name: str
    layout: Literal["file", "folder", "main_file"]
    parent: str  # the root / dir it was scanned under

class ScanProblem(DataSpec):
    spec_kind = "diskio.scan_problem"
    path: str
    type_name: str
    message: str

# ── §4 DocumentReader ─────────────────────────────────────────────────────────

YamlProfile = Literal["yaml11", "yaml12", "strings"]

class DocumentRead(DataSpec):
    spec_kind = "diskio.document_read"
    path: str  # "" for read_bytes
    raw_text: str
    body: str  # capsule-stripped, as AssetDocument.body
    fields: dict[str, Any]
    body_start_line: int
    metadata_error: str | None
    revision: str  # "sha256:…" of the raw bytes
    error: ItemError | None  # kinds: unreadable | decode | capsule

# ── §5 TextExtractor ──────────────────────────────────────────────────────────

class LinkGrammar(DataSpec):
    spec_kind = "diskio.link_grammar"
    version: int = 1
    fence_min_ticks: int = 3
    mask_inline_code: bool = True
    wiki_url_prefixes: tuple[str, ...] = ("/dock/assets/wiki/", "/dock/hub/assets/wiki/")
    md_link_skip_schemes: tuple[str, ...] = ("http", "https")

class LinkOccurrence(DataSpec):
    """``WikiLink(raw, line, wiki_ref)`` — the three the store writes."""

    spec_kind = "diskio.link_occurrence"
    raw: str
    line: int  # 1-indexed, in the UNMASKED body
    wiki_ref: str | None = None

class DocText(DataSpec):
    spec_kind = "diskio.doc_text"
    h1: str | None  # first "# …" line, stripped; the fallback chain is the caller's
    links: tuple[LinkOccurrence, ...]
    wiki_words: tuple[str, ...]

# ── §6 Prober ─────────────────────────────────────────────────────────────────

class FingerprintRule(DataSpec):
    spec_kind = "diskio.fingerprint_rule"
    kind: Literal["stat", "stat_sum", "max_mtime"]
    parts: tuple[str, ...] = ()  # relative to base; "." = the asset path itself
    globs: tuple[str, ...] = ()  # one level under base
    trees: tuple[str, ...] = ()  # recursive, dirs included

class ProbeRequest(DataSpec):
    spec_kind = "diskio.probe_request"
    record_id: str
    type_name: str  # the key into ``rules``
    asset_path: str  # RESOLVED (§0)
    shadow_dir: str  # <records_root>/<type>/<record_id>/
    fingerprint: str | None = None  # pre-computed by the wrapper → the rule is skipped

class Probe(DataSpec):
    spec_kind = "diskio.probe"
    record_id: str
    index_required: bool
    error: ItemError | None  # kinds: unreadable

# ── §7 ShadowStore ────────────────────────────────────────────────────────────

class ShadowRecord(DataSpec):
    spec_kind = "diskio.shadow_record"
    type_name: str
    dir_id: str  # folder name as found
    meta_id: str | None  # the id metadata.json carries
    asset_ref: str | None  # AS STORED (unresolved)
    fields: dict[str, Any] | None  # the whole metadata.json, only when load_meta=True
    indexed_epoch: int | None  # the three parts of the sentinel stem,
    indexed_hash: str | None  # looked up at records_root/<type>/<meta_id>/;
    indexed_path_digest: str | None  # None = none
    error: ItemError | None  # kinds: unreadable (metadata.json) | parse (not a JSON object)

# ── §8 SessionReader ──────────────────────────────────────────────────────────

class ClaudeSessionStats(DataSpec):
    """Mirror of a Claude Code transcript JSONL, aggregated. The wrapper adds
    ``task_path`` and ``estimated_cost_usd`` — neither is a JSONL fact."""

    spec_kind = "diskio.session_stats.claude"
    path: str
    session_id: str
    cwd: str
    version: str
    git_branch: str
    slug: str
    model: str | None
    message_count: int
    user_message_count: int
    assistant_message_count: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    duration_ms: int
    tools_used: tuple[str, ...]  # sorted
    has_plan: bool
    last_stop_reason: str | None
    last_user_message: str | None
    modified_at: str | None
    models_used: tuple[str, ...]  # sorted
    primary_model: str | None
    created_at: str | None
    search_content: str | None
    error: ItemError | None  # kinds: unreadable | decode

class CodexSessionStats(DataSpec):
    """Mirror of a Codex transcript JSONL (rollout or stream-event), aggregated."""

    spec_kind = "diskio.session_stats.codex"
    path: str
    session_id: str
    cwd: str
    version: str
    originator: str
    git_branch: str
    model: str | None
    effort: str | None
    personality: str | None
    approval_policy: str | None
    sandbox_policy: str | None
    message_count: int
    user_message_count: int
    assistant_message_count: int
    tool_uses: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    last_user_message: str | None
    last_assistant_message: str | None
    last_stop_reason: str | None
    modified_at: str | None
    created_at: str | None
    estimated_cost_usd: float = 0.0
    models_used: tuple[str, ...]
    primary_model: str | None
    search_content: str | None
    worker_type: Literal["codex"] = "codex"
    error: ItemError | None  # kinds: unreadable | decode

# ── §9 TreeHasher ─────────────────────────────────────────────────────────────

class FileNodeValue(DataSpec):
    spec_kind = "diskio.file_node"
    rel_path: str
    content_hash: str  # sha256 of the raw bytes
    title: str
    is_folder_note: bool
    wiki_links: tuple[str, ...]

class FolderNodeValue(DataSpec):
    spec_kind = "diskio.folder_node"
    rel_path: str  # "" for root
    files: tuple[str, ...]  # rel_paths of its FileNodeValues, folder note excluded
    folder_note: str | None  # rel_path of the folder note, if any
    subfolders: tuple[str, ...]  # rel_paths of its FolderNodeValues
    own_hash: str
    inputs_hash: str
    existing_hash: str
    manual: bool
    ground_truth: bool
    has_index: bool
    index_title: str

# ── §13 Scanner — stage 1 ─────────────────────────────────────────────────────

class ScanRoot(DataSpec):
    spec_kind = "diskio.scan_root"
    path: str  # RESOLVED by the parent
    kind: Literal["user_home_folder", "real_project_cwd", "cwd_root", "system_root"]

class ScanRequest(DataSpec):
    spec_kind = "diskio.scan_request"
    roots: tuple[ScanRoot, ...]
    policy: WalkPolicy
    specs: tuple[TypeScanSpec, ...]
    threads: int = 1  # a CAP on the backend's pool

#: Every value class, in spec order — what the conformance kit's ``test_kinds.py`` resolves.
VALUES: Final[tuple[type[DataSpec], ...]] = (
    ItemError, StreamEnd, WalkPolicy, WalkEntry, ShapeSpec, WalkSpec, TypeScanSpec,
    ScanCandidate, ScanProblem, DocumentRead, LinkGrammar, LinkOccurrence, DocText,
    FingerprintRule, ProbeRequest, Probe, ShadowRecord, ClaudeSessionStats,
    CodexSessionStats, FileNodeValue, FolderNodeValue, ScanRoot, ScanRequest,
)
